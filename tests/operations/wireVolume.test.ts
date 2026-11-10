import { expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { OperationEngine } from '../../src/sync/operations/engine';
import { createSnapshot } from '../../src/sync/operations/snapshots';
import { canonical, type Operation } from '../../src/sync/operations/protocol';

it('measures per-edit wire volume and retained state for both paths', async () => {
  const engine = new OperationEngine('board'), date = '2026-01-01';
  const make = (seq: number, fields: Operation['fields'], kind: Operation['kind'] = 'create', entityId = `card-${seq}`): Operation => ({
    schemaVersion: 1, boardId: 'board', actorId: 'writer', seq, opId: `writer:${seq}`, clock: seq,
    deps: seq > 1 ? { writer: seq - 1 } : {}, collection: seq === 1 ? 'projects' : 'cards',
    entityId: seq === 1 ? 'board' : entityId, kind, fields, unset: []
  });
  await engine.receive([make(1, { name: 'Representative board', template: 'project', createdAt: date, updatedAt: date })]);
  const cards = 1000;
  for (let from = 0; from < cards; from += 100) {
    await engine.receive(Array.from({ length: 100 }, (_, n) => make(from + n + 2,
      { content: 'Representative synthetic card text. '.repeat(10), title: `Card ${from + n}`, type: 'task', status: 'candidate', orderKey: 'a0', createdAt: date, updatedAt: date })));
  }
  const edit = make(cards + 2, { content: 'Edit 1' }, 'patch', 'card-2');
  const body = canonical(edit);
  const frame = JSON.stringify({ id: crypto.randomUUID(), index: 0, total: 1, text: body });
  const boardJson = JSON.stringify(structuredClone(engine.state()));
  const boardGzip = gzipSync(new TextEncoder().encode(boardJson));
  const checkpoint = await createSnapshot(engine);
  const engineJson = JSON.stringify(engine.state()), checkpointJson = JSON.stringify(checkpoint);
  const perEditOps = Math.floor(8000 / body.length);
  const batch = Array.from({ length: 128 }, (_, n) => make(cards + 300 + n, { content: `Edit ${n}` }, 'patch', 'card-2'));
  const batchBody = canonical({ protocol: 'pboard-operations-v1', kind: 'operations', operations: batch });
  const batchFrames = Math.ceil(batchBody.length / 8000);
  process.stdout.write(`per-edit wire volume and retained state (Node, synthetic, single client) ${JSON.stringify({
    editCanonicalBytes: body.length,
    editFrameBytes: frame.length,
    editsPerRealtimeFrame: perEditOps,
    wholeBoardJsonBytes: boardJson.length,
    wholeBoardGzipBytes: boardGzip.length,
    realtimeBufferBoundBytes: 16 * 1024 * 1024,
    engineRetainedJsonBytes: engineJson.length,
    checkpointJsonBytes: checkpointJson.length,
    receipts: Object.keys(checkpoint.checkpoint.receipts).length,
    batchCanonicalBytes: batchBody.length,
    batchFrames
  })}\n`);
  expect(body.length).toBeLessThanOrEqual(8000);
  expect(perEditOps).toBeGreaterThanOrEqual(1);
  expect(batchBody.length).toBeGreaterThan(8000);
  expect(checkpointJson.length).toBeGreaterThan(engineJson.length);
});
