import type { GoogleAuthProvider } from "./googleAuth";
import { DRIVE_TRANSIENT_ATTEMPTS, DRIVE_TRANSIENT_STATUSES, driveBoundedRetryDelayMs, driveRetryDelayMs, isDriveReplayableMethod } from "./driveRetry";
import { defaultDriveQuotaThrottle, driveQuotaError, driveRequestCost, isDriveQuotaFailure, type DriveQuotaThrottle } from "./driveQuota";
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

export function createDrivePermissionTransport(auth: GoogleAuthProvider, fetcher: typeof fetch = fetch, quota: DriveQuotaThrottle = defaultDriveQuotaThrottle()): DrivePermissionTransport {
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
    return new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  async function authorizedFetch(input: string, init: RequestInit = {}, retry = true, attempt = 0, spentMs = 0): Promise<Response> {
    const token = await auth.getAccessToken(!retry);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const cost = driveRequestCost(input);
    // Defer projected overshoots; a real Google quota denial blocks requests
    // through the context's shared cooldown before they reach the network.
    await quota.acquire(cost, init.signal);
    // Presence, offers and answers change at the same URLs. A cached empty
    // file search or older peer record can prevent two browsers rendezvousing.
    const response = await fetcher(input, { ...init, headers,
      ...(!init.method || init.method === "GET" ? { cache: "no-store" as const } : {}) });
    quota.observe(cost, response.headers);
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
   * A listing request is priced by the page size it asks for, so the funnels ask
   * for a small page and follow the continuation token. `nextPageToken` must be in
   * the projection or the loop cannot see that more results exist.
   */
  const LIST_PAGE_SIZE = "20";
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
      // People API profile fields require separate authorization.
      const response = await authorizedFetch(`${DRIVE_API}/about?fields=user(emailAddress,displayName)`);
      const body = (await response.json()) as { user?: { emailAddress?: string; displayName?: string } };
      const email = body.user?.emailAddress;
      if (!email) return null;
      return { email, name: body.user?.displayName };
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
      const params = new URLSearchParams({ fields: "nextPageToken,permissions(id,type,role,emailAddress,displayName)", pageSize: LIST_PAGE_SIZE });
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
  realtimeFolderId(projectId: string): Promise<string>;
  /**
   * Shared projects this account can access. Found by listing every project.json
   * the account has a Drive permission on (Drive returns only reachable files) and
   * grouping by the parent folder name, which is the projectId.
   */
  discoverSharedProjects(): Promise<DiscoveredSharedProject[]>;
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

  async function discoverSharedProjects(): Promise<DiscoveredSharedProject[]> {
    const now = Date.now();
    if (discovered && now - discovered.at < DISCOVERY_TTL_MS) {
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
    let realtimeFolderId = cached.realtimeFolderId;
    if (!realtimeFolderId) {
      let realtime = await transport.findFile(REALTIME_FOLDER_NAME, folderId);
      if (!realtime) realtime = await transport.createFolder(REALTIME_FOLDER_NAME, folderId);
      realtimeFolderId = realtime.id;
    }
    await sharedProjects.set(projectId, { folderId, projectFileId, realtimeFolderId });
    return folderId;
  }

  async function ensureRealtimeFolder(projectId: string): Promise<string> {
    const cached = await sharedProjects.get(projectId);
    if (cached.realtimeFolderId) return cached.realtimeFolderId;
    const layout = await resolveLayout(projectId);
    if (!layout.folderId) throw new Error("Project is not shared");
    let realtime = await transport.findFile(REALTIME_FOLDER_NAME, layout.folderId);
    if (!realtime) realtime = await transport.createFolder(REALTIME_FOLDER_NAME, layout.folderId);
    await sharedProjects.set(projectId, { realtimeFolderId: realtime.id });
    return realtime.id;
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
  /** Resolve (and, if needed, create) the realtime folder id for the project. */
  realtimeFolderId: () => Promise<string>;
  now?: () => number;
}): PboardDriveSignalStore {
  const { transport, sharedProjects, projectId, peerId, topic, realtimeFolderId } = options;
  const now = options.now ?? (() => Date.now());
  const prefix = `sig-${topic}-`;
  const fileName = (id: string) => `${prefix}${id}.json`;

  async function writePeer(peer: string, record: PboardDriveSignalRecord): Promise<void> {
    const folderId = await realtimeFolderId();
    const name = fileName(peer);
    const body = JSON.stringify(record);
    const existing = await transport.findFile(name, folderId);
    if (existing) await transport.uploadJsonFile(existing.id, body);
    else await transport.createJsonFile(name, folderId, body);
  }

  return {
    peerId,
    now,
    async readPeer(peer) {
      const folderId = await realtimeFolderId();
      const file = await transport.findFile(fileName(peer), folderId);
      if (!file) return null;
      try {
        return JSON.parse(await transport.downloadFile(file.id)) as PboardDriveSignalRecord;
      } catch {
        return null;
      }
    },
    writeOwn: (record) => writePeer(peerId, record),
    async listPeers() {
      const folderId = await realtimeFolderId();
      const files = (await transport.listFiles(folderId)).filter((ref) => ref.name.startsWith(prefix));
      const result: Record<string, PboardDriveSignalRecord> = {};
      await Promise.all(
        files.map(async (file) => {
          const peer = file.name.slice(prefix.length, file.name.length - ".json".length);
          try {
            result[peer] = JSON.parse(await transport.downloadFile(file.id)) as PboardDriveSignalRecord;
          } catch {
            // A torn read of a concurrently-written peer file; skip this poll.
          }
        })
      );
      return result;
    },
    async deleteOwn() {
      const folderId = await realtimeFolderId();
      const file = await transport.findFile(fileName(peerId), folderId);
      if (file) await transport.deleteFile(file.id);
    }
  };
}
