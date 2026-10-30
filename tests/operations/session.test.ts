import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { LocalOperationStore } from '../../src/sync/operations/localStore';
import { OperationSession } from '../../src/sync/operations/session';
import type { Command } from '../../src/sync/operations/protocol';
import { ImmutableDriveFake } from './driveFake';
import { DRIVE_MAX_UNPUBLISHED_MS, DRIVE_POLL_MS } from '../../src/sync/syncPolicy';
const date = '2026-01-01';
const board: Command = { collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Board', template: 'project', createdAt: date, updatedAt: date }, unset: [] };
const card: Command = { collection: 'cards', entityId: 'card', kind: 'create', fields: { content: 'Initial', type: 'task', status: 'candidate', orderKey: 'a0', createdAt: date, updatedAt: date }, unset: [] };
const patch = (fields: Command['fields']): Command => ({ collection: 'cards', entityId: 'card', kind: 'patch', fields, unset: [] });
const cleanup: (() => Promise<void>)[] = [];
async function client(fake: ImmutableDriveFake, name = crypto.randomUUID(), hooks: Partial<ConstructorParameters<typeof OperationSession>[0]> = {}) {
  const journal = new ChangeJournal(name); await journal.open(); const local = new LocalOperationStore(journal);
  const session = new OperationSession({ boardId: 'board', local, drive: fake.store(), role: async () => fake.role, batchDelayMs: 60000, ...hooks });
  cleanup.push(async () => { await session.close(); journal.close(); });
  await session.open(); return { journal, local, session, name };
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
async function seeded(fake: ImmutableDriveFake) { const a = await client(fake); await a.session.edit(board); await a.session.edit(card); await a.session.sync(); return a; }

describe('operation session integration against simulated regular Drive', () => {
  it('manual sync discovers remote segments while realtime is connected and keeps unpublished edits', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake);
    await b.session.sync(); await b.session.edit(patch({ title: 'Local pending' }));
    await a.session.edit(patch({ content: 'Remote edit' })); await a.session.sync();
    await b.session.sync(true); await a.session.sync(true);
    expect(b.session.state().cards[0]).toMatchObject({ title: 'Local pending', content: 'Remote edit' });
    expect(a.session.state()).toEqual(b.session.state());
  });
  it('edits immediately with all network calls failing, survives restart and later publishes', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake);
    await a.session.setRealtime(false); fake.offline = true;
    await a.session.edit(patch({ content: 'Durable offline draft' }));
    expect(a.session.state().cards[0].content).toBe('Durable offline draft');
    await expect(a.session.sync()).rejects.toThrow();
    await a.session.close(); a.journal.close();
    const resumed = await client(fake, a.name); expect(resumed.session.state().cards[0].content).toBe('Durable offline draft');
    fake.offline = false; fake.role = 'editor'; await resumed.session.sync(true);
    const b = await client(fake); await b.session.sync(); expect(b.session.state()).toEqual(resumed.session.state());
  });
  it('converges two offline editors with WebRTC disabled and the owner absent throughout', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake); await b.session.sync();
    fake.role = 'editor'; await a.session.setRealtime(false); await b.session.setRealtime(false);
    await a.session.edit(patch({ title: 'A', content: 'A' })); await b.session.edit(patch({ status: 'done', content: 'B' }));
    await b.session.sync(); await a.session.sync(); await b.session.sync();
    expect(a.session.state()).toEqual(b.session.state());
    expect(a.session.state().cards[0]).toMatchObject({ title: 'A', status: 'done' });
  });
  it('deduplicates realtime followed by Drive, repeated sync and reconnection', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake); await b.session.sync();
    const op = await a.session.edit(patch({ title: 'Realtime' }));
    await b.session.receiveRealtime([op, op]); await a.session.sync(); await b.session.sync();
    const downloads = b.session.metrics.downloadedSegments;
    await b.session.sync(); expect(b.session.metrics.downloadedSegments).toBe(downloads);
    await b.session.setRealtime(false); await b.session.setRealtime(true); await b.session.receiveRealtime([op]);
    expect(a.session.state()).toEqual(b.session.state());
  });
  it('recovers successful uploads with lost acknowledgement without duplicate logical operations or files', async () => {
    const fake = new ImmutableDriveFake(), a = await client(fake); await a.session.edit(board);
    fake.timeoutNext = true; await expect(a.session.sync()).rejects.toThrow();
    expect(fake.files.size).toBe(1);
    await a.session.close(); a.journal.close();
    const resumed = await client(fake, a.name); await resumed.session.sync(true);
    expect(fake.files.size).toBe(1); expect((await resumed.local.outbox('board'))[0].driveFileId).toBeTruthy();
  });
  it('allows normal editing while a compaction upload is paused', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), store = a.session.options.drive;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const publish = store.publishSnapshot;
    vi.spyOn(store, 'publishSnapshot').mockImplementation(async (...args) => { started(); await gate; return publish(...args); });
    const compacting = a.session.compact(); await ready;
    await a.session.edit(patch({ title: 'During compaction' })); release(); await compacting;
    await a.session.sync(); const b = await client(fake); await b.session.sync();
    expect(b.session.state().cards[0].title).toBe('During compaction');
  });
  it('publishes concurrent owner snapshots without a lock or mutable pointer, and recovers without the compacted logs', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake); await b.session.sync();
    await a.session.edit(patch({ title: 'A' })); await b.session.edit(patch({ content: 'B' }));
    await Promise.all([a.session.compact(), b.session.compact()]);
    const snapshots = [...fake.files.values()].filter(file => file.name.startsWith('snapshot-'));
    expect(snapshots).toHaveLength(2);
    // Test recovery from retained checkpoints; actual gardening is a separate
    // preview and confirmation flow, not exercised as a production deletion.
    for (const file of [...fake.files.values()]) if (file.name.startsWith('operations-')) fake.files.delete(file.id);
    const fresh = await client(fake); await fresh.session.sync();
    expect(fresh.session.state().cards[0]).toMatchObject({ title: 'A', content: 'B' });
  });
  it('refuses editor/viewer compaction and repeated activation shares one local job', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake);
    fake.role = 'viewer'; await expect(a.session.compact()).rejects.toThrow();
    fake.role = 'editor'; await expect(a.session.compact()).rejects.toThrow();
    fake.role = 'owner'; const first = a.session.compact(), second = a.session.compact();
    expect(first).toBe(second); await first;
    expect([...fake.files.values()].filter(file => file.name.startsWith('snapshot-'))).toHaveLength(1);
  });
  it('recovers a snapshot upload whose success acknowledgement was lost', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake);
    fake.timeoutNext = true; await expect(a.session.compact()).rejects.toThrow();
    const snapshots = [...fake.files.values()].filter(file => file.name.startsWith('snapshot-')); expect(snapshots).toHaveLength(1);
    const id = await a.session.compact(); expect(id).toBe(JSON.parse(snapshots[0].body).snapshotId);
    expect([...fake.files.values()].filter(file => file.name.startsWith('snapshot-'))).toHaveLength(1);
  });
  it('revalidates an established realtime session and closes it on revocation while preserving the outbox', async () => {
    const fake = new ImmutableDriveFake(), transport = vi.fn(async () => {}), a = await seeded(fake);
    const b = await client(fake, crypto.randomUUID(), { setRealtimeEnabled: transport }); await b.session.sync();
    const edit = await a.session.edit(patch({ title: 'Not admitted' })); fake.role = 'revoked';
    await expect(b.session.receiveRealtime([edit])).rejects.toThrow(); fake.role = 'editor';
    expect(transport).toHaveBeenCalledWith(false); expect(b.session.state().cards[0].title).toBeUndefined();
    expect((await a.local.outbox('board')).some(row => !row.driveFileId)).toBe(true);
  });
  it('continues durable Drive polling with WebRTC disabled and stops timers on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); const fake = new ImmutableDriveFake(), a = await client(fake, crypto.randomUUID(), { pollMinMs: 1000, pollMaxMs: 2000, random: () => 1 });
    await a.session.setRealtime(false); expect(a.session.metrics.syncs).toBe(0); await vi.advanceTimersByTimeAsync(2000);
    await a.session.close(); const calls = fake.requests.length; await vi.advanceTimersByTimeAsync(10000); expect(fake.requests.length).toBe(calls);
  });  it('projects local edits from concurrent contexts sharing one durable stream', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake, a.name);
    await a.session.edit(patch({ title: 'First context' }));
    await b.session.edit(patch({ content: 'Second context' }));
    expect(b.session.state().cards[0]).toMatchObject({ title: 'First context', content: 'Second context' });
    await a.session.edit(patch({ status: 'done' }));
    expect(a.session.state().cards[0]).toMatchObject({ title: 'First context', content: 'Second context', status: 'done' });
  });

});

describe('delayed automatic Drive publication', () => {
  it('persists and broadcasts immediately, then flushes at 25 minutes despite continued editing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = new ImmutableDriveFake(), broadcast = vi.fn(async () => true);
    const a = await client(fake, crypto.randomUUID(), { polling: false, batchDelayMs: undefined, broadcast });
    await a.session.edit(board); await a.session.edit(card);
    expect(a.session.state().cards[0].content).toBe('Initial');
    expect((await a.local.outbox('board', true))).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(fake.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(24 * 60_000);
    await a.session.edit(patch({ title: 'Still editing' }));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(a.session.metrics.publishedSegments).toBeGreaterThan(0));
    expect(await a.session.unpublished()).toBe(0);
    expect([...fake.files.values()].some(file => file.body.includes('Still editing'))).toBe(true);
  });

  it('restores the oldest unpublished deadline after closing and reopening the local journal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = new ImmutableDriveFake(), a = await client(fake, crypto.randomUUID(), { polling: false, batchDelayMs: undefined });
    await a.session.edit(board);
    const timing = await a.local.pendingTiming('board');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await a.session.close(); a.journal.close();
    const resumed = await client(fake, a.name, { polling: false, batchDelayMs: undefined });
    expect(await resumed.local.pendingTiming('board')).toEqual(timing);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(resumed.session.metrics.publishedSegments).toBe(1));
  });

  it('polls at ten minutes without uploading younger operations, while manual sync flushes immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = new ImmutableDriveFake(), a = await client(fake, crypto.randomUUID(), { batchDelayMs: undefined, random: () => 0 });
    await a.session.edit(board);
    await vi.advanceTimersByTimeAsync(DRIVE_POLL_MS - 1);
    expect(fake.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(a.session.metrics.syncs).toBe(1));
    expect(fake.requests.every(request => request.method === 'GET')).toBe(true);
    expect(await a.session.unpublished()).toBe(1);
    await a.session.sync(true);
    expect(await a.session.unpublished()).toBe(0);
    a.session.setPolling(false);
    const calls = fake.requests.length;
    await vi.advanceTimersByTimeAsync(DRIVE_MAX_UNPUBLISHED_MS);
    expect(fake.requests).toHaveLength(calls);
  });
});
it('recovers operations downloaded by another extension context before allocating a causally later edit', async () => {
  const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake, a.name), remote = await client(fake);
  await remote.session.sync(); const operation = await remote.session.edit(patch({ content: 'Received in the other context' })); await remote.session.sync();
  await a.session.sync(); // The download receipt is shared in IndexedDB.
  await b.session.sync();
  expect(b.session.state()).toEqual(a.session.state());
  const later = await b.session.edit(patch({ content: 'Causally later local edit' }));
  expect(later.clock).toBeGreaterThan(operation.clock); expect(later.deps[operation.actorId]).toBe(operation.seq);
  await b.session.sync(); await remote.session.sync(); expect(remote.session.state()).toEqual(b.session.state());
});
it('merges a checkpoint discovered by another extension context even after its file receipt is shared', async () => {
  const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake, a.name), remote = await client(fake);
  await remote.session.sync(); await remote.session.edit(patch({ content: 'Durable new checkpoint' })); await remote.session.compact();
  await a.session.sync(); await b.session.sync();
  expect(b.session.state()).toEqual(a.session.state()); expect(b.session.state().cards[0].content).toBe('Durable new checkpoint');
});
