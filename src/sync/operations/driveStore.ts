import { validateSnapshotAsync } from './snapshotTasks';
import { hashBlob, imageToBlob } from '../../storage/blobStore';
import type { BoardImage } from '../../types';
import { parseStrictJson } from '../../collab/security/canonical';
import type { GoogleAuthProvider } from '../googleAuth';
import { canonical, digest, MAX_SEGMENT_BYTES, validateSegment, type Segment } from './protocol';
import { defaultDriveQuotaThrottle, driveQuotaError, driveRequestCost, isDriveQuotaFailure, type DriveQuotaThrottle } from '../driveQuota';
import { shareGet } from '../driveSharedRequest';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export type ImmutableFile = { id: string; name: string; size?: string; createdTime?: string };
export type DriveRole = 'owner' | 'editor' | 'viewer' | 'revoked';
/** Receives a known regular Drive folder ID; never invokes legacy filename merge.
 * Authorization callback must perform the existing fresh Drive ACL check.
 * No file replacement, folder creation, deletion, AppData, or authority service. */
export function createOperationDriveStore(options: {
  auth: GoogleAuthProvider; folderId: string; boardId: string;
  role: () => Promise<DriveRole>; fetcher?: typeof fetch;
  inventory?: (full: () => Promise<ImmutableFile[]>, force: boolean) => Promise<ImmutableFile[]>; quota?: DriveQuotaThrottle;
}) {
  const fetcher = options.fetcher ?? fetch;
  const quota = options.quota ?? defaultDriveQuotaThrottle();
  const assertRole = async (write: boolean, owner = false) => {
    const role = await options.role();
    if (role === 'revoked' || (write && !['owner', 'editor'].includes(role)) || (owner && role !== 'owner'))
      throw new Error('Current Google Drive permission does not allow this action');
  };
  async function call(url: string, init: RequestInit = {}) {
    const send = async (refresh = false) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await options.auth.getAccessToken(refresh)}`);
      const cost = driveRequestCost(url, init.method ?? "GET");
      // Respect projected budget deferrals and real Google quota cooldowns.
      await quota.acquire(cost, init.signal);
      const response = await fetcher(url, { ...init, headers, cache: 'no-store' });
      quota.observe(cost, response.headers);
      return response;
    };
    // Every board's inventory, metadata and segment reads run through here, and
    // one reconcile round asks for the same immutable file from the inventory,
    // the image sweep and the checkpoint read. Concurrent identical reads share
    // one request; the refresh retry keeps its own key so it never awaits itself.
    const key = `${url}|${init.method ?? 'GET'}`;
    const response = await shareGet(init.method, key, () => send());
    if (response.status === 401) return await shareGet(init.method, `${key}|renewed`, () => send(true));
    return response;
  }
  async function errorDetail(response: Response): Promise<string> {
    try {
      const body = await response.json() as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
      const reason = body.error?.errors?.find((entry) => entry.reason)?.reason;
      return [reason, body.error?.status, body.error?.message].filter(Boolean).join(': ');
    } catch {
      // Some intermediary failures return a non-JSON response.
      return '';
    }
  }
  async function required(response: Response): Promise<Response> {
    if (!response.ok) {
      // A quota denial must reach the UI as a quota, not as a storage failure.
      const detail = await errorDetail(response);
      if (isDriveQuotaFailure(detail)) throw driveQuotaError(response.status, detail, quota);
      throw new Error(`Google Drive operation storage failed (${response.status})`);
    }
    return response;
  }
  async function allocateId(): Promise<string> {
    await assertRole(true);
    const response = await required(await call(`${API}/files/generateIds?count=1&space=drive&type=files`));
    const body = await response.json() as { ids?: string[] };
    if (!body.ids?.[0]) throw new Error('Google Drive returned no pre-generated file ID');
    return body.ids[0];
  }
  async function read(fileId: string, maxBytes = MAX_SEGMENT_BYTES): Promise<string> {
    await assertRole(false);
    // Verify membership as well as access; same-named external files are irrelevant.
    const metadata = await (await required(await call(`${API}/files/${encodeURIComponent(fileId)}?fields=id,parents,trashed,size`))).json() as { parents?: string[]; trashed?: boolean; size?: string };
    if (metadata.trashed || !metadata.parents?.includes(options.folderId) || Number(metadata.size ?? 0) > maxBytes)
      throw new Error('Invalid immutable file location or size');
    const response = await required(await call(`${API}/files/${encodeURIComponent(fileId)}?alt=media`));
    if (!response.body) throw new Error('Missing immutable file body');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Immutable file exceeds size limit'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  async function publish(fileId: string, name: string, text: string, ownerOnly = false): Promise<void> {
    await assertRole(true, ownerOnly);
    // fileId AND exact bytes must already be durable locally. A retry is another
    // CREATE with the same ID. 409 requires verification, never overwrite.
    const boundary = `pboard_${crypto.randomUUID()}`;
    const metadata = { id: fileId, name, parents: [options.folderId], mimeType: 'application/json' };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const response = await call(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
    });
    if (!response.ok && response.status !== 409) await required(response);
    const recovered = await read(fileId, Math.max(MAX_SEGMENT_BYTES, new TextEncoder().encode(text).length));
    if (recovered !== text) throw new Error('Immutable Drive upload verification mismatch');
  }
  async function inventory(force = false): Promise<ImmutableFile[]> {
    await assertRole(false);
    return options.inventory ? options.inventory(listInventory, force) : listInventory();
  }
  async function listInventory(): Promise<ImmutableFile[]> {
    const result: ImmutableFile[] = [], parent = options.folderId.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    let pageToken = '';
    do {
      const params = new URLSearchParams({ spaces: 'drive', q: `'${parent}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,size,createdTime)', pageSize: '200' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await (await required(await call(`${API}/files?${params}`))).json() as { files?: ImmutableFile[]; nextPageToken?: string };
      result.push(...(data.files ?? []).filter(file => /^(operations|snapshot|migration|image)-.+\.json$/.test(file.name)));
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);
    return result;
  }
  async function metadata(fileId: string): Promise<{ id: string; name: string; parents?: string[]; ownedByMe?: boolean; owners?: { emailAddress?: string }[];
    capabilities?: { canAddChildren?: boolean }; contentRestrictions?: { readOnly?: boolean; ownerRestricted?: boolean }[] }> {
    const response = await required(await call(`${API}/files/${encodeURIComponent(fileId)}?fields=id,name,parents,ownedByMe,owners(emailAddress),capabilities(canAddChildren),contentRestrictions`));
    return response.json();
  }
  async function folderRole(): Promise<DriveRole> {
    const response = await call(`${API}/files/${encodeURIComponent(options.folderId)}?fields=trashed,ownedByMe,capabilities(canAddChildren)`);
    if ([403, 404].includes(response.status)) {
      // Quota denial stays distinguishable from a revoked role.
      const detail = await errorDetail(response);
      if (isDriveQuotaFailure(detail)) throw driveQuotaError(response.status, detail, quota);
      return 'revoked';
    }
    const value = await (await required(response)).json() as { trashed?: boolean; ownedByMe?: boolean; capabilities?: { canAddChildren?: boolean } };
    if (value.trashed) return 'revoked';
    return value.ownedByMe ? 'owner' : value.capabilities?.canAddChildren ? 'editor' : 'viewer';
  }
  async function protectLegacy(fileId: string): Promise<void> {
    const boardRole = await options.role();
    if (!['owner', 'editor'].includes(boardRole)) throw new Error('Current Google Drive permission cannot protect the legacy checkpoint');
    const file = await metadata(fileId);
    if (!['board.json.gz', 'project.json', `project-${options.boardId}.pboard`].includes(file.name)
      || (file.name === 'project.json' && !file.parents?.includes(options.folderId))) throw new Error('Legacy migration file identity mismatch');
    if (file.contentRestrictions?.some(restriction => restriction.readOnly)) return;
    const response = await call(`${API}/files/${encodeURIComponent(fileId)}?fields=contentRestrictions`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentRestrictions: [
        { readOnly: true, ownerRestricted: boardRole === 'owner' && file.ownedByMe === true, reason: 'Pboard operation protocol: upgrade Pboard before editing this board.' }
      ] })
    }); await required(response);
    if (!(await metadata(fileId)).contentRestrictions?.some(r => r.readOnly)) throw new Error('Legacy write barrier could not be verified');
  }
  return {
    allocateId, inventory, read, metadata, folderRole, protectLegacy,
    async createLegacy(fileId: string, text: string) { await publish(fileId, 'project.json', text); await protectLegacy(fileId); },
    async publishImage(fileId: string, imageId: string, image: BoardImage) {
      if (!/^[a-f0-9]{64}$/.test(imageId) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
        || !image.dataUrl.startsWith(`data:${image.mimeType};base64,`) || (await hashBlob(await imageToBlob(image.dataUrl))) !== imageId) throw new Error('Invalid image asset');
      await publish(fileId, `image-${imageId}.json`, canonical({ format: 'pboard-image', imageId, image }));
    },
    async readImage(fileId: string, imageId: string): Promise<BoardImage> {
      const saved = parseStrictJson(await read(fileId, 28 * 1024 * 1024), 28 * 1024 * 1024) as any;
      const image = saved?.image;
      if (saved?.format !== 'pboard-image' || saved.imageId !== imageId || !image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
        || typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(`data:${image.mimeType};base64,`)
        || !Number.isSafeInteger(image.width) || image.width <= 0 || !Number.isSafeInteger(image.height) || image.height <= 0
        || (await hashBlob(await imageToBlob(image.dataUrl))) !== imageId) throw new Error('Shared image integrity mismatch');
      return image;
    },
    async publishMigration(fileId: string, migration: { protocol: string; boardId: string; snapshotFileId?: string; baselineSegmentIds?: string[]; baselineIntegrity?: string; legacyFileIds: string[] }) {
      if (migration.protocol !== 'pboard-operations-v1' || migration.boardId !== options.boardId) throw new Error('Invalid migration protocol');
      await publish(fileId, `migration-${fileId}.json`, canonical(migration));
    },
    async trash(fileId: string) {
      await assertRole(true, true);
      const file = await metadata(fileId);
      if (!file.parents?.includes(options.folderId) || !/^(operations|snapshot|migration|image)-.+\.json$/.test(file.name)) throw new Error('Only proven operation history in this board may be gardened');
      const response = await call(`${API}/files/${encodeURIComponent(fileId)}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      if (response.status !== 404) await required(response);
    },
    async publishSegment(fileId: string, segment: Segment) {
      validateSegment(segment, options.boardId);
      const text = canonical({ ...segment, integrity: await digest(segment) });
      if (new TextEncoder().encode(text).length > MAX_SEGMENT_BYTES) throw new Error('Operation segment envelope exceeds size limit');
      await publish(fileId, `operations-${segment.segmentId}.json`, text, segment.operations.some(op => op.collection === 'projects' && op.kind === 'delete'));
    },
    async readSegment(fileId: string): Promise<Segment> {
      const saved = parseStrictJson(await read(fileId), MAX_SEGMENT_BYTES) as any;
      const { integrity, ...segment } = saved;
      validateSegment(segment as Segment, options.boardId);
      if (integrity !== await digest(segment)) throw new Error('Operation segment integrity mismatch');
      return segment as Segment;
    },
    async publishSnapshot(fileId: string, snapshot: import('./snapshots').OperationSnapshot) {
      await validateSnapshotAsync(snapshot, options.boardId);
      await publish(fileId, `snapshot-${snapshot.snapshotId}.json`, canonical(snapshot), true);
    }
  };
}
export type OperationDriveStore = ReturnType<typeof createOperationDriveStore>;
