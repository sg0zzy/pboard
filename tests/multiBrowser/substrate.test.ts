/**
 * Unit proof for the three lifecycle-scenario substrate primitives added to
 * `fixtures/fakeSignaling.ts`, exercised directly (no browser runtime): the
 * handshake here is the real signature choreography the fixture demands, just
 * driven socket-to-socket. Every wait is event-gated — the suite owns no
 * wall-clock sleeps.
 *
 *  (a) restart: a second `FakeSignaling` over the same `FakeSignalingStore`
 *      keeps the appended rows and their sequences, while the volatile halves
 *      of the real service — the board-grant `GrantCache` and the identity
 *      Directory — go away, and live sockets see an abnormal close (1006),
 *      not a clean close-by-agreement (1000).
 *  (b) `insufficientHistory`: an armed per-room fault answers the next
 *      subscribe with the service's own gap frames (`sync_api.rs:257-283`) —
 *      `window synced:false gap.history_unavailable` and `snapshotRequired`
 *      with the checkpoint triple — fires exactly once, then recovers.
 *  (c) account room: one device may hold a board room and the account room
 *      (`pboard-account-<hash>-order`, `admission.rs:181-188`) on two live
 *      handles at once, and a frame naming the other room is still refused
 *      with `board_mismatch` (`sync_api.rs:245-248`).
 */
import { describe, expect, it } from 'vitest';
import { generateDeviceKey, importSigningKey, publicKeyFingerprint, signBytes, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest, type BoardPermissionManifest, type SignedManifest } from '../../src/collab/security/manifest';
import { canonicalBytes, toBase64Url, type Json } from '../../src/collab/security/canonical';
import { createSignalingStore, FakeSignaling, type FakeSocketImpl } from './fixtures/fakeSignaling';

const RELAY_ORIGIN = 'https://relay.invalid';
const OWNER = 'owner@example.test';
const BOARD = 'board-1';
const ACCOUNT_HASH = toBase64Url(new Uint8Array(Buffer.from(OWNER))).slice(0, 43);

type Frame = Record<string, unknown>;
const utf8 = (value: string) => new TextEncoder().encode(value);
/** Domain-separated tuples cross the wire as JSON arrays, exactly as the service parses them. */
const tuple = (value: unknown[]) => utf8(JSON.stringify(value));
const sha256url = async (bytes: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)));
const json = (value: unknown): Json => value as Json;

/** A socket plus the frames its "client" received, close included. Frames are
 * consumed strictly in arrival order; `until` skips past frames it doesn't want. */
class Recorder {
  readonly received: Frame[] = [];
  private readonly pending: Frame[] = [];
  private readonly waiters: ((frame: Frame) => void)[] = [];

  constructor(readonly socket: FakeSocketImpl) {
    socket.onmessage = event => this.accept(JSON.parse(String(event.data)) as Frame);
    socket.onclose = event => this.accept({ type: 'close', code: event.code });
  }

  private accept(frame: Frame) {
    this.received.push(frame);
    const resolve = this.waiters.shift();
    if (resolve) resolve(frame);
    else this.pending.push(frame);
  }

  take(): Promise<Frame> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<Frame>(resolve => this.waiters.push(resolve));
  }

  async until(type: string, action?: string): Promise<Frame> {
    for (;;) {
      const frame = await this.take();
      if (frame.type === type && (action === undefined || frame.action === action)) return frame;
    }
  }

  send(request: Record<string, unknown>) {
    return this.socket.send(JSON.stringify({ type: 'sync', request }));
  }
}

/** Everything one device needs to be admitted into one room under one authority. */
type Enrollment = {
  authority: StoredDeviceKey;
  device: StoredDeviceKey;
  deviceKeyId: string;
  authorityKeyId: string;
  payload: BoardPermissionManifest;
  signed: SignedManifest;
  topic: string;
  room: string;
  manifestPayload: string;
  digest: string;
};

async function createEnrollment(options: { topic: string; boardId: string; driveProjectFileId: string; driveFolderId: string; device?: StoredDeviceKey }): Promise<Enrollment> {
  const authority = await generateDeviceKey();
  const device = options.device ?? await generateDeviceKey();
  const deviceKeyId = await publicKeyFingerprint(device.publicJwk);
  const authorityKeyId = await publicKeyFingerprint(authority.publicJwk);
  const now = Date.now();
  const payload: BoardPermissionManifest = {
    protocol: 2, boardId: options.boardId, driveProjectFileId: options.driveProjectFileId, driveFolderId: options.driveFolderId,
    authorityKeyId, epoch: 1, issuedAt: now, expiresAt: now + 300_000,
    devices: [{ deviceKeyId, publicKey: device.publicJwk, role: 'owner' }],
  };
  const signed = await signManifest(payload, authority);
  const canonical = canonicalBytes(payload as unknown as Json);
  const roomHash = await sha256url(tuple(['pboard-ws-room-v2', options.topic, options.driveProjectFileId, options.driveFolderId]));
  return {
    authority, device, deviceKeyId, authorityKeyId, payload, signed, topic: options.topic,
    room: `pboard-v2-${authorityKeyId}-${roomHash}`,
    manifestPayload: toBase64Url(canonical),
    digest: await sha256url(canonical),
  };
}

const boardEnrollment = (device?: StoredDeviceKey) => createEnrollment({ topic: `pboard-collab-${BOARD}-cards`, boardId: BOARD, driveProjectFileId: 'file-1', driveFolderId: 'folder-1', device });
const accountEnrollment = (device?: StoredDeviceKey) => createEnrollment({ topic: `pboard-account-${ACCOUNT_HASH}-order`, boardId: `account:${ACCOUNT_HASH}`, driveProjectFileId: '', driveFolderId: '', device });

/** The full admission the fixture demands: identity exchange for a receipt, then the v2 authenticate. */
async function connect(service: FakeSignaling, token: string, enrollment: Enrollment): Promise<Recorder> {
  const recorder = new Recorder(new service.WebSocket('wss://relay.invalid/ws'));
  const welcome = await recorder.take();
  const hello = await (await service.handleHttp(`${RELAY_ORIGIN}/identity/challenge`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }))?.json() as Frame;
  const operation = { type: 'admit', challenge: welcome.challenge, session: welcome.session, room: enrollment.room, deviceKeyId: enrollment.deviceKeyId };
  const deviceKey = await importSigningKey(enrollment.device.privateJwk);
  const exchanged = await (await service.handleHttp(`${RELAY_ORIGIN}/identity/exchange`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      version: 1, challenge: hello.challenge, publicKey: enrollment.device.publicJwk,
      signature: await signBytes(deviceKey, canonicalBytes(json(['pboard-identity-v1', hello.challenge, enrollment.deviceKeyId, operation]))),
      operation,
    }),
  }))?.json() as Frame;
  await recorder.socket.send(JSON.stringify({
    type: 'authenticate', version: 2, room: enrollment.room, deviceKeyId: enrollment.deviceKeyId, serviceAdmission: exchanged.admission,
    authorization: { topic: enrollment.topic, authority: enrollment.authority.publicJwk, manifestPayload: enrollment.manifestPayload, manifestSignature: enrollment.signed.signature },
    signature: await signBytes(deviceKey, tuple(['pboard-ws-auth-v2', welcome.challenge, welcome.session, enrollment.room, enrollment.deviceKeyId, enrollment.digest])),
  }));
  await recorder.until('authenticated');
  return recorder;
}

/** Publishes through the real `/grants/publish` contract and returns the authority scope to read it back from. */
async function publishGrant(service: FakeSignaling, enrollment: Enrollment): Promise<string> {
  const hello = await (await service.handleHttp(`${RELAY_ORIGIN}/grants/challenge`, { method: 'POST' }))?.json() as Frame;
  const challenge = String(hello.challenge);
  const response = await service.handleHttp(`${RELAY_ORIGIN}/grants/publish`, {
    method: 'POST',
    body: JSON.stringify({
      version: 2, challenge,
      bundle: { version: 1, authority: enrollment.authority.publicJwk, history: [{ payload: enrollment.manifestPayload, signature: enrollment.signed.signature }] },
      deviceKeyId: enrollment.deviceKeyId,
      authoritySignature: await signBytes(await importSigningKey(enrollment.authority.privateJwk),
        tuple(['pboard-grant-publish-v2', challenge, enrollment.authorityKeyId, enrollment.payload.boardId, enrollment.digest])),
      signature: await signBytes(await importSigningKey(enrollment.device.privateJwk),
        tuple(['pboard-ws-auth-v2', 'publish', 'publish', enrollment.room, enrollment.deviceKeyId, enrollment.digest])),
    }),
  });
  expect(response?.status).toBe(204);
  return await sha256url(tuple(['pboard-board-grants-v1', enrollment.authorityKeyId, enrollment.payload.boardId]));
}

const readGrant = (service: FakeSignaling, scope: string) => service.handleHttp(`${RELAY_ORIGIN}/grants/${scope}`);

describe('fake signaling restart (T11 substrate)', () => {
  it('preserves appended operations and their seq while dropping published grants', async () => {
    const accounts = new Map([['token-a', OWNER]]);
    const first = new FakeSignaling(accounts, createSignalingStore());
    const enrollment = await boardEnrollment();
    const scope = await publishGrant(first, enrollment);
    expect((await readGrant(first, scope))?.status).toBe(200);

    const writer = await connect(first, 'token-a', enrollment);
    await writer.send({ action: 'subscribe', board: enrollment.room, afterSeq: 0 });
    expect((await writer.until('sync', 'window')).synced).toBe(true);
    await writer.send({ action: 'submit', board: enrollment.room, operations: [{ opId: 'op-1', payload: 'one' }, { opId: 'op-2', payload: 'two' }] });
    const accepted = await writer.until('sync', 'accepted');
    expect((accepted.results as Frame[]).map(row => row.seq)).toEqual([1, 2]);
    // Courier rows are as durable as the log (key_courier.rs creates SQLite tables).
    await writer.send({ action: 'publishDeviceKey', board: enrollment.room, publicKey: toBase64Url(utf8('wrap-key-1')) });
    await writer.until('sync', 'deviceKeyStored');
    await writer.send({ action: 'publishKeyGrants', board: enrollment.room, grants: [{ deviceKeyId: enrollment.deviceKeyId, envelope: toBase64Url(utf8('envelope')) }] });
    await writer.until('sync', 'keyGrantsStored');

    const second = first.restart();
    expect((await writer.until('close')).code).toBe(1006); // process death, not a clean close-by-agreement

    // Volatile halves: the GrantCache and the identity Directory are process RAM in the real service.
    expect(second.grants.size).toBe(0);
    expect((await readGrant(second, scope))?.status).toBe(404);
    expect(second.directory.size).toBe(0);
    // Durable halves, through the protocol rather than by reading the map:
    const reader = await connect(second, 'token-a', enrollment);
    await reader.send({ action: 'subscribe', board: enrollment.room, afterSeq: 0 });
    const window = await reader.until('sync', 'window');
    expect(window.synced).toBe(true);
    expect((window.operations as Frame[]).map(row => [row.seq, row.opId])).toEqual([[1, 'op-1'], [2, 'op-2']]);
    expect(window.liveFromSeq).toBe(3);
    const keys = await (reader.send({ action: 'listDeviceKeys', board: enrollment.room }), reader.until('sync', 'deviceKeys'));
    expect((keys.devices as Frame[]).map(row => row.deviceKeyId)).toEqual([enrollment.deviceKeyId]);
    await reader.send({ action: 'fetchKeyGrants', board: enrollment.room });
    const grants = await reader.until('sync', 'keyGrants');
    expect((grants.grants as Frame[]).map(row => row.fromDeviceKeyId)).toEqual([enrollment.deviceKeyId]);
    // And the sequence continues where the dead process left it:
    await reader.send({ action: 'submit', board: enrollment.room, operations: [{ opId: 'op-3', payload: 'three' }] });
    const resumed = await reader.until('sync', 'accepted');
    expect((resumed.results as Frame[]).map(row => row.seq)).toEqual([3]);
  });
});

describe('armed insufficient-history fault (T11 substrate)', () => {
  it('answers the next subscribe with the server gap frame, once, then recovers', async () => {
    const accounts = new Map([['token-a', OWNER]]);
    const service = new FakeSignaling(accounts, createSignalingStore());
    const enrollment = await boardEnrollment();
    const writer = await connect(service, 'token-a', enrollment);
    await writer.send({ action: 'submit', board: enrollment.room, operations: [{ opId: 'op-1', payload: 'one' }] });
    await writer.until('sync', 'accepted');

    service.insufficientHistory(enrollment.room, { reason: 'history_unavailable' });
    await writer.send({ action: 'subscribe', board: enrollment.room, afterSeq: 0 });
    const unavailable = await writer.until('sync', 'window');
    expect(unavailable.board).toBe(enrollment.room);
    expect(unavailable.synced).toBe(false);
    expect(unavailable.operations).toEqual([]);
    expect(unavailable.gap).toEqual({ reason: 'history_unavailable', oldestRetainedSeq: 1 });

    // Fired once: the following subscribe is a normal window again.
    await writer.send({ action: 'subscribe', board: enrollment.room, afterSeq: 0 });
    const recovered = await writer.until('sync', 'window');
    expect(recovered.synced).toBe(true);
    expect((recovered.operations as Frame[]).map(row => row.seq)).toEqual([1]);

    // snapshot_required is answered as the service answers it: a snapshotRequired
    // frame carrying the checkpoint triple the client's gap handler reads.
    service.insufficientHistory(enrollment.room, { reason: 'snapshot_required' });
    await writer.send({ action: 'subscribe', board: enrollment.room, afterSeq: 0 });
    const pruned = await writer.until('sync', 'snapshotRequired');
    expect(pruned.synced).toBe(false);
    expect(pruned.gap).toEqual({ reason: 'snapshot_required', checkpointSeq: 0, checkpointEpoch: 0, snapshotSeq: 0 });
    expect(service.replayFaults.get(enrollment.room)?.length).toBe(0);
    await writer.send({ action: 'subscribe', board: enrollment.room, afterSeq: 0 });
    expect((await writer.until('sync', 'window')).synced).toBe(true);
  });
});

describe('account room handles (T4/T5 substrate)', () => {
  it('holds the account room and a board room on two handles while refusing cross-room frames', async () => {
    const accounts = new Map([['token-a', OWNER]]);
    const service = new FakeSignaling(accounts, createSignalingStore());
    // One device (the browser), two pinned authorities (the board's and the
    // account's — `accountSecurityFor` is a separate authority in production).
    const device = await generateDeviceKey();
    const board = await boardEnrollment(device);
    const account = await accountEnrollment(device);
    const boardHandle = await connect(service, 'token-a', board);
    const accountHandle = await connect(service, 'token-a', account);

    const held = service.roomsHeld(board.deviceKeyId).map(entry => entry.room);
    expect(board.deviceKeyId).toBe(account.deviceKeyId); // one device, two rooms
    expect(held).toContain(board.room);
    expect(held).toContain(account.room);
    expect(service.roomsHeld()).toHaveLength(2);

    // The account handle works its own room with its own sequence.
    await accountHandle.send({ action: 'submit', board: account.room, operations: [{ opId: 'acct-1', payload: 'board.created' }] });
    const accepted = await accountHandle.until('sync', 'accepted');
    expect((accepted.results as Frame[]).map(row => row.seq)).toEqual([1]);

    // Separate sequences, separate row sets: `roomFor(room, 'account:<hash>')`
    // gets its own log the way every board does in the real service
    // (`sync_log.rs:394-398` per-board `next_seq`), so the account plane's
    // budget never interleaves with a board's — asserted, not assumed.
    await boardHandle.send({ action: 'submit', board: board.room, operations: [{ opId: 'card-1', payload: 'edit' }] });
    const onBoard = await boardHandle.until('sync', 'accepted');
    expect((onBoard.results as Frame[]).map(row => row.seq)).toEqual([1]);
    const accountRoom = service.rooms.get(account.room);
    expect(accountRoom?.board).toBe(`account:${ACCOUNT_HASH}`);
    expect((accountRoom?.rows ?? []).map(row => row.opId)).toEqual(['acct-1']);
    expect(service.rooms.get(board.room)?.rows.map(row => row.opId)).toEqual(['card-1']);

    // A grant can be advertised for the account room too: `/grants/publish`
    // derives the account topic from the manifest exactly like admission does.
    const scope = await publishGrant(service, account);
    expect((await readGrant(service, scope))?.status).toBe(200);

    // A frame on the account handle naming the board room is refused exactly as
    // the service refuses it, echoing the name the frame carried.
    await accountHandle.send({ action: 'subscribe', board: board.room });
    const refusal = await accountHandle.until('sync', 'error');
    expect(refusal.code).toBe('board_mismatch');
    expect(refusal.board).toBe(board.room);
    // The refusal is not a disconnect: the handle keeps serving its own room.
    await accountHandle.send({ action: 'subscribe', board: account.room });
    expect((await accountHandle.until('sync', 'window')).synced).toBe(true);
    // The board handle received nothing addressed to the account room.
    expect(boardHandle.received.filter(frame => frame.action === 'operation' && frame.board === account.room)).toEqual([]);
  });
});
