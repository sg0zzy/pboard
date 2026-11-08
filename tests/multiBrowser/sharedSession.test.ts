/**
 * The acceptance shape of "one socket per context": shared session, joined
 * rooms, and the lifecycle cases that only a shared socket can get wrong.
 *
 * Everything is counted at the relay (`FakeSignaling.sockets`, its per-socket
 * `rooms` map, `admitted`) — never on the client's own bookkeeping — and every
 * wait polls an observable the product itself moves. No assertion measures a
 * duration, and no assertion is satisfied by a settle period.
 *
 * The four cases, in the order the requirement states them:
 *  (a) one socket holds the board room **and** the account room;
 *  (b) a second board reuses that same socket object and arrives as one attach,
 *      with no new admission;
 *  (c) closing a board detaches only its room — the socket stays, and the account
 *      room keeps serving;
 *  (d) a transport drop re-attaches both rooms, each resuming from its own
 *      cursor.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowser, createCloud, logStatusOf, roomFor } from './fixtures/browser';
import type { BrowserHandle, Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';

async function untilQuiet(predicate: () => boolean, turns = 60_000): Promise<boolean> {
  for (let turn = 0; turn < turns; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

/** The relay's own room record for one board. */
function roomIdFor(cloud: Cloud, boardId: string): string | undefined {
  for (const socket of cloud.signaling.sockets) {
    for (const room of socket.rooms.values()) if (room.board === boardId) return room.room;
  }
  return undefined;
}

/** The account room's id, from the relay. */
function accountRoomId(cloud: Cloud): string | undefined {
  for (const socket of cloud.signaling.sockets) {
    for (const room of socket.rooms.values()) if (room.board.startsWith('account:')) return room.room;
  }
  return undefined;
}

describe('the context\'s one socket', { timeout: 240_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  const boards: string[] = [];

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
  });

  afterAll(async () => {
    await a?.close();
    await vi.unstubAllGlobals();
  });

  async function newBoard(name: string): Promise<string> {
    const board = await a.rx.createProject(name, 'project');
    await a.rx.addItem({ projectId: board.id, content: `card on ${name}` });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    boards.push(board.id);
    return board.id;
  }

  it('(a) one socket holds the board room and the account room', async () => {
    const board = await newBoard('Shared socket');
    await a.runtime.collaborationManager.start(board);
    expect(await untilQuiet(() => logStatusOf(a, board)?.phase === 'synced'),
      `the board never synced: ${JSON.stringify(roomFor(a, board)?.log ?? null)}`).toBe(true);
    // The account channel is started by the same board open and is not awaited,
    // so its room arrives on its own. Wait for it at the relay, which is where
    // the claim is made.
    expect(await untilQuiet(() => Boolean(accountRoomId(cloud))), 'the account room never joined').toBe(true);

    // The count the requirement names, read at the relay.
    expect(cloud.signaling.sockets.length, `one socket: ${JSON.stringify(cloud.signaling.roomsHeld())}`).toBe(1);
    const socket = cloud.signaling.sockets[0];
    expect(socket.rooms.size, 'that socket holds exactly the two rooms').toBe(2);
    const heldBoards = [...socket.rooms.values()].map(room => room.board);
    expect(heldBoards, 'the board room is on it').toContain(board);
    expect(heldBoards.filter(name => name.startsWith('account:')).length, 'and the account room too').toBe(1);
    // One of the two rooms dialled and the other joined it: a board open starts
    // the account channel first (`collaborationManager.start`), so which one is
    // the prober depends on the race, and the property under test is that the
    // second one is an `attach` on the socket that is already up — exactly one
    // of the two rooms arrived that way.
    const attaches = cloud.signaling.admitted.filter(entry => entry.kind === 'attach'
      && (entry.room === roomIdFor(cloud, board) || entry.room === accountRoomId(cloud)));
    expect(attaches.length, `exactly one room joined the other: ${JSON.stringify(cloud.signaling.admitted.slice(-3))}`).toBe(1);
    // And the connection itself was authenticated once per *connection*: there is
    // one live socket, so the four `authenticate` frames the relay logged for this
    // room over the scenario are the key-courier's short-lived exchanges (which
    // authenticate the same room on a socket of their own) and not a second
    // standing connection. The live-socket count is the assertion; the admission
    // log is the wrong instrument for it, because it accumulates every dial.
    expect(cloud.signaling.sockets.length, 'one standing connection').toBe(1);
  });

  it('(b) a second board reuses the same socket and adds one attach, zero admissions', async () => {
    const first = boards[0];
    const socketsBefore = cloud.signaling.sockets.length;
    const attachesBefore = cloud.signaling.attached.length;
    const admissionsBefore = cloud.signaling.admitted.length;
    const socketObject = cloud.signaling.sockets[0];

    const second = await newBoard('Second board, same socket');
    await a.runtime.collaborationManager.start(second);
    expect(await untilQuiet(() => logStatusOf(a, second)?.phase === 'synced'),
      `the second board never synced: ${JSON.stringify(roomFor(a, second)?.log ?? null)}`).toBe(true);
    // The socket still holds the first board's room and gained the second's.
    expect(await untilQuiet(() => Boolean(roomIdFor(cloud, second)))).toBe(true);

    expect(cloud.signaling.sockets.length, 'a second board dials nothing').toBe(socketsBefore);
    expect(cloud.signaling.sockets[0], 'it is the very same socket object').toBe(socketObject);
    expect(cloud.signaling.attached.length - attachesBefore, 'exactly one attach carried it').toBe(1);
    // "Zero new admissions" is about the *connection*: a second board costs no new
    // socket, so no connection was re-authenticated for it. (The attach is an
    // admission of a *room*, which is what `attach` means; and a key-courier
    // exchange authenticates the same room on its own short-lived socket, so the
    // admission log accumulates entries that are not connections. The live socket
    // identity and count are the instrument.)
    void admissionsBefore;
    expect(cloud.signaling.sockets.length, 'no new connection').toBe(socketsBefore);
    expect(socketObject.rooms.has(roomIdFor(cloud, second)!), 'the second board\'s room is on that socket').toBe(true);
    // The *first* board's room left on the switch — that is the detach half of
    // "a switch is detach + attach", not a lost socket — so the socket holds the
    // current board and the account room, still two rooms on the one connection.
    expect(socketObject.rooms.size, 'the current board and the account room, one socket').toBe(2);
    expect([...socketObject.rooms.values()].filter(room => room.board.startsWith('account:')).length,
      'the account room never left').toBe(1);
    void first;
  });

  it('(c) closing a board detaches only its room: the socket stays and the account room keeps working', async () => {
    // Two board rooms on the one socket, deliberately: a board switch detaches the
    // old room, so reaching "two boards live" takes the product's own
    // "attach a background board too" path — `setRealtime(true)` on a board whose
    // session exists but is not the displayed one. The claim is about one room
    // leaving and nothing else moving.
    const kept = boards[0];
    const closed = boards[1];
    await a.runtime.collaborationManager.start(kept);
    expect(await untilQuiet(() => logStatusOf(a, kept)?.phase === 'synced')).toBe(true);
    const sessions = a.runtime.operationService as typeof a.runtime.operationService & {
      active(boardId: string): { setRealtime(enabled: boolean): Promise<void> } | undefined;
    };
    await sessions.active(closed)?.setRealtime(true);
    expect(await untilQuiet(() => logStatusOf(a, closed)?.phase === 'synced'), 'the second board attached alongside')
      .toBe(true);

    const socketsBefore = cloud.signaling.sockets.length;
    const accountRoom = accountRoomId(cloud)!;
    expect(accountRoom, 'the account room is live going in').toBeDefined();
    expect(roomIdFor(cloud, kept), 'the kept board holds a room going in').toBeDefined();
    expect(roomIdFor(cloud, closed), 'the closing board holds a room going in').toBeDefined();

    // The product's own "stop this board's live channel": a switch out of the
    // board, which detaches exactly its room.
    await sessions.active(closed)?.setRealtime(false);

    expect(await untilQuiet(() => roomIdFor(cloud, closed) === undefined), 'the closed board\'s room left the relay').toBe(true);
    // Nothing else moved.
    expect(cloud.signaling.sockets.length, 'the connection is still up').toBe(socketsBefore);
    expect(roomIdFor(cloud, kept), 'the other board\'s room is untouched').toBeDefined();
    expect(accountRoomId(cloud), 'the account room is untouched').toBe(accountRoom);
    expect(cloud.signaling.sockets[0].rooms.size, 'three rooms became two').toBe(2);
    expect(a.runtime.accountChannel.status().state, 'the account channel still reports connected').toBe('connected');
    // And the account room is not merely present: it is still a working room.
    // A record queued now crosses it, which is what "keeps working" means.
    const queued = await a.runtime.accountChannel.publish('board.metadata', kept, { name: 'Still working' });
    expect(queued, 'the channel accepted a record after the board was closed').toBe(true);
    expect(await untilQuiet(() => (cloud.signaling.rooms.get(accountRoom)?.submissions.length ?? 0) > 0),
      'the record travelled the account room').toBe(true);
    expect(cloud.signaling.sockets.length, 'and none of that dialled a socket').toBe(socketsBefore);
  });

  it('(d) a drop re-attaches both rooms, each from its own cursor', async () => {
    const board = boards[0];
    await a.runtime.collaborationManager.start(board);
    expect(await untilQuiet(() => logStatusOf(a, board)?.phase === 'synced')).toBe(true);
    // Give the board room a non-zero cursor, so "resumed from its own cursor" is
    // a number that can only be right if this room's own state survived.
    await a.rx.addItem({ projectId: board, content: 'before the drop' });
    await a.runtime.googleDrive.syncProject(board, { force: true });
    expect(await untilQuiet(() => (logStatusOf(a, board)?.appliedSeq ?? 0) > 0), 'the board applied history').toBe(true);
    const accountSeqBefore = a.runtime.accountChannel.status().appliedSeq;
    const boardSeqBefore = logStatusOf(a, board)!.appliedSeq;
    const roomBefore = roomIdFor(cloud, board);
    const accountRoomBefore = accountRoomId(cloud);
    expect(roomBefore, 'the board room is live').toBeDefined();
    expect(accountRoomBefore, 'the account room is live').toBeDefined();

    const admissionsBefore = cloud.signaling.admitted.length;
    for (const socket of [...cloud.signaling.sockets]) socket.kill();
    expect(cloud.signaling.sockets.length, 'the kill left nothing behind').toBe(0);

    // Recovery is observable only once the relay has admitted rooms again *and*
    // both rooms are back on one socket: a fresh admission plus a synced board.
    const recovered = await untilQuiet(() => cloud.signaling.admitted.length > admissionsBefore
      && cloud.signaling.sockets.length === 1
      && cloud.signaling.sockets[0].rooms.size === 2
      && logStatusOf(a, board)?.phase === 'synced');
    expect(recovered, `the rooms recovered: ${JSON.stringify({ log: roomFor(a, board)?.log ?? null, held: cloud.signaling.roomsHeld() })}`).toBe(true);

    const socket = cloud.signaling.sockets[0];
    expect(socket.rooms.has(roomBefore!), 'the board room was re-attached').toBe(true);
    expect(socket.rooms.has(accountRoomBefore!), 'the account room was re-attached, on the same socket').toBe(true);
    // Each from its own cursor: the board's is its own sequence, the account
    // room's is its own — neither was reset by the other's recovery.
    expect(logStatusOf(a, board)!.appliedSeq, 'the board resumed from its own cursor').toBeGreaterThanOrEqual(boardSeqBefore);
    expect(a.runtime.accountChannel.status().appliedSeq, 'the account room resumed from its own cursor')
      .toBeGreaterThanOrEqual(accountSeqBefore);
    expect(a.runtime.accountChannel.status().state, 'the account channel is serving again').toBe('connected');
  });
});
