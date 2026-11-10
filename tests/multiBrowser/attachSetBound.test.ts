/**
 * W1 + W8, measured end to end on the real composition root.
 *
 * W1 — the attach set is one board. A profile's board sockets come from the
 * operation log a session attaches for the board it *displays*; the reconcile
 * round used to run `healRelay` for every board it listed, and heal re-attaches
 * a room, so visiting N boards left N sockets behind. The rule now lives in the
 * heal leg itself (`healRelayWork` returns `idle:not-attached` for a board the
 * context is not displaying), so no trigger — the round, the worker-epoch
 * listener, an explicit call — can attach a room this context has no consumer
 * for.
 *
 * W8 — a write on a board that is not the current one must not notify the
 * project-list or current-board subscription.
 *
 * **Determinism.** The harness fakes only `Date`, so anything that waits for a
 * timer is a race; and a count read "after a settle" is a race regardless of how
 * many turns it waited. Every absence assertion here therefore carries a
 * *barrier*: a later change that must emit, on the same serialized reader, so
 * its emission proves every earlier notification has already been read and
 * evaluated. Every wait is a poll of a counter or of the client's own gauge; no
 * duration and no fixed turn count is treated as a state. The gauge is
 * cross-checked against what the relay actually holds (`roomsHeld()`), so the
 * socket assertions cannot pass by trusting the client's bookkeeping.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowser, createCloud, logStatusOf } from './fixtures/browser';
import type { BrowserHandle, Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';

/** Zero-delay task-queue polling of an observable this test owns. */
async function untilQuiet(predicate: () => boolean, turns = 40_000): Promise<boolean> {
  for (let turn = 0; turn < turns; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

/** Live relay sockets that hold a room of one board's log — the room, on
 * whichever socket carries it. A context's socket is one and holds the account
 * room too, so reading `socket.room` (the *primary* room) would answer a
 * different question: which room dialled first. */
function boardSockets(cloud: Cloud, boardId: string) {
  return cloud.signaling.socketsForBoard(boardId);
}
/** Every live socket that carries any board room (`account:` rooms excluded). */
function allBoardSockets(cloud: Cloud) {
  return cloud.signaling.boardSockets();
}
/** The relay's own count of *board* rooms it is serving — the independent answer.
 * Filtered by the room's board, not by the room id's prefix: the account room is
 * a `pboard-v2-` room too, and it now shares the same socket, so a prefix test
 * would count it as a second board. */
function relayBoardRooms(cloud: Cloud) {
  return cloud.signaling.sockets
    .flatMap(socket => [...socket.rooms.values()])
    .filter(room => !room.board.startsWith('account:'));
}

async function openBoard(browser: BrowserHandle, boardId: string) {
  await browser.runtime.collaborationManager.start(boardId);
}
async function reconcile(browser: BrowserHandle) {
  return await browser.runtime.googleDrive.reconcileAll({ force: true });
}
/**
 * Closes one observation phase. The repository coalesces a burst of
 * notifications into a single read after its own settle window, so two writes
 * placed back to back can share one read and one emission — which would make a
 * "nothing was published" assertion pass without proving anything. Each phase
 * here is closed before the next begins, and each is asserted by exact count.
 */
async function phase() {
  for (let turn = 0; turn < 6; turn++) await new Promise<void>(resolve => setTimeout(resolve, 8));
}

/** The client's own live-socket gauge, for the cross-check. */
function gaugeOpen(browser: BrowserHandle) {
  return browser.counters().active['transport.open'] ?? 0;
}

describe('one attached board per context, whatever has been visited', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  /** Three boards the browser opens in turn; the third stays current. */
  const visited: string[] = [];

  beforeAll(async () => {
    // The counter instance is captured when each browser's private module graph
    // loads, so the flag has to be stubbed before `createBrowser` evaluates it.
    vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    for (let index = 0; index < 3; index++) {
      const board = await a.rx.createProject(`Visited board ${index}`, 'project');
      await a.rx.addItem({ projectId: board.id, content: `card on board ${index}` });
      await a.runtime.googleDrive.syncProject(board.id, { force: true });
      visited.push(board.id);
    }
    // Visit each board and let it *lose* its room before moving on: that is the
    // state the leak needed. A heal re-attaches any board that still has a room
    // record and only a switch detaches, so the rooms a round finds are exactly
    // the ones earlier visits left behind, offline. Three visits, three offline
    // rooms, one round: three sockets, pre-fix.
    //
    // "Lose its room" is `setRealtime(false)` under protocol 3, not a killed
    // socket. A killed socket is no longer a way to leave a board — the context's
    // session owns the connection and re-attaches every wanted room from its own
    // cursor, which is the whole point of the multiplexed transport — so closing
    // one here would leave the room synced on a replacement socket and hang the
    // loop below. `setRealtime(false)` is the product's own "stop this board's
    // live channel", and it detaches exactly this room.
    for (const [index, boardId] of visited.entries()) {
      const last = index === visited.length - 1;
      await openBoard(a, boardId);
      if (!await untilQuiet(() => logStatusOf(a, boardId)?.phase === 'synced'))
        throw new Error(`board ${boardId} never synced while open: ${JSON.stringify(a.rooms().find(room => room.topic.includes(boardId)) ?? null)}`);
      if (last) continue;
      await (a.runtime.operationService as typeof a.runtime.operationService & {
        active(id: string): { setRealtime(enabled: boolean): Promise<void> } | undefined;
      }).active(boardId)?.setRealtime(false);
      if (!await untilQuiet(() => boardSockets(cloud, boardId).length === 0))
        throw new Error(`board ${boardId}'s room never left the relay`);
    }
  // The suite's setup opens three boards on one browser context — several genuine
  // Drive and relay round trips — and routinely exceeds vitest's 10 s *hook*
  // default while staying far inside the per-test budget. The explicit timeout
  // keeps a slow setup from being reported as eight skipped tests behind a hook
  // timeout that says nothing about the behaviour under test.
  }, 120_000);

  afterAll(async () => {
    await a?.close();
    vi.unstubAllGlobals();
  });

  it('visiting N boards leaves exactly one board-room socket, and a reconcile round keeps it at one', async () => {
    // The bound: **1**. One browser context displays one board, the operation
    // log attaches per displayed board, and the attach set is that board — so
    // the count is the number of displayed boards. Two would mean a second
    // board's room survived a switch; three is the pre-fix shape, one per
    // visited board (measured: this scenario yields 3 without the gate).
    const BOARD_ROOMS = 1;
    expect(allBoardSockets(cloud).length, `one attached board per context; visited ${visited.length} boards`).toBe(BOARD_ROOMS);
    expect(boardSockets(cloud, visited.at(-1)!).length, 'the socket belongs to the board that is current').toBe(BOARD_ROOMS);
    for (const stale of visited.slice(0, -1))
      expect(boardSockets(cloud, stale).length, 'a board left behind holds no socket').toBe(0);

    // The round that used to attach a room per listed board. `reconcileAll`
    // resolves after every relay leg it ran has finished (the heal awaits the
    // transport handle), so this is the barrier for "the round is done", not a
    // settle period.
    await reconcile(a);

    expect(allBoardSockets(cloud).length, 'a reconcile round must not add a board socket').toBe(BOARD_ROOMS);
    for (const stale of visited.slice(0, -1))
      expect(boardSockets(cloud, stale).length, 'the round must not re-attach a board it merely listed').toBe(0);
    expect(logStatusOf(a, visited.at(-1)!)?.phase, 'the current board keeps its room').toBe('synced');
    // Independence: the client's own gauge agrees with the relay, so neither
    // side can be passing alone. Counted in sockets that hold a room — a
    // reconcile round also runs a key-courier exchange, a short-lived dial on
    // the same topic that is expected to appear and disappear inside the round.
    const heldSockets = () => cloud.signaling.sockets.filter(socket => socket.rooms.size > 0).length;
    expect(await untilQuiet(() => gaugeOpen(a) === heldSockets() && heldSockets() === 1),
      `the client gauge counts the sockets that hold rooms: ${JSON.stringify(a.counters().active)}`).toBe(true);
  });

  it('repeated rounds are idempotent, not additive', async () => {
    for (let round = 0; round < 3; round++) await reconcile(a);
    expect(allBoardSockets(cloud).length, 'idle rounds add nothing').toBe(1);
    expect(relayBoardRooms(cloud).length).toBe(1);
    expect(await untilQuiet(() => cloud.signaling.sockets.filter(socket => socket.rooms.size > 0).length === 1)).toBe(true);
    expect(gaugeOpen(a)).toBeLessThanOrEqual(2); // the session, plus at most one courier exchange in flight
  });

  it('the round answers idle:not-attached for every board this context is not displaying', async () => {
    const result = await reconcile(a);
    for (const stale of visited.slice(0, -1))
      expect(result.relay?.[stale], 'a background board is answered, not run').toBe('idle:not-attached');
    expect(result.relay?.[visited.at(-1)!], 'the current board is genuinely processed').not.toBe('idle:not-attached');
    expect(result.relay?.[visited.at(-1)!]).toBe('idle:synced');
  });

  it('heal cannot re-attach a board this context is not displaying, and still restores the current one', async () => {
    const background = visited[0], current = visited.at(-1)!;
    expect(await untilQuiet(() => logStatusOf(a, current)?.phase === 'synced'), 'the current board is live going in').toBe(true);
    expect(boardSockets(cloud, background).length).toBe(0);

    // Ask the heal for the background board directly — the trigger an epoch
    // change, another round, or a stale UI reference could produce. Awaiting it
    // is the barrier: the answer is the leg's completion.
    const admittedBefore = cloud.signaling.admitted.length;
    expect(await a.runtime.healRelay(background), 'heal outside the attach set is refused, in the product\'s own words').toBe('idle:not-attached');
    expect(boardSockets(cloud, background).length, 'the refused heal attached nothing').toBe(0);
    // It returned before doing any work at all: no admission was requested, so
    // no room, courier exchange or grant publication followed from it. (Room
    // *records* are module memory that outlives a closed room, so the socket and
    // admission counts are the observables, not the record.)
    expect(cloud.signaling.admitted.length, 'the refused heal spent no admission').toBe(admittedBefore);

    // Now kill the current board's socket: its room must come back. This is the
    // outcome the heal exists for, and it must be unaffected by the gate.
    for (const socket of boardSockets(cloud, current)) socket.close();
    expect(await untilQuiet(() => boardSockets(cloud, current).length === 0), 'the kill took effect').toBe(true);
    expect(await untilQuiet(() => logStatusOf(a, current)?.phase !== 'synced'), 'the room noticed its socket died').toBe(true);

    // The heal's own answer, and then the recovery it promises.
    const healed = await a.runtime.healRelay(current);
    expect(healed, `the current board still has a heal answer: ${healed}`).toMatch(/^(healed|idle:)/);
    expect(await untilQuiet(() => logStatusOf(a, current)?.phase === 'synced'), 'the current board recovers').toBe(true);
    expect(await untilQuiet(() => boardSockets(cloud, current).length === 1), 'exactly one room after recovery').toBe(true);
    expect(boardSockets(cloud, background).length, 'the background board is still silent').toBe(0);
  });

  it('a background board\'s operation does not notify the project list or the current board', async () => {
    const background = visited[0];
    const current = (await a.rx.getCurrentProject())!.id;
    expect(current).not.toBe(background);

    // The receiving shape: another device writes on a board this browser holds
    // but does not display, and the write reaches here as applied operations —
    // the projection that rewrites the board row and writes a receipt per
    // downloaded file, the two writes that used to re-render the whole sidebar.
    const other = await createBrowser({ label: 'other device', email: OWNER, cloud });
    let projects = 0, currentProject = 0;
    const stops = [a.rx.subscribeProjects(() => { projects += 1; }), a.rx.subscribeCurrentProject(() => { currentProject += 1; })];
    try {
      await reconcile(other);
      expect((await other.rx.listProjects()).some(project => project.id === background), 'the second device holds the board').toBe(true);
      // Mount barrier: a subscription publishes its first read immediately.
      expect(await untilQuiet(() => projects > 0 && currentProject > 0), 'both subscriptions mounted').toBe(true);
      const mounted = { projects, currentProject };

      // Phase 1 — the background board's operation, through the real relay and
      // the receiving browser's real Drive reconcile. It must land and it must
      // emit nothing.
      const card = await other.rx.addItem({ projectId: background, content: 'Typed on a background board' });
      await other.runtime.googleDrive.syncProject(background, { force: true });
      await reconcile(a);
      expect(await untilQuiet(() => a.rooms().length > 0), 'this context still reports its rooms').toBe(true);
      expect((await a.rx.listCards(background)).some(item => item.id === card.id), 'the background write really landed').toBe(true);
      await phase();
      expect({ projects: projects - mounted.projects, currentProject: currentProject - mounted.currentProject },
        'a write on a board the person is not looking at must not re-render the sidebar').toEqual({ projects: 0, currentProject: 0 });

      // Phase 2 — the barrier: a rename of the *displayed* board by the same
      // other device, over the same path. Exactly one emission to each view.
      const afterBackground = { projects, currentProject };
      const renamed = 'Named by the other device';
      await other.rx.renameProject(current, renamed);
      await other.runtime.googleDrive.syncProject(current, { force: true });
      await reconcile(a);
      expect(await untilQuiet(() => projects > afterBackground.projects && currentProject > afterBackground.currentProject),
        'the current board\'s received rename must reach both views').toBe(true);
      await phase();
      expect((await a.rx.getProject(current))?.name, 'the rename really landed').toBe(renamed);
      expect({ projects: projects - afterBackground.projects, currentProject: currentProject - afterBackground.currentProject },
        'the displayed board\'s rename emits exactly once; the background write emitted nothing').toEqual({ projects: 1, currentProject: 1 });
    } finally { for (const stop of stops) stop(); await other.close(); }
  });

  it('the current board\'s own card still re-renders its card view', async () => {
    const current = (await a.rx.getCurrentProject())!.id;
    let cards = 0;
    const stop = a.rx.subscribeCards(current, () => { cards += 1; });
    try {
      expect(await untilQuiet(() => cards > 0), 'the card view mounted').toBe(true);
      const mounted = cards;
      const card = await a.rx.addItem({ projectId: current, content: 'Typed on the current board' });
      expect(await untilQuiet(() => cards > mounted), 'the current board\'s view re-renders for its own card').toBe(true);
      expect((await a.rx.listCards(current)).some(item => item.id === card.id)).toBe(true);
    } finally { stop(); }
  });

  it('the account channel is one more room on the context\'s one socket, unaffected by board count', async () => {
    // The account room is not a connection of its own: it joins the context's
    // socket as one more room, exactly as a second board does. The old shape of
    // this assertion counted sockets whose *primary* room was `account:` — the
    // per-board-socket model this transport replaced — so it is restated on the
    // relay's own room set: one socket, and the account room is on it.
    const accountRoom = [...cloud.signaling.rooms.values()].find(room => room.board.startsWith('account:'));
    expect(accountRoom, 'this profile has an account room').toBeDefined();
    const socketsBefore = cloud.signaling.sockets.length;
    const heldBefore = cloud.signaling.sockets.flatMap(socket => [...socket.rooms.keys()]);

    await reconcile(a);

    expect(cloud.signaling.sockets.length, 'a round must not dial a socket for the account room').toBe(socketsBefore);
    // Counted on the sockets that hold a *board* room: the round's key-courier
    // exchange authenticates the account room for the duration of one handshake
    // (`keyCourierTransport.ts`, one short-lived dial), and that transient
    // exchange is not a second home for the room. The claim being made is that
    // the account room shares the context's board socket, so that is where it is
    // read.
    const sessionSockets = cloud.signaling.sockets.filter(socket =>
      [...socket.rooms.values()].some(room => !room.board.startsWith('account:')));
    expect(sessionSockets.length, 'one socket carries the boards').toBe(1);
    const carriers = cloud.signaling.sockets.filter(socket => socket.rooms.has(accountRoom!.room));
    expect(carriers.length, 'the account room is held — and the board socket is one of them').toBeGreaterThanOrEqual(1);
    expect(carriers.includes(sessionSockets[0]), 'the account room is a room on the board\'s own socket').toBe(true);
    expect(sessionSockets[0].rooms.has(accountRoom!.room), 'and it is a room there, not its own connection').toBe(true);
    // The room set is unchanged by the round too: the account room neither
    // detached nor re-attached behind the board's back.
    expect(cloud.signaling.sockets.flatMap(socket => [...socket.rooms.keys()]).sort()).toEqual([...heldBefore].sort());
  });

  it('closing the board detaches its room, and reopening one leaves exactly one socket', async () => {
    await a.runtime.collaborationManager.stop();
    expect(await untilQuiet(() => allBoardSockets(cloud).length === 0), 'stopping the collaboration manager detaches the board room').toBe(true);

    const first = visited[0];
    await openBoard(a, first);
    expect(await untilQuiet(() => logStatusOf(a, first)?.phase === 'synced')).toBe(true);
    expect(allBoardSockets(cloud).length).toBe(1);
    expect(boardSockets(cloud, first).length).toBe(1);
    expect(relayBoardRooms(cloud).length).toBe(1);
  });
});
