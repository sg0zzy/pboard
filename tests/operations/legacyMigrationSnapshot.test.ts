import { describe, expect, it } from 'vitest';
import { OperationEngine } from '../../src/sync/operations/engine';
import { prepareLegacyMigrationSnapshot, verifyLegacyMigrationSnapshot } from '../../src/sync/operations/legacyMigrationSnapshot';
import { createSnapshot } from '../../src/sync/operations/snapshots';
import type { Operation } from '../../src/sync/operations/protocol';

const create: Operation = { schemaVersion: 1, boardId: 'board', actorId: 'actor', seq: 1, opId: 'actor:1', clock: 1, deps: {},
  collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Board', template: 'project', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, unset: [] };
const edit: Operation = { ...create, seq: 2, opId: 'actor:2', clock: 2, deps: { actor: 1 }, kind: 'patch', fields: { name: 'Recovered' } };

describe('migration snapshot readback', () => {
  it('builds a snapshot that preserves the baseline and recovered edits', async () => {
    const engine = new OperationEngine('board');
    await engine.receive([create]);
    const baseline = engine.checkpoint();
    const snapshot = await prepareLegacyMigrationSnapshot({ boardId: 'board', baseline, operations: [edit] });
    expect(OperationEngine.restore(snapshot.checkpoint).entity('projects', 'board')).toMatchObject({ name: 'Recovered' });
    await expect(verifyLegacyMigrationSnapshot({ boardId: 'board', baseline, expected: snapshot, readback: structuredClone(snapshot), operations: [edit] })).resolves.toBeUndefined();
  });

  it('does not build a snapshot when causal history is missing', async () => {
    const baseline = new OperationEngine('board').checkpoint();
    await expect(prepareLegacyMigrationSnapshot({ boardId: 'board', baseline, operations: [edit] })).rejects.toThrow(/incomplete/);
  });
  it('verifies recovered operations and the pre-existing baseline', async () => {
    const engine = new OperationEngine('board');
    await engine.receive([create]);
    const baseline = engine.checkpoint();
    await engine.receive([edit]);
    const snapshot = await createSnapshot(engine);
    await expect(verifyLegacyMigrationSnapshot({ boardId: 'board', baseline, expected: snapshot, readback: structuredClone(snapshot), operations: [edit] })).resolves.toBeUndefined();
  });

  it('rejects a valid snapshot that omits a recovered operation or the baseline', async () => {
    const engine = new OperationEngine('board');
    const empty = engine.checkpoint();
    await engine.receive([create]);
    const baseline = engine.checkpoint();
    const snapshot = await createSnapshot(engine);
    await expect(verifyLegacyMigrationSnapshot({ boardId: 'board', baseline, expected: snapshot, readback: snapshot, operations: [edit] })).rejects.toThrow(/does not cover operation/);
    const emptySnapshot = await createSnapshot(OperationEngine.restore(empty));
    await expect(verifyLegacyMigrationSnapshot({ boardId: 'board', baseline, expected: emptySnapshot, readback: emptySnapshot, operations: [] })).rejects.toThrow(/baseline/);
  });

  it('rejects a different valid readback and corrupted readback', async () => {
    const engine = new OperationEngine('board');
    await engine.receive([create]);
    const baseline = engine.checkpoint();
    const expected = await createSnapshot(engine), other = await createSnapshot(engine);
    await expect(verifyLegacyMigrationSnapshot({ boardId: 'board', baseline, expected, readback: other, operations: [] })).rejects.toThrow(/differs/);
    const broken = structuredClone(expected); broken.integrity = 'invalid';
    await expect(verifyLegacyMigrationSnapshot({ boardId: 'board', baseline, expected, readback: broken, operations: [] })).rejects.toThrow(/integrity/);
  });
});
