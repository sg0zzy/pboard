import type { GoogleAuthProvider } from '../googleAuth';
import type { RxRepository } from '../../storage/rxdbRepository';
import type { ImmutableFile } from './driveStore';
import { defaultDriveQuotaThrottle, driveQuotaError, driveRequestCost, DriveQuotaExceededError, type DriveQuotaThrottle } from '../driveQuota';

type Folder = { boardId: string; files: ImmutableFile[]; needsFull: boolean; refreshedAt: number };
type Cache = { id: string; kind: 'drive-change-cache'; boardId: string; account: string; token: string | null; folders: Record<string, Folder> };
/** The account-wide Changes cursor and a durable inbox of file IDs commit
 * together. A crash before operation download cannot skip an acknowledged change.
 * Full inventories recover expired cursors and independently verify the feed. */
export function createDriveChanges(options: {
  auth: GoogleAuthProvider; fetcher: typeof fetch; getAccountId: () => Promise<string | null>;
  getRepository: () => Promise<RxRepository | null>; now?: () => number; quota?: DriveQuotaThrottle;
}) {
  const now = options.now ?? Date.now;
  const quota = options.quota ?? defaultDriveQuotaThrottle();
  let queue: Promise<unknown> = Promise.resolve(), cache: Cache | undefined, lastPoll = -Infinity, unavailableUntil = 0;
  function locked<T>(work: () => Promise<T>): Promise<T> { const result = queue.then(work); queue = result.catch(() => undefined); return result; }
  async function call(path: string) {
    const url = `https://www.googleapis.com/drive/v3/${path}`, cost = driveRequestCost(url);
    const send = async (refresh: boolean) => {
      const token = await options.auth.getAccessToken(refresh);
      await quota.acquire(cost);
      const response = await options.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      quota.observe(cost, response.headers);
      return response;
    };
    let response = await send(false); if (response.status === 401) response = await send(true);
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = [body.error?.errors?.[0]?.reason, body.error?.status, body.error?.message].filter(Boolean).join(': ');
      } catch { /* Non-JSON intermediary response. */ }
      throw driveQuotaError(response.status, detail, quota);
    }
    return response.json();
  }
  async function context() {
    const account = await options.getAccountId(), rx = await options.getRepository();
    if (!account || !rx) throw new Error('Connect Google Drive and local storage before synchronization');
    if (cache?.account !== account) {
      cache = await rx.journal.read<Cache | undefined>('operationCheckpoints', store => store.get(`drive-changes:${account}`));
      cache ??= { id: `drive-changes:${account}`, kind: 'drive-change-cache', boardId: `_account-${account}`, account, token: null, folders: {} };
      lastPoll = -Infinity; unavailableUntil = 0;
    }
    return { account, rx, state: cache };
  }
  async function save(rx: RxRepository, state: Cache) {
    if (await options.getAccountId() !== state.account) { cache = undefined; throw new Error('Google account changed during Drive discovery'); }
    await rx.journal.operationTransaction<void>(state.boardId, ['operationCheckpoints'], (tx, result) => {
      tx.objectStore('operationCheckpoints').put(state); result(undefined);
    });
  }
  return {
    inventory(boardId: string, folderId: string, full: () => Promise<ImmutableFile[]>, force = false): Promise<ImmutableFile[]> {
      return locked(async () => {
        const { rx, state } = await context();
        let changed = false;
        if ((force || now() - lastPoll > 15000) && now() >= unavailableUntil) {
          try {
            if (!state.token) {
              const start = await call('changes/startPageToken');
              if (typeof start.startPageToken !== 'string') throw new Error('Missing Drive changes cursor');
              state.token = start.startPageToken;
            } else {
              let token: string | undefined = state.token, pages = 0;
              while (token) {
                if (++pages > 100) throw new Error('Drive change backlog requires an inventory');
                const params = new URLSearchParams({ pageToken: token, spaces: 'drive', pageSize: '1000',
                  fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,parents,size,createdTime,trashed))' });
                const data = await call(`changes?${params}`);
                if (!Array.isArray(data.changes)) throw new Error('Invalid Drive change page');
                for (const change of data.changes) {
                  const file = change.file;
                  for (const [parent, folder] of Object.entries(state.folders)) {
                    folder.files = folder.files.filter(existing => existing.id !== change.fileId);
                    if (!change.removed && !file?.trashed && file?.parents?.includes(parent) && /^(operations|snapshot|migration|image)-.+\.json$/.test(file.name))
                      folder.files.push({ id: change.fileId, name: file.name, size: file.size, createdTime: file.createdTime });
                  }
                }
                if (data.nextPageToken) token = data.nextPageToken;
                else { if (typeof data.newStartPageToken !== 'string') throw new Error('Missing terminal Drive cursor'); state.token = data.newStartPageToken; token = undefined; }
              }
            }
            changed = true; lastPoll = now();
          } catch (error) {
            // Quota exhaustion applies to inventories too. Do not turn one
            // denied feed request into a full listing for every board.
            if (error instanceof DriveQuotaExceededError) throw error;
            // Permission/network failures still surface through the fresh board
            // inventory. Never return an old cache as a successful recovery.
            state.token = null; unavailableUntil = now() + 60000;
            for (const folder of Object.values(state.folders)) folder.needsFull = true;
          }
        }
        let folder = state.folders[folderId];
        if (!folder || folder.needsFull || force || now() - folder.refreshedAt > 300000 || now() < unavailableUntil) {
          folder = { boardId, files: await full(), needsFull: false, refreshedAt: now() };
          state.folders[folderId] = folder; changed = true;
        }
        if (changed) await save(rx, state);
        return structuredClone(folder.files);
      });
    },
    forgetBoard(boardId: string): Promise<void> {
      return locked(async () => { const { rx, state } = await context(); for (const [id, folder] of Object.entries(state.folders)) if (folder.boardId === boardId) delete state.folders[id]; await save(rx, state); });
    }
  };
}
