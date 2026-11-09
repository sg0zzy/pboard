import { describe, expect, it } from 'vitest';
import { generateBoardContentKey, sealOp } from '../../src/sync/bufferCrypto';
import { OperationEngine } from '../../src/sync/operations/engine';
import { prepareFencedLegacyMigration, type LegacyMigrationIntent, type LegacyMigrationPreparation } from '../../src/sync/operations/legacyMigrationPreparation';
import type { Operation } from '../../src/sync/operations/protocol';
import type { OperationSnapshot } from '../../src/sync/operations/snapshots';

const create: Operation = { schemaVersion: 1, boardId: 'board', actorId: 'actor', seq: 1, opId: 'actor:1', clock: 1, deps: {},
  collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Before', template: 'project', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, unset: [] };
const edit: Operation = { ...create, seq: 2, opId: 'actor:2', clock: 2, deps: { actor: 1 }, kind: 'patch', fields: { name: 'After' } };

async function fixture() {
  const engine = new OperationEngine('board'); await engine.receive([create]);
  const key = await generateBoardContentKey();
  const row = { seq: 1, opId: edit.opId, payload: JSON.stringify(await sealOp(key, edit.opId, edit)) };
  let saved: LegacyMigrationIntent | null = null, durable: OperationSnapshot | null = null;
  const options: LegacyMigrationPreparation = {
    boardId: 'board', generation: 'attempt', after: 0, baseline: engine.checkpoint(),
    fence: async () => 1, readWindow: async () => [row], key: async () => key,
    journal: { reserve: async () => {}, load: async () => saved, save: async value => { saved = structuredClone(value); } },
    publish: async value => { durable = structuredClone(value); },
    readback: async () => { if (!durable) throw new Error('missing'); return structuredClone(durable); }
  };
  return { options, saved: () => saved };
}

describe('fenced migration preparation', () => {
  it('does not fence until the attempt identity is durably reserved', async () => {
    const { options } = await fixture(); let fenced = false;
    options.journal.reserve = async () => { throw new Error('journal unavailable'); };
    options.fence = async () => { fenced = true; return 1; };
    await expect(prepareFencedLegacyMigration(options)).rejects.toThrow('journal unavailable');
    expect(fenced).toBe(false);
  });
  it('retains an intent and verifies the recovered snapshot from durable readback', async () => {
    const { options, saved } = await fixture();
    const result = await prepareFencedLegacyMigration(options);
    expect(saved()?.snapshot.snapshotId).toBe(result.snapshot.snapshotId);
    expect(OperationEngine.restore(result.snapshot.checkpoint).entity('projects', 'board')).toMatchObject({ name: 'After' });
  });

  it('retries the same snapshot after an interrupted publish', async () => {
    const { options, saved } = await fixture();
    const publish = options.publish; let first = true;
    options.publish = async snapshot => { if (first) { first = false; throw new Error('interrupted'); } await publish(snapshot); };
    await expect(prepareFencedLegacyMigration(options)).rejects.toThrow('interrupted');
    const snapshotId = saved()!.snapshot.snapshotId;
    expect((await prepareFencedLegacyMigration(options)).snapshot.snapshotId).toBe(snapshotId);
  });

  it('does not publish a missing-key or incomplete relay window', async () => {
    const { options, saved } = await fixture();
    options.key = async () => undefined;
    await expect(prepareFencedLegacyMigration(options)).rejects.toThrow('missing-key');
    expect(saved()).toBeNull();
    options.readWindow = async () => [];
    await expect(prepareFencedLegacyMigration(options)).rejects.toThrow('invalid-window');
    expect(saved()).toBeNull();
  });

  it('never accepts a different snapshot as successful readback', async () => {
    const { options, saved } = await fixture();
    options.readback = async () => { const result = structuredClone(saved()!.snapshot); result.integrity = 'bad'; return result; };
    await expect(prepareFencedLegacyMigration(options)).rejects.toThrow(/integrity/);
    expect(saved()).not.toBeNull();
  });

  it('does not publish when a cancelled and recreated fence has a newer watermark', async () => {
    const { options } = await fixture(); let fences = 0, published = false;
    options.fence = async () => ++fences === 1 ? 1 : 2;
    options.publish = async () => { published = true; };
    await expect(prepareFencedLegacyMigration(options)).rejects.toThrow('fence changed');
    expect(published).toBe(false);
  });
});
