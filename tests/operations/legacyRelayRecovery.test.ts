import { describe, expect, it } from 'vitest';
import { generateBoardContentKey, sealOp } from '../../src/sync/bufferCrypto';
import { recoverLegacyRelayWindow } from '../../src/sync/operations/legacyRelayRecovery';
import type { Operation } from '../../src/sync/operations/protocol';

const operation: Operation = { schemaVersion: 1, boardId: 'board', actorId: 'actor', seq: 1,
  opId: 'actor:1', clock: 1, deps: {}, collection: 'cards', entityId: 'card',
  kind: 'patch', fields: { content: 'preserve me' }, unset: [] };

describe('legacy relay recovery', () => {
  it('recovers a complete encrypted window without changing its input', async () => {
    const key = await generateBoardContentKey();
    const payload = JSON.stringify(await sealOp(key, operation.opId, operation));
    const rows = [{ seq: 4, opId: operation.opId, payload }];
    expect(await recoverLegacyRelayWindow({ boardId: 'board', after: 3, through: 4, rows, key }))
      .toEqual({ status: 'ready', operations: [operation], covered: 4 });
    expect(rows[0].payload).toBe(payload);
  });

  it('blocks missing and incorrect keys, corrupt data, and missing rows', async () => {
    const key = await generateBoardContentKey();
    const rows = [{ seq: 1, opId: operation.opId, payload: JSON.stringify(await sealOp(key, operation.opId, operation)) }];
    const base = { boardId: 'board', after: 0, through: 1, rows };
    expect(await recoverLegacyRelayWindow(base)).toMatchObject({ status: 'blocked', reason: 'missing-key' });
    expect(await recoverLegacyRelayWindow({ ...base, key: await generateBoardContentKey() })).toMatchObject({ status: 'blocked', reason: 'unreadable-row' });
    expect(await recoverLegacyRelayWindow({ ...base, key, rows: [{ ...rows[0], payload: '{}' }] })).toMatchObject({ status: 'blocked', reason: 'unreadable-row' });
    expect(await recoverLegacyRelayWindow({ ...base, key, through: 2 })).toMatchObject({ status: 'blocked', reason: 'invalid-window' });
  });

  it('refuses a valid ciphertext carrying an operation for another board', async () => {
    const key = await generateBoardContentKey();
    const rows = [{ seq: 1, opId: operation.opId, payload: JSON.stringify(await sealOp(key, operation.opId, operation)) }];
    expect(await recoverLegacyRelayWindow({ boardId: 'other', after: 0, through: 1, rows, key }))
      .toEqual({ status: 'blocked', reason: 'invalid-operation', sequence: 1 });
  });
});
