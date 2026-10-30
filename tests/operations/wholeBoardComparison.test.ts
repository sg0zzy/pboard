import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { LocalOperationStore } from '../../src/sync/operations/localStore';
import { OperationSession } from '../../src/sync/operations/session';
import { ImmutableDriveFake } from './driveFake';
import { createBoardSyncV2 } from '../../src/sync/boardSyncV2';
import { createDriveBoardStore } from '../../src/sync/driveBoardStore';
import { DriveStub, REAL_ROOT_ID } from '../sync/driveStub';
import type { Command } from '../../src/sync/operations/protocol';
import type { ProjectSnapshot } from '../../src/sync/snapshot';

const auth = { getAccessToken: async () => 'test', getConnectionState: async (): Promise<'connected'> => 'connected', connect: async () => {}, disconnect: async () => {}, isConfigured: () => true };
const date = '2026-01-01T00:00:00.000Z';
const stats = (latencies: number[], requests: number, bytes: number[]) =>
  ({ medianEditSyncMs: [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)], maxEditSyncMs: Math.max(...latencies), driveRequests: requests, bytesPerEdit: Math.round(bytes.reduce((sum, item) => sum + item, 0) / latencies.length), maxBytesPerEdit: Math.max(...bytes) });

it('compares whole-board publish against incremental operations on one workload', async () => {
  const cards = Array.from({ length: 1000 }, (_, index) => ({
    content: `Card ${index}: ${'representative text '.repeat(12)}`, type: 'note', status: 'candidate', orderKey: 'a0', createdAt: date, updatedAt: date
  }));

  const fake = new ImmutableDriveFake();
  const journal = new ChangeJournal('probe-incremental'); await journal.open();
  const local = new LocalOperationStore(journal);
  const session = new OperationSession({ boardId: 'board', local, drive: fake.store(), role: async () => fake.role, batchDelayMs: 60000 });
  await session.open();
  await session.edit({ collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Probe board', template: 'project', createdAt: date, updatedAt: date }, unset: [] } satisfies Command);
  for (const card of cards) await session.edit({ collection: 'cards', entityId: `card-${cards.indexOf(card)}`, kind: 'create', fields: card, unset: [] } satisfies Command);
  await session.sync(true);
  const incrementalLatency: number[] = []; const incrementalBytes: number[] = [];
  const incrementalRequests = fake.requests.length;
  for (let edit = 0; edit < 50; edit++) {
    const started = performance.now(); const filesBefore = fake.files.size;
    await session.edit({ collection: 'cards', entityId: 'card-2', kind: 'patch', fields: { content: `Edit ${edit}` }, unset: [] } satisfies Command);
    await session.sync(true);
    incrementalLatency.push(performance.now() - started); incrementalBytes.push([...fake.files.values()].slice(filesBefore).reduce((sum, file) => sum + new TextEncoder().encode(file.body).length, 0));
  }
  const incrementalSegments = [...fake.files.values()].filter(file => file.name.startsWith('operations-')).length;

  const stub = new DriveStub();
  const root = stub.addFolder('pboard', REAL_ROOT_ID);
  const boards = createDriveBoardStore({ auth, fetcher: stub.fetch as unknown as typeof fetch });
  const snapshot: ProjectSnapshot = { format: 'pboard-project', version: 1, exportedAt: date, project: { id: 'board', name: 'Probe board', createdAt: date, updatedAt: date, revision: 1 } as never, items: cards.map((card, index) => ({ id: `card-${index}`, projectId: 'board', order: index, ...card })) as never };
  const state = new Map<string, { projectId: string; dirty: boolean; status: 'pending' | 'synced' | 'error'; remoteFileId?: string; revision?: number; error?: string }>([['board', { projectId: 'board', dirty: true, status: 'pending' }]]);
  const legacy = createBoardSyncV2({
    store: boards,
    snapshots: {
      read: async () => snapshot,
      list: async () => [snapshot],
      apply: async () => true,
      applyIfNewer: async () => 'local-newer' as const,
      remove: async (id: string) => { state.delete(id); }
    },
    syncState: {
      get: async (id: string) => state.get(id)!,
      ensureInitiallyDirty: async (id: string) => { if (!state.has(id)) state.set(id, { projectId: id, dirty: true, status: 'pending' }); },
      markSynced: async (id: string, revision: number, remoteFileId: string) => { state.set(id, { projectId: id, dirty: false, status: 'synced', remoteFileId, revision }); },
      markError: async (id: string, error: string) => { state.set(id, { projectId: id, dirty: true, status: 'error', error }); },
      forget: async (id: string) => { state.delete(id); }
    },
    tombstones: { getAll: async () => [], get: async () => null, add: async () => {}, clear: async () => {} },
    getRepository: async () => ({ isDeletedProject: async () => false, getProject: async () => snapshot.project, listProjects: async () => [snapshot.project] }) as never,
    connectionState: async () => 'connected',
    deviceKeyId: async () => 'probe-device'
  });
  await legacy.syncProject('board', { force: true });
  const requestsBefore = stub.requests.length;
  const wholeBoardLatency: number[] = []; const wholeBoardBytes: number[] = []; const boardFolder = stub.find('board', root.id)?.id;
  for (let edit = 0; edit < 50; edit++) {
    const started = performance.now();
    snapshot.items[2] = { ...snapshot.items[2], title: `Edit ${edit}`, updatedAt: new Date(1_700_000_000_000 + edit).toISOString() } as never;
    snapshot.project = { ...snapshot.project, revision: snapshot.project.revision + 1, updatedAt: new Date(1_700_000_000_000 + edit).toISOString() } as never;
    state.set('board', { projectId: 'board', dirty: true, status: 'pending' });
    await legacy.syncProject('board', { force: true });
    wholeBoardLatency.push(performance.now() - started); wholeBoardBytes.push(stub.find('board.json.gz', boardFolder)!.bytes.length);
  }
  const journalOps = await local.operations('board');
  journal.close(); await session.close();
  const incremental = stats(incrementalLatency, fake.requests.length - incrementalRequests, incrementalBytes);
  const wholeBoard = stats(wholeBoardLatency, stub.requests.length - requestsBefore, wholeBoardBytes);
  const retained = { incrementalJournalOps: journalOps.length, incrementalStateJsonBytes: JSON.stringify(session.state()).length, wholeBoardSnapshotJsonBytes: JSON.stringify(snapshot).length };
  expect(incremental.bytesPerEdit).toBeLessThan(wholeBoard.bytesPerEdit);
  expect(incrementalSegments).toBe(Math.ceil((cards.length + 1) / 128) + 50);
  process.stdout.write(`whole-board versus incremental (Node, fake Drive, one workload) ${JSON.stringify({ incremental, wholeBoard, retained, segmentFiles: incrementalSegments, wholeBoardSnapshotBytesPerSync: wholeBoardBytes.at(-1), incrementalFirstFive: incrementalLatency.slice(0, 5).map(v => Math.round(v)) })}\n`);
}, 30_000);
