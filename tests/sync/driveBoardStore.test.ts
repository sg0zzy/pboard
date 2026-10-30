import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createDriveBoardStore } from '../../src/sync/driveBoardStore';
import { DriveStub, REAL_ROOT_ID } from './driveStub';
const auth = { getAccessToken: async () => 'token', getConnectionState: async (): Promise<'connected'> => 'connected', connect: async () => {}, disconnect: async () => {}, isConfigured: () => true };
const store = (stub: DriveStub) => createDriveBoardStore({ auth, fetcher: stub.fetch as unknown as typeof fetch });
const bytes = (text: string) => new TextEncoder().encode(text);

describe('driveBoardStore', () => {
  it('looks up recovery folders without creating data, and requires an existing snapshot', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    expect(await boards.existingBoardFolder('board-r')).toBeNull();
    expect(stub.files).toHaveLength(0);
    const root = stub.addFolder('pboard', 'root');
    const folder = stub.addFolder('board-r', root.id);
    expect(await boards.existingBoardFolder('board-r')).toBeNull();
    const snapshot = stub.addFile('board.json.gz', folder.id, 'existing snapshot');
    const before = structuredClone(stub.files);
    expect(await boards.existingBoardFolder('board-r')).toBe(folder.id);
    expect(stub.files).toEqual(before);
    // Recovery bypasses the ordinary folder/snapshot cache.
    snapshot.trashed = true;
    expect(await boards.existingBoardFolder('board-r')).toBeNull();
  });

  it('refuses ambiguous recovery folders without merging or trashing data', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    for (let i = 0; i < 2; i++) {
      const root = stub.addFolder('pboard', 'root');
      const board = stub.addFolder('board-r', root.id);
      stub.addFile('board.json.gz', board.id, `snapshot-${i}`);
    }
    const before = structuredClone(stub.files);
    await expect(boards.existingBoardFolder('board-r')).rejects.toThrow(/Multiple Drive board folders/);
    expect(stub.files).toEqual(before);
  });

  it('refuses duplicate snapshots without changing either copy', async () => {
    const stub = new DriveStub();
    const root = stub.addFolder('pboard', 'root');
    const folder = stub.addFolder('board-r', root.id);
    stub.addFile('board.json.gz', folder.id, 'one');
    stub.addFile('board.json.gz', folder.id, 'two');
    const before = structuredClone(stub.files);
    await expect(store(stub).existingBoardFolder('board-r')).rejects.toThrow(/Multiple Drive board snapshots/);
    expect(stub.files).toEqual(before);
  });

  it('checks subsequent listing pages before deciding a recovery folder is unique', async () => {
    const stub = new DriveStub();
    const root = stub.addFolder('pboard', 'root');
    const one = stub.addFolder('board-r', root.id);
    const two = stub.addFolder('board-r', root.id);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get('q')?.includes("name = 'board-r'")) {
        return new Response(JSON.stringify(url.searchParams.has('pageToken')
          ? { files: [two] } : { files: [one], nextPageToken: 'next' }));
      }
      return stub.fetch(String(input), init);
    });
    const boards = createDriveBoardStore({ auth, fetcher });
    await expect(boards.existingBoardFolder('board-r')).rejects.toThrow(/Multiple Drive board folders/);
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('pageToken=next'))).toBe(true);
  });

  it('creates the pboard root and per-board folder exactly once', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    const first = await boards.boardFolder('board-1');
    const again = await boards.boardFolder('board-1');
    expect(first).toBe(again);
    const root = stub.files.find(f => f.name === 'pboard' && f.mimeType === 'application/vnd.google-apps.folder' && f.parents.includes(REAL_ROOT_ID));
    expect(root).toBeTruthy();
    const folders = stub.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    expect(folders.filter(f => f.name === 'board-1')).toHaveLength(1);
    expect(folders.find(f => f.name === 'board-1')!.parents).toEqual([root!.id]);
  });

  it('lists boards by folder name under the unified root', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    await boards.boardFolder('board-a');
    await boards.boardFolder('board-b');
    expect(await boards.listBoards()).toEqual(['board-a', 'board-b']);
  });

  it('publishes the canonical snapshot with If-Match and reports conflicts', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    expect(await boards.meta('board-x')).toBeNull();
    const id = await boards.ensureSnapshotFile('board-x');
    expect(stub.find('board.json.gz')!.id).toBe(id);
    expect(await boards.meta('board-x')).toMatchObject({ etag: '1' });
    const first = await boards.publish('board-x', '1', bytes('snapshot-one'));
    expect(first.status).toBe('published');
    const stale = await boards.publish('board-x', '1', bytes('snapshot-loser'));
    expect(stale.status).toBe('conflict');
    expect(await boards.download('board-x')).toEqual(bytes('snapshot-one'));
  });

  it('stores attachments as files under the board folder and replaces by name', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    const id = await boards.uploadAttachment('board-y', 'image-1', bytes('data-one'));
    expect(stub.find('attachments')).toBeTruthy();
    expect(stub.find('image-1')!.id).toBe(id);
    const replaced = await boards.uploadAttachment('board-y', 'image-1', bytes('data-two'));
    expect(replaced).toBe(id);
    expect(stub.files.filter(f => f.name === 'image-1' && !f.trashed)).toHaveLength(1);
    expect(await boards.downloadFile(id)).toEqual(bytes('data-two'));
    expect((await boards.findAttachment('board-y', 'image-1'))?.id).toBe(id);
  });

  it('trashing is idempotent for trashed and missing files', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    const id = await boards.ensureSnapshotFile('board-z');
    await boards.trashFile(id);
    await expect(boards.trashFile(id)).resolves.toBeUndefined();
    await expect(boards.trashFile('missing-id')).resolves.toBeUndefined();
  });

  it('downloads snapshot bytes from the v3 host (upload host answers 405)', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    await boards.ensureSnapshotFile('board-h');
    await boards.publish('board-h', '', bytes('payload'));
    expect(await boards.download('board-h')).toEqual(bytes('payload'));
    const media = stub.requests.filter(u => u.includes('alt=media'));
    expect(media.length).toBeGreaterThan(0);
    expect(media.every(u => !u.includes('/upload/'))).toBe(true);
  });

  it('merges duplicate root trees by content instead of trashing them', async () => {
    const stub = new DriveStub();
    // Two startup windows each created their own tree.
    const root1 = stub.addFolder('pboard', 'root');
    const b1a = stub.addFolder('b1', root1.id);
    const snapA = stub.addFile('board.json.gz', b1a.id, 'older-content');
    const root2 = stub.addFolder('pboard', 'root');
    const b1b = stub.addFolder('b1', root2.id);
    const snapB = stub.addFile('board.json.gz', b1b.id, 'newer-content');
    const b2folder = stub.addFolder('b2', root2.id);
    const boards = store(stub);
    const canonical = await boards.boardFolder('b1');
    expect(canonical).toBe(b1a.id); // oldest survives
    expect(root2.trashed).toBe(true);
    expect(b1b.trashed).toBe(true);
    // The board folder only present in the doomed root moved over.
    expect(stub.find('b2', root1.id)).toBeTruthy();
    expect(stub.files.find(f => f.id === b2folder.id)!.parents).toEqual([root1.id]);
    // Same-name snapshot: newer content won and physically lives in the survivor.
    const survivor = stub.files.find(f => f.id === snapB.id)!;
    expect(survivor.parents).toEqual([b1a.id]);
    expect(stub.files.find(f => f.id === snapA.id)!.trashed).toBe(true);
    expect(await boards.download('b1')).toEqual(bytes('newer-content'));
  });

  it('concurrent find-or-create resolves to one folder', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    const ids = await Promise.all(Array.from({ length: 10 }, () => boards.boardFolder('racy')));
    expect(new Set(ids).size).toBe(1);
    expect(stub.files.filter(f => f.name === 'racy' && !f.trashed)).toHaveLength(1);
  });

  it('evicts a cached snapshot id once the file vanished underneath', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    await boards.ensureSnapshotFile('board-e');
    await boards.publish('board-e', '', bytes('gone'));
    // Another device merged our snapshot away; a replacement exists.
    const folder = stub.find('board-e')!;
    stub.files.find(f => f.name === 'board.json.gz' && f.parents.includes(folder.id))!.trashed = true;
    stub.addFile('board.json.gz', folder.id, 'replacement');
    expect(await boards.download('board-e')).toEqual(bytes('replacement'));
  });

  it('adopts a rival copy created by another window mid-operation', async () => {
    const stub = new DriveStub();
    let planted = false;
    stub.onFetch = (url) => {
      // A second window's creation lands between our listing and our own
      // create response; the post-create re-list must find and merge it.
      if (planted || !url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id')) return;
      planted = true;
      stub.addFolder('pboard', 'root');
    };
    const boards = store(stub);
    const folder = await boards.boardFolder('b1');
    const survivors = stub.files.filter(f => f.name === 'pboard' && !f.trashed);
    expect(survivors).toHaveLength(1);
    const board = stub.files.find(f => f.id === folder)!;
    expect(board.parents).toEqual([survivors[0].id]);
  });

  it('revalidates a cached root whose copy was merged away elsewhere', async () => {
    vi.useFakeTimers();
    try {
      const stub = new DriveStub();
      const boards = store(stub);
      const rootA = await boards.rootFolder();
      // Another instance merged the trees elsewhere: our cached root lost.
      const rootB = stub.addFolder('pboard', 'root');
      stub.files.find(f => f.id === rootA)!.trashed = true;
      vi.advanceTimersByTime(61_000);
      const folder = await boards.boardFolder('board-z');
      expect(stub.files.find(f => f.id === folder)!.parents).toEqual([rootB.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the root across instances though listings carry the real root id, not the alias', async () => {
    const stub = new DriveStub();
    const boards = store(stub);
    await boards.boardFolder('b1');
    const roots = stub.files.filter(f => f.name === 'pboard' && !f.trashed);
    expect(roots).toHaveLength(1);
    expect(roots[0].parents).toEqual([REAL_ROOT_ID]);
    // A cold second instance must find the folder again: listings never
    // echo the "root" alias back, and matching the literal once created a
    // brand-new pboard directory on every single attempt.
    await store(stub).boardFolder('b2');
    await store(stub).rootFolder();
    expect(stub.files.filter(f => f.name === 'pboard' && !f.trashed)).toHaveLength(1);
  });
});
