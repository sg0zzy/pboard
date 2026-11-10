import { describe, expect, it, vi } from 'vitest';
import { ImmutableDriveFake } from './driveFake';
import { canonical, digest, type Segment } from '../../src/sync/operations/protocol';
import { clearDriveResourceGoneMemory, isDriveGone } from '../../src/sync/driveHttp';
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
  it('adopts a board whose legacy copies were deleted or belong to another account', async () => {
    // A second device opening boards the first one migrated meets legacy files it
    // did not create — some of them deleted since. Neither may stop the board
    // opening: a deleted file cannot be written by anybody, and a file owned by
    // another account can only be locked by that owner.
    const fake = new ImmutableDriveFake(), store = fake.store();
    const seed = (id: string, ownedByMe: boolean) => fake.files.set(id, { id, name: 'project.json', parents: ['folder'], body: '{}', createdTime: '2026-01-01T00:00:00.000Z', ownedByMe });

    await store.protectLegacy('adopt-deleted'); // never readable: metadata 404
    await store.protectLegacy('adopt-deleted');
    expect(fake.requests.filter(request => request.url.includes('adopt-deleted'))).toHaveLength(1);

    seed('adopt-theirs', false);
    fake.refusePatch = true;
    await store.protectLegacy('adopt-theirs');
    expect(fake.files.get('adopt-theirs')!.contentRestrictions).toBeUndefined();

    // A file this account owns and Drive still refuses to restrict is a real
    // failure, and says so instead of failing as a storage error.
    seed('adopt-mine', true);
    await expect(store.protectLegacy('adopt-mine')).rejects.toThrow(/owns the file/);
  });
  it('paces repeated 404 restriction writes without declaring an owned file protected', async () => {
    vi.useFakeTimers();
    try {
      const fake = new ImmutableDriveFake(), store = fake.store();
      const id = 'owned-refused';
      fake.files.set(id, { id, name: 'project.json', parents: ['folder'], body: '{}', createdTime: '2026-01-01', ownedByMe: true });
      fake.refusePatch = true; fake.refusePatchStatus = 404;
      await expect(fake.store().protectLegacy(id)).rejects.toThrow(/owns the file/);
      await expect(store.protectLegacy(id)).rejects.toThrow(/owns the file/);
      expect(fake.requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
      fake.refusePatch = false;
      await vi.advanceTimersByTimeAsync(60_001);
      await store.protectLegacy(id);
      expect(fake.requests.filter(request => request.method === 'PATCH')).toHaveLength(2);
      expect(fake.files.get(id)?.contentRestrictions?.[0].readOnly).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('reports a file Drive deleted as gone, separately from every other failure', async () => {
    // A peer's presence file is deleted the moment its session leaves, so a
    // read of it races the deletion; the caller has to be able to tell "gone"
    // (the peer is no longer there) from a storage failure (retry, report).
    const fake = new ImmutableDriveFake(), store = fake.store(), id = await store.allocateId();
    clearDriveResourceGoneMemory();
    await store.publishSegment(id, segment);
    fake.files.delete(id);
    await expect(store.metadata(id)).rejects.toSatisfy(isDriveGone);
    fake.role = 'revoked';
    await expect(store.inventory()).rejects.not.toSatisfy(isDriveGone);
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
