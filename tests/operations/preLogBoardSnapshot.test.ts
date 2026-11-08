import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { LocalOperationStore } from '../../src/sync/operations/localStore';
import { OperationSession } from '../../src/sync/operations/session';
import { consolidateBoardLog, describeLogCycle, releaseLogConsolidation, runLogConsolidation, type LogConsolidationTarget } from '../../src/sync/logConsolidationRuntime';
import { OperationEngine, type EngineCheckpoint } from '../../src/sync/operations/engine';
import { validateSnapshot } from '../../src/sync/operations/snapshots';
import type { LogLease, OperationLogSync } from '../../src/sync/operations/logSync';
import type { KeyValueStorage } from '../../src/storage/repository';
import type { Command, Operation } from '../../src/sync/operations/protocol';
import { ImmutableDriveFake } from './driveFake';

/**
 * The pre-log board: created before its operation log existed, so its log
 * contains card updates with no create anywhere. Before the bootstrap marker
 * every consolidation cycle refused such a board with "a snapshot would freeze
 * the gap" and no snapshot was ever published — `checkpoint_seq` stayed 0
 * forever while the log grew. These tests run the real wiring
 * (`runLogConsolidation`) over a real session and Drive fake.
 */
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function client(fake: ImmutableDriveFake, boardId = 'board', name = crypto.randomUUID()) {
  const journal = new ChangeJournal(name); await journal.open(); const local = new LocalOperationStore(journal);
  const session = new OperationSession({ boardId, local, drive: fake.store(), role: async () => fake.role, batchDelayMs: 60000 });
  cleanup.push(async () => { await session.close(); journal.close(); });
  await session.open();
  return { journal, local, session, name };
}

function makeLog(initial: { nextSeq: number; checkpointSeq: number; snapshotSeq: number }, options: { lease?: () => Promise<LogLease> } = {}) {
  const status: Record<string, number> = { ...initial };
  const commits: { seq: number; snapshotSeq: number; epoch: number }[] = [];
  const lease: LogLease = { holder: 'device-1', epoch: 7, expiresAt: 1 };
  const log = {
    async lease() { if (options.lease) return await options.lease(); return lease; },
    async release() {},
    async diagnose() { return status; },
    async catchUpTo(_sequence: number) { return 'ready' as const; },
    async commit(at: LogLease, sequence: number, snapshotSeq: number, _driveEtag: string) {
      commits.push({ seq: sequence, snapshotSeq, epoch: at.epoch });
      status.checkpointSeq = sequence; status.snapshotSeq = snapshotSeq;
      return { checkpointSeq: sequence, epoch: at.epoch, snapshotSeq, stale: false };
    },
  } satisfies Pick<OperationLogSync, 'lease' | 'release' | 'diagnose' | 'catchUpTo' | 'commit'>;
  return { log, commits, status };
}

function makeStorage(): KeyValueStorage & { records: Record<string, unknown> } {
  const records: Record<string, unknown> = {};
  return { records, async get(key: string) { return (records[key] ?? {}) as Record<string, unknown>; }, async set(values: Record<string, unknown>) { Object.assign(records, values); } };
}

function target(session: OperationSession, fake: ImmutableDriveFake, log: LogConsolidationTarget['log'], storage: KeyValueStorage, boardId = 'board'): LogConsolidationTarget {
  return { boardId, folderId: 'folder', log, session, drive: fake.store(), role: async () => fake.role, storage };
}

async function preLogEdits(session: OperationSession) {
  await session.edit({ collection: 'cards', entityId: 'c1', kind: 'patch', fields: { content: 'First pre-log edit' }, unset: [] } satisfies Command);
  await session.edit({ collection: 'cards', entityId: 'c2', kind: 'patch', fields: { content: 'Second pre-log edit' }, unset: [] } satisfies Command);
}

it('publishes a snapshot for a board whose history predates its log', async () => {
  const fake = new ImmutableDriveFake(), a = await client(fake);
  await preLogEdits(a.session);
  // The refusal itself, with the guard still closed: without the bootstrap
  // proof the engine will not checkpoint this board. (The wiring passes that
  // proof only while the log has never committed anything.)
  await expect(a.session.prepareLogSnapshot()).rejects.toThrow('Board history is incomplete; a snapshot would freeze the gap');

  const { log, commits, status } = makeLog({ nextSeq: 2, checkpointSeq: 0, snapshotSeq: 0 });
  const outcome = await runLogConsolidation(target(a.session, fake, log, makeStorage()));
  expect(outcome).toEqual({ status: 'published', snapshotSeq: 1, stale: false });
  expect(describeLogCycle(outcome)).toBe('published/1');
  expect(commits).toEqual([{ seq: 2, snapshotSeq: 1, epoch: 7 }]);
  expect(status.checkpointSeq).toBe(2);

  const file = [...fake.files.values()].find(entry => entry.name.startsWith('snapshot-'))!;
  const snapshot = JSON.parse(file.body) as { checkpoint: { entities: { collection: string; id: string; bootstrap?: boolean; created?: boolean }[] } };
  await validateSnapshot(JSON.parse(file.body), 'board');
  const entities = new Map(snapshot.checkpoint.entities.map(entity => [`${entity.collection}:${entity.id}`, entity]));
  expect(entities.get('cards:c1')?.bootstrap).toBe(true);
  expect(entities.get('cards:c2')?.bootstrap).toBe(true);
  // The board cannot hold cards without its project: the first snapshot
  // materializes it even though no operation ever mentioned it.
  expect(entities.get('projects:board')?.bootstrap).toBe(true);

  // The live engine keeps no marker: local projection never adopts bootstrap
  // entities, and publishing again on the same evidence still refuses.
  expect(a.session.state().project).toBeNull();
  await expect(a.session.prepareLogSnapshot()).rejects.toThrow('freeze the gap');
});

it('a fresh device catches up from the bootstrap snapshot without replaying any log', async () => {
  const fake = new ImmutableDriveFake(), a = await client(fake);
  await preLogEdits(a.session);
  const { log } = makeLog({ nextSeq: 2, checkpointSeq: 0, snapshotSeq: 0 });
  await runLogConsolidation(target(a.session, fake, log, makeStorage()));
  expect([...fake.files.values()].some(file => file.name.startsWith('operations-'))).toBe(false);

  const b = await client(fake);
  await b.session.sync(true);
  expect(b.session.state()).toEqual({
    project: { id: 'board' },
    cards: [
      { id: 'c1', projectId: 'board', content: 'First pre-log edit' },
      { id: 'c2', projectId: 'board', content: 'Second pre-log edit' },
    ],
  });
  // Nothing travelled as operations: the catch-up was the snapshot file.
  expect(await b.local.operations('board')).toHaveLength(0);
  // And the device that caught up can keep the chain going: its engine is
  // resolved, so its own snapshots build without bootstrap relief.
  const { snapshot } = await b.session.prepareLogSnapshot();
  expect(snapshot.checkpoint.entities.some(entity => entity.bootstrap === true)).toBe(true);
});

it('never bootstraps once history could have been pruned: with a committed checkpoint the refusal stands', async () => {
  const fake = new ImmutableDriveFake(), a = await client(fake);
  await preLogEdits(a.session);
  // The log says a snapshot already covers sequence 5 — so an entity this
  // engine cannot explain is a real hole, not pre-log past.
  const { log } = makeLog({ nextSeq: 6, checkpointSeq: 5, snapshotSeq: 1 });
  await expect(runLogConsolidation(target(a.session, fake, log, makeStorage()))).rejects.toThrow('Board history is incomplete; a snapshot would freeze the gap');
});

it('an unacked local write defers the cycle instead of faulting the board', async () => {
  const fake = new ImmutableDriveFake(), a = await client(fake);
  // A remote operation waiting on an actor this device has never seen: a
  // genuine gap in causal order the engine holds as pending.
  const waiting: Operation = { schemaVersion: 1, boardId: 'board', actorId: 'remote-actor', seq: 6, opId: 'remote-actor:6', clock: 7,
    deps: { 'remote-actor': 5, 'other-actor': 6 }, collection: 'cards', entityId: 'c9', kind: 'patch', fields: { content: 'queued behind a missing prefix' }, unset: [] };
  await a.session.receiveRealtime([waiting]);
  const { log } = makeLog({ nextSeq: 6, checkpointSeq: 0, snapshotSeq: 0 });
  const outcome = await runLogConsolidation(target(a.session, fake, log, makeStorage()));
  expect(outcome).toEqual({ status: 'idle', reason: 'pending-local-writes' });
  expect(describeLogCycle(outcome)).toBe('idle:pending-local-writes');
  expect([...fake.files.values()].some(file => file.name.startsWith('snapshot-'))).toBe(false);
});

it('reports idle outcomes with their reason and keeps leases out of it', async () => {
  const fake = new ImmutableDriveFake(), a = await client(fake);
  await preLogEdits(a.session);
  const storage = makeStorage();

  fake.role = 'editor';
  const outsider = makeLog({ nextSeq: 2, checkpointSeq: 0, snapshotSeq: 0 });
  expect(describeLogCycle(await runLogConsolidation(target(a.session, fake, outsider.log, storage)))).toBe('idle:not-owner');
  fake.role = 'owner';

  const clean = makeLog({ nextSeq: 2, checkpointSeq: 2, snapshotSeq: 1 });
  expect(describeLogCycle(await runLogConsolidation(target(a.session, fake, clean.log, storage)))).toBe('idle:clean');

  const busy = makeLog({ nextSeq: 2, checkpointSeq: 0, snapshotSeq: 0 }, { lease: async () => { throw new Error('lease_busy'); } });
  expect(describeLogCycle(await runLogConsolidation(target(a.session, fake, busy.log, storage)))).toBe('idle:lease-busy');
  // A busy lease published nothing.
  expect([...fake.files.values()].some(file => file.name.startsWith('snapshot-'))).toBe(false);
});

it('coalesces concurrent cycles for one board into a single lease, from either entry point', async () => {
  const fake = new ImmutableDriveFake(), a = await client(fake);
  const { session } = a;
  await preLogEdits(session);
  const { log } = makeLog({ nextSeq: 2, checkpointSeq: 0, snapshotSeq: 0 });
  let open!: () => void; const held = new Promise<void>(resolve => { open = resolve; });
  const slow = { ...log, lease: async () => { const lease = await log.lease(); await held; return lease; } };
  const first = runLogConsolidation(target(session, fake, slow, makeStorage()));
  const second = consolidateBoardLog('board');
  open();
  const [one, two] = await Promise.all([first, second]);
  expect(one).toEqual(two);
  expect(one.status).toBe('published');
  expect([...fake.files.values()].filter(file => file.name.startsWith('snapshot-'))).toHaveLength(1);

  releaseLogConsolidation('board');
  expect(describeLogCycle(await consolidateBoardLog('board'))).toBe('idle:no-room');
});

it('rejects a checkpoint that claims bootstrap without meaning it', () => {
  const base: EngineCheckpoint = { schemaVersion: 1, boardId: 'board', frontier: { 'actor-1': 1 }, clock: 1,
    receipts: { 'actor-1:1': { hash: 'a'.repeat(64), clock: 1 } },
    entities: [{ collection: 'cards', id: 'c1', created: false, deleted: false, fields: { content: { stamp: { clock: 1, actorId: 'actor-1', seq: 1 }, value: 'x', unset: false } } }] };
  const restored = OperationEngine.restore(structuredClone(base));
  expect(restored.unresolvedReferences()).toEqual(['cards:c1', 'projects:board']);
  const bootstrapped = structuredClone(base);
  bootstrapped.entities[0] = { ...bootstrapped.entities[0]!, bootstrap: true };
  const trusted = OperationEngine.restore(bootstrapped);
  // The marker resolves the card it is written on — nothing else: a board
  // whose project is still unproven stays unresolved even with bootstrapped
  // cards, so the marker cannot be used to smuggle an absent project past
  // the guard except through the snapshot engine, which states it openly.
  expect(trusted.unresolvedReferences()).toEqual(['projects:board']);
  expect(trusted.entity('cards', 'c1')).toEqual({ id: 'c1', projectId: 'board', content: 'x' });
  const forged = structuredClone(bootstrapped);
  forged.entities[0]!.bootstrap = false;
  expect(() => OperationEngine.restore(forged)).toThrow('Invalid checkpoint entity');
});
