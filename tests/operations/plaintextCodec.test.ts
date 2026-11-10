import { describe, expect, it } from 'vitest';
import { createPlaintextOperationCodec } from '../../src/sync/operations/plaintextCodec';
import type { Operation } from '../../src/sync/operations/protocol';

const op: Operation = { schemaVersion: 1, boardId: 'board', actorId: 'actor', seq: 1,
  opId: 'actor:1', clock: 1, deps: {}, collection: 'cards', entityId: 'card',
  kind: 'patch', fields: { content: 'hello' }, unset: [] };

describe('versioned plaintext relay codec', () => {
  it('round trips a validated operation', async () => {
    const codec = createPlaintextOperationCodec('board');
    expect(await codec.open(await codec.seal(op), op.opId)).toEqual(op);
  });

  it('rejects altered content, wrong identity, and a different board', async () => {
    const codec = createPlaintextOperationCodec('board');
    const encoded = await codec.seal(op);
    const modified = JSON.parse(encoded);
    modified.operation.fields.content = 'changed';
    await expect(codec.open(JSON.stringify(modified), op.opId)).rejects.toThrow(/integrity/);
    await expect(codec.open(encoded, 'actor:2')).rejects.toThrow(/identifier/);
    await expect(createPlaintextOperationCodec('other').open(encoded, op.opId)).rejects.toThrow();
  });

  it('rejects unversioned and malformed payloads', async () => {
    const codec = createPlaintextOperationCodec('board');
    await expect(codec.open(JSON.stringify(op), op.opId)).rejects.toThrow();
    await expect(codec.open('{"format":"x","format":"y"}', op.opId)).rejects.toThrow();
  });
});
