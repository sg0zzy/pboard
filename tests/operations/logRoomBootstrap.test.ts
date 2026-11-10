import { expect, it, vi } from 'vitest';
import { createRoomCore } from '../../src/sync/operations/logRoom';
import type { Operation } from '../../src/sync/operations/protocol';

function operation(seq: number): Operation {
  return { schemaVersion: 1, boardId: 'board', actorId: 'actor', seq, opId: `actor:${seq}`, clock: seq,
    deps: seq > 1 ? { actor: seq - 1 } : {}, collection: 'cards', entityId: 'card', kind: 'patch',
    fields: { content: `edit ${seq}` }, unset: [] };
}
function row(seq: number) {
  return { seq, opId: `actor:${seq}`, payload: JSON.stringify(operation(seq)) };
}

it('applies all replay pages in bounded durable batches before reporting synced', async () => {
  const rows = Array.from({ length: 300 }, (_, index) => row(index + 1));
  const asked: number[] = [], received: number[] = [], saved: number[] = [];
  const synchronized = vi.fn();
  const core = await createRoomCore({
    boardId: 'board', seal: async op => JSON.stringify(op), open: async text => JSON.parse(text) as Operation,
    receive: async operations => { expect(operations.length).toBeLessThanOrEqual(128); received.push(operations.length); },
    cursor: { load: async () => 0, save: async seq => { saved.push(seq); } },
    ask: async (_action, body) => {
      const after = body.afterSeq as number; asked.push(after);
      return { action: 'window', operations: rows.slice(after, after + 200), liveFromSeq: 301, synced: true };
    },
    announce: () => {}, synchronized, background: () => {}
  });
  await core.bootstrap();
  expect(asked).toEqual([0, 200]);
  expect(received).toEqual([128, 72, 100]);
  expect(saved).toEqual([128, 200, 300]);
  expect(core.appliedSeq()).toBe(300);
  expect(synchronized).toHaveBeenCalledOnce();
  expect(synchronized).toHaveBeenCalledWith('synced', {});
});

it('does not advance past a replay chunk the local store rejected', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => row(index + 1));
  let calls = 0;
  const core = await createRoomCore({
    boardId: 'board', seal: async op => JSON.stringify(op), open: async text => JSON.parse(text) as Operation,
    receive: async () => { if (++calls === 2) throw new Error('local write failed'); },
    cursor: { load: async () => 0, save: async () => {} },
    ask: async (_action, body) => ({ action: 'window', operations: rows.slice(body.afterSeq as number), liveFromSeq: 201, synced: true }),
    announce: () => {}, synchronized: () => {}, background: () => {}
  });
  await expect(core.bootstrap()).rejects.toThrow('local write failed');
  expect(core.appliedSeq()).toBe(128);
  await core.bootstrap();
  expect(core.appliedSeq()).toBe(200);
});
