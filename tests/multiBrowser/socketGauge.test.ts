/**
 * The connection-count invariant, measured on the client's own gauge and
 * cross-checked against what the relay actually holds.
 *
 * `transport.open` is counted where `createOperationLogSync` and
 * `runKeyCourier` construct their socket, not where a handle is created, so it
 * is the number of *dials* in flight. The relay's room set is the independent
 * answer: the two must agree, or the gauge is measuring the fixture rather than
 * the product.
 *
 * **The unit is the socket, not the room.** Under protocol 3 a context dials
 * once and every board and the account channel are `attach`es on that one
 * socket (`logSession.ts`, `RelaySessions` keyed by relay URL alone). So the
 * assertion a per-board gauge could not make is stated here instead: one live
 * socket, and *the board's room is among the rooms that socket holds* — read
 * from the relay, not from the client. The per-topic counter still exists (it
 * attributes the one dial to the topic that made it), and it is asserted to be
 * a *subset* of the rooms held rather than to equal them: the account room and
 * every other attached room share that dial.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowser, createCloud, logStatusOf, type BrowserHandle, type Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';

async function untilQuiet(predicate: () => boolean): Promise<boolean> {
  for (let turn = 0; turn < 20_000; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

/** Live sockets per room topic, as this browser's counters report them: one
 * entry per *dial*, attributed to the topic that made it. */
function dialsByTopic(browser: BrowserHandle): Record<string, number> {
  return Object.fromEntries(Object.entries(browser.counters().active)
    .filter(([name]) => name.startsWith('transport.topic.'))
    .map(([name, count]) => [name.slice('transport.topic.'.length), count]));
}

/** The rooms the relay holds for one board, whichever socket carries them. */
function roomsOfBoard(cloud: Cloud, boardId: string): string[] {
  return cloud.signaling.sockets
    .flatMap(socket => [...socket.rooms.values()])
    .filter(room => room.board === boardId)
    .map(room => room.room);
}

describe('the socket gauge', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let boardId = '';

  beforeAll(async () => {
    // The counters are captured when `src/collab/counters` loads inside each
    // browser's private module graph, so the flag has to be stubbed before
    // `createBrowser` evaluates it.
    vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    const board = await a.rx.createProject('Socket gauge board', 'project');
    boardId = board.id;
    await a.rx.addItem({ projectId: board.id, content: 'one edit' });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
  });

  afterAll(async () => {
    await a?.close();
    vi.unstubAllGlobals();
  });

  it('holds one socket that carries the board\'s room, and returns to nothing when the browser closes', async () => {
    await a.runtime.collaborationManager.start(boardId);
    expect(await untilQuiet(() => logStatusOf(a, boardId)?.phase === 'synced'), `board never synced: ${JSON.stringify(logStatusOf(a, boardId))}`).toBe(true);

    // The flag reached this browser's private module graph: an idle board that
    // still records a heartbeat is a gauge that is collecting, not a snapshot
    // that is empty because the build disabled it.
    expect(a.counters().active['timer.logsync.heartbeat']).toBe(1);
    const dials = dialsByTopic(a);
    const open = a.counters().active['transport.open'] ?? 0;
    // Exactly one dial for this context, attributed to the room that made it —
    // which is the account channel here, because a board open starts the
    // account channel first (`collaborationManager.start`) and the board then
    // joins that socket as an `attach`. The per-topic key is therefore a
    // *dial* ledger, not a room list: the board has no key of its own, and
    // asserting otherwise would be asserting a socket per room.
    const dialTopics = Object.entries(dials);
    expect(dialTopics.length, `exactly one room dialled: ${JSON.stringify(dials)}`).toBe(1);
    expect(open, `one dial: ${JSON.stringify(dials)}`).toBe(1);
    expect(dialTopics[0][1]).toBe(1);

    // The independent answer, counted at the relay: one socket, and the board's
    // room is one of the rooms it holds. This is the assertion the old
    // per-board-socket shape could not make — it read `socket.room` (the
    // *primary* room) and so counted a board whose room was a later attach as
    // having no socket at all.
    const sockets = cloud.signaling.sockets;
    expect(sockets.length, `one context, one socket: ${JSON.stringify(cloud.signaling.roomsHeld())}`).toBe(1);
    const rooms = roomsOfBoard(cloud, boardId);
    expect(rooms.length, 'the board\'s room is live').toBe(1);
    expect([...sockets[0].rooms.keys()], 'the board\'s room is among the rooms that socket holds').toContain(rooms[0]);
    // The topic that dialled is the topic of one of the rooms on that socket:
    // the ledger names a real owner, not a phantom second connection.
    expect([...sockets[0].rooms.values()].map(room => room.board)).toContain(dialTopics[0][0].startsWith('pboard-account-') ? `account:${dialTopics[0][0].slice('pboard-account-'.length, -'-order'.length)}` : boardId);
    // The gauge and the relay agree on the dial, so neither can pass alone.
    expect(open, 'the client gauge counts the dials the relay holds sockets for').toBe(sockets.length);
  });

  it('does not grow when other boards are reconciled but not opened', async () => {
    // Counted in the sockets that carry a *board* room, not in momentary dials: a
    // reconcile round runs a key-courier exchange (`keyCourierTransport.ts`), a
    // short-lived dial that also authenticates the account room for the duration
    // of one handshake. The invariant under test is that the round attaches no
    // board room, so it is stated on board rooms.
    const heldSockets = () => cloud.signaling.sockets.filter(socket =>
      [...socket.rooms.values()].some(room => !room.board.startsWith('account:')));
    const before = heldSockets().length;
    // Rooms on the *session* socket, not `roomsHeld()`: a courier exchange opens
    // its own short-lived connection and authenticates the account room there, so
    // the fleet-wide room list briefly holds a second copy of a room that never
    // moved. The claim is that the round attaches no board room to the session.
    const roomsBefore = [...heldSockets()[0].rooms.values()].map(room => room.board).sort();
    for (let index = 0; index < 5; index++) await a.rx.createProject(`Unopened ${index}`, 'project');
    await a.runtime.googleDrive.reconcileAll({ force: true });
    // Reconciling a board is not attaching it: no socket gained a room, which is
    // the invariant a heal fan-out would break (it would attach one room per
    // board it visited).
    expect(heldSockets().length, 'a round opens no attached socket').toBe(before);
    expect([...heldSockets()[0].rooms.values()].map(room => room.board).sort(),
      'a round attaches no room to the session socket').toEqual(roomsBefore);
    expect(a.counters().active['timer.log.consolidate'] ?? 0).toBe(1);
    // And once the round's own exchanges have finished, the gauge is back to one
    // dial per socket that holds a board room — no dial is left behind.
    expect(await untilQuiet(() => (a.counters().active['transport.open'] ?? 0) === heldSockets().length),
      `dials left after the round: ${JSON.stringify(dialsByTopic(a))}`).toBe(true);
  });

  it('releases every dial on close, so a torn-down browser holds no socket', async () => {
    // A courier exchange from the last round may still be in flight; it is a
    // dial too, and its own owner releases it. The steady state is exactly the
    // session's one socket.
    expect(await untilQuiet(() => (a.counters().active['transport.open'] ?? 0)
      === cloud.signaling.sockets.filter(socket =>
        [...socket.rooms.values()].some(room => !room.board.startsWith('account:'))).length), 'one dial for the session').toBe(true);
    await a.close();
    expect(a.counters().active['transport.open']).toBeUndefined();
    expect(dialsByTopic(a)).toEqual({});
    expect(cloud.signaling.roomsHeld()).toEqual([]);
    expect(cloud.signaling.sockets).toEqual([]);
  });
});
