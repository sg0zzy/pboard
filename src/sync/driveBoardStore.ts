/**
 * Canonical Sync v2 board storage: regular, user-visible Google Drive.
 *
 * Layout: `My Drive/pboard/<boardId>/board.json.gz` plus `attachments/`.
 * One path for every board — a private board simply carries no extra ACLs;
 * sharing changes folder ACLs only and never moves data. No AppData role:
 * discovery is a folder listing, snapshots are gzip JSON files, and
 * conditional publishing (If-Match) reuses drivePublish. All Drive access
 * goes through the injected fetcher so tests run without OAuth.
 *
 * Duplicate resilience: two windows (or the service worker and a page) can
 * each find "no folder yet" and create their own. Every find-or-create is
 * therefore single-flight per folder and, when duplicates are observed,
 * merged rather than trashed: the oldest folder survives, children move
 * into it, same-named files keep the newer copy (the loser stays in Drive
 * trash for 30 days). Trashing an unmerged duplicate would orphan content.
 */
import { getSnapshotMeta, downloadSnapshotBytes, publishSnapshotConditional } from "./drivePublish";
import type { GoogleAuthProvider } from "./googleAuth";
import { defaultDriveQuotaThrottle, driveQuotaError, driveRequestCost, isDriveQuotaFailure, type DriveQuotaThrottle } from "./driveQuota";
import { shareGet } from "./driveSharedRequest";

export const BOARD_ROOT_NAME = "pboard";
export const BOARD_SNAPSHOT_FILENAME = "board.json.gz";
export const ATTACHMENTS_FOLDER_NAME = "attachments";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

export type DriveBoardFile = { id: string; name: string };
type DriveNode = { id: string; name: string; parents?: string[]; mimeType?: string; createdTime?: string; modifiedTime?: string };

export type DriveBoardStore = {
  rootFolder(): Promise<string>;
  /** Find-or-create `pboard/<boardId>`; returns the folder id. */
  boardFolder(boardId: string): Promise<string>;
  /** Fresh, read-only lookup for ownership recovery; never creates or merges folders. */
  existingBoardFolder(boardId: string): Promise<string | null>;
  attachmentsFolder(boardId: string): Promise<string>;
  /** Board ids of every child folder of the root (board discovery). */
  listBoards(): Promise<string[]>;
  /** Snapshot file id, or null when the board has no snapshot yet. */
  snapshotFileId(boardId: string): Promise<string | null>;
  ensureSnapshotFile(boardId: string): Promise<string>;
  meta(boardId: string): Promise<{ etag: string; version: string } | null>;
  download(boardId: string): Promise<Uint8Array | null>;
  publish(boardId: string, knownEtag: string, gzipBytes: Uint8Array): ReturnType<typeof publishSnapshotConditional>;
  listAttachments(boardId: string): Promise<DriveBoardFile[]>;
  findAttachment(boardId: string, name: string): Promise<DriveBoardFile | null>;
  uploadAttachment(boardId: string, name: string, bytes: Uint8Array): Promise<string>;
  /** Replace-or-create one direct child file of the board folder (used by
   * the legacy migration to relocate history archives). */
  uploadBoardFile(boardId: string, name: string, bytes: Uint8Array): Promise<string>;
  downloadFile(fileId: string): Promise<Uint8Array | null>;
  /** Move one file to Drive trash; 404 counts as success (already gone). */
  trashFile(fileId: string): Promise<void>;
  reset(): void;
};

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

export function createDriveBoardStore(options: {
  auth: GoogleAuthProvider;
  fetcher?: typeof fetch;
  quota?: DriveQuotaThrottle;
  rootName?: string;
}): DriveBoardStore {
  const fetchRaw = options.fetcher ?? fetch;
  const quota = options.quota ?? defaultDriveQuotaThrottle();
  const rootName = options.rootName ?? BOARD_ROOT_NAME;
  const token = () => options.auth.getAccessToken();
  const folders = new Map<string, { id: string; at: number }>();
  const snapshots = new Map<string, string | undefined>();
  const pending = new Map<string, Promise<string>>();

  async function sendRaw(url: string, init: RequestInit = {}): Promise<Response> {
    // Board discovery, per-board inventory and the ownership probe can ask for
    // the same folder listing inside one startup tick; concurrent identical
    // reads share the request and its quota charge.
    const bearer = new Headers(init.headers).get("authorization") ?? "";
    return await shareGet(init.method, `${bearer}|${url}`, () => issue(url, init));
  }
  async function issue(url: string, init: RequestInit = {}): Promise<Response> {
    const cost = driveRequestCost(url, init.method ?? "GET");
    // Respect projected budget deferrals and real Google quota cooldowns.
    await quota.acquire(cost, init.signal);
    const response = await fetchRaw(url, {
      ...init,
      ...(!init.method || init.method === "GET" ? { cache: "no-store" as const } : {})
    });
    // Google's reported cost outranks the projection when the header is present.
    quota.observe(cost, response.headers);
    return response;
  }
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (bearer: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${bearer}`);
      return sendRaw(url, { ...init, headers });
    };
    let response = await send(await token());
    // A stale token can survive client-side expiry checks; force-refresh once.
    if (response.status === 401) response = await send(await options.auth.getAccessToken(true));
    return response;
  }
  /** Google's list endpoints need the proven parameter envelope (including
   * `spaces=drive`); hand-built query strings drifted from it once already. */
  const listUrl = (query: string, fields: string) =>
    `${API}/files?${new URLSearchParams({ spaces: "drive", q: query, fields, pageSize: "20" })}`;
  const esc = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  async function failure(response: Response, what: string): Promise<Error> {
    let detail = "";
    try {
      const body = await response.json() as { error?: { status?: string; message?: string } };
      detail = [body.error?.status, body.error?.message].filter(Boolean).join(": ");
    } catch {
      // Non-JSON intermediary failure: status is all we have.
    }
    // Quota denial is quota, not lost access: it must be classified before the
    // scope hint, so a throttled request is never read as a permission failure.
    if (isDriveQuotaFailure(detail)) return driveQuotaError(response.status, detail, quota);
    if (response.status === 403 && /scope/i.test(detail)) detail += "; reconnect Google Drive and allow Drive access";
    return new Error(`Drive board store ${what} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  async function json<T>(response: Response, what: string): Promise<T> {
    if (!response.ok) throw await failure(response, what);
    return await response.json() as T;
  }
  /** Children of `parent` (or the named subset), full node metadata.
   *
   * NOTE: the live API only accepts the `"root"` alias in *queries and
   * writes*; listed `parents` arrays carry the account's real root id. The
   * server query already scopes to the parent, so the client-side check
   * must treat `"root"` as satisfied — comparing against the literal alias
   * here once filtered every root-level folder out and turned every
   * find-or-create into a fresh duplicate. */
  const listNodes = async (parent: string, name?: string): Promise<DriveNode[]> => {
    const query = name === undefined
      ? `'${esc(parent)}' in parents and trashed = false`
      : `name = '${esc(name)}' and '${esc(parent)}' in parents and trashed = false`;
    const nodes: DriveNode[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(listUrl(query, "nextPageToken,files(id,name,parents,mimeType,createdTime,modifiedTime)"));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await json<{ files?: DriveNode[]; nextPageToken?: string }>(await call(url.toString()), "listing");
      nodes.push(...body.files ?? []);
      pageToken = body.nextPageToken;
    } while (pageToken);
    // Exact-match the name client-side (substring `in name` semantics stay
    // irrelevant) and require the parent for non-alias lookups, so a
    // same-named stray file elsewhere can never masquerade as this asset.
    return nodes.filter(node =>
      (name === undefined || node.name === name) &&
      (parent === "root" || (node.parents ?? []).includes(parent)));
  };
  async function create(parent: string, name: string, mimeType: string): Promise<string> {
    const metadata: Record<string, unknown> = { name, parents: [parent] };
    if (mimeType) metadata.mimeType = mimeType;
    // Plain JSON metadata POST — the pattern the legacy sharing code has
    // used against the live API throughout.
    const created = await call(`${API}/files?fields=id`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata)
    });
    const id = (await json<{ id: string }>(created, "creation")).id;
    if (!id) throw new Error("Drive board store creation returned no id");
    return id;
  }
  async function trashFile(fileId: string): Promise<void> {
    const response = await call(`${API}/files/${encodeURIComponent(fileId)}?fields=id`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true })
    });
    if (!response.ok && response.status !== 404) throw await failure(response, "trashing");
  }
  async function moveNode(node: DriveNode, targetParent: string): Promise<void> {
    const params = new URLSearchParams({
      fields: "id", supportsAllItems: "true", addParents: targetParent, removeParents: (node.parents ?? []).join(",")
    });
    const response = await call(`${API}/files/${encodeURIComponent(node.id)}?${params}`, { method: "PATCH", body: "{}" });
    if (!response.ok && response.status !== 404) throw await failure(response, "moving");
  }
  /** Merge one duplicate folder's children into the canonical folder, then
   * trash the empty duplicate. Same-name files: newer modifiedTime wins and
   * the loser goes to trash (30-day recovery); folder/file collisions and
   * same-name folder conflicts are preserved by renaming aside. */
  async function mergeInto(canonicalId: string, doomedId: string, depth = 0): Promise<void> {
    const canonicalChildren = await listNodes(canonicalId), incomingChildren = await listNodes(doomedId);
    const operationTree = [...canonicalChildren, ...incomingChildren].some(node => /^(operations|snapshot|migration)-/.test(node.name));
    const byName = new Map(canonicalChildren.map(node => [node.name, node] as const));
    for (const child of incomingChildren) {
      const twin = byName.get(child.name);
      const isFolder = (node: DriveNode) => node.mimeType === FOLDER_MIME;
      if (!twin) {
        await moveNode(child, canonicalId);
        byName.set(child.name, child);
      } else if (isFolder(child) && isFolder(twin)) {
        if (depth < 3) await mergeInto(twin.id, child.id, depth + 1);
        else await moveNode(child, canonicalId);
      } else if (!isFolder(child) && !isFolder(twin)) {
        // Operation protocol files are identified by Drive ID, never filename.
        // Preserve every immutable candidate, including concurrent snapshots.
        if (operationTree || /^(operations|snapshot|migration|asset|image)-/.test(child.name)) { await moveNode(child, canonicalId); continue; }
        if ((child.modifiedTime ?? "").localeCompare(twin.modifiedTime ?? "") > 0) {
          await trashFile(twin.id);
          await moveNode(child, canonicalId);
          byName.set(child.name, child);
        } else await trashFile(child.id);
      } else {
        // Type collision keeps both: the intruder is renamed aside first.
        const renamed = await call(`${API}/files/${encodeURIComponent(child.id)}?fields=id`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `${child.name}-merged` })
        });
        if (renamed.ok) await moveNode(child, canonicalId);
      }
    }
    await trashFile(doomedId);
  }
  /** Cached folder ids age out: another window can merge this instance's
   * folder away at any time, and an id cached forever would keep creating
   * children inside the doomed (trashed) copy — where Drive hides them
   * instead of erroring. Revalidation is one list per folder per window. */
  const FOLDER_CACHE_MS = 60_000;
  /** Single-flight find-or-create for one folder under `parent`. */
  async function resolveFolder(parent: string, name: string): Promise<string> {
    const key = `${parent}/${name}`;
    const cached = folders.get(key);
    if (cached && Date.now() - cached.at < FOLDER_CACHE_MS) return cached.id;
    const running = pending.get(key);
    if (running) return await running;
    const run = (async (): Promise<string> => {
      let nodes = await listNodes(parent, name);
      if (!nodes.length) {
        try { await create(parent, name, FOLDER_MIME); } catch { /* raced creation is fine */ }
        // Re-list even after a successful create: a second window may have
        // created its own copy between our listing and our creation.
        nodes = await listNodes(parent, name);
        if (!nodes.length) throw new Error(`Drive folder creation failed for ${name}`);
      }
      if (nodes.length > 1) {
        // Oldest survives; every duplicate merges into it (never a plain
        // trash: trashing an unmerged folder orphans its children).
        nodes = [...nodes].sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
        const canonical = nodes[0];
        for (const extra of nodes.slice(1)) await mergeInto(canonical.id, extra.id);
        folders.clear();
        snapshots.clear();
        folders.set(key, { id: canonical.id, at: Date.now() });
        return canonical.id;
      }
      folders.set(key, { id: nodes[0].id, at: Date.now() });
      return nodes[0].id;
    })();
    pending.set(key, run);
    try {
      return await run;
    } finally {
      pending.delete(key);
    }
  }
  async function rootFolder(): Promise<string> {
    return await resolveFolder("root", rootName);
  }
  async function boardFolder(boardId: string): Promise<string> {
    return await resolveFolder(await rootFolder(), sanitize(boardId));
  }
  async function existingBoardFolder(boardId: string): Promise<string | null> {
    const roots = (await listNodes("root", rootName)).filter(node => node.mimeType === FOLDER_MIME);
    const candidates: DriveNode[] = [];
    for (const root of roots) {
      candidates.push(...(await listNodes(root.id, sanitize(boardId))).filter(node => node.mimeType === FOLDER_MIME));
    }
    if (candidates.length > 1) throw new Error("Multiple Drive board folders found; authority recovery requires an unambiguous board folder");
    if (!candidates.length) return null;
    const snapshots = (await listNodes(candidates[0].id, BOARD_SNAPSHOT_FILENAME)).filter(node => node.mimeType !== FOLDER_MIME);
    if (snapshots.length > 1) throw new Error("Multiple Drive board snapshots found; authority recovery requires an unambiguous snapshot");
    return snapshots.length === 1 ? candidates[0].id : null;
  }
  async function attachmentsFolder(boardId: string): Promise<string> {
    return await resolveFolder(await boardFolder(boardId), ATTACHMENTS_FOLDER_NAME);
  }
  async function listBoards(): Promise<string[]> {
    const nodes = await listNodes(await rootFolder());
    return nodes.filter(node => node.mimeType === FOLDER_MIME).map(node => node.name);
  }
  /** Snapshot file id; a vanished (e.g. merged-away) cached id is evicted
   * and re-resolved instead of being published into. */
  async function snapshotId(boardId: string): Promise<string | null> {
    const key = sanitize(boardId);
    const cached = snapshots.get(key);
    if (cached) {
      const probe = await call(`${API}/files/${encodeURIComponent(cached)}?fields=id`, { method: "GET" });
      if (probe.ok) return cached;
      snapshots.delete(key);
    }
    const found = (await listNodes(await boardFolder(boardId), BOARD_SNAPSHOT_FILENAME))[0]?.id ?? null;
    snapshots.set(key, found ?? undefined);
    return found;
  }
  async function ensureSnapshotFile(boardId: string): Promise<string> {
    const existing = await snapshotId(boardId);
    if (existing) return existing;
    const key = sanitize(boardId);
    try {
      const id = await create(await boardFolder(boardId), BOARD_SNAPSHOT_FILENAME, "");
      snapshots.set(key, id);
      return id;
    } catch {
      const raced = (await listNodes(await boardFolder(boardId), BOARD_SNAPSHOT_FILENAME))[0]?.id;
      if (!raced) throw new Error("Drive snapshot creation failed");
      snapshots.set(key, raced);
      return raced;
    }
  }
  async function meta(boardId: string) {
    const id = await snapshotId(boardId);
    if (!id) return null;
    return getSnapshotMeta(fetcher(), id, await token());
  }
  const fetcher = () => ((input: string, init?: Record<string, unknown>) => sendRaw(input, init as RequestInit)) as Parameters<typeof getSnapshotMeta>[0];
  async function download(boardId: string) {
    const id = await snapshotId(boardId);
    if (!id) return null;
    return downloadSnapshotBytes(fetcher(), id, await token());
  }
  async function publish(boardId: string, knownEtag: string, gzipBytes: Uint8Array) {
    const id = await snapshotId(boardId);
    if (!id) return { status: "missing" as const };
    return publishSnapshotConditional(fetcher(), id, await token(), knownEtag, gzipBytes);
  }
  async function listAttachments(boardId: string) {
    const parent = await attachmentsFolder(boardId);
    const nodes = await listNodes(parent);
    return nodes.filter(node => node.mimeType !== FOLDER_MIME).map(node => ({ id: node.id, name: node.name }));
  }
  async function findAttachment(boardId: string, name: string) {
    return (await listAttachments(boardId)).find(file => file.name === name) ?? null;
  }
  async function uploadBoardChild(parent: string, name: string, bytes: Uint8Array): Promise<string> {
    const replaced = (await listNodes(parent, name))[0]?.id;
    if (replaced) {
      const response = await call(`${UPLOAD_API}/${encodeURIComponent(replaced)}?uploadType=media&fields=id`, {
        method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: bytes.slice().buffer as ArrayBuffer
      });
      if (!response.ok) throw await failure(response, "file replace");
      return replaced;
    }
    const id = await create(parent, name, "");
    const response = await call(`${UPLOAD_API}/${encodeURIComponent(id)}?uploadType=media&fields=id`, {
      method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: bytes.slice().buffer as ArrayBuffer
    });
    if (!response.ok) { await trashFile(id); throw new Error(`Drive file upload failed (${response.status})`); }
    return id;
  }
  async function uploadAttachment(boardId: string, name: string, bytes: Uint8Array): Promise<string> {
    return await uploadBoardChild(await attachmentsFolder(boardId), name, bytes);
  }
  async function uploadBoardFile(boardId: string, name: string, bytes: Uint8Array): Promise<string> {
    return await uploadBoardChild(await boardFolder(boardId), name, bytes);
  }
  async function downloadFile(fileId: string) {
    return downloadSnapshotBytes(fetcher(), fileId, await token());
  }
  return {
    rootFolder, boardFolder, existingBoardFolder, attachmentsFolder, listBoards,
    snapshotFileId: snapshotId, ensureSnapshotFile,
    meta, download, publish, listAttachments, findAttachment, uploadAttachment, uploadBoardFile, downloadFile, trashFile,
    reset() { folders.clear(); snapshots.clear(); }
  };
}
