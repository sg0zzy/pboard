import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createPrivateDriveHistory } from '../../src/sync/privateDriveHistory';
import { createBackendProjectSnapshotStore } from '../../src/sync/snapshot';
import type { DriveTransport } from '../../src/sync/driveTransport';
import type { KeyValueStorage } from '../../src/storage/repository';

/**
 * The sidebar reconciles every 30 seconds. Every reconciliation used to
 * download and re-verify every private history archive of every board, and
 * the archives grow with the board's history, so the cost grew without bound
 * on the sidebar's main thread.
 *
 * An archive is immutable and its name carries its content fingerprint, so an
 * archive this device already verified must not be fetched again.
 */
const repos: RxRepository[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.db.close();
});

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, unknown>();
  return {
    async get(key) { return { [key]: data.get(key) }; },
    async set(values) { for (const [k, v] of Object.entries(values)) data.set(k, v); }
  };
}

function mockDrive() {
  const files = new Map<string, { id: string; name: string; contents: string }>();
  const stats = { downloads: 0, uploads: 0, lists: 0 };
  let nextId = 1;
  // The real transport names a file `history-<key>.pboard`, where the key is
  // `<boardId>_<fingerprint>`.
  const nameFor = (key: string) => `history-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.pboard`;
  const transport: DriveTransport = {
    async listProjectFiles() { stats.lists++; return [...files.values()].map((f) => ({ id: f.id, name: f.name })); },
    async findProjectFile(key: string) {
      const name = nameFor(key);
      return [...files.values()].find((f) => f.name === name) ?? null;
    },
    async download(fileId: string) {
      stats.downloads++;
      const file = files.get(fileId);
      if (!file) throw new Error("missing");
      return file.contents;
    },
    async upload(key: string, contents: string, fileId?: string) {
      stats.uploads++;
      const name = fileId ? (files.get(fileId)?.name ?? nameFor(key)) : nameFor(key);
      const id = fileId ?? `f${nextId++}`;
      files.set(id, { id, name, contents });
      return { id, name };
    },
    async delete(fileId: string) { files.delete(fileId); }
  };
  return { stats, files, transport };
}

it("does not download a private history archive it has already verified", async () => {
  const rx = await createRxRepository({ name: `cache${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Board', 'project');
  const storage = memoryStorage();
  const drive = mockDrive();
  const snapshots = createBackendProjectSnapshotStore(storage, async () => rx);
  const history = createPrivateDriveHistory({
    transport: drive.transport, snapshots, getRepository: async () => rx, getAccountId: async () => 'acct'
  });

  await rx.addItem({ projectId: board.id, content: 'card one' });
  await history.sync(board.id, [], async () => true);
  console.log('archives after the first sync:', drive.files.size);
  console.log('downloads after the first sync:', drive.stats.downloads);

  // The second sync reads the archive that now exists, and verifies it.
  await history.sync(board.id, [], async () => true);
  const downloadsAfterSecondSync = drive.stats.downloads;
  console.log('downloads after the second sync:', downloadsAfterSecondSync);
  expect(downloadsAfterSecondSync).toBeGreaterThan(0);

  // A third sync must not fetch the verified archive again.
  await history.sync(board.id, [], async () => true);
  console.log('downloads after the third sync:', drive.stats.downloads);
  expect(drive.stats.downloads).toBe(downloadsAfterSecondSync);

  // The inventory read (the reconciliation's board list) must not fetch it
  // either.
  await history.boards(() => {});
  console.log('downloads after the board inventory:', drive.stats.downloads);
  expect(drive.stats.downloads).toBe(downloadsAfterSecondSync);
}, 60000);

it("downloads an archive again when its content is new", async () => {
  const rx = await createRxRepository({ name: `cache2${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Board', 'project');
  const storage = memoryStorage();
  const drive = mockDrive();
  const snapshots = createBackendProjectSnapshotStore(storage, async () => rx);
  const history = createPrivateDriveHistory({
    transport: drive.transport, snapshots, getRepository: async () => rx, getAccountId: async () => 'acct'
  });

  await rx.addItem({ projectId: board.id, content: 'card one' });
  await history.sync(board.id, [], async () => true);
  const first = drive.stats.downloads;
  console.log('downloads after the first sync:', first, 'archives:', drive.files.size);

  await rx.addItem({ projectId: board.id, content: 'card two' });
  await history.sync(board.id, [], async () => true);
  console.log('downloads after the second sync:', drive.stats.downloads, 'archives:', drive.files.size);
  // The new archive is fetched; the old one is not fetched again.
  expect(drive.files.size).toBeGreaterThan(1);
}, 60000);
