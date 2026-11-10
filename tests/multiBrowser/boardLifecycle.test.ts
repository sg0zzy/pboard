/**
 * Account-level board discovery: one operation-log connection per browser on the
 * account room (`pboard-account-<hash>-order`), carrying small lifecycle records
 * so a second browser of the same Google account learns a board id in realtime
 * instead of waiting for a Drive listing poll.
 *
 * What these scenarios insist on, in the product's own terms:
 *  - a record is a *hint*. The only thing it can buy is a Drive read, and a board
 *    appears locally only when the live Drive ACL already grants this account a
 *    role. Nothing here may make a board interactive by itself.
 *  - the second browser must not have polled Drive to learn the id, so
 *    `reconcileAll` is counted and asserted to have run zero times. The claim
 *    under test is "the record was the source", not "the poll arrived first".
 *  - idempotence is measured in rows and subscriptions, not in bytes: a record
 *    that arrives twice must leave one project row and no extra board socket.
 *  - a browser that was never enrolled in the account room fails closed with a
 *    stated reason, opens no socket, and still opens boards normally.
 *
 * Timing: the suite runs without fake timers (two module graphs, fake IndexedDB
 * and a fake relay all doing real asynchronous I/O), so waiting means polling an
 * observable on zero-delay task-queue turns — the convention the rest of
 * `tests/multiBrowser` uses — never a fixed wall-clock sleep.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowser, createCloud, createSharedProfile, roomFor, type BrowserHandle, type BrowserRuntime, type Cloud } from './fixtures/browser';
import { hashBlob } from '../../src/storage/blobStore';
import { publicKeyFingerprint } from '../../src/collab/security/keys';
import type { DeviceRequest, EnrollmentBundle } from '../../src/collab/security/enrollment';

const OWNER = 'owner@example.com';
const STRANGER = 'stranger@example.com';

/** The account channel's report, as the runtime publishes it. */
type AccountChannelStatus = {
  account: string | null;
  state: string;
  reason: string;
  appliedSeq: number;
  lastKind: string | null;
  outbox: number;
  skipped: Record<string, number>;
  error: string | null;
  reconnectReason: string | null;
  throttled: boolean;
};

/** The account channel and the enrollment ceremony: both are on the runtime, and
 * the fixture's structural runtime type — written before either existed — lists
 * neither, so the scenario narrows it here rather than editing the shared file. */
type AccountRuntime = BrowserRuntime & {
  experimentalEnrollment: {
    initialize(kind: 'account'): Promise<EnrollmentBundle>;
    request(kind: 'account'): Promise<DeviceRequest>;
    approve(raw: string, deviceKeyId: string, email: string): Promise<EnrollmentBundle>;
    trust(raw: string, authorityFingerprint: string): Promise<unknown>;
  };
  accountChannel: {
    status(): AccountChannelStatus;
    start(): Promise<void>;
    close(): Promise<void>;
    publish(kind: 'board.created' | 'board.deleted' | 'board.metadata', boardId: string, extra?: { name?: string }): Promise<boolean>;
  };
};
const runtime = (browser: BrowserHandle) => browser.runtime as unknown as AccountRuntime;
const channelProblem = (browser: BrowserHandle) => JSON.stringify(runtime(browser).accountChannel.status());
/** The account room's own sockets as this browser holds them: one room, or a
 * retry loop that the missing-pin contract specifically forbids. */
const accountRoomSockets = (browser: BrowserHandle) => browser.rooms().filter(room => room.topic.startsWith('pboard-account-')).length;

/** Drive discovery — the thing the account channel is meant to beat. Counting
 * `reconcileAll` is how a scenario proves the record, not the listing, brought a
 * board id to this browser. */
function drivePollCounter(browser: BrowserHandle) {
  const provider = browser.runtime.googleDrive;
  const real = provider.reconcileAll.bind(provider);
  let polls = 0;
  provider.reconcileAll = (async (options?: Parameters<typeof real>[0]) => {
    polls++;
    return await real(options);
  }) as typeof provider.reconcileAll;
  return { polls: () => polls, restore: () => { provider.reconcileAll = real; } };
}

/** Sockets the relay admitted for one board's rooms, across every browser: the
 * subscription count for "a record must not open the board it announced". */
function boardSockets(cloud: Cloud, boardId: string) {
  return cloud.signaling.admitted.filter(entry => entry.room.includes(boardId)).length;
}

/**
 * Polls `observable` on zero-delay task-queue turns until it is true, within a
 * **real-time** budget (`performance.now`, which `vi.useFakeTimers({toFake:
 * ['Date']})` does not touch, unlike `Date.now`).
 *
 * The budget and the 1 ms yield matter: a zero-delay spin runs thousands of
 * turns in the time a single real millisecond takes, so it can exhaust any turn
 * count long before a recovery timer fires. That is not hypothetical — the
 * reconnect ladder is a real setTimeout, so a turn-bounded wait reported "never
 * recovered" for a channel that recovered 1 s later.
 */
async function until(observable: () => boolean, budgetMs = 20_000): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (observable()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  return observable();
}
/** The awaitable-observable form of `until`, with the same real-time budget. */
async function untilSettled(probe: () => Promise<boolean>, budgetMs = 20_000): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (await probe()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  return probe();
}

/**
 * A barrier for "nothing is in flight any more", built from an event this test
 * controls rather than from a duration. `sender` queues a lifecycle record that
 * is *inert at the receiver* (a `board.deleted` for an id nobody holds: the
 * channel applies it, the verification path answers `ignored`, and no row, no
 * folder and no socket follows), and the caller waits until the receiver's
 * frontier has passed it. The account room is one ordered log, so a record that
 * crossed it after that point is the only thing that can still move the
 * receiver's cursor.
 *
 * Returns the receiver's frontier once it is quiescent — the baseline a strict
 * "strictly greater" assertion needs, because sampling a raw value while the
 * previous scenario's records are still landing compares a value with itself.
 */
async function settledCursor(receiver: BrowserHandle, sender: BrowserHandle): Promise<number> {
  const before = runtime(receiver).accountChannel.status().appliedSeq;
  const barrier = crypto.randomUUID();
  if (!await runtime(sender).accountChannel.publish('board.deleted', barrier)) {
    throw new Error(`the barrier record could not be queued: ${channelProblem(sender)}`);
  }
  const crossed = await until(() => runtime(receiver).accountChannel.status().appliedSeq > before);
  if (!crossed) throw new Error(`the barrier record never crossed the account room; ${channelProblem(receiver)}`);
  return runtime(receiver).accountChannel.status().appliedSeq;
}

/** The account-scope authority ceremony, in the order the enrollment UI performs
 * it: the first device initializes the account authority and publishes its
 * manifest to Drive; the second requests admission; the owner approves it after
 * verifying the device fingerprint and the Google email out of band; the second
 * trusts the returned bundle after verifying the authority fingerprint. What both
 * end up holding is an `account:<hash>` pin — the only thing that makes the
 * account room admissible for them. */
async function enrollSecondDevice(owner: BrowserHandle, joiner: BrowserHandle, email: string) {
  const request = await runtime(joiner).experimentalEnrollment.request('account');
  const bundle = await runtime(owner).experimentalEnrollment.approve(JSON.stringify(request), request.payload.deviceKeyId, email);
  await runtime(joiner).experimentalEnrollment.trust(JSON.stringify(bundle), await publicKeyFingerprint(bundle.authority));
}

/** Brings each browser's account channel to a reading state, driving the key
 * courier the way a reconcile round does: the device holding the account content
 * key answers the requests of devices enrolled since its last pass, so a second
 * browser may need that pass before its own grant appears. Every step is awaited;
 * nothing here waits on a timer. */
async function connectAccountChannel(...browsers: BrowserHandle[]) {
  for (let pass = 0; pass < 3; pass++) {
    for (const browser of browsers) await runtime(browser).accountChannel.start();
    if (browsers.every(browser => runtime(browser).accountChannel.status().state === 'connected')) return;
  }
}

describe('account-level board discovery', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let account = '';
  let discovered = '';
  /** The board T3 deleted while B held it; the delete-idempotence scenario
   * replays against this one because B has already handled its delete. */
  let erased = '';

  /** The relay sockets currently admitted to this account's own room — the
   * connections the scenarios kill when a transport has to die mid-session. */
  const accountSockets = () => cloud.signaling.sockets.filter(socket => socket.room?.board === `account:${account}`);
  /** The account room's own record, for assertions about what crossed it. */
  const accountRoom = () => [...cloud.signaling.rooms.values()].find(room => room.board === `account:${account}`);

  beforeAll(async () => {
    cloud = createCloud();
    // Two browser contexts, one Google account: the case the channel exists for.
    a = await createBrowser({ label: 'laptop', email: OWNER, cloud });
    b = await createBrowser({ label: 'desktop', email: OWNER, cloud });
    account = await hashBlob(new Blob([OWNER]));
    await runtime(a).experimentalEnrollment.initialize('account');
    await enrollSecondDevice(a, b, OWNER);
  });

  afterAll(async () => {
    await b?.close();
    await a?.close();
  });

  it('T2: a board A put on Drive reaches B, which holds no room for it and never polled Drive for it', async () => {
    const board = await a.rx.createProject('Found through the account room', 'project');
    discovered = board.id;
    // Drive adoption on the authoring device. This is the moment worth
    // announcing: from here on the id means a Drive path another device of this
    // account can follow, and it is also the moment a listing poll could have
    // found the board — which is exactly what the next lines prove did not happen.
    await a.runtime.googleDrive.syncProject(board.id, { force: true });

    const polls = drivePollCounter(b);
    try {
      await connectAccountChannel(a, b);
      expect(runtime(b).accountChannel.status().state, `B's account channel did not connect: ${channelProblem(b)}; refusals ${JSON.stringify(cloud.signaling.refusals.slice(-3))}`).toBe('connected');

      // B materialises: the project row arrives, and it arrives from the record.
      const arrived = await untilSettled(async () => Boolean(await b.rx.getProject(board.id)));
      expect(arrived, `a board.created record must import the board through the existing discovery path; B's channel says ${channelProblem(b)}`).toBe(true);
      expect(polls.polls(), 'B learned the board id without a Drive listing poll').toBe(0);
      expect(runtime(b).accountChannel.status().appliedSeq, 'the record was applied, not merely received').toBeGreaterThan(0);

      // A hint, not a grant: the board arrives exactly as its author left it, and
      // nothing attached B to the board's own room.
      expect((await b.rx.getProject(board.id))?.name).toBe('Found through the account room');
      expect(await b.rx.listCards(board.id), 'a newly announced board arrives empty, as its author left it').toEqual([]);
      expect(boardSockets(cloud, board.id), 'a lifecycle record must not subscribe anyone to the board room').toBe(0);
      // The room the record travelled in is the account's own: admitted under the
      // account authority, addressed as `account:<hash>`, and no board's room.
      expect([...cloud.signaling.rooms.values()].some(room => room.board === `account:${account}`),
        'the account room is where the record travelled').toBe(true);
    } finally { polls.restore(); }
  });

  it('T8: the same record twice leaves one project row and one board subscription', async () => {
    const boardId = discovered;
    expect(boardId, 'scenario order: T2 announced this board').not.toBe('');
    const rows = async () => (await b.rx.listProjects()).filter(project => project.id === boardId).length;
    const rowsBefore = await rows();
    const socketsBefore = boardSockets(cloud, boardId);
    const appliedBefore = runtime(b).accountChannel.status().appliedSeq;

    // A browser that lost its local cursor re-reads the retained history and
    // receives records it already applied. That is the duplicate-delivery case,
    // produced by the product's own persistence rather than a hand-built frame.
    await runtime(b).accountChannel.close();
    delete b.storage.data[`pboardAccountLifecycle:${account}`];
    await connectAccountChannel(b);
    expect(runtime(b).accountChannel.status().state, `B could not re-read the account room: ${channelProblem(b)}`).toBe('connected');
    await untilSettled(async () => (await b.rx.getProject(boardId)) !== null);

    expect(await rows(), 'one row, however many times the record arrived').toBe(rowsBefore);
    expect((await b.rx.getProject(boardId))?.name).toBe('Found through the account room');
    expect(await b.rx.listCards(boardId)).toEqual([]);
    expect(boardSockets(cloud, boardId), 'a duplicate record must not attach a second subscription').toBe(socketsBefore);
    // Re-reading history ends at the same frontier: the replay was absorbed, not
    // re-applied as new state.
    expect(runtime(b).accountChannel.status().appliedSeq).toBe(appliedBefore);
  });

  it('T9: a browser that never called any enrollment API reaches the account room by itself', async () => {
    // The shipped product has no enrollment panel. On the Drive-authorized path
    // there is no `account:<hash>` pin to establish at all: the account room is
    // admitted by the same `/drive/admit` exchange every board room uses, so a
    // browser that has never called an enrollment API reaches it from nothing
    // but a connected Google account.
    const unenrolled = await createBrowser({ label: 'kiosk', email: OWNER, cloud });
    try {
      const pinsOf = async () => ((await unenrolled.storage.get('pboardSecurityPins')).pboardSecurityPins ?? {}) as Record<string, unknown>;
      expect(Object.keys(await pinsOf()).filter(key => key.startsWith('account:')),
        'a fresh Drive-authorized profile needs no account pin').toEqual([]);

      // Opening a board is the only thing a person does, and it must not wait
      // on the account room: the board log is its own room.
      const board = await unenrolled.rx.createProject('Opened before any enrollment', 'project');
      await unenrolled.runtime.googleDrive.syncProject(board.id, { force: true });
      await unenrolled.runtime.collaborationManager.start(board.id);
      expect(await until(() => unenrolled.rooms().some(room => room.boardId === board.id && room.log?.phase === 'synced')),
        'the board log must reach synced on its own').toBe(true);

      // The account room arrives the same way — no pin, no ceremony, no
      // authority browser standing by.
      expect(await until(() => runtime(unenrolled).accountChannel.status().state === 'connected'),
        `the connected account must reach the account room by itself: ${channelProblem(unenrolled)}`).toBe(true);
      // Read at the relay, not from the client's own bookkeeping: the account
      // room is the room whose board id is `account:<hash>`.
      const relayRooms = [...cloud.signaling.rooms.values()].filter(room => room.board === `account:${account}`);
      expect(relayRooms.length, `one account room at the relay, not a retry loop: ${channelProblem(unenrolled)}`).toBe(1);
      expect(Object.keys(await pinsOf()).filter(key => key.startsWith('account:')),
        'and it did so without minting an authority').toEqual([]);
    } finally { await unenrolled.close(); }
  });

  it('F8: a cold browser of the same account receives a board created now, with no reload and no Drive poll', async () => {
    // The user's case, end to end: a browser that has never called an enrollment
    // API, on the same Google account, learns about a board the moment it is
    // created — not after the 25-minute publication flush and a poll.
    const cold = await createBrowser({ label: 'cold-desktop', email: OWNER, cloud });
    try {
      const polls = drivePollCounter(cold);
      try {
        // Nothing but the product's own startup: the channel is what a board
        // open starts, and it is what bootstraps the authority.
        await cold.runtime.googleDrive.reconcileAll({ force: true });
        // The authority browser signs the cold device in on its own pass.
        await a.runtime.googleDrive.reconcileAll({ force: true });
        await cold.runtime.googleDrive.reconcileAll({ force: true });
        expect(await until(() => runtime(cold).accountChannel.status().state === 'connected'),
          `the cold browser must reach the account room on its own: ${channelProblem(cold)}`).toBe(true);
        const pollsAfterStartup = polls.polls();

        const board = await a.rx.createProject('Announced to a cold browser', 'project');
        // Drive adoption on the authoring device, so the receiver's verification
        // can succeed; the poll counter below is the cold browser's, and this is
        // A's own write.
        await a.runtime.googleDrive.syncProject(board.id, { force: true });

        expect(await untilSettled(async () => Boolean(await cold.rx.getProject(board.id))),
          `a cold same-account browser must receive a board created now; it says ${channelProblem(cold)}`).toBe(true);
        expect((await cold.rx.getProject(board.id))?.name).toBe('Announced to a cold browser');
        expect(polls.polls(), 'the board arrived over the account room, not from a Drive listing poll')
          .toBe(pollsAfterStartup);
        expect([...cloud.signaling.rooms.values()].some(room => room.board === `account:${account}` && room.submissions.length > 0),
          'the record travelled the account room').toBe(true);
      } finally { polls.restore(); }
    } finally { await cold.close(); }
  });

  it('F9: two contexts of one profile bootstrapping at once end with one account room and no pin', async () => {
    // The MV3 worker and the sidebar are separate JS contexts over one storage,
    // and both start the account channel on their own. The race must end in one
    // room, not two sockets or two authorities.
    const profile = createSharedProfile();
    const [worker, sidebar] = await Promise.all([
      createBrowser({ label: 'boot-worker', email: OWNER, cloud, profile }),
      createBrowser({ label: 'boot-sidebar', email: OWNER, cloud, profile })
    ]);
    try {
      await Promise.all([runtime(worker).accountChannel.start(), runtime(sidebar).accountChannel.start()]);
      expect(await until(() => runtime(worker).accountChannel.status().state === 'connected'
        && runtime(sidebar).accountChannel.status().state === 'connected'),
        `both contexts must end up in the room: worker ${channelProblem(worker)}; sidebar ${channelProblem(sidebar)}`).toBe(true);

      const pins = ((await worker.storage.get('pboardSecurityPins')).pboardSecurityPins ?? {}) as Record<string, unknown>;
      expect(Object.keys(pins).filter(key => key.startsWith('account:')),
        'the Drive path establishes no account pin, however many contexts raced for the room').toEqual([]);
      const rooms = [...cloud.signaling.rooms.values()].filter(room => room.board === `account:${account}`);
      expect(rooms.length, 'one account room: both contexts verified the same authority').toBe(1);
    } finally {
      await sidebar.close();
      await worker.close();
    }
  });

  it('a record never grants anything: naming a board Drive will not name a role for leaves it unknown', async () => {
    // A second Google account with an account authority of its own: its own room
    // and its own records. It announces a board it cannot read — the owner's —
    // and the point of the scenario is what does *not* happen at the device
    // that receives the record: no local row, no Drive folder, no subscription.
    // A record buys a Drive read and nothing else.
    //
    // The receiver must be a second device of the stranger's room: a
    // publisher's own row is its own acknowledgement — the channel skips rows
    // it sent — so with one device the verification path never runs and every
    // "grants nothing" assertion here would pass on a channel that consumed
    // nothing at all.
    const stranger = await createBrowser({ label: 'stranger', email: STRANGER, cloud });
    const accomplice = await createBrowser({ label: 'stranger-desktop', email: STRANGER, cloud });
    try {
      await runtime(stranger).experimentalEnrollment.initialize('account');
      await enrollSecondDevice(stranger, accomplice, STRANGER);
      await connectAccountChannel(stranger, accomplice);
      expect(runtime(stranger).accountChannel.status().state, `the stranger's own account room should admit it: ${channelProblem(stranger)}`).toBe('connected');
      expect(runtime(accomplice).accountChannel.status().state, `the stranger's second device must be enrolled too: ${channelProblem(accomplice)}`).toBe('connected');
      expect(await runtime(stranger).accountChannel.publish('board.created', discovered), 'a device may write to its own account room').toBe(true);

      // The stranger's other device applied the record — projection, callback,
      // verification answer and all — so the verification path really ran there
      // and Drive really refused to name a role for that board.
      const applied = await until(() => runtime(accomplice).accountChannel.status().appliedSeq > 0);
      expect(applied, `the stranger's second device never applied the record: ${channelProblem(accomplice)}`).toBe(true);
      expect(await accomplice.rx.getProject(discovered), 'a lifecycle record is a hint, never a grant').toBeNull();
      // And it created nothing: the verification path used to probe Drive with
      // the find-or-create folder resolver, so this exact record minted
      // `pboard/<boardId>` owned by the stranger — a folder whose ACL then
      // reported `owner`, which is how a hint used to "grant" itself. Zero
      // stranger-owned folders is the whole ballgame.
      expect(cloud.drive.files.some(f => f.name === discovered && !f.trashed
        && f.ownerEmail === STRANGER && f.mimeType === 'application/vnd.google-apps.folder'),
        'verifying a stranger record must create no folder in the stranger Drive').toBe(false);
      expect(await stranger.rx.getProject(discovered), 'the authoring device imports nothing from its own hint either').toBeNull();
      expect(boardSockets(cloud, discovered), 'an unverifiable record must not subscribe anyone to the board it named').toBe(0);
      // The owner's browser learned nothing new from a stranger's room, and the
      // two accounts do not share a room to learn it in.
      expect((await a.rx.getProject(discovered))?.name).toBe('Found through the account room');
      expect(new Set([...cloud.signaling.rooms.values()].map(room => room.board)).has(`account:${account}`)).toBe(true);
      expect(new Set(cloud.signaling.admitted.map(entry => entry.email)).size).toBe(2);
    } finally {
      await accomplice.close();
      await stranger.close();
    }
  });

  it('F2: a board created while the relay is unreachable is announced when the socket reconnects on its own', async () => {
    // The outage the outbox exists for: a creation while the transport is down,
    // and a relay that comes back with nobody touching the browser. The channel
    // reconnects by its own backoff and flushes on the `synced` edge — no
    // `start()`, no second publish, no reload intervenes between the two halves.
    const signaling = cloud.signaling;
    signaling.unreachableAttempts = 0;
    signaling.unreachable = true;
    try {
      const live = accountSockets();
      expect(live.length, 'scenario order: A holds a live account socket').toBeGreaterThan(0);
      for (const socket of live) socket.kill();
      // The channel notices without help: its own first retry has already been
      // refused at the dead transport.
      expect(await until(() => signaling.unreachableAttempts >= 1),
        `A's account channel never retried on its own: ${channelProblem(a)}`).toBe(true);

      const board = await a.rx.createProject('Made during an outage', 'project');
      await a.runtime.googleDrive.syncProject(board.id, { force: true });
      // The creation is real — Drive has the board — and its record sits in the
      // durable queue: nothing sent, nothing dropped.
      expect(await until(() => runtime(a).accountChannel.status().outbox > 0),
        `the record of a board created during an outage must queue, not vanish: ${channelProblem(a)}`).toBe(true);
      expect(await b.rx.getProject(board.id), 'a queued record cannot reach the peer while the channel is down').toBeNull();

      // The relay comes back.
      signaling.unreachable = false;
      expect(await until(() => runtime(a).accountChannel.status().state === 'connected'
        && runtime(a).accountChannel.status().outbox === 0),
        `the reconnecting channel must flush its queue by itself: ${channelProblem(a)}; refusals ${JSON.stringify(signaling.refusals.slice(-3))}`).toBe(true);
      const arrived = await untilSettled(async () => (await b.rx.getProject(board.id)) !== null);
      expect(arrived, `B must converge on the record a reconnect flushed; B says ${channelProblem(b)}`).toBe(true);
      expect((await b.rx.getProject(board.id))?.name).toBe('Made during an outage');
    } finally { signaling.unreachable = false; }
  });

  it('F4: verifying a record that names a board Drive never had writes nothing at the receiver', async () => {
    // B announces a board id that exists nowhere on Drive — the forged,
    // stranger-published, or pre-publication record. Verification must be a
    // read: the earlier order probed with the find-or-create folder resolver,
    // so the "verification" itself created `/pboard/<boardId>`, its ACL gate
    // passed on the folder the record had just caused, and the ghost persisted.
    const forged = crypto.randomUUID();
    const mutationsBefore = cloud.drive.mutations.length;
    const appliedBefore = runtime(a).accountChannel.status().appliedSeq;
    expect(await runtime(b).accountChannel.publish('board.created', forged), 'a device may write to its own account room').toBe(true);
    const applied = await until(() => runtime(a).accountChannel.status().appliedSeq > appliedBefore);
    expect(applied, `A never applied B's record: ${channelProblem(a)}`).toBe(true);

    expect(await a.rx.getProject(forged), 'a hint Drive cannot name stays unknown').toBeNull();
    expect(cloud.drive.mutations.length,
      `verifying an absent board mutated Drive: ${JSON.stringify(cloud.drive.mutations.slice(mutationsBefore))} — verification is read-only`).toBe(mutationsBefore);
    expect(cloud.drive.files.some(f => f.name === forged && !f.trashed && f.mimeType === 'application/vnd.google-apps.folder'),
      'no ghost folder for the absent board exists in any Drive view').toBe(false);
  });

  it('F5: a rename reaches a peer that already holds the board', async () => {
    // The whole audience for `board.metadata` is peers who already imported the
    // board — the consume path used to return before touching them, while the
    // publish side kept emitting renames into the void.
    const boardId = discovered;
    expect(boardId, 'scenario order: T2 announced this board and T/F2 both hold it').not.toBe('');
    // Determinism: the baseline is sampled only after B's frontier has stopped
    // moving *and* A has nothing left queued, which is a state both ends report
    // (the channel's own counters, not a duration). Sampling a raw value here
    // was a race: the rename's publish path is fire-and-forget end to end
    // (`renameProject` → `projectChanged` → `markDirty` → `publish`), so a fast
    // run applied the record before the sample and compared the frontier with
    // itself. The barrier below is a change this test controls: A queues a
    // no-op-proof record for a board B does not hold and waits for B to apply
    // it, so every notification the rename could still produce has already been
    // read and evaluated.
    const appliedBefore = await settledCursor(b, a);
    expect(runtime(a).accountChannel.status().outbox, 'A is quiescent: nothing queued before the rename').toBe(0);

    await a.rx.renameProject(boardId, 'Renamed in place');

    // Two events, in the order the protocol defines them: the receiver applies
    // the record (the board row changes), and only then does its transport
    // advance the frontier past it. Waiting on the frontier rather than on the
    // name is what makes the strict comparison below meaningful — a name can be
    // visible before its sequence is durable, and sampling in that window is how
    // this assertion used to compare a value with itself.
    const advanced = await until(() => runtime(b).accountChannel.status().appliedSeq > appliedBefore);
    expect(advanced, `the record was applied, not merely received; ${channelProblem(b)}`).toBe(true);
    const renamed = await untilSettled(async () => (await b.rx.getProject(boardId))?.name === 'Renamed in place');
    expect(renamed, `a rename must refresh the peer that already holds the board; B says ${channelProblem(b)}`).toBe(true);
    expect(runtime(b).accountChannel.status().lastKind, 'the rename arrived as a metadata record').toBe('board.metadata');
    // Strictly greater, and exactly one record delivered: a record that arrives
    // and is discarded as stale must not count as delivered, and a rename that
    // somehow reached B twice must not pass as once.
    expect(runtime(b).accountChannel.status().appliedSeq - appliedBefore, 'a rename is exactly one applied record').toBe(1);
    expect((await a.rx.getProject(boardId))?.name, 'the author keeps its own rename').toBe('Renamed in place');
    // Applying a record must not echo it back: B's own dirty-mark found the
    // name already announced, so the room holds no rename storm — after a
    // quiet moment B's applied frontier is exactly where the rename left it.
    const settled = runtime(b).accountChannel.status().appliedSeq;
    expect(await until(() => runtime(b).accountChannel.status().appliedSeq >= settled), 'sanity: the cursor moved forward').toBe(true);
  });

  it('F3: two runtime contexts of one profile publishing at once lose no record', async () => {
    // The real deployment: the MV3 worker and the sidebar each build a runtime
    // over one profile — one extension storage, one device key, one content-key
    // store — and both start the account channel. They used to share one send
    // frontier: same actor, independent counters, identical `actorId:seq` op
    // ids, and the log's unique index answered the loser `duplicate` while the
    // whole-object persist clobbered the other's queue. Here both contexts
    // announce a board of their own in the same instant.
    const profile = createSharedProfile();
    const worker = await createBrowser({ label: 'profile-worker', email: OWNER, cloud, profile });
    const sidebar = await createBrowser({ label: 'profile-sidebar', email: OWNER, cloud, profile });
    try {
      // One profile enrolls as one device: the ceremony runs once (the pin and
      // the device key it produces live in the shared storage and key store).
      await enrollSecondDevice(a, worker, OWNER);
      await connectAccountChannel(a, b, worker, sidebar);
      expect(runtime(worker).accountChannel.status().state, `the worker context must connect: ${channelProblem(worker)}`).toBe('connected');
      expect(runtime(sidebar).accountChannel.status().state, `the sidebar context must connect: ${channelProblem(sidebar)}`).toBe('connected');

      const boardW = await worker.rx.createProject('Worker made it', 'project');
      const boardS = await sidebar.rx.createProject('Sidebar made it', 'project');
      await Promise.all([
        worker.runtime.googleDrive.syncProject(boardW.id, { force: true }),
        sidebar.runtime.googleDrive.syncProject(boardS.id, { force: true })
      ]);

      // Both ids arrive at the unaffiliated peer of the same account: neither
      // record was swallowed as the other's duplicate nor clobbered from the
      // shared queue by the other context's persist.
      const wArrived = await untilSettled(async () => (await b.rx.getProject(boardW.id)) !== null);
      expect(wArrived, `the worker's record must survive the sidebar context: ${channelProblem(b)}`).toBe(true);
      const sArrived = await untilSettled(async () => (await b.rx.getProject(boardS.id)) !== null);
      expect(sArrived, `the sidebar's record must survive the worker context: ${channelProblem(b)}`).toBe(true);
      expect((await b.rx.getProject(boardW.id))?.name).toBe('Worker made it');
      expect((await b.rx.getProject(boardS.id))?.name).toBe('Sidebar made it');
      // And each context materialises the other's board — the two of one
      // profile converge exactly like two browsers would.
      expect(await untilSettled(async () => (await sidebar.rx.getProject(boardW.id)) !== null),
        `the sidebar must learn the worker's board: ${channelProblem(sidebar)}`).toBe(true);
      expect(await untilSettled(async () => (await worker.rx.getProject(boardS.id)) !== null),
        `the worker must learn the sidebar's board: ${channelProblem(worker)}`).toBe(true);
    } finally {
      await sidebar.close();
      await worker.close();
    }
  });

  it('F6: a board created while Drive refuses writes is announced at creation, held as an absent board at the peer, and converges once Drive accepts', async () => {
    // The architecture's mandated sequence, with the Drive half removed: local
    // RxDB write → record on the socket → server forwards → peer creates a local
    // representation → Drive persistence afterwards, asynchronously. The defect
    // this replaces announced nothing until the board's first successful
    // `syncOperations`, which in production waits behind the 25-minute
    // publication flush — so with Drive refusing writes, the peer heard nothing
    // at all and the board was simply invisible until a poll succeeded.
    const mutationsBefore = cloud.drive.mutations.length;
    const board = await a.rx.createProject('Created while Drive refuses writes', 'project');
    const boardId = board.id;
    cloud.drive.writeOutage = 503;
    try {
      // No syncProject call anywhere in this phase: the announcement must come
      // from the creation itself. A's Drive half cannot have put the board
      // there — every mutation is refused while the outage is set.
      expect(await until(() => runtime(a).accountChannel.status().appliedByKind['board.created'] !== undefined
        || runtime(a).accountChannel.status().lastKind !== null), `sanity: A's channel is live; ${channelProblem(a)}`).toBe(true);
      // Drive has no folder for the board, and nothing has published one.
      expect(cloud.drive.files.some(file => file.name === boardId && !file.trashed),
        'premise: Drive never received the folder').toBe(false);

      // B receives the record and holds it: verified-absent is a stated state,
      // not a silent drop.
      const deferred = await until(() => runtime(b).accountChannel.status().deferred > 0
        && runtime(b).accountChannel.status().deferred >= 1);
      expect(deferred, `B must hold the record rather than discard it: ${channelProblem(b)}`).toBe(true);
      // Held, not applied: no local board, no Drive state, no subscription.
      expect(await b.rx.getProject(boardId), 'an unverifiable record must not create a local board').toBeNull();
      expect((await b.rx.listProjects()).some(project => project.id === boardId), 'and it must not appear in the list either').toBe(false);
      expect(cloud.drive.mutations.length, `B must create no Drive state for a board it cannot verify: `
        + `${JSON.stringify(cloud.drive.mutations.slice(mutationsBefore))}`).toBe(mutationsBefore);
      expect(cloud.drive.files.some(file => file.name === boardId && !file.trashed),
        'B must not mint the folder the record named').toBe(false);
      expect(boardSockets(cloud, boardId), 'an unverifiable record attaches nothing').toBe(0);
      expect(roomFor(b, boardId), 'and it opens no board room').toBeUndefined();
    } finally { cloud.drive.writeOutage = null; }

    // Drive accepts again and A publishes, the way the product does.
    await a.runtime.googleDrive.syncProject(boardId, { force: true });
    expect(cloud.drive.files.some(file => file.name === boardId && !file.trashed),
      'A published the board once Drive accepted').toBe(true);

    // B converges without a reload: the confirmation record A owes every
    // creation-time announcement is what un-defers it, and the ordinary
    // discovery path imports the board exactly as the author left it.
    const converged = await untilSettled(async () => (await b.rx.getProject(boardId)) !== null);
    expect(converged, `B must converge once the board is on Drive, without a reload; ${channelProblem(b)}`).toBe(true);
    expect((await b.rx.getProject(boardId))?.name).toBe('Created while Drive refuses writes');
    expect(await b.rx.listCards(boardId), 'the board arrives empty, as its author left it').toEqual([]);
    // The deferral ends when the confirmation record's verification finishes,
    // which is one step *after* the board row appears — so the assertion gates on
    // that event rather than sampling a status a write ahead of it.
    const finished = await until(() => !runtime(b).accountChannel.status().deferredBoards.includes(boardId));
    expect(finished, `the deferred record is finished, not still pending; ${channelProblem(b)}`).toBe(true);
    // And B created no Drive state *for this board*: importing a board it may
    // read is a read plus the ordinary discovery path. Scoped to this board's id
    // because B legitimately publishes boards of its own in a round, and a whole
    // -round count cannot tell the two apart.
    const boardMutations = () => cloud.drive.mutations.filter(mutation => mutation.url.includes(boardId)).length;
    const beforeRound = boardMutations();
    await b.runtime.googleDrive.reconcileAll({ force: true });
    expect(boardMutations(), 'a reconcile round at the receiver writes nothing for the board it imported')
      .toBe(beforeRound);
    expect(cloud.drive.files.filter(file => file.name === boardId && !file.trashed).length,
      'and exactly one folder exists for the board — the author\'s, not one the receiver resolved')
      .toBe(1);
  });

  it('F7: an imported board is not announced, so the account room holds exactly one board.created for it', async () => {
    // The echo the origin gate removes: a second device of the same account that
    // imports a board already learned its id *from* the announcement, so
    // announcing it again writes a record per importing device per board that
    // says nothing new. Counted on the room itself, because "one row and one
    // subscription" cannot see a duplicate record that the projection absorbs.
    const room = accountRoom();
    expect(room, 'scenario order: the account room exists').toBeDefined();
    const board = await a.rx.createProject('Announced exactly once', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    // B imports it through the record, which is what marks the origin `imported`
    // on this device (`service.ts:performOpen`).
    const arrived = await untilSettled(async () => Boolean(await b.rx.getProject(board.id)));
    expect(arrived, `scenario order: B must import the board; B says ${channelProblem(b)}`).toBe(true);
    expect(runtime(a).accountChannel.status().appliedByKind['board.created'], 'A applied one creation record of its own').toBeGreaterThanOrEqual(1);

    // Whatever B does next — a reconcile round is the echo's trigger — the room
    // must not gain a second creation record for this board.
    const creations = () => room!.rows.filter(row => row.payload.includes(board.id)).length;
    const before = creations();
    await b.runtime.googleDrive.reconcileAll({ force: true });
    await b.runtime.googleDrive.syncProject(board.id, { force: true });
    const quiet = await until(() => {
      const status = runtime(b).accountChannel.status();
      return status.outbox === 0 && status.deferred === 0;
    });
    expect(quiet, `B's channel settles after importing: ${channelProblem(b)}`).toBe(true);
    expect(creations(), 'an importing device must not announce a board it imported — the room would carry one record per device')
      .toBe(before);
  });

  it('T3: an owner delete reaches B, which holds no room for the board, and a Drive round afterwards does not bring it back', async () => {
    // The scenario the suite shipped without, and the reason deleting a board
    // in one browser silently failed to stop its presentation in the other:
    // the receiving branch of `materialiseAccountRecord` used to demand that
    // Drive *not* have the board's folder, and an owner-side delete never
    // removes the folder (the operation log is append-only; only retention
    // gardening trashes files), so the probe always said "still there" and
    // every `board.deleted` record was discarded. Proved here: B holds the
    // board with no board room open, A deletes, B stops presenting it, and a
    // reconcile round afterwards must still leave the board gone.
    //
    // Two carriers now reach B: the deletion *fact* (`board.tombstone`, merged
    // into B's own durable store — see `tombstonePropagation.test.ts`) and the
    // `board.deleted` hint. The fact is what makes B's decision B's own, so the
    // assertions below no longer expect B to hold no marker.
    const board = await a.rx.createProject('Deleted while B held it', 'project');
    erased = board.id;
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await connectAccountChannel(a, b);
    const arrived = await untilSettled(async () => Boolean(await b.rx.getProject(board.id)));
    expect(arrived, `scenario order: a created record must have handed the board to B first; B says ${channelProblem(b)}`).toBe(true);
    // The whole premise, stated before anything is deleted: B presents this
    // board while holding no room for it — the account channel is the only
    // connection that ever heard its id.
    expect(roomFor(b, board.id), 'B holds the board without opening that board\'s room').toBeUndefined();
    expect(boardSockets(cloud, board.id), 'no browser is subscribed to the board room').toBe(0);

    const polls = drivePollCounter(b);
    try {
      await a.rx.deleteProject(board.id);
      expect(await a.rx.isDeletedProject(board.id), 'the erasing browser records the account deletion marker').toBe(true);

      const gone = await untilSettled(async () => (await b.rx.getProject(board.id)) === null
        && !(await b.rx.listProjects()).some(project => project.id === board.id));
      expect(gone, `a board.deleted record must stop presentation at a peer that holds the board with no board room open `
        + `(the projects-document delete rides the board's own log, so syncOperations must pull it; requiring the Drive `
        + `folder to be gone discards every such record, because an owner delete never trashes the folder); `
        + `A already erased it and B still presents it; B says ${channelProblem(b)}`).toBe(true);
      expect(polls.polls(), 'the record — not a Drive listing poll — is what removed the board at B').toBe(0);
      // Either carrier may be the last applied record: the fact and the hint
      // both say the same thing, and which one lands second is transport order.
      expect(runtime(b).accountChannel.status().lastKind, 'what B applied was a deletion record').toMatch(/^board\.(deleted|tombstone)$/);
      expect(await b.rx.listCards(board.id), 'a deleted board keeps no live cards at the receiver').toEqual([]);
      expect(roomFor(b, board.id), 'handling a delete must not open the board room at the receiver either').toBeUndefined();
      // B learned a deletion *and holds it as evidence*: the fact crossed the
      // account room, so `isDeletedProject` is B's own answer from its own
      // durable store — which is what makes the next Drive import refuse.
      expect(await b.rx.isDeletedProject(board.id), 'the receiving browser holds the deletion fact').toBe(true);
      // The stored row may survive — a fact hides a board, it does not destroy
      // the receiver's retained copy — but nothing may present it: the reads
      // above already proved that. What must never happen is a live *presented*
      // row, and `getProject`/`listProjects`/`listCards` are the presentation.
      expect(await b.rx.getProject(board.id), 'no read presents the board').toBeNull();
      expect((await b.rx.listCards(board.id))).toEqual([]);
    } finally { polls.restore(); }

    // The resurrection attempt the design names: a full reconcile round may
    // still see the board on Drive (a collaborator's copy, or a folder the
    // cleanup has not reached yet), and nothing may turn that listing back into
    // a presented board — the fact is in B's store either way.
    await b.runtime.googleDrive.reconcileAll({ force: true });
    expect((await b.rx.listProjects()).some(project => project.id === board.id),
      'a Drive listing of a folder whose log says deleted must not re-present the board').toBe(false);
    expect(await b.rx.getProject(board.id)).toBeNull();
  });

  it('a deletion fact hides the board even when the receiver\'s Drive reads fail', async () => {
    // The direction that matters most for a *fact*, and the one the hint path
    // could not offer: a `board.deleted` hint is only a claim, so a failed Drive
    // read must leave the board alone (hiding a board because Drive could not be
    // read is the unsafe direction). The tombstone fact is the evidence itself —
    // it is merged into the receiver's durable store through the same rule the
    // deleting device writes through, with no Drive read at all — so it decides
    // regardless of what Drive says. Anything less would leave a peer without
    // the evidence exactly when Drive is unwell.
    const board = await a.rx.createProject('Deleted while B cannot read Drive', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    const arrived = await untilSettled(async () => Boolean(await b.rx.getProject(board.id)));
    expect(arrived, `scenario order: B must hold the board before the delete; B says ${channelProblem(b)}`).toBe(true);

    const folderId = cloud.drive.mustFind(board.id).id;
    const polls = drivePollCounter(b);
    try {
      // Every read of this board's folder fails at the receiver's Drive. The
      // scope keeps the deleting browser — the same Google account, and
      // indistinguishable at the Drive service — untouched.
      cloud.drive.readFaults.push({ status: 500, match: url => url.includes(`files/${folderId}?`) || url.includes(encodeURIComponent(`'${folderId}'`)) });
      await a.rx.deleteProject(board.id);
      expect(await a.rx.isDeletedProject(board.id), 'the deleting device records the decision').toBe(true);

      const gone = await untilSettled(async () => (await b.rx.getProject(board.id)) === null);
      expect(gone, `the tombstone fact must hide the board at B without a Drive read; B says ${channelProblem(b)}`).toBe(true);
      expect(await b.rx.isDeletedProject(board.id), 'B holds the fact as its own decision').toBe(true);
      expect((await b.rx.listProjects()).some(project => project.id === board.id)).toBe(false);
      expect(roomFor(b, board.id), 'applying a fact opens no board room').toBeUndefined();
      expect(polls.polls(), 'the fact — not a Drive listing poll — is what removed the board').toBe(0);
    } finally {
      cloud.drive.readFaults.length = 0;
      polls.restore();
    }
  });

  it('a delete misfires nowhere: unknown ids no-op, and a stale duplicate repeats nothing', async () => {
    const accountRoom = () => [...cloud.signaling.rooms.values()].find(room => room.board === `account:${account}`);
    const room = accountRoom();
    expect(room, 'scenario order: the account room exists').toBeDefined();

    // A `board.deleted` for a board this browser never held. `isDeletedProject`
    // does not know the id, `getProject` returns null, and the branch returns
    // before touching Drive at all — no row, no folder, and not even a read.
    const ghost = crypto.randomUUID();
    const submissionsBefore = room!.submissions.length;
    const rowsBefore = (await b.rx.listProjects()).length;
    const appliedBefore = runtime(b).accountChannel.status().appliedSeq;
    expect(await runtime(a).accountChannel.publish('board.deleted', ghost), 'a device may write to its own account room').toBe(true);
    expect(await until(() => runtime(b).accountChannel.status().appliedSeq > appliedBefore),
      `B never applied the record for the unknown id: ${channelProblem(b)}`).toBe(true);
    expect(await b.rx.getProject(ghost), 'a delete for an unknown id creates nothing and hides nothing').toBeNull();
    expect((await b.rx.listProjects()).length, 'the no-op added no board row at B').toBe(rowsBefore);
    expect(cloud.drive.files.some(f => f.name === ghost && !f.trashed), 'the unknown id gained no Drive folder').toBe(false);
    expect(cloud.drive.requests.filter(url => url.includes(ghost)).length,
      'the no-op must not even read Drive for an id it does not hold').toBe(0);
    expect(room!.submissions.length,
      `B must not answer a record it did not handle with one of its own: ${JSON.stringify(room!.submissions.slice(submissionsBefore))}`)
      .toBe(submissionsBefore + 1); // exactly A's own publish.

    // A stale duplicate of a delete B already handled: the projection hands
    // the newer record over (it is a fresh fact, not a replayed op id), the
    // delete branch finds no local row, and the whole delivery is inert —
    // the board stays gone and B emits nothing back.
    const boardId = erased;
    expect(boardId, 'scenario order: T3 deleted a board B handled').not.toBe('');
    const subsBeforeDuplicate = room!.submissions.length;
    const appliedBeforeDuplicate = runtime(b).accountChannel.status().appliedSeq;
    expect(await runtime(a).accountChannel.publish('board.deleted', boardId)).toBe(true);
    expect(await until(() => runtime(b).accountChannel.status().appliedSeq > appliedBeforeDuplicate),
      `B never received the duplicate delete: ${channelProblem(b)}`).toBe(true);
    expect(await b.rx.getProject(boardId), 'the board stays deleted through a replayed delete').toBeNull();
    expect((await b.rx.listProjects()).some(project => project.id === boardId), 'the replayed delete cannot resurrect the row').toBe(false);
    expect(await b.rx.listCards(boardId), 'and no cards come back with it').toEqual([]);
    expect(room!.submissions.length,
      `a replayed delete must not be answered with another record: ${JSON.stringify(room!.submissions.slice(subsBeforeDuplicate))}`)
      .toBe(subsBeforeDuplicate + 1); // again exactly A's own publish.
  });

  it('F1: a dead transport leaves the channel able to reconnect on its own', async () => {
    // The routine death of a backgrounded tab: the proxy ages the tunnel out.
    // On the Drive-authorized path the admission is a short-lived, socket-bound
    // ticket minted per dial (`/drive/admit`, `googleDriveAdmission.ts`), so a
    // reconnect re-admits with a fresh one; there is no five-minute manifest to
    // expire and no authority gesture to renew it. What must hold is that the
    // channel comes back by itself and keeps carrying records.
    const live = accountSockets();
    expect(live.length, 'scenario order: both browsers hold live account sockets').toBeGreaterThanOrEqual(2);
    for (const socket of live) socket.kill();                   // the proxy ages the tunnels out

    expect(await until(() => runtime(a).accountChannel.status().state === 'connected'
      && runtime(b).accountChannel.status().state === 'connected'),
      `both channels must reconnect on their own: A ${channelProblem(a)}; B ${channelProblem(b)}`).toBe(true);

    // And it is a live channel, not a decorative one: a record published after
    // the recovery arrives at the other context.
    const probe = crypto.randomUUID();
    const appliedBefore = runtime(b).accountChannel.status().appliedSeq;
    expect(await runtime(a).accountChannel.publish('board.created', probe)).toBe(true);
    expect(await until(() => runtime(b).accountChannel.status().appliedSeq > appliedBefore),
      `a record must cross the recovered channel: ${channelProblem(b)}`).toBe(true);
  });


});
