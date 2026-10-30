import { describe, expect, it } from 'vitest';
import { OperationEngine } from '../../src/sync/operations/engine';
import { validateOperation, type Command, type Operation } from '../../src/sync/operations/protocol';
import { createSnapshot, planGardening, selectSnapshot, validateSnapshot } from '../../src/sync/operations/snapshots';
const date = '2026-01-01T00:00:00.000Z';
export const board: Command = { collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Board', template: 'project', createdAt: date, updatedAt: date }, unset: [] };
export const card = (id = 'card'): Command => ({ collection: 'cards', entityId: id, kind: 'create', fields: { content: 'Original', type: 'task', status: 'candidate', orderKey: 'a0', createdAt: date, updatedAt: date }, unset: [] });
export function operation(actorId: string, seq: number, command: Command, deps: Record<string, number> = {}, clock = Math.max(seq, ...Object.values(deps).map(n => n + 1))): Operation {
  return { ...structuredClone(command), boardId: 'board', schemaVersion: 1, actorId, seq, opId: `${actorId}:${seq}`, deps: { ...deps, ...(seq > 1 ? { [actorId]: seq - 1 } : {}) }, clock };
}
export const patch = (fields: Command['fields'], entityId = 'card'): Command => ({ collection: 'cards', entityId, kind: 'patch', fields, unset: [] });
const root = operation('base', 1, board);
const creation = operation('base', 2, card(), { base: 1 });
async function engine() { const e = new OperationEngine('board'); await e.receive([root, creation]); return e; }
function random(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function shuffled<T>(input: T[], rand: () => number): T[] {
  const result = [...input];
  for (let n = result.length - 1; n > 0; n--) { const i = Math.floor(rand() * (n + 1)); [result[i], result[n]] = [result[n], result[i]]; }
  return result;
}

describe('transport-independent operation engine', () => {
  it('deduplicates WebRTC, Drive, repeated polling and reconnect delivery by the same ID', async () => {
    const e = await engine(), edit = operation('a', 1, patch({ content: 'Edited' }), { base: 2 }, 3);
    for (let n = 0; n < 10; n++) await e.receive([edit]);
    expect(e.entity('cards', 'card')?.content).toBe('Edited');
    expect(e.metrics.applied).toBe(3); expect(e.metrics.duplicates).toBe(9);
    const resumed = OperationEngine.restore(e.checkpoint());
    await resumed.receive([edit]); expect(resumed.metrics.applied).toBe(0);
  });
  it('rejects conflicting actor/sequence identity without partially accepting the batch', async () => {
    const e = await engine(), first = operation('a', 1, patch({ content: 'A' }), { base: 2 }, 3);
    await expect(e.receive([first, { ...first, fields: { content: 'B' } }])).rejects.toThrow(/identity/);
    expect(e.metrics.applied).toBe(2);
    await e.receive([first]);
    await expect(e.receive([{ ...first, fields: { content: 'B' } }])).rejects.toThrow(/identity/);
  });
  it('does not advance contiguous prefixes through gaps and recovers delayed dependencies', async () => {
    const e = new OperationEngine('board');
    await e.receive([creation]); expect(e.vector()).toEqual({}); expect(e.missing()).toEqual({ base: { from: 1, to: 1 } });
    expect(() => e.checkpoint()).toThrow(/incomplete/);
    await e.receive([root]); expect(e.vector()).toEqual({ base: 2 }); expect(e.pendingCount()).toBe(0);
  });
  it('queues cross-actor dependencies without discarding the dependent operation', async () => {
    const e = await engine(), first = operation('a', 1, patch({ title: 'title' }), { base: 2 }, 3);
    const second = operation('b', 1, patch({ content: 'body' }), { base: 2, a: 1 }, 4);
    await e.receive([second]); expect(e.pendingCount()).toBe(1);
    await e.receive([first]); expect(e.pendingCount()).toBe(0);
    expect(e.entity('cards', 'card')).toMatchObject({ title: 'title', content: 'body' });
  });
  it('quarantines an invalid causal clock and never advances its stream', async () => {
    const e = await engine(), first = operation('a', 1, patch({ title: 'title' }), { base: 2 }, 20);
    const bad = operation('b', 1, patch({ content: 'invalid' }), { base: 2, a: 1 }, 3);
    await e.receive([bad, first]); expect(e.vector().b).toBeUndefined();
    expect(e.inconsistencies()[bad.opId]).toMatch(/Logical clock/);
    expect(e.entity('cards', 'card')?.content).toBe('Original');
  });
  it.each([
    [{ title: 'Left' }, { content: 'Right' }, { title: 'Left', content: 'Right' }],
    [{ content: 'Left' }, { content: 'Right' }, { content: 'Right' }],
    [{ orderKey: 'a1' }, { orderKey: 'a2' }, { orderKey: 'a2' }],
    [{ status: 'done' }, { status: 'started' }, { status: 'started' }]
  ])('converges concurrent property edits and moves %j / %j', async (a, b, expected) => {
    const ops = [operation('a', 1, patch(a), { base: 2 }, 3), operation('b', 1, patch(b), { base: 2 }, 3)];
    const left = await engine(), right = await engine();
    await left.receive(ops); await right.receive([...ops].reverse());
    expect(left.canonicalState()).toBe(right.canonicalState()); expect(left.entity('cards', 'card')).toMatchObject(expected);
  });
  it.each<Command['fields']>([{ content: 'Changed' }, { orderKey: 'a3', status: 'done' }])('permanent deletion wins concurrent and later edits %j', async fields => {
    const e = await engine(), remove = operation('z', 1, { collection: 'cards', entityId: 'card', kind: 'delete', fields: {}, unset: [] }, { base: 2 }, 3);
    await e.receive([operation('a', 1, patch(fields), { base: 2 }, 30), remove]);
    expect(e.entity('cards', 'card')).toBeNull();
    await e.receive([operation('a', 2, card(), { base: 2, a: 1, z: 1 }, 31)]);
    expect(e.entity('cards', 'card')).toBeNull();
  });
  it('preserves trash restore as a regular semantic operation', async () => {
    const e = await engine();
    await e.receive([operation('a', 1, patch({ status: 'trash', deletedAt: date }), { base: 2 }, 3)]);
    await e.receive([operation('a', 2, { ...patch({ status: 'candidate' }), unset: ['deletedAt'] }, { base: 2, a: 1 }, 4)]);
    expect(e.entity('cards', 'card')?.deletedAt).toBeUndefined();
    expect(e.entity('cards', 'card')?.status).toBe('candidate');
  });
  it('orders concurrent inserts with equal fractional ranks by stable ID', async () => {
    const e = await engine();
    await e.receive([operation('a', 1, card('aaa'), { base: 2 }, 3), operation('b', 1, card('bbb'), { base: 2 }, 3)]);
    expect(e.state().cards.map(c => c.id)).toEqual(['aaa', 'bbb', 'card']);
  });
  it('converges board metadata without inventing column entities', async () => {
    const e = await engine(), change = (fields: Command['fields']): Command => ({ collection: 'projects', entityId: 'board', kind: 'patch', fields, unset: [] });
    await e.receive([operation('a', 1, change({ name: 'Renamed' }), { base: 2 }, 3), operation('b', 1, change({ template: 'idea' }), { base: 2 }, 3)]);
    expect(e.state().project).toMatchObject({ name: 'Renamed', template: 'idea' });
  });
  it('causally later edits win independently of the actor tie breaker', async () => {
    const e = await engine();
    await e.receive([operation('z', 1, patch({ title: 'Old' }), { base: 2 }, 3)]);
    await e.receive([operation('a', 1, patch({ title: 'Later' }), { base: 2, z: 1 }, 4)]);
    expect(e.entity('cards', 'card')?.title).toBe('Later');
  });
  it('mandatory randomized convergence: independent offline clients, duplication, delays, restarts, no authority', async () => {
    const clients = await Promise.all(Array.from({ length: 4 }, engine));
    const operations: Operation[] = [root, creation];
    for (let round = 0; round < 15; round++) {
      for (let i = 0; i < clients.length; i++) {
        const client = clients[i], actor = `writer-${i}`;
        const op = operation(actor, round + 1, patch({ content: `${actor}:${round}`, orderKey: `a${i + 1}` }), client.vector(), client.logicalClock() + 1);
        await client.receive([op]); operations.push(op);
      }
      // Periodic partial gossip changes the causal graph, without establishing a master.
      if (round % 3 === 0) await clients[round % 4].receive(operations.slice(-6));
    }
    const canonical: string[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      let receiver = new OperationEngine('board');
      const delivery = shuffled([...operations, ...operations.filter((_, n) => n % 2 === 0)], random(seed));
      for (let i = 0; i < delivery.length; i += 7) {
        await receiver.receive(delivery.slice(i, i + 7));
        // Simulated restart only at a consistent checkpoint; incomplete WAL is
        // tested separately by rebuilding from persisted operations.
        if (!receiver.pendingCount()) receiver = OperationEngine.restore(receiver.checkpoint());
      }
      expect(receiver.pendingCount()).toBe(0); canonical.push(receiver.canonicalState());
    }
    expect(new Set(canonical).size).toBe(1);
  });
  it('rejects unknown versions, malformed payloads and invalid identities or dependencies', () => {
    for (const op of [{ ...creation, schemaVersion: 2 }, { ...creation, actorId: '__proto__' }, { ...creation, boardId: 'other' },
      { ...creation, fields: { framework: 'unexpected' } }, { ...creation, deps: {} }, { ...creation, seq: 1.5 }])
      expect(() => validateOperation(op as Operation, 'board')).toThrow();
  });
});

describe('immutable operation snapshots and conservative retention', () => {
  it('retains conflict metadata, deduplication and terminal tombstones after recovery', async () => {
    const e = await engine(), op = operation('a', 1, patch({ content: 'A' }), { base: 2 }, 3);
    await e.receive([op]); const s = await createSnapshot(e); await validateSnapshot(s, 'board');
    const restored = OperationEngine.restore(s.checkpoint);
    await restored.receive([op, operation('b', 1, patch({ title: 'B' }), { base: 2 }, 3)]);
    expect(restored.entity('cards', 'card')).toMatchObject({ content: 'A', title: 'B' });
    await expect(restored.receive([{ ...op, fields: { content: 'duplicate changed' } }])).rejects.toThrow(/identity/);
  });
  it('recovers operations published after generation, including prolonged-offline writers', async () => {
    const e = await engine(), snapshot = await createSnapshot(e), resumed = OperationEngine.restore(snapshot.checkpoint);
    const offline = operation('offline', 1, patch({ title: 'offline edit' }), { base: 2 }, 3);
    await resumed.receive([offline]); expect(resumed.entity('cards', 'card')?.title).toBe('offline edit');
  });
  it('handles concurrent owner candidates deterministically and retains both branches', async () => {
    const a = await engine(), b = await engine();
    await a.receive([operation('a', 1, patch({ title: 'A' }), { base: 2 }, 3)]);
    await b.receive([operation('b', 1, patch({ content: 'B' }), { base: 2 }, 3)]);
    const snapshots = [await createSnapshot(a), await createSnapshot(b)];
    expect((await selectSnapshot(snapshots, 'board'))?.snapshotId).toBe((await selectSnapshot([...snapshots].reverse(), 'board'))?.snapshotId);
    const selected = OperationEngine.restore((await selectSnapshot(snapshots, 'board'))!.checkpoint);
    await selected.receive([operation('a', 1, patch({ title: 'A' }), { base: 2 }, 3), operation('b', 1, patch({ content: 'B' }), { base: 2 }, 3)]);
    expect(selected.entity('cards', 'card')).toMatchObject({ title: 'A', content: 'B' });
  });
  it('rejects corrupt integrity and incomplete identity history', async () => {
    const s = await createSnapshot(await engine());
    await expect(validateSnapshot({ ...s, snapshotId: 'changed' }, 'board')).rejects.toThrow(/integrity/);
    const broken = structuredClone(s.checkpoint); delete broken.receipts['base:1'];
    expect(() => OperationEngine.restore(broken)).toThrow(/frontier|identity/);
  });
  it('only proposes old segments covered by every retained snapshot, while retaining at least three snapshots', async () => {
    const e = await engine(), snapshots = await Promise.all([createSnapshot(e), createSnapshot(e), createSnapshot(e)]);
    const segment = { protocol: 'pboard-operations-v1' as const, boardId: 'board', segmentId: 's1', operations: [root, creation] };
    const plan = await planGardening({ boardId: 'board', snapshots, segments: [{ fileId: 'old', segment, createdAt: date }, { fileId: 'recent', segment, createdAt: new Date().toISOString() }] });
    expect(plan.eligibleSegmentIds).toEqual(['old']); expect(plan.retainedSnapshotIds).toHaveLength(3);
    const late = { ...segment, segmentId: 'late', operations: [operation('late', 1, patch({ content: 'late' }), { base: 2 }, 3)] };
    expect((await planGardening({ boardId: 'board', snapshots, segments: [{ fileId: 'late', segment: late, createdAt: date }] })).eligibleSegmentIds).toEqual([]);
    expect((await planGardening({ boardId: 'board', snapshots: snapshots.slice(0, 2), segments: [{ fileId: 'old', segment, createdAt: date }] })).eligibleSegmentIds).toEqual([]);
  });
});

it('uses the same locale-independent tie order in RxDB and the canonical engine', async () => {
  const { compareOrdered } = await import('../../src/storage/orderKey');
  const e = new OperationEngine('board');
  await e.receive([root, operation('upper', 1, card('A'), { base: 1 }, 2), operation('lower', 1, card('a'), { base: 1 }, 2)]);
  const ids = e.state().cards.map(card=>card.id);
  expect(ids).toEqual(['A','a']);
  expect([{ id: 'a', orderKey: 'a0' }, { id: 'A', orderKey: 'a0' }].sort(compareOrdered).map(card=>card.id)).toEqual(ids);
});
