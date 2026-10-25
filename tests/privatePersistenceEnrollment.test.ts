import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createDriveRuntime } from '../src/sync/runtime';
import { createRxRepository, type RxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore, hashBlob } from '../src/storage/blobStore';
import { MemoryStorage } from './recovery/harness';

const repositories: RxRepository[] = [];
afterEach(async () => { for (const rx of repositories.splice(0)) await rx.db.close(); });

const harness = (storageOverrides: Record<string, unknown> = {}) => {
  const storage = new MemoryStorage();
  Object.assign(storage.data, storageOverrides);
  const state = { email: 'a@example.test', connected: true };
  const uploads: string[] = [];
  return { storage, state, uploads };
};

// Private persistence enrollment governs the legacy Drive-provider path;
// Sync v2 (websocket provider) never enrolls into AppData (tests/sync/unifiedMode).
it('a connected Drive enrolls every local board automatically — no disclosure step', async () => {
  const { storage, state, uploads } = harness();
  const rx = await createRxRepository({ name: `autoen${crypto.randomUUID().replaceAll('-', '')}`, blobs: createIndexedDbBlobStore(`autoenblobs${crypto.randomUUID()}`) });
  repositories.push(rx);
  const board = await rx.createProject('First board', 'project');
  const runtime = createDriveRuntime({ storage, getRepository: async () => rx,
    auth: { getAccessToken: async () => state.email, getConnectionState: async () => state.connected ? 'connected' : 'disconnected',
      connect: async () => {}, disconnect: async () => {}, isConfigured: () => true },
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/about')) return new Response(JSON.stringify({ user: { emailAddress: state.email } }));
      if (init?.method === 'POST' || init?.method === 'PATCH') { uploads.push(String(init.body)); return new Response(JSON.stringify({ id: 'fixture' })); }
      return new Response(JSON.stringify({ files: [] }));
    } });
  await runtime.driveSyncState.markDirty(board.id);
  await expect(runtime.googleDrive.syncProject(board.id)).resolves.toBe('pushed');
  // A board created afterwards is equally automatic — enrollment is per account
  // connection, never per board.
  const later = await rx.createProject('Later board', 'project');
  await runtime.driveSyncState.markDirty(later.id);
  await expect(runtime.googleDrive.syncProject(later.id)).resolves.toBe('pushed');
  expect(uploads.length).toBeGreaterThanOrEqual(2);
  // Without a connected account there is nothing to enroll into: no upload.
  state.connected = false;
  const offlineBoard = await rx.createProject('Offline board', 'project');
  await runtime.driveSyncState.markDirty(offlineBoard.id);
  const before = uploads.length;
  await expect(runtime.googleDrive.syncProject(offlineBoard.id)).rejects.toThrow();
  expect(uploads.length).toBe(before);
});

it('connecting reconciles immediately so a fresh profile restores this account’s boards', async () => {
  const { storage } = harness();
  const rx = await createRxRepository({ name: `autocon${crypto.randomUUID().replaceAll('-', '')}`, blobs: createIndexedDbBlobStore(`autoconblobs${crypto.randomUUID()}`) });
  repositories.push(rx);
  let reconciled = 0;
  const runtime = createDriveRuntime({ storage, getRepository: async () => rx,
    auth: { getAccessToken: async () => 'synthetic-token', getConnectionState: async () => 'connected',
      connect: async () => {}, disconnect: async () => {}, isConfigured: () => true },
    // One listing round is enough: the imported board set is empty either way.
    fetcher: async () => new Response(JSON.stringify({ files: [], user: { emailAddress: 'a@example.test' } })) });
  const baseReconcile = runtime.googleDrive.reconcileAll;
  void baseReconcile;
  // Drive the observable contract: connect() triggers a reconciliation pass.
  const seen: number[] = [];
  Object.defineProperty(runtime.googleDrive, 'reconcileAll', { value: async () => { reconciled += 1; seen.push(reconciled); return { status: 'reconciled', imported: 0, pulled: 0, pushed: 0, deleted: 0 } as never; }, configurable: true });
  await runtime.googleDrive.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reconciled).toBeGreaterThanOrEqual(1);
});

it('authorizePrivatePersistence still records the account-scoped disclosure', async () => {
  const { storage, state } = harness();
  const rx = await createRxRepository({ name: `discl${crypto.randomUUID().replaceAll('-', '')}`, blobs: createIndexedDbBlobStore(`disclblobs${crypto.randomUUID()}`) });
  repositories.push(rx);
  const board = await rx.createProject('Disclosed board', 'project');
  const runtime = createDriveRuntime({ storage, getRepository: async () => rx,
    auth: { getAccessToken: async () => state.email, getConnectionState: async () => state.connected ? 'connected' : 'disconnected',
      connect: async () => {}, disconnect: async () => {}, isConfigured: () => true },
    fetcher: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/about')) return new Response(JSON.stringify({ user: { emailAddress: state.email } }));
      return new Response(JSON.stringify({ files: [] }));
    } });
  await runtime.authorizePrivatePersistence();
  expect(storage.data.pboardBindingDisclosure).toMatchObject({ version: 1,
    accountId: await hashBlob(new Blob(['a@example.test'])), boardIds: [board.id] });
  state.connected = false;
  await expect(runtime.authorizePrivatePersistence()).rejects.toThrow('Connect Google');
});

it('retains both board enrollments when sync is requested concurrently after a board switch', async () => {
  const storage = new MemoryStorage();
  let release!: () => void, started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const set = storage.set.bind(storage); let first = true;
  storage.set = async patch => {
    if ('pboardBindingDisclosure' in patch && first) { first = false; started(); await gate; }
    await set(patch);
  };
  const runtime = createDriveRuntime({ storage,
    getRepository: async () => ({ listProjects: async () => [{ id: 'board-a' }, { id: 'board-b' }] }) as unknown as RxRepository,
    auth: { getAccessToken: async () => 'synthetic-token', getConnectionState: async () => 'connected',
      connect: async () => {}, disconnect: async () => {}, isConfigured: () => true },
    fetcher: async () => new Response(JSON.stringify({ user: { emailAddress: 'a@example.test' } })) });
  const a = runtime.authorizePrivatePersistence('board-a');
  await writing;
  const b = runtime.authorizePrivatePersistence('board-b');
  // Let the second request reach the shared disclosure while A's write is held.
  for (let i = 0; i < 30; i++) await Promise.resolve();
  release(); await Promise.all([a, b]);
  expect(storage.data.pboardBindingDisclosure).toMatchObject({ version: 1,
    accountId: await hashBlob(new Blob(['a@example.test'])), boardIds: ['board-a', 'board-b'] });
});
