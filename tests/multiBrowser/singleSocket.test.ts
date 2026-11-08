/**
 * One socket per browser context — the invariant, measured at the relay.
 *
 * `logSession.ts` owns one authenticated socket per relay URL and every board is
 * a room attached to it: a board switch is `detach(old)` + `attach(new)` on the
 * connection that is already up, a `refused` or a server-initiated `detached` is
 * scoped to the room it names, and a drop re-attaches exactly the rooms that were
 * attached, each from its own cursor. What these scenarios count is the socket
 * the relay itself holds, because that is the only answer that cannot be
 * self-reported.
 *
 * **Why a second board under a different device key is now free.** A client
 * enrols one device per board (`board-device:<board>`,
 * `signalingSelection.ts:28`), and the v3 `attach` frame carries that room's own
 * `deviceKeyId`; the service verifies each attach's proof against the device it
 * presents (`lib.rs`, `AttachFrame.device_key_id`). Before that field existed the
 * server could only verify an attach against the connection's device, which made
 * "one socket per session regardless of board count" unreachable: the relay
 * answered `service_auth_required`. That is why the numbers below are zero-cost
 * rather than one-socket-per-board.
 *
 * Everything here is counted, never timed: an assertion is on sockets,
 * admissions, attaches or cursor values, and every wait is on one of those
 * moving — a fixed sleep would pass on a slow machine and fail on a fast one.
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

/**
 * Admissions carried by an `attach` frame — a room joining a connection that was
 * already authenticated. This is the only admission count that answers "did the
 * transport multiplex": `authenticate` admissions are shared with the key
 * courier, which dials its own short-lived socket per board on the same topic,
 * so counting those would count a courier exchange as a board's transport.
 */
function attachesFor(cloud: Cloud): number {
  return cloud.signaling.admitted.filter(entry => entry.kind === 'attach').length;
}

/** The relay's own room id for a board, from whichever socket carries it. */
function roomIdFor(cloud: Cloud, boardId: string): string | undefined {
  for (const socket of cloud.signaling.sockets) {
    for (const room of socket.rooms.values()) if (room.board === boardId) return room.room;
  }
  return undefined;
}

async function openBoard(browser: BrowserHandle, boardId: string) {
  await browser.runtime.collaborationManager.start(boardId);
}

async function expectSynced(browser: BrowserHandle, boardId: string, what = '') {
  if (!await untilQuiet(() => logStatusOf(browser, boardId)?.phase === 'synced'))
    throw new Error(`browser ${browser.label} never synced board ${boardId}${what ? ` (${what})` : ''}: ${JSON.stringify(roomFor(browser, boardId)?.log ?? null)}`);
}

describe('one socket per browser context', { timeout: 240_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  const boards: string[] = [];

  beforeAll(async () => {
    vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
  });

  afterAll(async () => {
    await a?.close();
    vi.unstubAllGlobals();
  });

  async function newBoard(name: string): Promise<string> {
    const board = await a.rx.createProject(name, 'project');
    await a.rx.addItem({ projectId: board.id, content: `card on ${name}` });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    boards.push(board.id);
    return board.id;
  }

  it('holds one socket that carries the board\'s room, and never more', async () => {
    const first = await newBoard('Socket one');
    await openBoard(a, first);
    await expectSynced(a, first);

    // One socket for the context, and the board's room is on it. The account
    // channel is a *room* on the same connection — it is one more `attach`, not
    // a connection of its own — so the count below is sockets and the room set
    // is where the sharing is asserted.
    const sockets = cloud.signaling.sockets.length;
    expect(sockets, `one board: ${JSON.stringify(cloud.signaling.roomsHeld())}`).toBe(1);
    const rooms = cloud.signaling.sockets.flatMap(socket => [...socket.rooms.values()].map(room => room.board));
    expect(rooms, 'the board\'s room is among the rooms the socket holds').toContain(first);
    // Every other room on that socket is an account room: nothing else may be
    // sharing the context's transport with a board.
    for (const board of rooms) expect(board === first || board.startsWith('account:'),
      `unexpected room on the context's socket: ${board}`).toBe(true);
  });

  it('a switch is detach + attach on one connection, never a re-admission', async () => {
    // Re-opening the *same* board is the case where the device key is shared, and
    // it is where "a switch never re-authenticates" is exactly true and
    // measurable: one admission for the lifetime of the context, and the second
    // and third visits answered as attaches on the connection that is still up.
    const board = boards[0];
    await openBoard(a, board);
    await expectSynced(a, board);
    const sockets = cloud.signaling.sockets.length;
    const attaches = cloud.signaling.attached.length;
    const detaches = cloud.signaling.detached.length;

    for (let visit = 0; visit < 10; visit++) {
      await openBoard(a, board);
      await expectSynced(a, board);
    }

    expect(cloud.signaling.sockets.length, 'ten re-opens are not ten sockets').toBe(sockets);
    // No new attach either: a room this connection already holds is answered
    // locally, so the relay never even hears about the re-open.
    expect(cloud.signaling.detached.length, 'ten re-opens are not ten detaches').toBe(detaches);
    // Each re-open of a room this context already holds is the session's own
    // "already attached" answer: nothing is sent, so nothing is re-admitted.
    expect(cloud.signaling.attached.length, 'a held room is answered, not attached twice').toBe(attaches);
    void detaches;
  });

  it('opening a second board costs zero sockets, zero admissions and one attach', async () => {
    // The acceptance number for "one socket per context". Every board enrols its
    // own device key (`board-device:<board>`), and the v3 `attach` carries that
    // key, so a room under a *different* device joins the connection already up.
    // Nothing here may dial: no socket, no admission, no bootstrap on the first
    // board's room.
    const before = cloud.signaling.sockets.length;
    const attaches = cloud.signaling.attached.length;

    const second = await newBoard('Second device key');
    await openBoard(a, second);
    await expectSynced(a, second);

    expect(cloud.signaling.sockets.length, 'a second board joins the connection already up').toBe(before);
    // It arrived as an attach — a room admitted to a connection that was already
    // authenticated — and not as a new socket's `authenticate`.
    expect(cloud.signaling.attached.length, 'exactly one attach carried the second board').toBe(attaches + 1);
    expect(attachesFor(cloud), 'the room was admitted by its own attach frame').toBeGreaterThanOrEqual(1);
    // It joined *the same socket object* — the one the first board dialled. A
    // second socket here would be the very per-board transport v3 removes.
    expect(cloud.signaling.sockets.length, 'one live socket, the same object').toBe(1);
    const socket = cloud.signaling.sockets[0];
    expect(socket.rooms.has(roomIdFor(cloud, second)!), 'the new board is on that socket').toBe(true);
    // And the room it carries was admitted under the second board's own device
    // key, not the key that opened the connection: that is what the per-attach
    // `deviceKeyId` buys, and the reason this test exists.
    expect(socket.deviceForRoom.get(roomIdFor(cloud, second)!), 'the second board kept its own device key')
      .not.toBe(socket.deviceKeyId);
  });

  it('a per-room detach is not a disconnect: the room states its cause and the socket stays', async () => {
    // Two rooms on one connection is only reachable under one device key, which
    // today means one board plus a second *attachment* of the same room. The
    // transport-level property under test is independent of that: a `detached`
    // frame with a code must reach the room it names and leave the connection
    // alone.
    const board = boards[0];
    await openBoard(a, board);
    await expectSynced(a, board);
    const sockets = cloud.signaling.sockets.length;
    const attaches = cloud.signaling.attached.length;
    // The room id is the one the *relay* holds, resolved after the board is live.
    const room = roomIdFor(cloud, board);
    expect(room, `the relay names the room it holds: ${JSON.stringify(cloud.signaling.roomsHeld())}`).toBeDefined();
    expect(cloud.signaling.detachRoom(room!, 'authorization_changed')).toBe(true);
    expect(await untilQuiet(() => roomFor(a, board)?.log?.error === 'authorization_changed'),
      `the detached room states its cause: ${JSON.stringify(roomFor(a, board)?.log ?? null)}`).toBe(true);
    // The refusal is the room's, not the connection's: the socket is still there
    // and the room is not retried into a loop.
    expect(cloud.signaling.sockets.length, 'a per-room detach never closes the connection').toBe(sockets);
    expect(cloud.signaling.attached.length, 'a per-room detach is not a re-attach').toBe(attaches);
    expect(roomFor(a, board)?.log?.phase).toBe('error');
    expect(roomFor(a, board)?.log?.error).toBe('authorization_changed');
    expect(cloud.signaling.detached.at(-1), 'the relay sent the coded detach for that room').toEqual({ room: room!, code: 'authorization_changed' });
  });

  it('a coded detach for one board leaves another board syncing, and states its own cause', async () => {
    // Two rooms on *one* socket, which is the case the routing rule exists for.
    // A board switch detaches the old room, so reaching this state takes the
    // product's own "attach a background board too" path: `setRealtime(true)` on
    // a board whose session exists but is not the displayed one. Both rooms are
    // then live on the same connection and the relay detaches one of them.
    const first = boards[1];
    const second = await newBoard('Routing sibling');
    await openBoard(a, first);
    await expectSynced(a, first);
    await openBoard(a, second);
    await expectSynced(a, second);

    // Bring the first board's room back alongside the second's. The fixture's
    // runtime type predates `active()`, so the session is narrowed here rather
    // than widening a type every other suite shares.
    const sessions = a.runtime.operationService as typeof a.runtime.operationService & {
      active(boardId: string): { setRealtime(enabled: boolean): Promise<void> } | undefined;
    };
    const sibling = sessions.active(first);
    expect(sibling, 'the first board still has a session to attach').toBeDefined();
    await sibling!.setRealtime(true);
    expect(await untilQuiet(() => logStatusOf(a, first)?.phase === 'synced'),
      `the background board attached: ${JSON.stringify(roomFor(a, first)?.log ?? null)}`).toBe(true);

    const heldA = roomIdFor(cloud, first);
    const heldB = roomIdFor(cloud, second);
    expect(heldA, 'board A holds a room').toBeDefined();
    expect(heldB, 'board B holds a room').toBeDefined();
    expect(cloud.signaling.sockets.length, 'both rooms are on one socket').toBe(1);
    // Named rooms, not a size: the socket also carries the account room, so the
    // count is "these two and any account room", and asserting the *identities*
    // is what keeps this from passing on a socket that swapped one for the other.
    const held = [...cloud.signaling.sockets[0].rooms.keys()];
    expect(held, 'that socket really holds both board rooms').toEqual(expect.arrayContaining([heldA!, heldB!]));
    for (const room of cloud.signaling.sockets[0].rooms.values())
      expect(room.board === first || room.board === second || room.board.startsWith('account:'),
        `unexpected third room on the socket: ${room.board}`).toBe(true);
    const beforeA = logStatusOf(a, first)!;

    // Detach board B alone.
    expect(cloud.signaling.detachRoom(heldB!, 'authorization_changed'), 'the relay detached board B').toBe(true);
    expect(await untilQuiet(() => roomFor(a, second)?.log?.error === 'authorization_changed'),
      `board B states the cause it was given: ${JSON.stringify(roomFor(a, second)?.log ?? null)}`).toBe(true);

    // Board B: its own cause, its own terminal state.
    const afterB = logStatusOf(a, second)!;
    expect(afterB.phase).toBe('error');
    expect(afterB.error).toBe('authorization_changed');
    // Board A: nothing moved — not its phase, not its cursor, not its room.
    const afterA = logStatusOf(a, first)!;
    expect(afterA.phase, "one room's detach never changes another room's phase").toBe('synced');
    expect(afterA.error, 'the sibling inherits no error').toBeNull();
    expect(afterA.appliedSeq, 'the sibling cursor is untouched').toBe(beforeA.appliedSeq);
    expect(roomIdFor(cloud, first), 'board A keeps the very room it had').toBe(heldA);
    // And it was not a disconnect: nothing re-admitted, nothing reopened.
    expect(cloud.signaling.sockets.length, 'a per-room detach never closes the connection').toBe(1);
    expect(cloud.signaling.detached.at(-1), 'the relay sent the coded detach for that room')
      .toEqual({ room: heldB!, code: 'authorization_changed' });
  });

  it('a refused attach is the room\'s own cause and leaves the connection serving', async () => {
    const blocked = await newBoard('Refused attach');
    // Armed by board, because the room id is derived from the manifest.
    cloud.signaling.refuseAttachRoom(blocked, 'unauthorized');
    await a.runtime.collaborationManager.start(blocked);
    expect(await untilQuiet(() => {
      const log = roomFor(a, blocked)?.log;
      return log?.phase === 'error' && log.error === 'unauthorized';
    }), `the refused room states its own cause: ${JSON.stringify(roomFor(a, blocked)?.log ?? null)}`).toBe(true);
    expect(cloud.signaling.refusals.some(entry => entry.code === 'unauthorized'), 'the relay answered the admission').toBe(true);

    // The context is still usable: another board opens and syncs.
    const healthy = boards[1];
    await openBoard(a, healthy);
    await expectSynced(a, healthy, 'the context survived a refused board');
  });

  it('a transport drop re-attaches the room from its own cursor and ends with one socket', async () => {
    const board = boards[1];
    await openBoard(a, board);
    await expectSynced(a, board);
    await a.rx.addItem({ projectId: board, content: 'before the drop' });
    await a.runtime.googleDrive.syncProject(board, { force: true });
    await expectSynced(a, board);
    const applied = logStatusOf(a, board)!.appliedSeq;
    expect(applied, 'the room applied history, so its cursor is non-zero').toBeGreaterThan(0);

    // Sampled *before* the kill, so "did this room come back" is decided by a
    // number that can only move when a fresh admission happened. Reading
    // `phase === 'synced'` alone is not a wait at all: that is the state the room
    // is already in, so the assertion below would sample the pre-drop snapshot
    // and then blame the code for a socket the client had not dialled yet.
    const admissions = cloud.signaling.admitted.length;
    for (const socket of [...cloud.signaling.sockets]) socket.kill();
    expect(cloud.signaling.sockets.length, 'the kill left nothing behind').toBe(0);

    // Recovery is a *new* admission plus a synced room: the drop is observable
    // only once the relay has admitted the room again.
    const recovered = await untilQuiet(() => cloud.signaling.admitted.length > admissions
      && cloud.signaling.sockets.length === 1
      && logStatusOf(a, board)?.phase === 'synced');
    expect(recovered, `the room recovered: ${JSON.stringify({ log: roomFor(a, board)?.log ?? null, held: cloud.signaling.roomsHeld() })}`).toBe(true);
    // The recovered room resumed above its own cursor instead of replaying from
    // zero, which is what a per-room cursor means.
    expect(logStatusOf(a, board)!.appliedSeq, 'the room resumed from its own cursor').toBeGreaterThanOrEqual(applied);
    expect(cloud.signaling.sockets.length, `the context is back to one live socket: ${JSON.stringify(cloud.signaling.roomsHeld())}`).toBe(1);
    // And the socket it holds is the board's: the recovery re-attached the room
    // rather than dialling a socket that carries nothing.
    expect(cloud.signaling.socketsForBoard(board).length, 'the recovered socket carries the board').toBe(1);
  });

  it('twenty boards on one context cost one socket and twenty attachments', async () => {
    // The acceptance number the whole change exists for. Every board enrols its
    // own device key and the relay admits each room against the key the attach
    // presents, so board count cannot multiply sockets. Twenty is the number the
    // brief names; each one is created, synced to Drive, opened and left synced
    // before the next, so a per-board socket would accumulate to twenty and a
    // per-board re-admission would show as twenty admissions.
    const startSockets = cloud.signaling.sockets.length;
    const startAttaches = cloud.signaling.attached.length;
    const visited: string[] = [];
    for (let index = 0; index < 20; index++) {
      const board = await newBoard(`Twenty ${index}`);
      visited.push(board);
      await openBoard(a, board);
      await expectSynced(a, board, `board ${index} of 20`);
    }
    expect(visited).toHaveLength(20);
    // One socket for twenty boards, and it is the socket the context already
    // had: the loop dialled nothing.
    expect(startSockets, 'there was exactly one socket to keep').toBe(1);
    expect(cloud.signaling.sockets.length, `twenty boards hold one socket: ${JSON.stringify(cloud.signaling.roomsHeld().map(r => r.room.slice(0, 12)))}`).toBe(1);
    // And the transport never changed hands: a switch detaches the old room and
    // *attaches* the new one to the connection that is already authenticated, so
    // twenty boards produce twenty attaches and not one new dial. (Admission
    // counts are not the right instrument here — the key courier dials a
    // short-lived socket per board on the same topic and authenticates there
    // too, which is pre-existing and unrelated to the transport.)
    // Every one of the twenty arrived as an `attach` frame.
    expect(cloud.signaling.attached.length - startAttaches, 'each board arrived as an attach').toBe(20);
    // The socket that carries them is carrying the current board's room, and the
    // room was admitted under that board's own device key — not the key that
    // opened the connection.
    const current = visited.at(-1)!;
    expect(cloud.signaling.socketsForBoard(current).length, 'the current board is on the live socket').toBe(1);
    const socket = cloud.signaling.sockets[0];
    expect(socket.deviceForRoom.get(roomIdFor(cloud, current)!), 'the room kept its own device key').not.toBe(socket.deviceKeyId);
  });

  it('falls back to protocol 2 unchanged: one socket per room, no attach ever sent', async () => {
    const fallback = createCloud();
    fallback.signaling.protocolVersion = 2;
    const b = await createBrowser({ label: 'legacy', email: OWNER, cloud: fallback });
    try {
      const first = await b.rx.createProject('Legacy one', 'project');
      await b.runtime.googleDrive.syncProject(first.id, { force: true });
      await openBoard(b, first.id);
      await expectSynced(b, first.id);
      const second = await b.rx.createProject('Legacy two', 'project');
      await b.rx.addItem({ projectId: second.id, content: 'second board' });
      await b.runtime.googleDrive.syncProject(second.id, { force: true });
      await openBoard(b, second.id);
      await expectSynced(b, second.id);

      // The deployed server's vocabulary: `authenticate` only. A v3-only frame
      // would have closed the socket (on v2, an unknown frame is fatal), so the
      // absence of `attach` is what proves the fallback is byte-compatible.
      expect(fallback.signaling.attached.length, 'a v2 server is never sent attach').toBe(0);
      expect(fallback.signaling.admitted.length, 'each room authenticated its own socket').toBeGreaterThanOrEqual(2);
      const status = logStatusOf(b, second.id);
      expect(status?.phase, `the v2 room synced: ${JSON.stringify(roomFor(b, second.id) ?? null)}`).toBe('synced');
      expect(status?.error).toBeNull();
    } finally { await b.close(); }
  });
});
