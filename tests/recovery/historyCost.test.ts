import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createPrivateDriveHistory } from '../../src/sync/privateDriveHistory';
import { createBackendProjectSnapshotStore } from '../../src/sync/snapshot';
import type { DriveTransport } from '../../src/sync/driveTransport';
import type { KeyValueStorage } from '../../src/storage/repository';

/**
 * The private history grows with the board's edits, and the sidebar
 * reconciles every 30 seconds. This measures the cost of the inventory read
 * that every reconciliation performs, with and without the verified-archive
 * cache.
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
  const stats = { downloads: 0, bytes: 0 };
  let nextId = 1;
  const nameFor = (key: string) => `history-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.pboard`;
  const transport: DriveTransport = {
    async listProjectFiles() { return [...files.values()].map((f) => ({ id: f.id, name: f.name })); },
    async findProjectFile(key: string) {
      const name = nameFor(key);
      return [...files.values()].find((f) => f.name === name) ?? null;
    },
    async download(fileId: string) {
      stats.downloads++;
      const file = files.get(fileId);
      if (!file) throw new Error("missing");
      stats.bytes += file.contents.length;
      return file.contents;
    },
    async upload(key: string, contents: string, fileId?: string) {
      const name = fileId ? (files.get(fileId)?.name ?? nameFor(key)) : nameFor(key);
      const id = fileId ?? `f${nextId++}`;
      files.set(id, { id, name, contents });
      return { id, name };
    },
    async delete(fileId: string) { files.delete(fileId); }
  };
  return { stats, files, transport };
}

it("keeps the reconciliation cost flat as the private history grows", async () => {
  const rx = await createRxRepository({ name: `flat${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Board', 'project');
  const storage = memoryStorage();
  const drive = mockDrive();
  const snapshots = createBackendProjectSnapshotStore(storage, async () => rx);
  const history = createPrivateDriveHistory({
    transport: drive.transport, snapshots, getRepository: async () => rx, getAccountId: async () => 'acct'
  });

  // Build a history with many archives.
  for (let round = 0; round < 12; round++) {
    await rx.addItem({ projectId: board.id, content: `card ${round} ${"x".repeat(400)}` });
    await history.sync(board.id, [], async () => true);
  }
  console.log('archives:', drive.files.size);

  // The inventory read the reconciliation performs.
  const first = drive.stats.downloads;
  const started = performance.now();
  await history.boards(() => {});
  const firstMs = performance.now() - started;
  console.log(`inventory read 1: ${firstMs.toFixed(1)} ms, downloads +${drive.stats.downloads - first}`);

  const second = drive.stats.downloads;
  const startedSecond = performance.now();
  await history.boards(() => {});
  const secondMs = performance.now() - startedSecond;
  console.log(`inventory read 2: ${secondMs.toFixed(1)} ms, downloads +${drive.stats.downloads - second}`);

  // The second read must not fetch the archives again.
  expect(drive.stats.downloads - second).toBe(0);
  expect(secondMs).toBeLessThan(firstMs + 1);
}, 120000);
