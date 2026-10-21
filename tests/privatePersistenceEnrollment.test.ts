import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createDriveRuntime } from '../src/sync/runtime';
import { createRxRepository, type RxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore, hashBlob } from '../src/storage/blobStore';
import { MemoryStorage } from './recovery/harness';

const repositories: RxRepository[] = [];
afterEach(async () => { for (const rx of repositories.splice(0)) await rx.db.close(); });

it('records only verified account/board consent, rejects stale global consent and blocks enrollment after an account switch', async () => {
  const storage = new MemoryStorage();
  storage.data.pboardCollaborationSettings = { provider: 'websocket', url: 'wss://relay.example.test/ws' };
  storage.data.pboardBindingDisclosure = { grantedAt: '2026-10-19T00:00:00Z' };
  const rx = await createRxRepository({ name: `consent${crypto.randomUUID().replaceAll('-', '')}`, blobs: createIndexedDbBlobStore(`consentblobs${crypto.randomUUID()}`) });
  repositories.push(rx);
  const board = await rx.createProject('Account A standalone board', 'project');
  let email = 'a@example.test', connected = true, switchDuringIdentity = false;
  const uploads: string[] = [];
  const runtime = createDriveRuntime({ storage, getRepository: async () => rx,
    auth: { getAccessToken: async () => email, getConnectionState: async () => connected ? 'connected' : 'disconnected',
      connect: async () => {}, disconnect: async () => {}, isConfigured: () => true },
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/about')) {
        const current = email; if (switchDuringIdentity) email = 'b@example.test';
        return new Response(JSON.stringify({ user: { emailAddress: current } }));
      }
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        uploads.push(String(init.body)); return new Response(JSON.stringify({ id: 'fixture' }));
      }
      return new Response(JSON.stringify({ files: [] }));
    } });
  await runtime.driveSyncState.markDirty(board.id);
  await expect(runtime.googleDrive.syncProject(board.id)).rejects.toThrow('not enrolled');
  await runtime.authorizePrivatePersistence();
  expect(storage.data.pboardBindingDisclosure).toMatchObject({ version: 1,
    accountId: await hashBlob(new Blob(['a@example.test'])), boardIds: [board.id] });
  const later = await rx.createProject('Later standalone work', 'project');
  await runtime.driveSyncState.markDirty(later.id);
  await expect(runtime.googleDrive.syncProject(later.id)).rejects.toThrow('not enrolled');
  email = 'b@example.test';
  await expect(runtime.googleDrive.syncProject(board.id)).rejects.toThrow('not enrolled');
  expect(uploads.some(body => body.includes('"name":"project-') || body.includes('"name":"history-'))).toBe(false);
  const consent = structuredClone(storage.data.pboardBindingDisclosure);
  connected = false;
  await expect(runtime.authorizePrivatePersistence()).rejects.toThrow('Connect Google');
  expect(storage.data.pboardBindingDisclosure).toEqual(consent);
  connected = true; email = 'a@example.test'; switchDuringIdentity = true;
  await expect(runtime.authorizePrivatePersistence()).rejects.toThrow('account changed');
  expect(storage.data.pboardBindingDisclosure).toEqual(consent);
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
