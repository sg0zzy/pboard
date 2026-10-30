import { expect, it } from 'vitest';
import { OperationEngine } from '../../src/sync/operations/engine';
import { createSnapshot } from '../../src/sync/operations/snapshots';
import type { Operation } from '../../src/sync/operations/protocol';

it('measures synthetic incremental application versus whole-board clone/serialization work', async () => {
  const engine = new OperationEngine('board'), date = '2026-01-01';
  const make = (seq: number, fields: Operation['fields'], kind: Operation['kind'] = 'create', entityId = `card-${seq}`): Operation => ({
    schemaVersion: 1, boardId: 'board', actorId: 'writer', seq, opId: `writer:${seq}`, clock: seq,
    deps: seq > 1 ? { writer: seq - 1 } : {}, collection: seq === 1 ? 'projects' : 'cards', entityId: seq === 1 ? 'board' : entityId,
    kind, fields, unset: []
  });
  await engine.receive([make(1, { name: 'Synthetic board', template: 'project', createdAt: date, updatedAt: date })]);
  const count = 1000, edits = 100;
  for (let from = 0; from < count; from += 100) {
    await engine.receive(Array.from({ length: 100 }, (_, n) => make(from + n + 2,
      { content: 'Representative synthetic card text. '.repeat(10), title: `Card ${from + n}`, type: 'task', status: 'candidate', orderKey: 'a0', createdAt: date, updatedAt: date })));
  }
  const baseline = engine.state(), oldCpu = process.cpuUsage(), oldStart = performance.now();
  let serializedBytes = 0;
  for (let n = 0; n < edits; n++) {
    baseline.cards[0].content = `Edit ${n}`;
    serializedBytes += JSON.stringify(structuredClone(baseline)).length;
  }
  const wholeBoard = { elapsedMs: performance.now() - oldStart, cpuMs: (process.cpuUsage(oldCpu).user + process.cpuUsage(oldCpu).system) / 1000, serializedBytes };
  const appliedBefore = engine.metrics.applied, newCpu = process.cpuUsage(), start = performance.now();
  for (let n = 0; n < edits; n++) {
    await engine.receive([make(count + n + 2, { content: `Edit ${n}` }, 'patch', 'card-2')]);
    engine.entity('cards', 'card-2');
  }
  const incremental = { elapsedMs: performance.now() - start, cpuMs: (process.cpuUsage(newCpu).user + process.cpuUsage(newCpu).system) / 1000 };
  const snapshotStart = performance.now(); const snapshot = await createSnapshot(engine);
  const snapshotMs = performance.now() - snapshotStart;
  expect(engine.metrics.applied - appliedBefore).toBe(edits);
  expect(Object.keys(snapshot.checkpoint.receipts)).toHaveLength(count + edits + 1);
  process.stdout.write(`operation-protocol microbenchmark (Node, synthetic; not integrated browser evidence) ${JSON.stringify({ cards: count, edits, wholeBoardCloneAndSerialize: wholeBoard, incrementalHashApplyAndReadEntity: incremental, snapshotMs })}\n`);
});
