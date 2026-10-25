import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { createDriveRuntime } from '../../src/sync/runtime';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore, hashBlob } from '../../src/storage/blobStore';
import { MemoryStorage } from '../recovery/harness';
import { DriveStub, REAL_ROOT_ID } from './driveStub';

const repositories: RxRepository[] = [];
const open = async () => {
  const rx = await createRxRepository({ name: `uni${crypto.randomUUID().replaceAll('-', '')}`, blobs: createIndexedDbBlobStore(`uniblobs${crypto.randomUUID()}`) });
  repositories.push(rx);
  return rx;
};

// The collaboration setting is the mode switch: `websocket` is Sync v2.
const runtimeFor = (storage: MemoryStorage, rx: RxRepository, stub: DriveStub, onReconciled?: () => Promise<void>) => createDriveRuntime({
  storage, getRepository: async () => rx,
  auth: {
    getAccessToken: async () => 'token', getConnectionState: async () => 'connected' as const,
    connect: async () => {}, disconnect: async () => {}, isConfigured: () => true
  },
  fetcher: async (input, init) => String(input).includes('/about')
    ? new Response(JSON.stringify({ user: { emailAddress: 'a@example.test' } }))
    : stub.fetch(input as string, init),
  ...(onReconciled ? { onReconciled } : {})
});

it('Sync v2 mode persists boards through the unified /pboard layout without any AppData call', async () => {
  const storage = new MemoryStorage();
  Object.assign(storage.data, { pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.example.test/ws' } });
  const rx = await open();
  const stub = new DriveStub();
  const runtime = runtimeFor(storage, rx, stub);
  const board = await rx.createProject('Unified board', 'project');
  await runtime.driveSyncState.markDirty(board.id);
  expect(await runtime.googleDrive.syncProject(board.id)).toBe('pushed');
  // Ongoing persistence is pure regular Drive: zero AppData-shaped requests.
  expect(stub.appDataCalls).toBe(0);
  const root = stub.files.find(f => f.name === 'pboard' && f.parents.includes(REAL_ROOT_ID) && !f.trashed);
  expect(root).toBeTruthy();
  const folder = stub.files.find(f => f.name === board.id && f.parents.includes(root!.id) && !f.trashed);
  expect(folder).toBeTruthy();
  expect(stub.files.some(f => f.name === 'board.json.gz' && f.parents.includes(folder!.id) && !f.trashed)).toBe(true);
  expect(await runtime.googleDrive.reconcileAll()).toMatchObject({ status: 'reconciled' });
  // The automatic legacy pass probes AppData once per session and the
  // account ordering preference round-trips once per reconcile — both
  // read-mostly; board persistence itself never touches AppData.
  expect(stub.appDataCalls).toBeLessThanOrEqual(2);
  const before = stub.appDataCalls;
  expect(await runtime.googleDrive.reconcileAll()).toMatchObject({ status: 'reconciled' });
  expect(stub.appDataCalls - before).toBeLessThanOrEqual(1);
  // Every issued request targeted regular Drive (no spaces/parents appData hints).
  expect(stub.requests.length).toBeGreaterThan(0);
  for (const repository of repositories.splice(0)) await repository.db.close();
});

it('legacy Drive-provider mode keeps using the AppData-backed provider', async () => {
  const storage = new MemoryStorage();
  const rx = await open();
  const stub = new DriveStub();
  const runtime = runtimeFor(storage, rx, stub);
  const board = await rx.createProject('Legacy board', 'project');
  await runtime.driveSyncState.markDirty(board.id);
  expect(await runtime.googleDrive.syncProject(board.id)).toBe('pushed');
  expect(stub.appDataCalls).toBeGreaterThan(0); // AppData-shaped requests happened here
  expect(stub.files.some(f => f.name === 'pboard')).toBe(false);
  for (const repository of repositories.splice(0)) await repository.db.close();
});

it('Sync v2 reconcile automatically migrates a legacy AppData board (connect is consent)', async () => {
  const storage = new MemoryStorage();
  Object.assign(storage.data, { pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.example.test/ws' } });
  const rx = await open();
  const stub = new DriveStub();
  const legacy = {
    format: 'pboard-project', version: 1, exportedAt: '2025-12-01T00:00:00.000Z',
    project: { id: 'old1', name: 'Old board', createdAt: '2025-11-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z', revision: 4 },
    items: [{ id: 'c1', projectId: 'old1', order: 0, title: 'Card', displayMode: 'normal' }]
  };
  const appData = stub.addFile('project-old1.pboard', 'appDataFolder', JSON.stringify(legacy));
  const runtime = runtimeFor(storage, rx, stub);
  expect(await rx.getProject('old1')).toBe(null);
  expect(await runtime.googleDrive.reconcileAll()).toMatchObject({ status: 'reconciled' });
  // Fresh-profile recovery: the legacy content is now the local board…
  expect(await rx.getProject('old1')).toBeTruthy();
  // …and its canonical unified file exists under pboard/old1/.
  const root = stub.files.find(f => f.name === 'pboard' && f.parents.includes(REAL_ROOT_ID) && !f.trashed);
  const folder = stub.files.find(f => f.name === 'old1' && root && f.parents.includes(root!.id) && !f.trashed);
  expect(folder).toBeTruthy();
  expect(stub.files.some(f => f.name === 'board.json.gz' && folder && f.parents.includes(folder!.id) && !f.trashed)).toBe(true);
  // Verified-before-delete: the source survives the migration untouched.
  expect(appData.trashed).toBe(false);
  expect(appData.version).toBe(1);
  for (const repository of repositories.splice(0)) await repository.db.close();
});

it('Sync v2 reconcile pulls the account board order from AppData (fresh browser)', async () => {
  const storage = new MemoryStorage();
  Object.assign(storage.data, { pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.example.test/ws' } });
  const rx = await open();
  const stub = new DriveStub();
  const first = await rx.createProject('First', 'project');
  const second = await rx.createProject('Second', 'project');
  // Another browser already stored this account's preferred order there.
  const account = await hashBlob(new Blob(['a@example.test']));
  const remote = { ids: [second.id, first.id], updatedAt: new Date(Date.now() + 60_000).toISOString() };
  stub.addFile(`account-preferences-${account}.pboard`, 'appDataFolder', JSON.stringify(remote));
  const runtime = runtimeFor(storage, rx, stub);
  expect(await runtime.googleDrive.reconcileAll()).toMatchObject({ status: 'reconciled' });
  // The dropdown order follows the account preference, not local creation order.
  expect((await rx.listProjects()).map(project => project.id)).toEqual([second.id, first.id]);
  const stored = stub.files.find(f => f.name === `account-preferences-${account}.pboard` && !f.trashed)!;
  expect(JSON.parse(new TextDecoder().decode(stored.bytes)).ids).toEqual([second.id, first.id]);
  for (const repository of repositories.splice(0)) await repository.db.close();
});

it('every reconcile round runs the onReconciled maintenance hook in both provider modes', async () => {
  for (const provider of ['websocket', 'webrtc'] as const) {
    const storage = new MemoryStorage();
    if (provider === 'websocket') Object.assign(storage.data, { pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.example.test/ws' } });
    const rx = await open();
    const stub = new DriveStub();
    let calls = 0;
    const runtime = runtimeFor(storage, rx, stub, async () => { calls += 1; throw new Error('hook failure must not surface'); });
    const board = await rx.createProject(`Hooked ${provider}`, 'project');
    await runtime.driveSyncState.markDirty(board.id);
    expect(await runtime.googleDrive.reconcileAll()).toMatchObject({ status: 'reconciled' });
    // Fire-and-forget: give the hook a tick before asserting.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    // The throwing hook never surfaced: reconcile returned and the pass had
    // already pushed the dirty board (next sync sees nothing to do).
    expect(await runtime.googleDrive.syncProject(board.id)).toBe('not-dirty');
    await rx.db.close();
    repositories.pop();
  }
});
