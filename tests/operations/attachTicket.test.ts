/**
 * Every v3 `attach` carries its own service-admission receipt.
 *
 * A receipt is bound to `(socket challenge, session, room, device)` and is
 * **single-use**: the service deletes it when it consumes one
 * (`identity_enrollment.rs` `consume`). The relay's v3 `attach` therefore
 * requires a receipt minted for *that* attach, and the client could not supply
 * one twice: `admitService` reused a receipt for a minute, so a board switched
 * away and back on the same socket presented a spent receipt and was answered
 * `service_auth_required` — which is terminal, so the room went to `error#18`
 * for good while its sibling stayed `synced`.
 *
 * These scenarios pin the four rules that make that unrepresentable:
 *  - every attach mints its own receipt, for its own device;
 *  - a receipt that cannot be obtained is that room's stated cause and never
 *    the connection's;
 *  - three rooms cost three receipts;
 *  - a welcome that does not require admission mints nothing.
 *
 * Everything is counted at the fake identity service and the fake relay, never
 * timed; the only waits are on those counters moving.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instantAuthBudget } from '../helpers/authBudget';
import { createOperationLogSync, clearReconnectLedger, type OperationLogSync } from '../../src/sync/operations/logSync';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest } from '../../src/collab/security/manifest';
import type { RelayAuthorization } from '../../src/collab/security/relayAdmission';
import type { Operation } from '../../src/sync/operations/protocol';

const URL_ = 'wss://relay.example.test/ws';
type Ticket = { challenge: string; session: string; room: string; deviceKeyId: string };

/**
 * One relay *and* the identity service behind it, because the two halves of the
 * contract only mean something together: a receipt the client mints here is
 * consumed here, exactly once, for the exact binding it was minted for.
 */
class Relay {
  static OPEN = 1;
  static instances: Relay[] = [];
  static requireAdmission = true;
  /** Every receipt the identity service minted, in order. */
  static minted: Ticket[] = [];
  /** Every `attach`/`authenticate` the relay refused, with its code. */
  static refusals: { code: string; room: string }[] = [];
  /** Makes the next identity exchanges fail, for the room's-own-cause case. */
  static admissionFailure: string | null = null;
  /** Fails exchanges for one room only, leaving its siblings mintable. */
  static admissionFailureForRoom: { room: string; reason: string } | null = null;
  /** Fails every exchange for one room's *device*, so the failure lands inside
   * `prove` before the room id is known — the fresh-dial case. */
  static admissionFailureForDevice: string | null = null;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number } | undefined) => void;
  onerror?: () => void;
  rooms = new Map<string, string>();
  receipts = new Map<string, Ticket>();
  nextSeq = new Map<string, number>();
  challenge = 'c'.repeat(43);
  session = 's'.repeat(43);
  constructor(_url: string | URL) {
    Relay.instances.push(this);
    queueMicrotask(() => this.push({ type: 'welcome', version: 1, supportedVersions: [1, 2, 3],
      challenge: this.challenge, session: this.session, requiresServiceAdmission: Relay.requireAdmission }));
  }
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(raw: string) {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'authenticate' || message.type === 'attach') this.admit(message);
    if (message.type === 'detach') {
      this.rooms.delete(String(message.room ?? ''));
      this.push({ type: 'detached', room: message.room });
    }
    if (message.type === 'sync') this.answer(message.request as Record<string, unknown>);
  }
  admit(message: Record<string, unknown>) {
    const room = String(message.room ?? '');
    const deviceKeyId = String(message.deviceKeyId ?? '');
    if (Relay.requireAdmission) {
      const key = String(message.serviceAdmission ?? '');
      const ticket = this.receipts.get(key);
      // Consumed on presentation, before the binding is checked — the service
      // removes the row first (`identity_enrollment.rs` `consume`).
      this.receipts.delete(key);
      if (!ticket || ticket.challenge !== this.challenge || ticket.session !== this.session
        || ticket.room !== room || ticket.deviceKeyId !== deviceKeyId) {
        Relay.refusals.push({ code: 'service_auth_required', room });
        this.push({ type: 'refused', code: 'service_auth_required', room });
        return;
      }
    }
    this.rooms.set(room, deviceKeyId);
    if (!this.nextSeq.has(room)) this.nextSeq.set(room, 1);
    if (message.type === 'authenticate')
      this.push({ type: 'authenticated', peerId: deviceKeyId, session: this.session, version: 3, role: 'editor' });
    else this.push({ type: 'attached', room, role: 'editor' });
  }
  answer(request: Record<string, unknown>) {
    const board = String(request.board ?? '');
    if (request.action === 'subscribe') this.push({ type: 'sync', action: 'window', board,
      operations: [], checkpointSeq: 0, synced: true, liveFromSeq: this.nextSeq.get(board) ?? 1 });
  }
  kill() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  close() { this.readyState = 3; }
}

const settled = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let step = 0; step < 400; step++) {
    await settled();
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`never reached: ${what}`);
};

let seq = 0;
type Room = { id: string; topic: string; key: StoredDeviceKey; authorization: RelayAuthorization };
async function board(): Promise<Room> {
  const id = `board-${++seq}`;
  const key = await generateDeviceKey();
  const manifest = await signManifest({
    protocol: 2, boardId: id, driveProjectFileId: `file-${id}`, driveFolderId: `folder-${id}`, authorityKeyId: key.keyId,
    epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' }]
  }, key);
  return { id, topic: `pboard-collab-${id}-cards`, key, authorization: { authority: key.publicJwk, manifest } };
}

/**
 * The identity service's `/identity/exchange` for `type: 'admit'`. One call is
 * one receipt; there is deliberately no client-side cache, because a receipt
 * that has been presented once can never admit a second frame.
 */
function admitService(request: { challenge: string; session: string; room: string; key: StoredDeviceKey }): Promise<string> {
  if (Relay.admissionFailure) return Promise.reject(new Error(Relay.admissionFailure));
  if (Relay.admissionFailureForRoom?.room === request.room)
    return Promise.reject(new Error(Relay.admissionFailureForRoom.reason));
  if (Relay.admissionFailureForDevice === request.key.keyId) return Promise.reject(new Error('the identity service is unreachable'));
  const receipt: Ticket = { challenge: request.challenge, session: request.session, room: request.room, deviceKeyId: request.key.keyId };
  Relay.minted.push(receipt);
  const ticket = `${'a'.repeat(37)}${String(Relay.minted.length).padStart(6, '0')}`;
  Relay.instances.at(-1)?.receipts.set(ticket, receipt);
  return Promise.resolve(ticket);
}

async function start(room: Room, overrides: Record<string, unknown> = {}): Promise<OperationLogSync> {
  return await createOperationLogSync({
    boardId: room.id, topic: room.topic, url: URL_,
    getKey: async () => room.key, getAuthorization: async () => room.authorization,
    seal: async op => JSON.stringify(op), open: async payload => JSON.parse(payload) as Operation,
    receive: async () => {}, gap: async () => {}, status: () => {},
    cursor: { load: async () => 0, save: async () => {} },
    authBudget: instantAuthBudget(),
    getServiceAdmission: admitService,
    reconnectBaseMs: 10,
    webSocket: Relay as unknown as typeof WebSocket, ...overrides
  });
}

beforeEach(() => {
  clearReconnectLedger();
  Relay.instances = []; Relay.minted = []; Relay.refusals = []; Relay.requireAdmission = true; Relay.admissionFailure = null; Relay.admissionFailureForRoom = null; Relay.admissionFailureForDevice = null;
});
afterEach(() => { clearReconnectLedger(); Relay.instances = []; });

describe('every v3 attach carries its own service-admission receipt', () => {
  it('a room attached after the first carries a receipt and reaches synced', async () => {
    const first = await board(), second = await board();
    const logs: OperationLogSync[] = [];
    try {
      logs.push(await start(first));
      await until(() => logs[0].status().phase === 'synced', 'first room synced');
      logs.push(await start(second));
      await until(() => logs[1].status().phase === 'synced', 'second room synced');

      const attach = Relay.instances[0].sent.find(frame => frame.type === 'attach');
      expect(attach, 'the second room joined the socket as an attach').toBeDefined();
      expect(attach?.serviceAdmission, 'the attach frame carries a receipt').toBeTypeOf('string');
      // ...and it was minted for this attach's own device, not the connection's.
      const minted = Relay.minted.at(-1)!;
      expect(minted.deviceKeyId).toBe(second.key.keyId);
      expect(minted.room).toBe(attach?.room);
      expect(Relay.refusals).toEqual([]);
    } finally { for (const log of logs) await log.close(); }
  });

  it('re-attaching the same room on one socket mints a fresh receipt, never the spent one', async () => {
    // The field defect: `admitService` reused a receipt for a minute, so a board
    // switched away and back presented one the relay had already consumed and
    // was answered `service_auth_required` — terminal, so that room could never
    // attach again while its sibling kept syncing.
    const room = await board();
    const logs: OperationLogSync[] = [];
    try {
      const first = await start(room);
      logs.push(first);
      await until(() => first.status().phase === 'synced', 'first attach synced');
      const mintedAfterFirst = Relay.minted.length;
      await first.close();
      await settled();
      // Same socket, same challenge, same session, same room, same device: the
      // exact binding a reuse cache answered from.
      const second = await start(room);
      logs.push(second);
      await until(() => second.status().phase === 'synced', 're-attach synced');
      expect(Relay.minted.length, 'the re-attach minted its own receipt').toBe(mintedAfterFirst + 1);
      expect(Relay.refusals, 'no frame presented a consumed receipt').toEqual([]);
      expect(Relay.instances.length, 'the socket was never rebuilt for this').toBe(1);
    } finally { for (const log of logs) await log.close(); }
  });

  it('three rooms on one v3 session mint three receipts and all sync', async () => {
    const rooms = [await board(), await board(), await board()];
    const logs: OperationLogSync[] = [];
    try {
      for (const room of rooms) {
        logs.push(await start(room));
        await until(() => logs.at(-1)!.status().phase === 'synced', `${room.id} synced`);
      }
      expect(Relay.instances.length, 'one socket carried every room').toBe(1);
      expect(Relay.minted, 'one receipt per room, not one for the connection')
        .toHaveLength(rooms.length);
      expect(Relay.minted.map(entry => entry.deviceKeyId).sort(), 'each receipt names its own room device')
        .toEqual(rooms.map(room => room.key.keyId).sort());
      expect(Relay.refusals).toEqual([]);
    } finally { for (const log of logs) await log.close(); }
  });

  it('a room whose receipt cannot be obtained states its cause, and its sibling keeps syncing', async () => {
    const first = await board(), second = await board();
    const logs: OperationLogSync[] = [];
    try {
      logs.push(await start(first));
      await until(() => logs[0].status().phase === 'synced', 'first room synced');
      Relay.admissionFailure = 'Google service admission requires a connected account';

      // The open fails with that room's own cause, stated — not silently.
      await expect(start(second)).rejects.toThrow('Google service admission requires a connected account');
      await settled();

      expect(logs[0].status().phase, 'the sibling was never disturbed').toBe('synced');
      expect(Relay.instances.length, 'the socket stayed up: one dial, shared').toBe(1);
      expect(logs[0].status().error).toBeNull();

      // ...and the room recovers on the next attempt once its credential exists.
      Relay.admissionFailure = null;
      logs.push(await start(second));
      await until(() => logs[1].status().phase === 'synced', 'second room synced on retry');
      expect(Relay.instances.length, 'recovery reused the live socket').toBe(1);
    } finally { for (const log of logs) await log.close(); }
  });

  it('mints no receipt when the welcome does not require service admission', async () => {
    Relay.requireAdmission = false;
    const rooms = [await board(), await board()];
    const logs: OperationLogSync[] = [];
    try {
      logs.push(await start(rooms[0]));
      await until(() => logs[0].status().phase === 'synced', 'first room synced');
      logs.push(await start(rooms[1]));
      await until(() => logs[1].status().phase === 'synced', 'second room synced');
      expect(Relay.minted, 'the welcome said admission was not required').toEqual([]);
      const frames = Relay.instances[0].sent.filter(frame => frame.type === 'authenticate' || frame.type === 'attach');
      expect(frames).toHaveLength(2);
      expect(frames.every(frame => frame.serviceAdmission === undefined)).toBe(true);
    } finally { for (const log of logs) await log.close(); }
  });

  it('re-attaches every room after a dropped socket with a receipt for the new welcome', async () => {
    const rooms = [await board(), await board()];
    const logs: OperationLogSync[] = [];
    try {
      logs.push(await start(rooms[0]));
      await until(() => logs[0].status().phase === 'synced', 'first room synced');
      logs.push(await start(rooms[1]));
      await until(() => logs[1].status().phase === 'synced', 'second room synced');
      const before = Relay.instances.length;
      Relay.instances[0].kill();
      await until(() => Relay.instances.length > before, 'the connection redialled');
      const fresh = Relay.instances.at(-1)!;
      await until(() => fresh.rooms.size === 2, 'both rooms re-attached');
      const frames = fresh.sent.filter(frame => frame.type === 'authenticate' || frame.type === 'attach');
      expect(frames.map(frame => frame.type)).toEqual(['authenticate', 'attach']);
      expect(frames.every(frame => typeof frame.serviceAdmission === 'string'),
        'each re-attach carried a receipt for the new welcome').toBe(true);
      expect(Relay.refusals, 'the dead socket’s receipts were not re-presented').toEqual([]);
    } finally { for (const log of logs) await log.close(); }
  });

  it('a ticket that fails during re-attach is retried on the room\'s own ladder, not by re-dialling for everybody', async () => {
    const first = await board(), second = await board();
    // Each board has its own room id, so the failing one is named after it.
    const logs: OperationLogSync[] = [];
    try {
      logs.push(await start(first));
      await until(() => logs[0].status().phase === 'synced', 'first room synced');
      logs.push(await start(second));
      await until(() => logs[1].status().phase === 'synced', 'second room synced');
      const socket = Relay.instances[0];
      const secondRoom = [...socket.rooms.keys()][1] ?? [...socket.rooms.keys()][0];

      // The tunnel dies; the sibling's receipt can be minted, this room's cannot.
      Relay.admissionFailureForRoom = { room: secondRoom, reason: 'the identity exchange is rate limited' };
      socket.kill();
      await until(() => Relay.instances.length > 1, 'the connection redialled');
      const fresh = Relay.instances.at(-1)!;
      // The healthy room comes back on the new socket...
      await until(() => fresh.rooms.size === 1, 'the healthy room re-attached');
      // ...and the failing room states its own cause without taking it down.
      await until(() => [logs[1].status().error, logs[0].status().error]
        .some(error => String(error).includes('rate limited')), 'the room stated its cause');
      expect(Relay.instances.length, 'one redial; the failing ticket did not add another').toBe(2);

      // Its own credential returns: the room attaches on the socket that is up.
      Relay.admissionFailureForRoom = null;
      await until(() => logs[1].status().phase === 'synced', 'the room recovered');
      expect(Relay.instances.length, 'recovery cost no extra socket').toBe(2);
      expect(fresh.rooms.size).toBe(2);
    } finally { for (const log of logs) await log.close(); }
  });

  it('a room whose first attach cannot mint a ticket never takes the live socket down', async () => {
    const first = await board(), second = await board();
    const logs: OperationLogSync[] = [];
    try {
      logs.push(await start(first));
      await until(() => logs[0].status().phase === 'synced', 'first room synced');
      // The second room's device cannot get a receipt. The failure lands inside
      // `prove`, before the room id exists — the fresh-dial case.
      Relay.admissionFailureForDevice = second.key.keyId;
      await expect(start(second)).rejects.toThrow('the identity service is unreachable');
      await settled();
      expect(logs[0].status().phase, 'the sibling kept its socket and its sync').toBe('synced');
      expect(Relay.instances.length, 'no dial was spent on a room that never proved anything').toBe(1);
      // Its credential returns and the room opens on the socket that is up.
      Relay.admissionFailureForDevice = null;
      logs.push(await start(second));
      await until(() => logs[1].status().phase === 'synced', 'the room came back');
      expect(Relay.instances.length).toBe(1);
    } finally { for (const log of logs) await log.close(); }
  });
});
