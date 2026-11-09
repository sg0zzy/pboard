import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { LocalOperationStore } from '../../src/sync/operations/localStore';
import { OperationSession } from '../../src/sync/operations/session';
import type { Command } from '../../src/sync/operations/protocol';
import { ImmutableDriveFake } from './driveFake';
import { DriveQuotaExceededError } from '../../src/sync/driveQuota';
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
/** The log-path snapshot publication the consolidation cycle performs; tests
 * drive it directly to stay about the session, not the relay. */
async function publishLogSnapshot(session: OperationSession) {
  const { snapshot } = await session.prepareLogSnapshot();
  await session.publishLogSnapshot(snapshot);
  return snapshot.snapshotId;
}

describe('operation session integration against simulated regular Drive', () => {
  it('drains more than one journal page after an offline period and stops on refusal', async () => {
    const fake = new ImmutableDriveFake();
    let accept = false, delivered = 0;
    const { local, session } = await client(fake, crypto.randomUUID(), { realtime: true, broadcast: async operations => {
      if (!accept) return false;
      delivered += operations.length; return true;
    } });
    for (let i = 0; i < 520; i++) await local.append('board', board, { frontier: {}, clock: 0 });
    await session.broadcastUnsent();
    expect((await local.unsent('board')).length).toBe(512);
    expect(delivered).toBe(0);
    accept = true;
    await session.broadcastUnsent();
    expect(delivered).toBe(520);
    expect(await local.unsent('board')).toEqual([]);
  });
  it('manual sync discovers remote segments while realtime is connected and keeps unpublished edits', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake);
    await b.session.sync(); await b.session.edit(patch({ title: 'Local pending' }));
    await a.session.edit(patch({ content: 'Remote edit' })); await a.session.sync();
    await b.session.sync(true); await a.session.sync(true);
    expect(b.session.state().cards[0]).toMatchObject({ title: 'Local pending', content: 'Remote edit' });
    expect(a.session.state()).toEqual(b.session.state());
  });
  it('consolidating through the log covers history that only ever travelled through Drive segments', async () => {
    // A board that switches to the operation log keeps the history it published as
    // Drive segments: the sync loop reads every `operations-*` file unconditionally,
    // and what a checkpoint must prove before those files may be collected is receipt
    // coverage per operation. Both halves matter — if adoption silently stopped, or if
    // a log-path snapshot failed to cover the adopted operations, migrating a legacy
    // board would mean choosing between its old edits and its new log.
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake);
    await b.session.sync();
    await a.session.edit(patch({ content: 'Legacy edit, never in the log' }));
    await a.session.sync();
    await b.session.sync(true);
    expect(b.session.state().cards[0]).toMatchObject({ content: 'Legacy edit, never in the log' });

    const drive = fake.store();
    const published: string[] = [];
    for (const file of [...fake.files.values()].filter(entry => entry.name.startsWith('operations-'))) {
      for (const operation of (await drive.readSegment(file.id)).operations) published.push(operation.opId);
    }
    expect(published.length).toBeGreaterThan(0);

    const { snapshot } = await b.session.prepareLogSnapshot();
    for (const opId of published) expect(Object.keys(snapshot.checkpoint.receipts)).toContain(opId);
  });

  it('keeps realtime switched on when a role check cannot run, and off when access is revoked', async () => {
    // The quota ledger refuses requests during an ordinary editing burst. Reading
    // that as lost access turned realtime off for the rest of the session — the
    // data channel stayed open while incoming operations were ignored — so a
    // collaborator went silent with nothing wrong but a throttled minute.
    const fake = new ImmutableDriveFake();
    await seeded(fake);
    const enabled: boolean[] = [];
    const quota = () => { throw new DriveQuotaExceededError('drive quota ledger: deferred', { reason: 'rateLimitExceeded' }, 100, 60_000); };
    const b = await client(fake, crypto.randomUUID(), { role: quota, setRealtimeEnabled: async (value: boolean) => { enabled.push(value); } });
    await b.session.setRealtime(true); enabled.length = 0;
    await expect(b.session.sync()).rejects.toThrow(/quota ledger/);
    expect(enabled).toEqual([]);
    await expect(b.session.receiveRealtime([])).rejects.toThrow(/quota ledger/); // the role check runs before anything is applied
    expect(enabled).toEqual([]);
    // Quota was only the first failure anyone noticed. Any error means the question
    // was never answered, and the sidebar re-enables realtime on its next role
    // refresh ten seconds later, so closing the room for one made the room restart
    // about every ten seconds — `starts` in `pboardCollaboration()` climbing past
    // sixty — and a peer connection rebuilt on that schedule never finishes ICE.
    // The failure is recorded instead of acted on, so it is still findable.
    const broken = await client(fake, crypto.randomUUID(), {
      role: () => { throw new Error('Request failed with status 503'); },
      setRealtimeEnabled: async (value: boolean) => { enabled.push(value); },
    });
    await broken.session.setRealtime(true); enabled.length = 0;
    await expect(broken.session.sync()).rejects.toThrow(/503/);
    expect(enabled).toEqual([]);
    expect(broken.session.metrics).toMatchObject({ roleCheckFailures: 1, roleCheckError: 'Request failed with status 503' });
    // A real revocation still closes the room.
    const revoked = await client(fake, crypto.randomUUID(), { role: async () => 'revoked' as const, setRealtimeEnabled: async (value: boolean) => { enabled.push(value); } });
    await revoked.session.setRealtime(true); enabled.length = 0;
    await expect(revoked.session.sync()).rejects.toThrow(/revoked/);
    expect(enabled).toEqual([false]);
  });
  it('forgets a Drive file it can list but no longer read, and retries one that merely failed', async () => {
    // Drive lists a compacted segment for minutes after deleting it. Each listing used
    // to cost a download that answered 404, and the rejection stopped that poll
    // applying anything else — so a board with one vanished file stopped synchronising
    // at all, and paid for the privilege every poll forever.
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake);
    await b.session.sync();
    await a.session.edit(patch({ content: 'Later edit' })); await a.session.sync();
    fake.files.set('vanished', { id: 'vanished', name: 'operations-vanished.json', parents: ['folder'], body: '{ "operations": [] }', createdTime: '2026-01-02T00:00:00Z' });
    fake.unreadable.add('vanished');
    fake.requests.length = 0;
    await b.session.sync();
    expect(b.session.state().cards[0]).toMatchObject({ content: 'Later edit' }); // the files that do exist still arrived
    expect(b.session.metrics.goneResources).toBe(1);
    expect((await b.local.downloadedFiles('board')).has('vanished')).toBe(true);
    expect(fake.requests.filter(request => request.url.includes('vanished') && request.url.includes('alt=media'))).toHaveLength(1);
    fake.requests.length = 0;
    await b.session.sync(true);
    expect(fake.requests.filter(request => request.url.includes('vanished'))).toEqual([]); // Drive's answer is terminal: never asked again
    // A 500 is not a verdict about the file, and swallowing it would lose the segment.
    const c = await client(fake), segment = [...fake.files.values()].find(file => file.name.startsWith('operations-') && file.id !== 'vanished')!;
    fake.failing.add(segment.id);
    await expect(c.session.sync()).rejects.toThrow(/500/);
    expect((await c.local.downloadedFiles('board')).has(segment.id)).toBe(false);
    fake.failing.delete(segment.id);
    await c.session.sync();
    expect(c.session.state().cards[0]).toMatchObject({ content: 'Later edit' });
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
  it('rejects delivery interrupted while a Drive role check is pending', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake);
    let finish!: (role: 'editor') => void;
    const pending = new Promise<'editor'>(resolve => { finish = resolve; });
    const b = await client(fake, crypto.randomUUID(), { realtimeRole: () => pending });
    await b.session.sync();
    const operation = await a.session.edit(patch({ content: 'Retry me' }));
    const delivery = b.session.receiveRealtime([operation]);
    await b.session.setRealtime(false);
    finish('editor');
    await expect(delivery).rejects.toThrow(/interrupted/);
    await expect(b.session.receiveRealtime([operation])).rejects.toThrow(/no longer active/);
    expect(b.session.state().cards[0].content).not.toBe('Retry me');
    await b.session.setRealtime(true);
    await b.session.receiveRealtime([operation]);
    expect(b.session.state().cards[0].content).toBe('Retry me');
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
  it('allows normal editing while a snapshot upload is paused', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), store = a.session.options.drive;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const publish = store.publishSnapshot;
    vi.spyOn(store, 'publishSnapshot').mockImplementation(async (...args) => { started(); await gate; return publish(...args); });
    const prepared = await a.session.prepareLogSnapshot();
    const publishing = a.session.publishLogSnapshot(prepared.snapshot); await ready;
    await a.session.edit(patch({ title: 'During compaction' })); release(); await publishing;
    await a.session.sync(); const b = await client(fake); await b.session.sync();
    expect(b.session.state().cards[0].title).toBe('During compaction');
  });
  it('publishes concurrent owner snapshots without a lock or mutable pointer, and recovers without the compacted logs', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake); await b.session.sync();
    await a.session.edit(patch({ title: 'A' })); await b.session.edit(patch({ content: 'B' }));
    await Promise.all([publishLogSnapshot(a.session), publishLogSnapshot(b.session)]);
    const snapshots = [...fake.files.values()].filter(file => file.name.startsWith('snapshot-'));
    expect(snapshots).toHaveLength(2);
    // Test recovery from retained checkpoints; actual gardening is a separate
    // preview and confirmation flow, not exercised as a production deletion.
    for (const file of [...fake.files.values()]) if (file.name.startsWith('operations-')) fake.files.delete(file.id);
    const fresh = await client(fake); await fresh.session.sync();
    expect(fresh.session.state().cards[0]).toMatchObject({ title: 'A', content: 'B' });
  });
  it('refuses to publish another session\'s unprepared snapshot and never re-uploads a published one', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake), b = await client(fake);
    const { snapshot } = await a.session.prepareLogSnapshot();
    await a.session.publishLogSnapshot(snapshot);
    const published = [...fake.files.values()].filter(file => file.name.startsWith('snapshot-'));
    expect(published).toHaveLength(1);
    await a.session.publishLogSnapshot(snapshot);
    expect([...fake.files.values()].filter(file => file.name.startsWith('snapshot-'))).toEqual(published);
    const foreign = await b.session.prepareLogSnapshot();
    await expect(a.session.publishLogSnapshot(foreign.snapshot)).rejects.toThrow('Snapshot was never prepared');
  });
  it('recovers a snapshot upload whose success acknowledgement was lost', async () => {
    const fake = new ImmutableDriveFake(), a = await seeded(fake);
    const { snapshot } = await a.session.prepareLogSnapshot();
    fake.timeoutNext = true; await expect(a.session.publishLogSnapshot(snapshot)).rejects.toThrow();
    const snapshots = [...fake.files.values()].filter(file => file.name.startsWith('snapshot-')); expect(snapshots).toHaveLength(1);
    await a.session.publishLogSnapshot(snapshot);
    expect(JSON.parse(snapshots[0].body).snapshotId).toBe(snapshot.snapshotId);
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
  await remote.session.sync(); await remote.session.edit(patch({ content: 'Durable new checkpoint' })); await publishLogSnapshot(remote.session);
  await a.session.sync(); await b.session.sync();
  expect(b.session.state()).toEqual(a.session.state()); expect(b.session.state().cards[0].content).toBe('Durable new checkpoint');
});
