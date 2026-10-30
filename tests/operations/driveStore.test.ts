import { describe, expect, it } from 'vitest';
import { ImmutableDriveFake } from './driveFake';
import { canonical, digest, type Segment } from '../../src/sync/operations/protocol';
const op = { schemaVersion: 1 as const, boardId: 'board', actorId: 'actor', seq: 1, opId: 'actor:1', clock: 1, deps: {}, collection: 'projects' as const, entityId: 'board', kind: 'create' as const,
  fields: { name: 'Board', template: 'project', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, unset: [] };
const segment: Segment = { protocol: 'pboard-operations-v1', boardId: 'board', segmentId: 'segment', operations: [op] };



describe('regular Drive immutable operation storage', () => {
  it('uses pre-generated IDs and verifies immutable uploads, without PATCH or AppData in these requests', async () => {
    const fake = new ImmutableDriveFake(), store = fake.store();
    const id = await store.allocateId(); await store.publishSegment(id, segment); await store.publishSegment(id, segment);
    expect(fake.files.size).toBe(1); expect(await store.readSegment(id)).toEqual(segment);
    expect(await store.inventory()).toHaveLength(1);
    expect(fake.requests.some(r => r.method === 'PATCH' || r.url.includes('appData'))).toBe(false);
  });
  it('recovers ambiguous successful uploads by retrying the same Drive ID', async () => {
    const fake = new ImmutableDriveFake(), store = fake.store(), id = await store.allocateId(); fake.timeoutNext = true;
    await expect(store.publishSegment(id, segment)).rejects.toThrow(/timeout/);
    await store.publishSegment(id, segment); expect(fake.files.size).toBe(1);
  });
  it('rejects retry collisions rather than replacing existing content', async () => {
    const fake = new ImmutableDriveFake(), store = fake.store(), id = await store.allocateId();
    await store.publishSegment(id, segment);
    const changed = { ...segment, segmentId: 'changed' };
    await expect(store.publishSegment(id, changed)).rejects.toThrow(/mismatch/);
    expect(fake.files.get(id)?.body).toBe(canonical({ ...segment, integrity: await digest(segment) }));
  });
  it('checks actual parent membership and size before reading a same-named file', async () => {
    const fake = new ImmutableDriveFake(), store = fake.store(), id = await store.allocateId(); await store.publishSegment(id, segment);
    fake.files.get(id)!.parents = ['elsewhere']; await expect(store.readSegment(id)).rejects.toThrow(/location/);
  });
  it('revalidates permissions on each action and prevents writes after revocation', async () => {
    const fake = new ImmutableDriveFake(), store = fake.store(), id = await store.allocateId();
    fake.role = 'viewer'; await expect(store.publishSegment(id, segment)).rejects.toThrow(/permission/);
    fake.role = 'revoked'; await expect(store.inventory()).rejects.toThrow(/permission/);
    expect(fake.files.size).toBe(0);
  });
});

it('rejects an accidentally modified segment before accepting any operation', async () => {
  const fake = new ImmutableDriveFake(), store = fake.store(), id = await store.allocateId(); await store.publishSegment(id, segment);
  const saved = JSON.parse(fake.files.get(id)!.body); saved.operations[0].fields.name = 'Corrupted'; fake.files.get(id)!.body = JSON.stringify(saved);
  await expect(store.readSegment(id)).rejects.toThrow(/integrity/);
});
