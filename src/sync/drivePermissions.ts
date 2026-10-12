import type { GoogleAuthProvider } from "./googleAuth";
import { DRIVE_TRANSIENT_ATTEMPTS, DRIVE_TRANSIENT_STATUSES, driveRetryDelayMs, isDriveReplayableMethod } from "./driveRetry";
import type { PboardDriveSignalRecord, PboardDriveSignalStore } from "../collab/signaling";
import type { BoardImage } from "../types";

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
  listPermissions(fileId: string): Promise<DrivePermission[]>;
  createPermission(fileId: string, role: PboardCollaboratorRole, email: string): Promise<DrivePermission>;
  updatePermission(fileId: string, permissionId: string, role: PboardCollaboratorRole): Promise<DrivePermission>;
  deletePermission(fileId: string, permissionId: string): Promise<void>;
}

const SHARED_ROOT_NAME = "Pboard";
const PROJECT_FILE_NAME = "project.json";
const REALTIME_FOLDER_NAME = "realtime";
const JSON_MIME = "application/json";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// pboard roles map 1:1 onto Drive permission roles; Drive spells them differently.
const driveRole = (role: PboardCollaboratorRole): "reader" | "writer" => (role === "editor" ? "writer" : "reader");
const escapeDriveQuery = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export function createDrivePermissionTransport(auth: GoogleAuthProvider, fetcher: typeof fetch = fetch): DrivePermissionTransport {
  async function requestError(response: Response): Promise<Error> {
    let detail = "";
    try {
      const body = await response.json() as GoogleDriveErrorResponse;
      const reason = body.error?.errors?.find((entry) => entry.reason)?.reason;
      detail = [reason, body.error?.status, body.error?.message].filter(Boolean).join(": ");
    } catch {
      // Non-JSON intermediary failures.
    }
    if (response.status === 403 && /insufficientScopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(detail)) {
      detail += "; reconnect Google Drive and allow project sharing access";
    }
    return new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  async function authorizedFetch(input: string, init: RequestInit = {}, retry = true, attempt = 0): Promise<Response> {
    const token = await auth.getAccessToken(!retry);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    // Presence, offers and answers change at the same URLs. A cached empty
    // file search or older peer record can prevent two browsers rendezvousing.
    const response = await fetcher(input, { ...init, headers,
      ...(!init.method || init.method === "GET" ? { cache: "no-store" as const } : {}) });
    if (response.status === 401 && retry) return authorizedFetch(input, init, false, attempt);
    // A transient Google-side failure (internalError, rate limit) usually
    // clears on a replay; only one-shot methods are replayed.
    if (!response.ok && DRIVE_TRANSIENT_STATUSES[response.status] && attempt + 1 < DRIVE_TRANSIENT_ATTEMPTS &&
        isDriveReplayableMethod(init.method)) {
      await new Promise<void>((resolve) => { setTimeout(resolve, driveRetryDelayMs(attempt, response.headers.get("Retry-After"))); });
      return authorizedFetch(input, init, retry, attempt + 1);
    }
    if (!response.ok) throw await requestError(response);
    return response;
  }

  async function findFile(name: string, parentId: string): Promise<DriveFileRef | null> {
    const params = new URLSearchParams({
      spaces: "drive",
      q: `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime)",
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
    async listFiles(parentId) {
      const params = new URLSearchParams({
        spaces: "drive",
        q: `'${encodeURIComponent(parentId)}' in parents and trashed = false`,
        fields: "files(id,name,mimeType,modifiedTime)",
        pageSize: "100"
      });
      const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
      const body = await response.json() as { files?: DriveFileRef[] };
      return body.files ?? [];
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
    async listFilesByName(name, mimeType) {
      const params = new URLSearchParams({
        spaces: "drive",
        q: `name = '${escapeDriveQuery(name)}' and mimeType = '${escapeDriveQuery(mimeType)}' and trashed = false`,
        fields: "files(id,name,mimeType,modifiedTime)",
        pageSize: "100"
      });
      const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
      const body = await response.json() as { files?: DriveFileRef[] };
      return body.files ?? [];
    },
    async listPermissions(fileId) {
      const response = await authorizedFetch(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,type,role,emailAddress,displayName)&pageSize=100`
      );
      const body = await response.json() as { permissions?: DrivePermission[] };
      return body.permissions ?? [];
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
};
export interface DriveSharedProjectStore {
  get(projectId: string): Promise<DriveSharedProjectRecord>;
  set(projectId: string, patch: Partial<DriveSharedProjectRecord>): Promise<void>;
  delete(projectId: string): Promise<void>;
}

export interface DrivePermissionServiceOptions {
  transport: DrivePermissionTransport;
  sharedProjects: DriveSharedProjectStore;
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
  /** The caller's role for the shared project; null when not shared or no permission. */
  myRole(projectId: string): Promise<PboardRole | null>;
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
   * Resolve the shared layout, preferring the local cache. A collaborator with no
   * local copy has an empty cache, so fall back to discovery: list the
   * project.json files the account can reach and match by parent folder name.
   */
  async function resolveLayout(projectId: string): Promise<DriveSharedProjectRecord> {
    const cached = await sharedProjects.get(projectId);
    if (cached.folderId && cached.projectFileId) return cached;
    const match = (await discoverSharedProjects()).find((entry) => entry.projectId === projectId);
    if (!match) return { folderId: cached.folderId, projectFileId: cached.projectFileId, realtimeFolderId: cached.realtimeFolderId };
    const folderId = (await transport.getFileParents(match.fileId))[0] ?? null;
    if (folderId) await sharedProjects.set(projectId, { folderId, projectFileId: match.fileId });
    return { folderId, projectFileId: match.fileId, realtimeFolderId: cached.realtimeFolderId };
  }

  async function discoverSharedProjects(): Promise<DiscoveredSharedProject[]> {
    const files = await transport.listFilesByName(PROJECT_FILE_NAME, JSON_MIME);
    const byProject = new Map<string, DiscoveredSharedProject>();
    for (const file of files) {
      const folderId = (await transport.getFileParents(file.id))[0];
      if (!folderId) continue;
      const folder = await transport.getFile(folderId);
      if (folder.mimeType !== FOLDER_MIME) continue;
      // The folder is named after the projectId (see ensureSharedProject).
      const projectId = folder.name;
      const cached = await sharedProjects.get(projectId);
      if (cached.folderId !== folderId || cached.projectFileId !== file.id) {
        await sharedProjects.set(projectId, { folderId, projectFileId: file.id });
      }
      if (!byProject.has(projectId)) byProject.set(projectId, { projectId, name: projectId, fileId: file.id });
    }
    return [...byProject.values()];
  }

  async function ensureSharedProject(projectId: string): Promise<string> {
    const cached = await sharedProjects.get(projectId);
    const rootId = await ensureSharedRoot();
    let folderId = cached.folderId;
    if (!folderId) {
      let folder = await transport.findFile(projectId, rootId);
      if (!folder) folder = await transport.createFolder(projectId, rootId);
      folderId = folder.id;
    }
    let projectFileId = cached.projectFileId;
    if (!projectFileId) {
      const existing = await transport.findFile(PROJECT_FILE_NAME, folderId);
      if (existing) projectFileId = existing.id;
      else projectFileId = (await transport.createJsonFile(PROJECT_FILE_NAME, folderId, await options.readSnapshot(projectId))).id;
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
    if (!mine) return null;
    return mine.role === "writer" ? "editor" : "viewer";
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
    await transport.uploadJsonFile(layout.projectFileId!, await options.readSnapshot(projectId));
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
    myRole,
    listCollaborators,
    invite,
    updateRole,
    removeCollaborator
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
