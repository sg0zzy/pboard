import type { GoogleAuthProvider } from "./googleAuth";
import { DRIVE_TRANSIENT_ATTEMPTS, DRIVE_TRANSIENT_STATUSES, driveBoundedRetryDelayMs, driveRetryDelayMs, isDriveReplayableMethod } from "./driveRetry";
import { defaultDriveQuotaThrottle, driveQuotaError, driveRequestCost, driveRequestSignature, isDriveQuotaFailure, type DriveQuotaThrottle } from "./driveQuota";
import { shareGet } from "./driveSharedRequest";
import { driveHttpError, isDriveGone } from "./driveHttp";
import { defaultDriveIdentityCache, type DriveIdentityCache } from "./driveIdentity";
import type { PboardDriveSignalRecord, PboardDriveSignalStore } from "../collab/signaling";
import { collaborationCounters } from "../collab/counters";
import type { BoardImage } from "../types";
import { aclDigest, sha256Hex, type DriveOwnershipProof } from "../collab/security/authorityTransition";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** pboard collaboration role, mapped 1:1 onto a Google Drive permission role. */
export type PboardCollaboratorRole = "viewer" | "editor";
/** The owner is the account that owns the file; not representable as a permission row. */
export type PboardRole = PboardCollaboratorRole | "owner";

export type DrivePermission = {
  id: string;
  type: "user" | "group" | "anyone" | "domain";
  role: "reader" | "writer" | "owner" | "fileOrganizer";
  emailAddress?: string;
  displayName?: string;
};

export type DriveFileRef = { id: string; name: string; mimeType: string; modifiedTime?: string; parents?: string[] };

export type Collaborator = {
  email: string;
  role: PboardRole;
  name?: string;
  /** Drive permission id, present for non-owner collaborators. */
  permissionId?: string;
};

type GoogleDriveErrorResponse = { error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> } };

/**
 * Thin Drive v3 permissions + app-folder transport. Kept separate from
 * `DriveTransport` so the sharing surface is independently testable and the
 * private app-data path is unchanged.
 */
export interface DrivePermissionTransport {
  currentIdentity(): Promise<{ email: string; name?: string } | null>;
  findSharedRoot(): Promise<DriveFileRef | null>;
  createFolder(name: string, parentId?: string): Promise<DriveFileRef>;
  findFile(name: string, parentId: string): Promise<DriveFileRef | null>;
  createJsonFile(name: string, parentId: string, contents: string): Promise<DriveFileRef>;
  uploadJsonFile(fileId: string, contents: string): Promise<DriveFileRef>;
  downloadFile(fileId: string): Promise<string>;
  /** Download a file's text; null when it does not exist (404). */
  downloadFileOrNull(fileId: string): Promise<string | null>;
  /** Fetch a file's metadata (name, mimeType, modifiedTime, parents). */
  getFile(fileId: string): Promise<DriveFileRef>;
  /** List non-trashed files in a parent folder (what the account can access). */
  listFiles(parentId: string): Promise<DriveFileRef[]>;
  /** Delete a file by id (idempotent; a 404 is treated as success). */
  deleteFile(fileId: string): Promise<void>;
  /** List the parent folder ids of a file (empty when it has none). */
  getFileParents(fileId: string): Promise<string[]>;
  /** List non-trashed files by exact name and MIME type (what the account can access). */
  listFilesByName(name: string, mimeType: string): Promise<DriveFileRef[]>;
  /**
   * The account's shared-with-me shelf. Unlike name search, Drive populates
   * it for freshly granted items without the (sometimes minutes-long) search
   * index delay, so discovery uses it to catch invitations immediately.
   */
  listSharedWithMe(): Promise<DriveFileRef[]>;
  listPermissions(fileId: string): Promise<DrivePermission[]>;
  /**
   * PATCH `writersCanShare=false` so only the owner may change sharing on a
   * My Drive item (D2). Shared-drive items reject this property; callers
   * treat failure as non-fatal. Caveats: Drive cannot restrict a writer
   * from sharing child items that writer itself creates inside the folder.
   */
  restrictWriterSharing(fileId: string): Promise<void>;
  createPermission(fileId: string, role: PboardCollaboratorRole, email: string): Promise<DrivePermission>;
  updatePermission(fileId: string, permissionId: string, role: PboardCollaboratorRole): Promise<DrivePermission>;
  deletePermission(fileId: string, permissionId: string): Promise<void>;
}

/** Storage key (browser.storage.local / platform KV) carrying boards whose
 * self-removal from a shared board's ACL is still pending delivery. */
export const PENDING_BOARD_LEAVES_KEY = "pboardPendingBoardLeaves";

const SHARED_ROOT_NAME = "Pboard";
const PROJECT_FILE_NAME = "project.json";
const REALTIME_FOLDER_NAME = "realtime";
const JSON_MIME = "application/json";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// pboard roles map 1:1 onto Drive permission roles; Drive spells them differently.
const driveRole = (role: PboardCollaboratorRole): "reader" | "writer" => (role === "editor" ? "writer" : "reader");
const escapeDriveQuery = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export function createDrivePermissionTransport(auth: GoogleAuthProvider, fetcher: typeof fetch = fetch, quota: DriveQuotaThrottle = defaultDriveQuotaThrottle(), identity: DriveIdentityCache = defaultDriveIdentityCache()): DrivePermissionTransport {
  async function errorDetail(response: Response): Promise<string> {
    try {
      const body = await response.json() as GoogleDriveErrorResponse;
      const reason = body.error?.errors?.find((entry) => entry.reason)?.reason;
      return [reason, body.error?.status, body.error?.message].filter(Boolean).join(": ");
    } catch {
      // Non-JSON intermediary failures.
      return "";
    }
  }

  async function requestError(response: Response): Promise<Error> {
    let detail = await errorDetail(response);
    if (response.status === 403 && /insufficientScopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(detail)) {
      detail += "; reconnect Google Drive and allow project sharing access";
    }
    // A quota denial is not a permission denial: the caller must still see the
    // quota, so this branch runs before the generic failure message.
    if (isDriveQuotaFailure(detail)) return driveQuotaError(response.status, detail, quota);
    return driveHttpError(response.status, `Google Drive request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  async function authorizedFetch(input: string, init: RequestInit = {}, retry = true, attempt = 0, spentMs = 0): Promise<Response> {
    const token = await auth.getAccessToken(!retry);
    // One startup asks the same sharing search, the same realtime-folder
    // lookup and the same ACL page from several subsystems in one tick; those
    // reads now share a single request and a single quota charge. The identity
    // lookup itself is cached by `driveIdentity`.
    const key = `${token}|${input} ${retry ? 1 : 0} ${attempt}`;
    return await shareGet(init.method, key, () => send(input, init, token, retry, attempt, spentMs));
  }

  async function send(input: string, init: RequestInit, token: string, retry: boolean, attempt: number, spentMs: number): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const cost = driveRequestCost(input, init.method ?? "GET");
    // Defer projected overshoots; a real Google quota denial blocks requests
    // through the context's shared cooldown before they reach the network.
    await quota.acquire(cost, init.signal);
    // Presence, offers and answers change at the same URLs. A cached empty
    // file search or older peer record can prevent two browsers rendezvousing.
    const response = await fetcher(input, { ...init, headers,
      ...(!init.method || init.method === "GET" ? { cache: "no-store" as const } : {}) });
    quota.observe(cost, response.headers, driveRequestSignature(input, init.method ?? "GET"));
    if (response.status === 401 && retry) return authorizedFetch(input, init, false, attempt, spentMs);
    if (response.status === 429 && isDriveQuotaFailure(await errorDetail(response.clone()))) throw await requestError(response);
    // A transient Google-side failure (internalError, rate limit) usually
    // clears on a replay; only one-shot methods are replayed. A quota denial is
    // not replayed blindly — the throttle owns the cooldown and the error
    // reaches the caller.
    if (!response.ok && DRIVE_TRANSIENT_STATUSES[response.status] && attempt + 1 < DRIVE_TRANSIENT_ATTEMPTS &&
        isDriveReplayableMethod(init.method)) {
      const delay = driveBoundedRetryDelayMs(attempt, response.headers.get("Retry-After"), spentMs, await errorDetail(response));
      await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
      return authorizedFetch(input, init, retry, attempt + 1, spentMs + delay);
    }
    if (!response.ok) throw await requestError(response);
    return response;
  }
  /**
   * A listing costs a flat 100 quota units whatever its page size, so asking for
   * a small page multiplies the 100-unit requests instead of cheapening them: a
   * folder with 25 entries was two listings per poll, and a folder that has
   * accumulated presence files from abandoned sessions was several. Ask for
   * Google's documented maximum and follow the continuation token only when a
   * folder really is that large. `nextPageToken` must stay in the projection or
   * the loop cannot see that more results exist.
   */
  const LIST_PAGE_SIZE = "1000";
  /** `permissions.list` coerces anything larger to 100; 20 just cost extra pages. */
  const PERMISSION_PAGE_SIZE = "100";
  async function listFilesPage(params: URLSearchParams): Promise<DriveFileRef[]> {
    const files: DriveFileRef[] = [];
    for (;;) {
      const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
      const body = await response.json() as { files?: DriveFileRef[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
      if (!body.nextPageToken) return files;
      params.set("pageToken", body.nextPageToken);
    }
  }
  async function findFile(name: string, parentId: string): Promise<DriveFileRef | null> {
    const params = new URLSearchParams({
      spaces: "drive",
      q: `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime,parents)",
      pageSize: "2"
    });
    const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
    const body = await response.json() as { files?: DriveFileRef[] };
    return body.files?.[0] ?? null;
  }

  return {
    async currentIdentity() {
      // Drive's user resource is available with the scopes we already request;
      // People API profile fields require separate authorization. The account
      // behind an access token does not change while that token is valid, so
      // concurrent and near-simultaneous callers share one lookup instead of
      // each asking `about.get` (docs/collaboration.md).
      const token = await auth.getAccessToken();
      return await identity.resolve(token, async (bearer) => {
        const response = await send(`${DRIVE_API}/about?fields=user(emailAddress,displayName)`, {}, bearer, true, 0, 0);
        const body = (await response.json()) as { user?: { emailAddress?: string; displayName?: string } };
        const email = body.user?.emailAddress;
        if (!email) return null;
        return { email, name: body.user?.displayName };
      });
    },
    findSharedRoot: () => findFile(SHARED_ROOT_NAME, "root"),
    async createFolder(name, parentId) {
      const metadata = JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) });
      const response = await authorizedFetch(`${DRIVE_API}/files?fields=id,name,mimeType,modifiedTime`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: metadata
      });
      return await response.json() as DriveFileRef;
    },
    findFile,
    async createJsonFile(name, parentId, contents) {
      const boundary = `pboard_${crypto.randomUUID().replaceAll("-", "")}`;
      const metadata = JSON.stringify({ name, parents: [parentId], mimeType: JSON_MIME });
      const body = [
        `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", metadata,
        `--${boundary}`, "Content-Type: application/json", "", contents, `--${boundary}--`, ""
      ].join("\r\n");
      const response = await authorizedFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime`, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body
      });
      return await response.json() as DriveFileRef;
    },
    async uploadJsonFile(fileId, contents) {
      const response = await authorizedFetch(
        `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType,modifiedTime`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: contents }
      );
      return await response.json() as DriveFileRef;
    },
    async downloadFile(fileId) {
      const response = await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
      return response.text();
    },
    async downloadFileOrNull(fileId) {
      try {
        const response = await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
        return response.text();
      } catch (error) {
        if (error instanceof Error && /404/.test(error.message)) return null;
        throw error;
      }
    },
    async getFile(fileId) {
      const response = await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,parents`);
      return await response.json() as DriveFileRef;
    },
    async listFiles(parentId: string) {
      return listFilesPage(new URLSearchParams({
        spaces: "drive",
        q: `'${encodeURIComponent(parentId)}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents)",
        pageSize: LIST_PAGE_SIZE
      }));
    },
    async deleteFile(fileId) {
      try {
        await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof Error && /404/.test(error.message)) return;
        throw error;
      }
    },
    async getFileParents(fileId) {
      try {
        const response = await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=parents`);
        const body = await response.json() as { parents?: string[] };
        return body.parents ?? [];
      } catch {
        return [];
      }
    },
    async listFilesByName(name: string, mimeType: string) {
      return listFilesPage(new URLSearchParams({
        spaces: "drive",
        q: `name = '${escapeDriveQuery(name)}' and mimeType = '${escapeDriveQuery(mimeType)}' and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents)",
        pageSize: LIST_PAGE_SIZE
      }));
    },
    async listSharedWithMe() {
      return listFilesPage(new URLSearchParams({
        spaces: "drive",
        q: "sharedWithMe = true and trashed = false",
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents)",
        pageSize: LIST_PAGE_SIZE
      }));
    },
    async listPermissions(fileId: string) {
      const permissions: DrivePermission[] = [];
      const params = new URLSearchParams({ fields: "nextPageToken,permissions(id,type,role,emailAddress,displayName)", pageSize: PERMISSION_PAGE_SIZE });
      for (;;) {
        const response = await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?${params}`);
        const body = await response.json() as { permissions?: DrivePermission[]; nextPageToken?: string };
        permissions.push(...(body.permissions ?? []));
        if (!body.nextPageToken) return permissions;
        params.set("pageToken", body.nextPageToken);
      }
    },
    async restrictWriterSharing(fileId) {
      // Metadata PATCH on the standard API host; a non-ok response rejects.
      await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id%2CwritersCanShare`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ writersCanShare: false })
      });
    },
    async createPermission(fileId, role, email) {
      const response = await authorizedFetch(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=id,type,role,emailAddress,displayName`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "user", role: driveRole(role), emailAddress: email, sendNotificationEmail: false }) }
      );
      return await response.json() as DrivePermission;
    },
    async updatePermission(fileId, permissionId, role) {
      const response = await authorizedFetch(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?fields=id,type,role,emailAddress,displayName`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: driveRole(role) }) }
      );
      return await response.json() as DrivePermission;
    },
    async deletePermission(fileId, permissionId) {
      await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`, { method: "DELETE" });
    }
  };
}

/**
 * Shared-project layout. A shared project lives in the owner's My Drive at:
 *   Pboard/<projectId>/              (folder — the authoritative ACL target)
 *     project.json                   (v1 snapshot; bootstrap source)
 *     realtime/                      (ephemeral WebRTC signaling records)
 *
 * The ACL is on the *folder* because Drive folder permissions inherit to
 * children, so a collaborator granted the folder reaches both project.json
 * (bootstrap) and the realtime/ signaling records with a single permission.
 * Removing a collaborator from the folder revokes both at once.
 */
export type DriveSharedProjectRecord = {
  folderId: string | null;
  projectFileId: string | null;
  realtimeFolderId: string | null;
  /**
   * Baseline for re-invitation detection: the id this account's own
   * collaborator permission had at the previous observation. Null means the
   * account held no grant at that observation. Drive's Permission
   * representation carries no creation time, so this is the only ordering
   * signal available; it is the sole field here beyond the layout ids.
   */
  observedGrantId?: string | null;
};
export interface DriveSharedProjectStore {
  get(projectId: string): Promise<DriveSharedProjectRecord>;
  set(projectId: string, patch: Partial<DriveSharedProjectRecord>): Promise<void>;
  delete(projectId: string): Promise<void>;
}

export interface DrivePermissionServiceOptions {
  prepareOperationBoard?: (projectId: string) => Promise<void>;
  isOperationBoard?: (projectId: string) => Promise<boolean>;
  transport: DrivePermissionTransport;
  sharedProjects: DriveSharedProjectStore;
  /** Read-only current-layout lookup, supplied for Sync v2 authority recovery. */
  findOwnershipFolder?: (projectId: string) => Promise<string | null>;
  /** Reads the current local snapshot (project + hydrated items) for a project. */
  readSnapshot: (projectId: string) => Promise<string>;
}

/** A shared project this account can access, discovered from Drive. */
export type DiscoveredSharedProject = { projectId: string; name: string; fileId: string };

export interface DrivePermissionService {
  /** Create or reuse the shared layout (folder + project.json + realtime/); returns the folder id. */
  ensureSharedProject(projectId: string): Promise<string>;
  /** Read the shared project.json snapshot text from Drive. */
  readSharedSnapshot(projectId: string): Promise<string>;
  /** Overwrite the shared project.json snapshot in Drive (backup / bootstrap source). */
  writeSharedSnapshot(projectId: string, snapshot: string): Promise<void>;
  readSharedImage(projectId: string, imageId: string): Promise<BoardImage | null>;
  writeSharedImage(projectId: string, imageId: string, image: BoardImage): Promise<void>;
  /** The shared project.json file id (null when the project is not shared). */
  projectFileId(projectId: string): Promise<string | null>;
  /** The shared project's realtime signaling folder id, created if missing. */
  /**
   * The board's presence folder. `underFolderId` names the parent the caller has
   * already agreed with the other collaborators — the operations layout, for the
   * realtime room — and is what makes two browsers converge on one room instead
   * of each trusting whichever parent it cached first.
   */
  realtimeFolderId(projectId: string, underFolderId?: string): Promise<string>;
  /**
   * Shared projects this account can access. Found by listing every project.json
   * the account has a Drive permission on (Drive returns only reachable files) and
   * grouping by the parent folder name, which is the projectId.
   */
  discoverSharedProjects(options?: { force?: boolean }): Promise<DiscoveredSharedProject[]>;
  /** Drop the short discovery cache; an explicit user sync must see grants
   * made seconds ago, not the cached listing. */
  invalidateSharedDiscovery(): void;
  /** The caller's role for the shared project; null when not shared or no permission. */
  myRole(projectId: string): Promise<PboardRole | null>;
  /**
   * Fresh live Drive ACL read proving this account owns the board folder
   * (authority re-key authorization). Throws when unverified or not owner —
   * never resolves from cached metadata.
   */
  verifyDriveOwnership(projectId: string): Promise<DriveOwnershipProof>;
  /**
   * Self-removal for a non-owner's board "delete": revoke the caller's own
   * collaborator and realtime permission so the owner's share list reflects
   * the departure. Resolves quietly when there is nothing to revoke (board
   * not Drive-shared, caller is the owner, or permission already gone);
   * transport failures reject so a pending-leave retry can re-run.
   */
  removeSelfFromProject(projectId: string): Promise<void>;
  /**
   * True when this account's collaborator grant on the board differs from the
   * grant id recorded at the previous observation: the original grant was
   * revoked and a new one issued after the removal, so the deletion marker
   * must yield. A board whose grant was never observed before the removal has
   * no baseline; the first observation records it and reports false.
   */
  wasReinvitedSince(projectId: string): Promise<boolean>;
  listCollaborators(projectId: string): Promise<Collaborator[]>;
  invite(projectId: string, email: string, role: PboardCollaboratorRole): Promise<void>;
  updateRole(projectId: string, email: string, role: PboardCollaboratorRole): Promise<void>;
  removeCollaborator(projectId: string, email: string): Promise<void>;
}

const roleRank = (role: PboardRole) => (role === "owner" ? 0 : role === "editor" ? 1 : 2);

export function createDrivePermissionService(options: DrivePermissionServiceOptions): DrivePermissionService {
  const { transport, sharedProjects } = options;
  /** Parent+board to the presence folder its listing gave (`resolveRealtimeFolder`). */
  const convergedFolders = new Map<string, string>();
  function imageFileName(imageId: string) {
    if (!/^[a-f0-9]{64}$/.test(imageId)) throw new Error("Invalid shared image id");
    return `image-${imageId}.json`;
  }

  async function ensureSharedRoot(): Promise<string> {
    const existing = await transport.findSharedRoot();
    if (existing) return existing.id;
    return (await transport.createFolder(SHARED_ROOT_NAME)).id;
  }

  /**
   * The shared projects this account can reach, and when the list was taken.
   *
   * `resolveLayout` falls back to discovery when a board's layout is not
   * cached. A board that is not shared never gets a cached layout, so every
   * resolution of it listed every shared `project.json` in the account again.
   * The sidebar resolves the board's role every ten seconds, and the role
   * resolution and the shared-file resolution run in parallel, so a local
   * board produced a steady stream of Drive listings.
   *
   * The list is therefore kept for a short while and reused. A board that
   * becomes shared is picked up by the next list, and the shared board's own
   * layout is cached as soon as it is found.
   */
  let discovered: { at: number; entries: DiscoveredSharedProject[] } | null = null;
  /** Drop the discovery cache so the next listing hits Drive again. */
  function invalidateSharedDiscovery() { discovered = null; }

  const DISCOVERY_TTL_MS = 60_000;

  async function discoverSharedProjects(options?: { force?: boolean }): Promise<DiscoveredSharedProject[]> {
    const now = Date.now();
    // A forced round (explicit user action, the recurring alarm) must see
    // grants that landed after the cached pass — that cache is exactly why a
    // freshly shared board could stay invisible for a whole TTL window.
    if (discovered && !options?.force && now - discovered.at < DISCOVERY_TTL_MS) {
      collaborationCounters.countSharedDiscovery(true);
      return discovered.entries;
    }
    collaborationCounters.countSharedDiscovery(false);
    const files = await transport.listFilesByName(PROJECT_FILE_NAME, JSON_MIME);
    const byProject = new Map<string, DiscoveredSharedProject[]>();
    const note = async (projectId: string, file: DriveFileRef, knownFolderId?: string) => {
      const cached = await sharedProjects.get(projectId);
      const folderId = knownFolderId ?? file.parents?.[0] ?? (await transport.getFileParents(file.id))[0];
      if (cached.folderId !== folderId || cached.projectFileId !== file.id) {
        await sharedProjects.set(projectId, { ...(folderId ? { folderId } : {}), projectFileId: file.id });
      }
      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId)!.push({ projectId, name: projectId, fileId: file.id });
    };
    for (const file of files) {
      try {
        const folderId = file.parents?.[0] ?? (await transport.getFileParents(file.id))[0];
        if (!folderId) continue;
        const folder = await transport.getFile(folderId);
        if (folder.mimeType !== FOLDER_MIME) continue;
        // A name search may still contain a child of a trashed/revoked folder.
        await note(folder.name, file, folderId);
      } catch (error) {
        if (!/\((403|404)\)/.test(String(error))) throw error;
      }
    }
    // Drive name search can lag real permission changes by minutes, which
    // looks like "the invitation never arrived" even after a browser
    // restart. The shared-with-me shelf reflects fresh grants immediately;
    // expand it (board folders and directly shared project files) as a
    // best-effort supplement — its failure never cancels the name results.
    try {
      const seen = new Set(files.map((file) => file.id));
      for (const shared of await transport.listSharedWithMe()) {
        if (shared.mimeType === FOLDER_MIME) {
          const marker = await transport.findFile(PROJECT_FILE_NAME, shared.id);
          if (marker && !seen.has(marker.id)) { seen.add(marker.id); await note(shared.name, marker); }
        } else if (shared.name === PROJECT_FILE_NAME && shared.mimeType === JSON_MIME && !seen.has(shared.id)) {
          seen.add(shared.id);
          const parentId = shared.parents?.[0] ?? (await transport.getFileParents(shared.id))[0];
          if (parentId) {
            const parent = await transport.getFile(parentId);
            if (parent.mimeType === FOLDER_MIME) await note(parent.name, shared);
          }
        }
      }
    } catch {
      // Name-search results stand; the next discovery pass retries the shelf.
    }
    const entries = [...byProject.values()].map((group) => group[0]);
    discovered = { at: now, entries };
    return entries;
  }

  /**
   * Resolve the shared layout, preferring the local cache. A collaborator with no
   * local copy has an empty cache, so fall back to discovery: list the
   * project.json files the account can reach and match by parent folder name.
   */
  async function resolveLayout(projectId: string): Promise<DriveSharedProjectRecord> {
    const cached = await sharedProjects.get(projectId);
    if (cached.folderId && cached.projectFileId) return cached;
    const match = (await discoverSharedProjects()).find((entry) => entry.projectId === projectId);
    if (!match) return { folderId: cached.folderId, projectFileId: cached.projectFileId, realtimeFolderId: cached.realtimeFolderId };
    // Discovery already persisted the parent it read from the listing projection;
    // the parent read is a fallback for a cache that was written without it.
    const written = await sharedProjects.get(projectId);
    const folderId = written.folderId ?? (await transport.getFileParents(match.fileId))[0] ?? null;
    if (folderId) await sharedProjects.set(projectId, { folderId, projectFileId: match.fileId });
    return { folderId, projectFileId: match.fileId, realtimeFolderId: cached.realtimeFolderId };
  }

  async function ensureSharedProject(projectId: string): Promise<string> {
    await options.prepareOperationBoard?.(projectId);
    const cached = await sharedProjects.get(projectId);
    const rootId = await ensureSharedRoot();
    let folderId = cached.folderId;
    if (!folderId) {
      let folder = await transport.findFile(projectId, rootId);
      if (!folder) { folder = await transport.createFolder(projectId, rootId); await restrictWriterSharingBestEffort(folder.id); }
      folderId = folder.id;
    }
    let projectFileId = cached.projectFileId;
    if (!projectFileId) {
      const existing = await transport.findFile(PROJECT_FILE_NAME, folderId);
      if (existing) projectFileId = existing.id;
      else { projectFileId = (await transport.createJsonFile(PROJECT_FILE_NAME, folderId, await options.readSnapshot(projectId))).id; await restrictWriterSharingBestEffort(projectFileId); }
    }
    const realtimeFolderId = await resolveRealtimeFolder(projectId, folderId);
    await sharedProjects.set(projectId, { folderId, projectFileId, realtimeFolderId });
    return folderId;
  }

/**
   * The board's `realtime/` folder, converged on the id every collaborator's
   * listing sees.
   *
   * Presence is only found by browsers that look in the same folder, and the id
   * used to be whatever this browser happened to resolve once and then kept
   * forever: the lookup was a Drive *name search*, whose index can lag by
   * minutes, so a browser joining a board another browser had just set up could
   * miss the folder that already existed and create a second one of the same
   * name. Each browser cached its own id, each then held a room the other could
   * not see — the exact shape of "collaboration is not working" reported by a
   * sidebar saying `role: owner`, `ready: true` and one presence file in the
   * room, with the two browsers still syncing through Drive.
   *
   * So the folder is resolved from the parent folder's *listing* — what every
   * collaborator sees — and a deterministic canonical child (lowest id) is chosen
   * so independent browsers converge whatever order they ran in. Once per board
   * per session; after that the answer is cached, so opening a board costs one
   * listing rather than one per presence poll.
   */
  async function resolveRealtimeFolder(projectId: string, parent: string): Promise<string> {
    const cached = await sharedProjects.get(projectId);
    const key = `${parent}\u0000${projectId}`;
    // The listing is consulted once per board, and again only when the cached id
    // stopped being the answer that listing gave: a cache left by an older build,
    // or moved by hand, must not freeze a room away from its collaborators.
    if (cached.realtimeFolderId && convergedFolders.get(key) === cached.realtimeFolderId) return cached.realtimeFolderId;
    let listed: string[];
    try {
      listed = (await transport.listFiles(parent))
        .filter((child) => child.name === REALTIME_FOLDER_NAME && child.mimeType === FOLDER_MIME)
        .map((child) => child.id)
        .sort();
    } catch (error) {
      // Convergence must never be the reason a room cannot start: this runs while
      // the realtime session joins, and a session whose join rejects is closed
      // with no peer and no retry. A browser that already has a folder keeps using
      // it and tries to converge again on the next resolution; only a browser with
      // nothing to fall back on has to wait for Drive.
      if (!cached.realtimeFolderId) throw error;
      return cached.realtimeFolderId;
    }
    // The listing wins over the cache even when the cached folder is one of the
    // listed ones: several `realtime` children of one board folder are normal
    // after this bug, and preferring a browser's own id is precisely what kept
    // the two rooms apart. The lowest id is the answer every browser's listing
    // reaches, in whatever order they were started.
    const chosen = listed[0] ?? cached.realtimeFolderId;
    if (chosen) {
      if (chosen !== cached.realtimeFolderId) await sharedProjects.set(projectId, { realtimeFolderId: chosen });
      convergedFolders.set(key, chosen);
      return chosen;
    }
    const created = await transport.createFolder(REALTIME_FOLDER_NAME, parent);
    await sharedProjects.set(projectId, { realtimeFolderId: created.id });
    convergedFolders.set(key, created.id);
    return created.id;
  }

  async function ensureRealtimeFolder(projectId: string, underFolderId?: string): Promise<string> {
    const parent = underFolderId ?? (await resolveLayout(projectId)).folderId;
    if (!parent) throw new Error("Project is not shared");
    return resolveRealtimeFolder(projectId, parent);
  }

  async function myRole(projectId: string): Promise<PboardRole | null> {
    const layout = await resolveLayout(projectId);
    if (!layout.folderId) return null;
    const identity = await transport.currentIdentity();
    if (!identity) return null;
    const permissions = await transport.listPermissions(layout.folderId);
    const email = identity.email.trim().toLowerCase();
    if (permissions.some((p) => p.role === "owner" && p.emailAddress?.trim().toLowerCase() === email)) return "owner";
    const mine = permissions.find((p) => p.type === "user" && p.emailAddress?.trim().toLowerCase() === email);
    // First observation of this account's grant establishes the baseline the
    // next read compares against, so a board left on another device can still
    // be recognized as re-invited.
    if (mine && (await sharedProjects.get(projectId)).observedGrantId === undefined)
      await sharedProjects.set(projectId, { observedGrantId: mine.id });
    if (!mine) return null;
    return mine.role === "writer" ? "editor" : "viewer";
  }
  // D2: folder sharing stays owner-only on My Drive. Unsupported on shared
  // drives (writersCanShare is fixed true there) and never worth breaking a
  // share for, so failure only counts an event.
  async function restrictWriterSharingBestEffort(fileId: string): Promise<void> {
    try { await transport.restrictWriterSharing(fileId); }
    catch { collaborationCounters.countEvent("drive.share_restriction_failed"); }
  }

  // Fresh authenticated ownership read for authority re-key (D1/D4): resolves
  // nothing from cache. Resolves ONLY when the live ACL proves this account
  // owns the board folder; every other outcome (not shared, signed out, API
  // failure, verified non-owner) throws so callers postpone rather than trust.
  // Sync v2 supplies its existing canonical folder; private boards need no
  // collaborator ACL or legacy project.json to establish their owner's proof.
  async function verifyDriveOwnership(projectId: string): Promise<DriveOwnershipProof> {
    // Prefer the canonical v2 board over a retained legacy sharing record.
    // Lookup must never create an empty owned folder as proof of ownership.
    const folderId = await options.findOwnershipFolder?.(projectId) ?? (await resolveLayout(projectId)).folderId;
    if (!folderId) throw new Error("No existing Drive board folder was found; Drive ownership cannot be verified");
    const identity = await transport.currentIdentity();
    if (!identity) throw new Error("Google account unavailable; Drive ownership is unverified");
    const permissions = await transport.listPermissions(folderId);
    const email = identity.email.trim().toLowerCase();
    if (!permissions.some((p) => p.role === "owner" && p.emailAddress?.trim().toLowerCase() === email))
      throw new Error("Google Drive does not report this account as the board folder owner; re-keying is refused");
    return { folderFileId: folderId, ownerEmailHash: await sha256Hex(email), aclDigest: await aclDigest(permissions), verifiedAt: Date.now() };
  }

  async function listCollaborators(projectId: string): Promise<Collaborator[]> {
    const layout = await resolveLayout(projectId);
    if (!layout.folderId) return [];
    const permissions = await transport.listPermissions(layout.folderId);
    const collaborators: Collaborator[] = [];
    for (const permission of permissions) {
      if (permission.type !== "user" || !permission.emailAddress) continue;
      const role: PboardRole = permission.role === "owner" ? "owner" : permission.role === "writer" ? "editor" : "viewer";
      collaborators.push({ email: permission.emailAddress, role, name: permission.displayName, permissionId: permission.id });
    }
    // Owner first, then editors, then viewers; alphabetical within role.
    collaborators.sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.email.localeCompare(b.email));
    return collaborators;
  }

  /**
   * Grant a collaborator write access to the realtime/ signaling folder. Every
   * peer — including viewers — must write its own ephemeral signaling record, so
   * this is always `writer` regardless of the project role. This is coordination
   * access, not content access: the project folder (and project.json) keep the
   * role-based ACL, so a viewer still cannot read or write board content. Known
   * v1 limitation: a peer with realtime write can disrupt or spoof signaling
   * (a liveness DoS), but cannot mutate project content — that is enforced at the
   * repository mutator gate and the WebRTC push modifier. See collaboration.md.
   */
  async function grantRealtimeAccess(projectId: string, email: string): Promise<void> {
    const layout = await resolveLayout(projectId);
    if (!layout.realtimeFolderId) throw new Error("Project is not shared");
    const existing = await transport.listPermissions(layout.realtimeFolderId);
    if (existing.some((p) => p.type === "user" && p.emailAddress?.toLowerCase() === email)) return;
    await transport.createPermission(layout.realtimeFolderId, "editor", email);
  }

  async function revokeRealtimeAccess(projectId: string, email: string): Promise<void> {
    const layout = await resolveLayout(projectId);
    if (!layout.realtimeFolderId) return;
    const permissions = await transport.listPermissions(layout.realtimeFolderId);
    const permission = permissions.find((p) => p.type === "user" && p.emailAddress?.toLowerCase() === email && p.role !== "owner");
    if (permission) await transport.deletePermission(layout.realtimeFolderId, permission.id);
  }

  async function invite(projectId: string, email: string, role: PboardCollaboratorRole): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a valid email address");
    await ensureSharedProject(projectId);
    const layout = await resolveLayout(projectId);
    if (!await options.isOperationBoard?.(projectId)) await transport.uploadJsonFile(layout.projectFileId!, await options.readSnapshot(projectId));
    await transport.createPermission(layout.folderId ?? "", role, normalized);
    await grantRealtimeAccess(projectId, normalized);
  }

  async function updateRole(projectId: string, email: string, role: PboardCollaboratorRole): Promise<void> {
    const target = await findCollaborator(projectId, email);
    await transport.updatePermission(target.folderId, target.permission.id, role);
  }

  async function removeCollaborator(projectId: string, email: string): Promise<void> {
    const target = await findCollaborator(projectId, email);
    const normalized = (target.permission.emailAddress ?? email).trim().toLowerCase();
    await transport.deletePermission(target.folderId, target.permission.id);
    await revokeRealtimeAccess(projectId, normalized);
  }

  async function removeSelfFromProject(projectId: string): Promise<void> {
    const layout = await resolveLayout(projectId);
    if (!layout.folderId) return;
    const identity = await transport.currentIdentity();
    if (!identity?.email) return;
    const email = identity.email.trim().toLowerCase();
    const permissions = await transport.listPermissions(layout.folderId);
    // Owners delete the board itself (content path); they never leave.
    if (permissions.some((p) => p.role === "owner" && p.emailAddress?.trim().toLowerCase() === email)) return;
    const mine = permissions.find((p) => p.type === "user" && p.emailAddress?.trim().toLowerCase() === email);
    if (mine) await transport.deletePermission(layout.folderId, mine.id);
    // The leave itself is the baseline: a different grant id at the next
    // observation means the owner re-invited. Recorded as null here, including
    // when the permission was already gone before the leave.
    await sharedProjects.set(projectId, { observedGrantId: null });
    await revokeRealtimeAccess(projectId, email);
  }

  async function wasReinvitedSince(projectId: string): Promise<boolean> {
    const layout = await resolveLayout(projectId);
    if (!layout.folderId) return false;
    const identity = await transport.currentIdentity();
    if (!identity?.email) return false;
    const email = identity.email.trim().toLowerCase();
    const permissions = await transport.listPermissions(layout.folderId);
    const mine = permissions.find((p) => p.type === "user" && p.emailAddress?.trim().toLowerCase() === email && p.role !== "owner");
    const recorded = (await sharedProjects.get(projectId)).observedGrantId;
    if (recorded === undefined) {
      // No prior observation: a single grant cannot be ordered against a
      // removal that happened while this account was not reading the board.
      await sharedProjects.set(projectId, { observedGrantId: mine?.id ?? null });
      return false;
    }
    if (!mine) return false;
    if (mine.id === recorded) return false;
    await sharedProjects.set(projectId, { observedGrantId: mine.id });
    return true;
  }

  async function findCollaborator(projectId: string, email: string): Promise<{ folderId: string; permission: DrivePermission }> {
    const layout = await resolveLayout(projectId);
    if (!layout.folderId) throw new Error("Project is not shared");
    const permissions = await transport.listPermissions(layout.folderId);
    const permission = permissions.find((p) => p.type === "user" && p.emailAddress?.toLowerCase() === email.trim().toLowerCase() && p.role !== "owner");
    if (!permission) throw new Error("Collaborator not found or is the owner");
    return { folderId: layout.folderId, permission };
  }

  return {
    ensureSharedProject,
    async readSharedSnapshot(projectId) {
      const layout = await resolveLayout(projectId);
      if (!layout.projectFileId) throw new Error("Project is not shared");
      return transport.downloadFile(layout.projectFileId);
    },
    async writeSharedSnapshot(projectId, snapshot) {
      await ensureSharedProject(projectId);
      const layout = await sharedProjects.get(projectId);
      if (!layout.projectFileId) throw new Error("Project is not shared");
      await transport.uploadJsonFile(layout.projectFileId, snapshot);
    },
    async readSharedImage(projectId, imageId) {
      const name = imageFileName(imageId);
      const layout = await resolveLayout(projectId);
      if (!layout.folderId) return null;
      const file = await transport.findFile(name, layout.folderId);
      if (!file) return null;
      const saved = JSON.parse(await transport.downloadFile(file.id)) as { format?: string; imageId?: string; image?: BoardImage };
      if (saved.format !== "pboard-image" || saved.imageId !== imageId || !saved.image) throw new Error("Invalid shared image asset");
      return saved.image;
    },
    async writeSharedImage(projectId, imageId, image) {
      const name = imageFileName(imageId);
      const layout = await resolveLayout(projectId);
      if (!layout.folderId) throw new Error("Project is not shared");
      const contents = JSON.stringify({ format: "pboard-image", imageId, image });
      const existing = await transport.findFile(name, layout.folderId);
      if (existing) await transport.uploadJsonFile(existing.id, contents);
      else await transport.createJsonFile(name, layout.folderId, contents);
    },
    async projectFileId(projectId) {
      return (await resolveLayout(projectId)).projectFileId;
    },
    realtimeFolderId: ensureRealtimeFolder,
    discoverSharedProjects,
    invalidateSharedDiscovery,
    myRole,
    verifyDriveOwnership,
    listCollaborators,
    invite,
    updateRole,
    removeCollaborator,
    removeSelfFromProject,
    wasReinvitedSince
  };
}

/**
 * A `PboardDriveSignalStore` backed by the shared project's `realtime/` folder.
 * Each peer owns one file, `sig-<topic>-<peerId>.json`; the store never writes
 * another peer's file, so concurrent peers cannot race. The peer id must be
 * stable for the life of the session (both collection pools share it). The
 * realtime folder is resolved lazily and idempotently via `realtimeFolderId`.
 */
export function createDriveSignalStore(options: {
  transport: DrivePermissionTransport;
  sharedProjects: DriveSharedProjectStore;
  projectId: string;
  peerId: string;
  topic: string;
  /** Resolve (and, if needed) create the realtime folder id for the project. */
  realtimeFolderId: () => Promise<string>;
  now?: () => number;
  /**
   * The poll loop's presence TTL, used to tell a peer that is merely quiet from
   * a session that is gone. Must match the TTL given to `createDriveSignaling`.
   */
  presenceTtlMs?: number;
}): PboardDriveSignalStore {
  const { transport, sharedProjects, projectId, peerId, topic, realtimeFolderId } = options;
  const now = options.now ?? (() => Date.now());
  const presenceTtlMs = options.presenceTtlMs ?? 60_000;
  const prefix = `sig-${topic}-`;
  const fileName = (id: string) => `${prefix}${id}.json`;

  /**
   * Presence files already accounted for, keyed by Drive id.
   *
   * `files.list` already returns the id, name and `modifiedTime` of every
   * presence file for 100 quota units; a download is 200. Re-downloading every
   * record on every poll — including the one this very session wrote, and the
   * ones belonging to sessions that died without deleting their file — made one
   * open board the single largest recurring Drive cost in the product
   * (~950 units every two seconds per room, ≈ 28,500 units/minute).
   *
   * A record is re-downloaded when its `modifiedTime` moved (something was
   * written) or after `rereadMs` regardless, so a Drive write that landed in the
   * same second as the previous one is still picked up: the worst-case signal
   * latency is `rereadMs`, never a lost signal.
   */
  const rereadMs = Math.max(5_000, Math.floor(presenceTtlMs / 4));
  /** A response without a modification time cannot be cached: read it again. */
  const stampOf = (file: DriveFileRef) => file.modifiedTime ?? "";
  const seen = new Map<string, { modifiedTime: string; at: number; record: PboardDriveSignalRecord }>();
  /**
   * Presence files Drive listed but could not serve (200 for the listing, 404 for
   * the file). Drive keeps naming a deleted file in the next listing, so the
   * answer for that id is asked once and then remembered: without this, a room
   * holding stale presence files spent two requests on each of them every poll,
   * forever — a self-inflicted 404 storm in the middle of a quota problem.
   * Bounded, because a folder that is a graveyard must not grow the list either.
   */
  const gonePeerFiles = new Map<string, { asks: number; retryAt: number }>();
  const MAX_GONE_PEER_FILES = 400;
  /**
   * Expired presence files whose removal was already attempted. Drive's listing
   * is not immediate, and a file this account may not delete — a board whose
   * collaborator left it — must not be re-deleted by every poll of every reader.
   */
  const expiredPeerFiles = new Set<string>();
  const MAX_EXPIRED_PEER_FILES = 400;
  /**
   * How long a presence file may sit unwritten before the room removes it. The
   * TTL alone is not that long: a browser in a background tab is throttled to
   * roughly one wake a minute by Firefox, so a live collaborator's heartbeat can
   * legitimately arrive two minutes after the last one, and a file deleted out
   * from under it costs that browser a 404 on every write until Drive's index
   * catches up. The removal exists to clear files whose owners are never coming
   * back, not to start a fight with a sleeping tab, so it waits five TTLs.
   */
  const expiredPeerMs = presenceTtlMs * 5;
  /**
   * A file Drive cannot serve is retired rather than retried every poll, but the
   * retirement is not permanent: this folder holds the live sessions of other
   * browsers, and a single failed read — a listing that raced a write, a Drive
   * frontend that had not caught up — must not exclude a peer for the rest of the
   * session, because presence is how the realtime room finds each other at all.
   * So a few re-asks, spaced a minute apart, and then it is gone.
   */
  const GONE_PEER_ASKS = 3;
  const GONE_PEER_RETRY_MS = 60_000;
  /** This session's own presence file: its id and the body it last wrote. */
  let ownFile: { id: string; name: string } | null = null;
  let ownRecord: PboardDriveSignalRecord | null = null;

  /** Forget the cached own file after a write failure: the id may be stale. */
  function forgetOwnFile() { ownFile = null; ownRecord = null; }

  async function writePeer(peer: string, record: PboardDriveSignalRecord): Promise<void> {
    const folderId = await realtimeFolderId();
    const name = fileName(peer);
    const body = JSON.stringify(record);
    const own = peer === peerId;
    // Our own file is written by nobody else, so its id is remembered for the
    // whole session instead of being re-resolved by name every heartbeat.
    const existing = own && ownFile?.name === name
      ? { id: ownFile.id }
      : await transport.findFile(name, folderId);
    try {
      const ref = existing
        ? await transport.uploadJsonFile(existing.id, body)
        : await transport.createJsonFile(name, folderId, body);
      remember(ref, name, record, own);
    } catch (error) {
      if (existing && isDriveGone(error)) {
        // Drive named a file it no longer serves: somebody removed it between the
        // lookup and this write — a collaborator's cleanup of an abandoned
        // session, or this client's own expiry, with Drive's index a moment behind.
        // Creating it is the only honest answer, and it has to be *this* call: a
        // remembered id is forgotten here and re-resolved from a listing that still
        // names the dead file, so the next attempt would 404 exactly the same way.
        // Escaping instead escapes `join()`, and a room whose presence write fails
        // is a room that never starts.
        seen.delete(existing.id);
        remember(await transport.createJsonFile(name, folderId, body), name, record, own);
        return;
      }
      if (own) forgetOwnFile();
      throw error;
    }
  }

  /** What a successful write leaves behind: the id, and the body it now holds. */
  function remember(ref: DriveFileRef, name: string, record: PboardDriveSignalRecord, own: boolean) {
    if (!own) return;
    ownFile = { id: ref.id, name };
    ownRecord = structuredClone(record);
    // We know exactly what the file now holds; no poll needs to fetch it.
    seen.set(ref.id, { modifiedTime: stampOf(ref), at: now(), record: structuredClone(record) });
  }

  return {
    peerId,
    now,
    /**
     * What this session last wrote, without touching Drive. The poll loop reads
     * its own record every tick only to preserve `peers` and `outbox` while it
     * heartbeats, and this session is the only writer of that file — but
     * `readPeer` below stays a faithful read of Drive, because that is what the
     * method promises.
     */
    ownRecord: () => (ownRecord ? structuredClone(ownRecord) : null),
    /**
     * Our own presence record, served from the last listing when it is still
     * fresh, else read from Drive.
     *
     * This is where the recurring cost was: a sidebar and a background worker
     * open the same room, and the one that did not *write* the file fell back to
     * `readOwn()`'s `readPeer(me)` on every tick — one 200-unit media download per
     * tick, ~1.7 per second, for a record whose `modifiedTime` had not moved. The
     * listing that `listPeers` already performs carries that stamp, so an
     * unchanged record costs nothing extra here while a changed one is read
     * immediately. `readPeer` itself stays a faithful read of Drive.
     */
    async readOwnCached(): Promise<PboardDriveSignalRecord | null> {
      if (ownRecord) return structuredClone(ownRecord);
      const folderId = await realtimeFolderId();
      const file = await transport.findFile(fileName(peerId), folderId);
      if (!file) return null;
      const stamp = stampOf(file);
      const cached = seen.get(file.id);
      const at = now();
      if (cached && stamp && cached.modifiedTime === stamp && at - cached.at < rereadMs) {
        return structuredClone(cached.record);
      }
      try {
        const record = JSON.parse(await transport.downloadFile(file.id)) as PboardDriveSignalRecord;
        seen.set(file.id, { modifiedTime: stamp, at, record });
        return record;
      } catch {
        return null;
      }
    },
    async readPeer(peer) {
      const folderId = await realtimeFolderId();
      const file = await transport.findFile(fileName(peer), folderId);
      if (!file) return null;
      // `readPeer` is the *faithful* read: it must not answer from a cache, because
      // a caller asking it is asking what Drive holds now (a file edited or
      // deleted behind our back has to read as it actually is, including as
      // unreadable). The poll loop does not need that fidelity for its own record —
      // it asks `ownRecord()` first, and only falls back here in a context that
      // never wrote the file — so the saving lives at the call site, below, not by
      // making this method lie.
      try {
        return JSON.parse(await transport.downloadFile(file.id)) as PboardDriveSignalRecord;
      } catch {
        return null;
      }
    },
    writeOwn: (record) => writePeer(peerId, record),
    async listPeers() {
      // Ids Drive lists but cannot serve — deleted after the listing was built,
      // still named by the next one. Re-asking for the same dead id on every poll
      // turned a room with stale presence files into a 404 generator, which is
      // what the console looked like. Asking once is enough: Drive's answer about
      // a specific id does not change.
      const folderId = await realtimeFolderId();
      let listed;
      try {
        listed = await transport.listFiles(folderId);
      } catch (error) {
        // A presence folder Drive no longer has (removed since this session
        // resolved its id) is a room nobody is in, not a poll that fails: the
        // caller would drop every peer on an empty roster, which is the same
        // answer, and a thrown error here stops the room from starting at all.
        // Creating the folder is the permission service's job, not the poll's.
        if (!isDriveGone(error)) throw error;
        return {};
      }
      const files = listed.filter((ref) => ref.name.startsWith(prefix));
      // Drive's own write times, compared with each other: the room's freshest
      // rewrite. A presence file untouched while the room's newest moved on by
      // two TTLs belongs to a session that is gone — its `updatedAt` is past the
      // TTL, so the poll ignores the record anyway and a download is waste.
      const newest = files.reduce((latest, file) => Math.max(latest, Date.parse(stampOf(file)) || 0), 0);
      const at = now();
      const result: Record<string, PboardDriveSignalRecord> = {};
      await Promise.all(
        files.map(async (file) => {
          const peer = file.name.slice(prefix.length, file.name.length - ".json".length);
          if (ownFile?.id === file.id && ownRecord) {
            result[peer] = structuredClone(ownRecord);
            return;
          }
          const cached = seen.get(file.id);
          const stamp = stampOf(file);
          if (cached && stamp && cached.modifiedTime === stamp && at - cached.at < rereadMs) {
            result[peer] = structuredClone(cached.record);
            return;
          }
          const age = Date.parse(stamp) || 0, behind = stamp ? newest - age : 0;
          if (stamp && behind > presenceTtlMs * 2) {
            // A file Drive has not rewritten while the room's newest moved two
            // presence TTLs past it cannot hold a live record: the caller drops any
            // record older than the TTL it carries, so the download would buy an
            // answer that is thrown away — 200 units per file per poll, which is how
            // a folder of abandoned files spent the board's quota on ghosts and left
            // nothing for the live peer. Two TTLs is the margin, not one: a
            // collaborator in a background tab is throttled to roughly one wake a
            // minute, and cutting it off at the TTL would drop a sleeping browser out
            // of the room it means to rejoin. Hand back what was last read; when
            // never read, do not buy it at all.
            if (behind > expiredPeerMs && !expiredPeerFiles.has(file.id)) {
              // Agree with that reckoning at its source: the folder is shared by
              // every browser that ever opened the board, so an abandoned file is
              // listed, downloaded-then-ignored, role-checked and offered to on
              // every pass of every reader, forever. Sixty of them turned a
              // two-browser room into a room that could not reach the one browser
              // it was looking for. Deleting is idempotent; a file this account
              // may not delete answers 403 and is remembered as tried; and the
              // browser a file belonged to writes it again on its next heartbeat,
              // because a failed write forgets the id.
              if (expiredPeerFiles.size >= MAX_EXPIRED_PEER_FILES) expiredPeerFiles.clear();
              expiredPeerFiles.add(file.id);
              seen.delete(file.id);
              await transport.deleteFile(file.id).catch(() => undefined);
              return;
            }
            if (cached) result[peer] = structuredClone(cached.record);
            return;
          }
          const gone = gonePeerFiles.get(file.id);
          if (gone && (gone.asks >= GONE_PEER_ASKS || at < gone.retryAt)) {
            // Not served from cache: a file Drive cannot any longer serve is not
            // a live session, and handing back its last record kept a phantom
            // peer in the roster — whose role was then looked up again, against
            // the same unreadable file, on every pass. Forgetting the cache is
            // what retires the peer.
            seen.delete(file.id);
            return;
          }
          try {
            const record = JSON.parse(await transport.downloadFile(file.id)) as PboardDriveSignalRecord;
            seen.set(file.id, { modifiedTime: stamp, at, record });
            result[peer] = structuredClone(record);
          } catch (error) {
            if (isDriveGone(error)) {
              // Bounded: a room whose folder is a graveyard stops growing the list.
              if (gonePeerFiles.size >= MAX_GONE_PEER_FILES) gonePeerFiles.delete(gonePeerFiles.keys().next().value as string);
              const asks = (gone?.asks ?? 0) + 1;
              gonePeerFiles.set(file.id, { asks, retryAt: at + GONE_PEER_RETRY_MS });
              seen.delete(file.id); // retire the peer, starting now
              if (asks >= GONE_PEER_ASKS) {
                // The budget is spent, so remove the file. Remembering it is only
                // ever in-memory, and the folder is shared by every browser that
                // ever opened the board: a room whose folder collected a
                // graveyard of crashed sessions paid for the whole graveyard again
                // on every reload of the board — one hundred and forty 404s in the
                // log before anything else had happened. Drive's own answer is that
                // the file does not exist; deleting it is idempotent, a file this
                // account may not delete answers 403 and is ignored, and the
                // browser a file belonged to writes it again on its next heartbeat
                // because a failed write forgets the id.
                gonePeerFiles.delete(file.id);
                await transport.deleteFile(file.id).catch(() => undefined);
              }
              return;
            }
            // A torn read of a concurrently-written peer file; skip this poll.
            if (cached) result[peer] = structuredClone(cached.record);
          }
        })
      );
      const alive = new Set(files.map(file => file.id));
      for (const id of [...seen.keys()]) if (!alive.has(id)) seen.delete(id);
      if (ownFile && !alive.has(ownFile.id)) forgetOwnFile();
      return result;
    },
    async deleteOwn() {
      const folderId = await realtimeFolderId();
      const name = fileName(peerId);
      const file = ownFile?.name === name ? { id: ownFile.id } : await transport.findFile(name, folderId);
      forgetOwnFile();
      if (file) {
        await transport.deleteFile(file.id);
        seen.delete(file.id);
      }
    }
  };
}
