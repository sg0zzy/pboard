import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createPrivateDriveHistory } from '../../src/sync/privateDriveHistory';
import { createBackendProjectSnapshotStore } from '../../src/sync/snapshot';
import type { DriveTransport } from '../../src/sync/driveTransport';
import type { KeyValueStorage } from '../../src/storage/repository';

/**
 * The cost of ONE background resync cycle for a board that cannot settle.
 *
 * The worker resyncs such a board every 15-30 s, forever. Each cycle runs the
 * whole private-history pipeline: the erasure inventory, the account
 * preferences, the history archive list, every archive download and
 * verification, and the journal scans. This measures that cost.
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
  const stats = { downloads: 0, bytes: 0, lists: 0 };
  let nextId = 1;
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

it("measures the cost of one resync cycle as the history grows", async () => {
  const rx = await createRxRepository({ name: `cyc${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Board', 'project');
  const storage = memoryStorage();
  const drive = mockDrive();
  const snapshots = createBackendProjectSnapshotStore(storage, async () => rx);
  const history = createPrivateDriveHistory({
    transport: drive.transport, snapshots, getRepository: async () => rx, getAccountId: async () => 'acct'
  });

  // Build a history with several archives, as a board in daily use would have.
  for (let round = 0; round < 10; round++) {
    await rx.addItem({ projectId: board.id, content: `card ${round} ${"x".repeat(500)}` });
    await history.sync(board.id, [], async () => true);
  }
  console.log('archives:', drive.files.size);

  // One resync cycle: the history sync is the dominant part of the pipeline.
  const downloadsBefore = drive.stats.downloads;
  const bytesBefore = drive.stats.bytes;
  const started = performance.now();
  await history.sync(board.id, [], async () => true);
  const elapsed = performance.now() - started;
  console.log(`one resync cycle: ${elapsed.toFixed(1)} ms`);
  console.log(`  archive downloads: +${drive.stats.downloads - downloadsBefore}`);
  console.log(`  archive bytes:     +${drive.stats.bytes - bytesBefore}`);

  // The second cycle of the same board re-reads the same archives.
  const downloadsBeforeSecond = drive.stats.downloads;
  const startedSecond = performance.now();
  await history.sync(board.id, [], async () => true);
  const secondElapsed = performance.now() - startedSecond;
  console.log(`second cycle: ${secondElapsed.toFixed(1)} ms, downloads +${drive.stats.downloads - downloadsBeforeSecond}`);

  expect(elapsed).toBeGreaterThan(0);
}, 120000);
