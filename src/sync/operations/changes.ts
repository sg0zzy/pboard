import type { GoogleAuthProvider } from '../googleAuth';
import type { RxRepository } from '../../storage/rxdbRepository';
import type { ImmutableFile } from './driveStore';
import { defaultDriveQuotaThrottle, driveQuotaError, driveRequestCost, driveRequestSignature, DriveQuotaExceededError, type DriveQuotaThrottle } from '../driveQuota';
import { shareGet } from '../driveSharedRequest';

/** Feed pages applied per round. Each page is 100 quota units, so this bounds a
 * single round's worst case at 10,000 units while still making progress. */
const CHANGE_PAGES_PER_ROUND = 100;
/**
 * A board folder as the account feed last saw it.
 *
 * `revision` moves exactly when this folder's file set changed — a page of the
 * account feed added or removed a file under it, or a full listing came back
 * with a different set — and never otherwise. It exists so one *round* can ask
 * "which of these folders moved since I last synchronized them?" once, instead
 * of every board paying a role read, a listing and a projection to discover
 * that nothing had. It is monotonic within a session, so a caller never
 * mistakes a refresh that changed nothing for progress; `undefined` on a row
 * written by an older build reads as 0 and only costs one extra sync.
 */
type Folder = { boardId: string; files: ImmutableFile[]; needsFull: boolean; refreshedAt: number; revision?: number };
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
    const url = `https://www.googleapis.com/drive/v3/${path}`, cost = driveRequestCost(url, "GET");
    const send = async (refresh: boolean) => {
      const token = await options.auth.getAccessToken(refresh);
      await quota.acquire(cost);
      const response = await options.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      quota.observe(cost, response.headers, driveRequestSignature(url, "GET"));
      return response;
    };
    // Boards are synchronized sequentially, but several synchronize in one
    // round and each asks the feed for the same page at the same cursor.
    const response = await shareGet("GET", url, () => send(false));
    if (response.status === 401) return await page(await shareGet("GET", `${url}|renewed`, () => send(true)));
    return await page(response);
  }
  async function page(response: Response) {
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
  /**
   * Apply the account-wide change feed to the cached folders, if its gates say
   * it is time to ask.
   *
   * This is the whole of what a reconcile *round* needs before it decides which
   * boards to synchronize: the feed's 15-second gate and its `unavailableUntil`
   * window are account-wide, so this costs at most one Drive request per round
   * however many boards the account holds — where the per-board `inventory` it
   * replaces cost one request *per board* per round. Applying a page updates
   * each cached folder's `revision`, which is the fact the round's gate compares
   * against.
   *
   * `proven: false` means the feed could not be read (permission, network, quota)
   * or its cursor was just discarded, and no caller may read "no change" into a
   * folder's unchanged revision.
   */
  async function walkFeed(rx: RxRepository, state: Cache, force: boolean): Promise<{ changed: boolean; proven: boolean }> {
    let changed = false, proven = true;
    if (force || now() - lastPoll > 15000) {
      if (now() < unavailableUntil) return { changed: false, proven: false };
      try {
        if (!state.token) {
          const start = await call('changes/startPageToken');
          if (typeof start.startPageToken !== 'string') throw new Error('Missing Drive changes cursor');
          state.token = start.startPageToken;
        } else {
          // A backlog longer than one round has to resume where it stopped.
          // Both the page cap and a denied page used to abandon the page
          // cursor: the cap threw and the denial rethrew, and in both cases
          // the next round walked the *same* pages again from the stale
          // cursor, 100 quota units a page, never converging — while the
          // failure path additionally marked every board's folder as needing
          // a full listing. An account with a long history therefore paid for
          // its backlog once per round, which is how one context reached
          // 175,525 of Google's 325,000 units per minute and kept being
          // denied. Drive's intermediate `nextPageToken` is a valid
          // resumption point, so the cursor now travels with the progress.
          let token: string | null = state.token;
          for (let pages = 0; token; ) {
            const params = new URLSearchParams({ pageToken: token, spaces: 'drive', pageSize: '1000',
              fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,parents,size,createdTime,trashed))' });
            const data = await call(`changes?${params}`);
            if (!Array.isArray(data.changes)) throw new Error('Invalid Drive change page');
            for (const change of data.changes) {
              const file = change.file;
              const parents = file?.parents;
              for (const [parent, folder] of Object.entries(state.folders)) {
                const had = folder.files.some(existing => existing.id === change.fileId);
                const added = !change.removed && !file?.trashed && parents?.includes(parent) && /^(operations|snapshot|migration|image)-.+\.json$/.test(file.name)
                  ? { id: change.fileId, name: file.name, size: file.size, createdTime: file.createdTime } : null;
                const kept = folder.files.filter(existing => existing.id !== change.fileId);
                // Only a change that moves *this* folder's file set moves its
                // revision: an unrelated file, or a file of another board,
                // leaves it where it was and therefore leaves the board
                // skippable. The feed is the one place that can answer "did
                // this board's Drive contents move since I synchronized it?"
                // without a per-board listing.
                if (had || added) folder.revision = (folder.revision ?? 0) + 1;
                folder.files = kept.concat(added ?? []);
              }
            }
            if (typeof data.nextPageToken === 'string') {
              token = data.nextPageToken;
              state.token = token;
              pages += 1;
              // One round's worth of pages; the rest waits for the next, so a
              // backlog is a bounded cost that shrinks instead of a loop.
              if (pages >= CHANGE_PAGES_PER_ROUND) break;
            } else {
              if (typeof data.newStartPageToken !== 'string') throw new Error('Missing terminal Drive cursor');
              state.token = data.newStartPageToken;
              token = null;
            }
          }
        }
        changed = true; lastPoll = now();
      } catch (error) {
        // Quota exhaustion applies to inventories too. Do not turn one
        // denied feed request into a full listing for every board — and do
        // not lose the pages that were already applied: a cursor that is
        // thrown away on failure charges the backlog again on the retry.
        proven = false;
        if (error instanceof DriveQuotaExceededError) {
          await save(rx, state).catch(() => undefined);
          throw error;
        }
        // Permission/network failures still surface through the fresh board
        // inventory. Never return an old cache as a successful recovery.
        state.token = null; unavailableUntil = now() + 60000;
        for (const folder of Object.values(state.folders)) folder.needsFull = true;
      }
    }
    return { changed, proven };
  }
  /**
   * One pass of the feed alone, for a caller that will decide per board what to
   * open. Resolves the revision of every folder this context has listed, keyed
   * by Drive folder id — the fact a round's gate compares against — or `null`
   * when the answer is not trustworthy.
   *
   * `null` rather than an empty map for the untrustworthy case, so a caller
   * cannot read "no folder moved" into a feed that never spoke: the two
   * situations are different and a single type says so. A folder absent from a
   * non-null map has never been listed here, and is also not provably unchanged.
   */
  async function pollFeed(force = false): Promise<Map<string, number> | null> {
    return await locked(async () => {
      const { rx, state } = await context();
      const { changed, proven } = await walkFeed(rx, state, force);
      if (changed) await save(rx, state);
      if (!proven) return null;
      const revisions = new Map<string, number>();
      for (const [folderId, folder] of Object.entries(state.folders)) if (folder.revision !== undefined) revisions.set(folderId, folder.revision);
      return revisions;
    });
  }
  /** The revision of one board folder as the feed last saw it, or `undefined`
   * when this context has never listed that folder and therefore cannot say. */
  async function revision(folderId: string): Promise<number | undefined> {
    return await locked(async () => (await context()).state.folders[folderId]?.revision);
  }
  return {
    poll: pollFeed,
    revision,
    inventory(boardId: string, folderId: string, full: () => Promise<ImmutableFile[]>, force = false): Promise<ImmutableFile[]> {
      return locked(async () => {
        const { rx, state } = await context();
        // A forced inventory (an explicit per-board sync) keeps its own promise:
        // the user asked for a fresh answer, so the feed is asked past its
        // 15-second window. Reconcile rounds never reach this branch with
        // `force` set — the round's loop always calls `syncOperations(id, false)`
        // — so a round over N boards still costs one feed request, not N.
        const { changed: feedChanged, proven } = await walkFeed(rx, state, force);
        let changed = feedChanged;
        let folder = state.folders[folderId];
        if (!folder || folder.needsFull || force || now() - folder.refreshedAt > 300000 || !proven) {
          const files = await full();
          // A full listing is the independent check of the feed, so it counts as
          // a change of this folder exactly when it disagrees with what the feed
          // (or the previous listing) said the folder holds.
          const previous = folder?.files;
          const same = previous?.length === files.length && previous.every((file, index) => file.id === files[index].id);
          folder = { boardId, files, needsFull: false, refreshedAt: now(), revision: (folder?.revision ?? 0) + (same ? 0 : 1) };
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
