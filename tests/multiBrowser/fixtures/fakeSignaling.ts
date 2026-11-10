/**
 * Shared fake Pboard signaling service for the two-browser suite.
 *
 * The log/room semantics are a copy-forward of `tests/operations/logSyncConvergence.test.ts`
 * (`BoardLog`/`Tab`: append with dedupe before sequence allocation, a replay
 * window filtered by the requested sequence, publication to every subscriber
 * including the writer, author attribution taken from the authenticated
 * connection), and the authentication/welcome choreography is a copy-forward
 * of `tests/operations/logSync.test.ts` and `tests/serviceAdmission.test.ts`.
 * They are deliberately *not* imported: another agent owns those files, and a
 * fixture two agents edit is how a mystery failure happens.
 *
 * On top of that it implements the two contracts the multi-browser scenarios
 * depend on, from `services/pboard-signaling/PROTOCOL.md`:
 *  - the board-grant directory (`/grants/challenge`, `/grants/publish`,
 *    `GET /grants/<scope>`) with the version-2 replay-resistant signatures, and
 *  - the Google identity exchange (`/identity/challenge`, `/identity/exchange`)
 *    including the short-lived service-admission receipts the sockets demand
 *    whenever the service has a Google account connected — the fixture derives
 *    that from `accounts.size`, mirroring the real condition
 *    (`lib.rs:883`/`:1081`: enrollment configured **and** the grant directory
 *    present). A receipt is validated against `(challenge, session, room,
 *    device)` and consumed on first presentation, exactly as
 *    `identity_enrollment.rs` consumes one, so one receipt admits one frame and
 *    every attach needs its own. A cloud with no Google account connected gets a
 *    service that requires none, which is what the deployed relay does when
 *    those tables are absent — and what makes a Google-free scenario testable
 *    without a credential it could never mint, and
 *  - the key courier (four actions, wire caps, envelopes addressed only to
 *    their recipient, idempotent republish, replace-not-append per sender).
 *
 * Attribution rules the fake enforces the way the service does: the author of
 * an operation row and the author of a courier grant come from the
 * *authenticated* connection, never from a body field; every socket authenticates
 * with the real signature scheme (`pboard-ws-auth-v2`) over the challenge it
 * was given, and admission is refused unless the manifest in the connection's
 * authorization lists that device, verifies against its authority, and matches
 * the room hash — so two browsers only share a room when they share a board
 * authority, which is exactly the property scenario 2 of the owner/editor file
 * asserts.
 *
 * The lifecycle scenarios (T4/T6/T7/T11) additionally need a server that dies
 * and comes back, a replay window that can run out, and one browser holding a
 * board room and its account room at once. The fixture models the real
 * service's durability split exactly: what lives in SQLite there — the
 * operation log with its per-board `next_seq`, checkpoints, and the courier's
 * `device_key`/`key_grant` tables — lives in a `FakeSignalingStore` hoisted
 * out of the socket layer and survives `restart()`; what lives in process RAM
 * there — the board-grant `GrantCache` (a `HashMap`, `board_grants.rs`), the
 * identity `Directory`, admission receipts — is per-instance and dies with it,
 * which is the asymmetry the scenarios assert, not an oversight.
 */
import { publicKeyFingerprint, verifyBytes } from '../../../src/collab/security/keys';
import { verifyManifest, type SignedManifest } from '../../../src/collab/security/manifest';
import { canonicalBytes, fromBase64Url, parseStrictJson, toBase64Url, type Json } from '../../../src/collab/security/canonical';

const RELAY_ORIGIN = 'https://relay.invalid';
const MAX_GRANTS_PER_PUBLISH = 32;
const MAX_LISTED_DEVICES = 64;
const MAX_PUBLIC_KEY_BYTES = 128;
const MAX_ENVELOPE_BYTES = 1024;

type Frame = Record<string, unknown>;
const frames = (value: unknown): Frame[] => Array.isArray(value)
  ? value.filter((row): row is Frame => !!row && typeof row === 'object' && !Array.isArray(row)) : [];

const random43 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32))).slice(0, 43);
const sha256url = async (bytes: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const utf8 = (value: string) => new TextEncoder().encode(value);
/** Wire payloads are structurally JSON by construction at these call sites. */
const asJson = (value: unknown): Json => value as Json;

/** One operation-log row as the log stores it: sealed bytes, author from auth. */
type LogRow = { opId: string; seq: number; actorId: string; protocolVersion: number; logicalClock: number; enqueuedAt: number; payload: string };

export type CourierGrant = { from: string; to: string; envelope: string };

/** Why a subscription cannot be answered from the retained window, in the
 * service's own words (`sync_api.rs:257-270`): `history_unavailable` rows fell
 * out of replay, `snapshot_required` means a checkpoint supersedes them. */
export type GapFaultReason = 'history_unavailable' | 'snapshot_required';

/** One armed insufficient-history answer; unset fields default to the room's
 * real checkpoint/cursor state when the fault fires. */
export type GapFault = {
  reason: GapFaultReason;
  oldestRetainedSeq?: number;
  checkpointSeq?: number;
  checkpointEpoch?: number;
  snapshotSeq?: number;
};

/** The durable half of one fake service — the part a real restart preserves
 * because SQLite holds it (the `operation`/`board`/`checkpoint`/`lease` tables
 * of `sync_log.rs` and the `device_key`/`key_grant` tables of
 * `key_courier.rs`). Pass one store to a second `FakeSignaling` to bring the
 * same data back up; `FakeSignaling.restart()` does exactly that. */
export type FakeSignalingStore = {
  /** Room string → log state. Rows keep their `seq` across instances. */
  readonly rooms: Map<string, FakeRoom>;
  readonly courierKeys: Map<string, Map<string, string>>;
  readonly courierGrants: Map<string, CourierGrant[]>;
};

export function createSignalingStore(): FakeSignalingStore {
  return { rooms: new Map(), courierKeys: new Map(), courierGrants: new Map() };
}

/** Which instance a store's WebSocket class is currently answering for: the
 * most recently constructed one, so sockets created after a `restart()` —
 * including by browsers that captured the class earlier — land on the new
 * process, while sockets made before it keep their original service. */
const liveServices = new WeakMap<FakeSignalingStore, FakeSignaling>();
function liveService(store: FakeSignalingStore): FakeSignaling {
  const service = liveServices.get(store);
  if (!service) throw new Error('fake signaling: store has no live service');
  return service;
}

/** The service's id grammar (`admission.rs:93-95`), as the client's own
 * `relayAdmission.ts` spells it. */
const validRoomId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);

/** A publication + pending device requests as the identity directory holds them. */
type DirectoryEntry = { publication: Frame; pending: { email: string; request: Frame }[] };

/** One room's log as the service stores it. This whole record is durable:
 * rows, the next sequence number, and the checkpoint survive `restart()`
 * because in the real service they are SQLite rows. */
export type FakeRoom = {
  room: string;
  board: string;
  rows: LogRow[];
  nextSeq: number;
  checkpointSeq: number;
  snapshotSeq: number;
  epoch: number;
  lease: { holder: string; epoch: number; expiresAt: number } | null;
  /** Every submission the log attributed, in order, with its authenticated author. */
  readonly submissions: { deviceKeyId: string; opId: string; seq: number; duplicate: boolean }[];
};

export class FakeSocketImpl {
  static OPEN = 1;
  readyState = 1;
  challenge = random43();
  session = random43();
  deviceKeyId = '';
  private googleEmail?: string;
  /** The negotiated protocol. 2 keeps this handle exactly as it always was — one
   * admitted room, every frame measured against it. 3 adds `attach`/`detach`,
   * per-room refusals and per-room detaches on one authenticated socket, which
   * is the whole point of the version. */
  version = 0;
  /** Every room this handle holds, in attach order. `room` is the first one, so
   * a v2 assertion (`socket.room?.board`) reads exactly as before. */
  readonly rooms = new Map<string, FakeRoom>();
  /** The device key each held room was admitted under. A multiplexed socket
   * carries one per room, so "this connection's device" is not an answer any
   * more for anything room-scoped (attribution, roles, courier addressing). */
  readonly deviceForRoom = new Map<string, string>();
  room: FakeRoom | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: ((event: { code: number }) => void) | undefined;
  onerror: (() => void) | undefined;

  constructor(public readonly url: string | URL, private readonly service: FakeSignaling) {
    service.sockets.push(this);
    if (service.unreachable) {
      // The service is not there: the socket opens and dies with no frames —
      // no welcome, no refusal, no service state touched. This is what a
      // client sees when the relay or the proxy in front of it is down, and
      // unlike an armed refusal it keeps answering every attempt for as long
      // as the scenario holds it, which is the point: the client has to
      // survive an outage, not one bad frame.
      service.unreachableAttempts++;
      queueMicrotask(() => { this.onerror?.(); this.kill(); });
      return;
    }
    queueMicrotask(() => this.push({ type: 'welcome', version: 1,
      supportedVersions: service.protocolVersion === 2 ? [1, 2] : [1, 2, 3],
      challenge: this.challenge, session: this.session,
      // What the real service tells the client (`lib.rs:883`), derived from the
      // same condition it enforces below: a service with a connected Google
      // account requires a receipt, one without does not.
      requiresServiceAdmission: service.requiresServiceAdmission }));
  }

  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }


  async send(raw: string) {
    const message = parseStrictJson(raw) as Frame | null;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'authenticate') { await this.authenticate(message); return; }
    if (message.type === 'attach') { await this.attach(message); return; }
    if (message.type === 'detach') { this.detach(message); return; }
    if (message.type === 'renewGoogle') {
      const room = String(message.room ?? ''), ticket = this.service.driveTickets.get(String(message.serviceAdmission ?? ''));
      this.service.driveTickets.delete(String(message.serviceAdmission ?? ''));
      if (!ticket || ticket.room !== room || ticket.session !== this.session || ticket.challenge !== this.challenge || ticket.email !== this.googleEmail || !this.rooms.has(room)) {
        this.push({ type: 'refused', room, code: 'unauthorized' }); return;
      }
      this.service.roles.set(`${this.deviceForRoom.get(room)}|${ticket.board}`, ticket.role);
      this.push({ type: 'renewedGoogle', room, role: ticket.role === 'owner' ? 'editor' : ticket.role }); return;
    }
    if (message.type === 'ping') { this.push({ type: 'pong' }); return; }
    if (message.type === 'leave') { this.drop(); return; }
    if (message.type === 'sync') await this.syncRequest(message.request as Frame);
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.drop();
    queueMicrotask(() => this.onclose?.({ code: 1000 }));
  }

  /** The process went away, not a hangup: an abnormal close (1006) with no
   * frame from the server and no close handshake — what a client's socket
   * reports when the tunnel dies. Used by `restart()`; a graceful
   * `server_shutdown` frame stays a different event, because it is one. */
  kill() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.drop();
    queueMicrotask(() => this.onclose?.({ code: 1006 }));
  }

  private drop() {
    this.rooms.clear();
    this.deviceForRoom.clear();
    if (this.room) this.room = undefined;
    const index = this.service.sockets.indexOf(this);
    if (index >= 0) this.service.sockets.splice(index, 1);
  }

  private async authenticate(message: Frame) {
    const room = String(message.room ?? '');
    const deviceKeyId = String(message.deviceKeyId ?? '');
    const receipt = this.service.receipts.get(String(message.serviceAdmission ?? ''));
    const authorization = message.authorization as { topic?: string; authority?: Record<string, unknown>; manifestPayload?: string; manifestSignature?: string } | undefined;
    const refused = (code: string) => { this.service.refusals.push({ code, room, deviceKeyId }); this.push({ type: 'error', code }); this.close(); };
    if (message.version !== 2 && message.version !== 3) return refused('version_unsupported');
    const admitted = await this.admitRoom(message, 'authenticate');
    if (typeof admitted === 'string') return refused(admitted);
    this.version = Number(message.version);
    this.deviceKeyId = admitted.deviceKeyId;
    this.room = admitted.room;
    this.rooms.set(admitted.room.room, admitted.room);
    this.deviceForRoom.set(admitted.room.room, admitted.deviceKeyId);
    queueMicrotask(() => this.push({ type: 'authenticated', peerId: admitted.deviceKeyId, session: this.session,
      ...(this.version >= 3 ? { version: this.version, role: this.roleFor(admitted.room) } : {}) }));
  }

  /** The v3 `attach`: one more room with its own complete authorization, on the
   * socket that is already authenticated. A refusal is an answer, never a
   * close — that is what keeps one bad board from taking the tab's transport
   * down. */
  private async attach(message: Frame) {
    if (this.version !== 3) return this.close(); // v2 has no such frame: fatal, exactly as before
    const room = String(message.room ?? '');
    const refused = (code: string) => {
      this.service.refusals.push({ code, room, deviceKeyId: this.deviceKeyId });
      this.push({ type: 'refused', code, room });
    };
    if (this.rooms.has(room)) {
      // Idempotent: attaching twice answers the role and does not double-subscribe.
      this.push({ type: 'attached', room, role: this.roleFor(this.rooms.get(room)!) });
      return;
    }
    if (this.rooms.size >= 32) return refused('room_limit');
    const admitted = await this.admitRoom(message, 'attach');
    if (typeof admitted === 'string') return refused(admitted);
    this.rooms.set(admitted.room.room, admitted.room);
    this.deviceForRoom.set(admitted.room.room, admitted.deviceKeyId);
    // The *primary* room — the one a legacy `join`/`signal` speaks for, and the
    // fallback a frame naming no board resolves to. On a multiplexed socket the
    // first room of a *connection* keeps the slot; a later attach fills it only
    // when the primary left (a switch detaches the old room first), which is
    // exactly the service's `primary.is_none()` rule. Without this the socket's
    // `room` stayed `undefined` after a switch and `syncRequest` returned early,
    // so the first subscribe on the new room went unanswered and the client
    // timed out — a fixture bug that looked exactly like a client one.
    if (!this.room) this.room = admitted.room;
    this.service.attached.push({ room: admitted.room.room, deviceKeyId: admitted.deviceKeyId,
      email: this.service.receipts.get(String(message.serviceAdmission ?? ''))?.email ?? '' });
    this.push({ type: 'attached', room: admitted.room.room, role: this.roleFor(admitted.room) });
  }

  private detach(message: Frame) {
    if (this.version !== 3) return this.close();
    const room = String(message.room ?? '');
    const held = this.rooms.get(room);
    if (!held) { this.push({ type: 'detached', room, code: 'not_attached' }); return; }
    this.rooms.delete(room);
    if (this.room === held) this.room = [...this.rooms.values()][0];
    this.push({ type: 'detached', room });
  }

  /** The device a held room was admitted under — the unit every room-scoped
   * action (lease holder, courier sender/recipient) is attributed to, because a
   * multiplexed socket has one per room. */
  private deviceOf(room: FakeRoom): string { return this.deviceForRoom.get(room.room) ?? this.deviceKeyId; }

  /** The role this connection holds in one room, as the manifest declared it. */
  private roleFor(room: FakeRoom): string {
    return this.service.roleOf(this.deviceForRoom.get(room.room) ?? this.deviceKeyId, room.board) ?? 'editor';
  }

  /**
   * The v2/v3 admission check, factored out because a v3 `attach` is
   * *authenticated exactly as an `authenticate` is*: same manifest, same
   * binding, same device signature over the same welcome challenge. Returns the
   * admitted room, or the refusal code.
   */
  private async admitRoom(message: Frame, kind: 'authenticate' | 'attach'): Promise<{ room: FakeRoom; deviceKeyId: string } | string> {
    const room = String(message.room ?? '');
    // An `attach` may present its own device key (`AttachDeviceKeys` on the
    // service side): the client enrols one device per board, so a multiplexed
    // socket's rooms are signed by different keys. Absent means "the
    // connection's device", which is what every pre-existing frame meant.
    const deviceKeyId = kind === 'authenticate'
      ? String(message.deviceKeyId ?? '')
      : String(message.deviceKeyId ?? this.deviceKeyId);
    const authorization = message.authorization as { topic?: string; authority?: Record<string, unknown>; manifestPayload?: string; manifestSignature?: string } | undefined;
    if (!authorization) {
      const ticketId = String(message.serviceAdmission ?? '');
      const ticket = this.service.driveTickets.get(ticketId);
      this.service.driveTickets.delete(ticketId);
      if (!ticket || ticket.room !== room || ticket.session !== this.session || ticket.challenge !== this.challenge || (this.googleEmail && this.googleEmail !== ticket.email)) return 'unauthorized';
      // The Drive-authorized room takes the same armed-refusal answer as a
      // manifest room: `refuseAttachRoom` names a board, and this is the only
      // admission a Drive-authorized browser performs, so an armed code must be
      // resolved here or no scenario could exercise a refused attach at all.
      // Like every refusal in the service it is the code for that room and it
      // leaves the socket (and its other rooms) untouched.
      const armed = this.service.attachRefusals.get(room) ?? this.service.attachRefusalsByBoard.get(ticket.board);
      if (armed) return armed;
      this.googleEmail = ticket.email;
      this.service.roles.set(`${deviceKeyId}|${ticket.board}`, ticket.role);
      this.service.admitted.push({ room, deviceKeyId, email: ticket.email, kind });
      return { room: this.service.roomFor(room, ticket.board), deviceKeyId };
    }
    if (!authorization?.manifestPayload || !authorization.manifestSignature || !authorization.topic) return 'unauthorized';
    const receipt = this.service.receipts.get(String(message.serviceAdmission ?? ''));
    // The receipt is consumed for this exact (challenge, session, room, device)
    // tuple, on a later attach exactly as on the first authenticate — and it is
    // demanded only when this service advertised that it would be
    // (`requiresServiceAdmission` on the welcome, `lib.rs:883`/`:1081`). A
    // service without a connected Google account asks for nothing and refuses
    // nothing that omits a receipt; a service with one refuses exactly as the
    // deployed relay does.
    if (this.service.requiresServiceAdmission) {
      // Deleted on presentation, before the binding is checked, exactly as
      // `identity_enrollment.rs` `consume` does (`admissions.remove(ticket)`):
      // a receipt admits one frame, so a client that re-presents a spent one is
      // refused rather than silently admitted twice.
      this.service.receipts.delete(String(message.serviceAdmission ?? ''));
      if (!receipt || receipt.expiresAt <= Date.now() || receipt.session !== this.session || receipt.challenge !== this.challenge
        || receipt.room !== room || receipt.deviceKeyId !== deviceKeyId) {
        return 'service_auth_required';
      }
    }
    const manifestPayload = parseStrictJson(new TextDecoder().decode(fromBase64Url(authorization.manifestPayload)), 1_048_576) as Frame | null;
    const authority = authorization.authority as { kty: 'EC'; crv: 'P-256'; x: string; y: string } | undefined;
    if (!manifestPayload || !authority) return 'unauthorized';
    const signed: SignedManifest = { payload: manifestPayload as SignedManifest['payload'], signature: authorization.manifestSignature };
    let manifest;
    try {
      const authorityKeyId = await publicKeyFingerprint(authority);
      manifest = await verifyManifest(signed, authority, authorityKeyId);
    } catch { return 'unauthorized'; }
    const device = manifest.devices.find(row => row.deviceKeyId === deviceKeyId);
    if (!device || manifest.expiresAt <= Date.now()) return 'unauthorized';
    // `admission.rs:181-197`: a board manifest names `pboard-collab-<board>-cards`,
    // and an *account* manifest (boardId `account:<hash>`, both Drive bindings
    // empty) names `pboard-account-<hash>-order`. That is how the account room
    // is admissible here — by admitting it the way the service admits it, with
    // the same topic/binding coupling refused on both sides, never by relaxing
    // a check.
    const account = manifest.boardId.startsWith('account:') ? manifest.boardId.slice('account:'.length) : null;
    const admissible = account !== null
      ? validRoomId(account) && manifest.driveProjectFileId === '' && manifest.driveFolderId === '' && authorization.topic === `pboard-account-${account}-order`
      : manifest.boardId === authorization.topic.match(/^pboard-collab-(.+)-cards$/)?.[1];
    if (!admissible) return 'unauthorized';
    // The room is recomputed from the verified manifest exactly as the client
    // derives it (`pboard-ws-room-v2` over topic + Drive binding): two devices
    // land in one room if and only if they verified the same authority.
    const roomHash = await sha256url(utf8(JSON.stringify(['pboard-ws-room-v2', authorization.topic, manifest.driveProjectFileId, manifest.driveFolderId])));
    const authorityId = await publicKeyFingerprint(authority);
    if (room !== `pboard-v2-${authorityId}-${roomHash}`) return 'unauthorized';
    // An armed per-room refusal (`refuseAttach`) answers exactly as the service
    // answers it: the code, for that room, with no effect on the socket.
    const armed = this.service.attachRefusals.get(room) ?? this.service.attachRefusalsByBoard.get(manifest.boardId);
    if (armed) return armed;
    const digest = await sha256url(canonicalBytes(manifest as unknown as Json));
    const signature = String(message.signature ?? '');
    if (!await verifyBytes(device.publicKey, signature, utf8(JSON.stringify(['pboard-ws-auth-v2', this.challenge, this.session, room, deviceKeyId, digest])))) return 'unauthorized';
    // `kind` is recorded so a scenario can say which question it is asking:
    // `authenticate` is "a socket dialled and was admitted", `attach` is "a room
    // joined a socket that was already up". Both are admissions of a room and
    // both carry the account — from the receipt when one was presented (the
    // account the identity service verified), and otherwise from the frame's own
    // authorisation, because a receipt-less service has no verified account to
    // attribute to and inventing one would be a lie a scenario could assert on.
    // Only a *socket* count must filter on the kind.
    this.service.admitted.push({ room, deviceKeyId, email: receipt?.email ?? '', kind });
    this.service.roles.set(`${deviceKeyId}|${manifest.boardId}`, device.role);
    return { room: this.service.roomFor(room, manifest.boardId), deviceKeyId };
  }

  private async syncRequest(request: Frame) {
    // The attach map is what a v3 socket serves; `room` is only the primary. A
    // gate on `room` alone silently dropped every request of a connection whose
    // primary had been detached mid-life.
    if (!this.rooms.size || !request || typeof request.action !== 'string') return;
    // `board` selects *which attachment* the frame applies to. On a v2 socket
    // that set is the single admitted room; on v3 it is the attach map, and a
    // frame naming a room this connection never attached is refused with the
    // same code and the same meaning as before — never re-scoped.
    const named = typeof request.board === 'string' ? request.board : this.room?.room;
    const room = named === undefined ? undefined : this.rooms.get(named);
    if (!room) {
      this.push({ type: 'sync', action: 'error', board: named, code: 'board_mismatch' });
      return;
    }
    const reply = (action: string, fields: Record<string, unknown> = {}) => this.push({ type: 'sync', action, board: room.room, ...fields });
    const refuse = (code: string) => this.push({ type: 'sync', action: 'error', board: room.room, code });
    switch (request.action) {
      case 'publishAccountHint': {
        if (room.board.startsWith('account:') || this.roleFor(room) === 'viewer') return refuse('unauthorized');
        const to = String(request.to ?? '');
        const entries = this.service.accountHints.get(to) ?? [];
        const hint = { type: 'accountHint', inbox: to, board: room.board, seq: entries.length + 1, hintId: request.hintId, payload: request.payload };
        entries.push(hint); this.service.accountHints.set(to, entries);
        reply('accountHintStored', { to, seq: hint.seq, duplicate: false });
        for (const socket of this.service.sockets) if ([...socket.rooms.values()].some(held => held.board === `account:${to}`)) socket.push(hint);
        return;
      }
      case 'replayAccountHints': {
        if (!room.board.startsWith('account:')) return refuse('unauthorized');
        const inbox = room.board.slice('account:'.length);
        const hints = (this.service.accountHints.get(inbox) ?? []).filter(hint => Number(hint.seq) > Number(request.afterSeq ?? 0));
        reply('accountHints', { inbox, hints, highest: hints.length }); return;
      }
      case 'subscribe': {
        // An armed insufficient-history fault (`insufficientHistory`) is the
        // service's own gap answer (`sync_api.rs:257-283`): a `window` with
        // `synced:false` and `gap.oldestRetainedSeq` for `history_unavailable`,
        // a `snapshotRequired` frame with the checkpoint triple for
        // `snapshot_required`. One armed fault answers one subscribe.
        const fault = (this.service.replayFaults.get(room.room) ?? []).shift();
        if (fault) {
          const gap = fault.reason === 'snapshot_required'
            ? { reason: fault.reason, checkpointSeq: fault.checkpointSeq ?? room.checkpointSeq, checkpointEpoch: fault.checkpointEpoch ?? room.epoch, snapshotSeq: fault.snapshotSeq ?? room.snapshotSeq }
            : { reason: fault.reason, oldestRetainedSeq: fault.oldestRetainedSeq ?? room.rows[0]?.seq ?? room.nextSeq };
          reply(fault.reason === 'snapshot_required' ? 'snapshotRequired' : 'window',
            { operations: [], liveFromSeq: room.nextSeq, checkpointSeq: room.checkpointSeq, synced: false, gap });
          return;
        }
        const after = typeof request.afterSeq === 'number' ? request.afterSeq : 0;
        reply('window', { operations: room.rows.filter(row => row.seq > after), liveFromSeq: room.nextSeq,
          checkpointSeq: room.checkpointSeq, synced: true });
        return;
      }
      case 'submit': {
        const operations = Array.isArray(request.operations) ? (request.operations as Frame[]) : [];
        const results = operations.map(input => {
          const opId = String(input.opId ?? '');
          const existing = room.rows.find(row => row.opId === opId);
          if (existing) return { opId, seq: existing.seq, duplicate: true };
          // Author attribution comes from this connection's authenticated
          // device id — the payload never names its own author to the log.
          // Attributed to the device that was admitted for *this room*, exactly
          // as the service attributes it (`Attached.device`): a multiplexed
          // socket carrying two boards must not launder one board's writes
          // through the other's identity.
          const author = this.deviceForRoom.get(room.room) ?? this.deviceKeyId;
          const row: LogRow = { opId, seq: room.nextSeq++, actorId: author, protocolVersion: Number(input.protocolVersion ?? 1),
            logicalClock: Number(input.logicalClock ?? 0), enqueuedAt: 1, payload: String(input.payload ?? '') };
          room.rows.push(row);
          room.submissions.push({ deviceKeyId: author, opId, seq: row.seq, duplicate: false });
          return { opId, seq: row.seq, duplicate: false };
        });
        reply('accepted', { results, ackedSeq: results.at(-1)?.seq });
        for (const result of results) {
          const row = room.rows.find(entry => entry.opId === result.opId);
          if (row && !result.duplicate) for (const tab of this.service.sockets) {
            if (!tab.rooms.has(room.room) && tab.room !== room) continue;
            tab.push({ type: 'sync', action: 'operation', board: room.room, ...row });
          }
        }
        return;
      }
      case 'lease': {
        const now = Date.now();
        if (room.lease && room.lease.expiresAt > now && room.lease.holder !== this.deviceOf(room)) return refuse('lease_busy');
        room.epoch += 1;
        room.lease = { holder: this.deviceOf(room), epoch: room.epoch, expiresAt: now + (typeof request.leaseMs === 'number' ? request.leaseMs : 60_000) };
        reply('lease', { holder: room.lease.holder, epoch: room.epoch, expiresAt: room.lease.expiresAt });
        return;
      }
      case 'release':
        if (room.lease?.holder === this.deviceOf(room)) room.lease = null;
        reply('released');
        return;
      case 'commit': {
        if (!room.lease || room.lease.holder !== this.deviceOf(room) || room.lease.epoch !== request.epoch) return refuse('lease_busy');
        room.checkpointSeq = Number(request.seq ?? room.checkpointSeq);
        room.snapshotSeq = Number(request.snapshotSeq ?? room.snapshotSeq);
        room.lease = null;
        reply('committed', { checkpointSeq: room.checkpointSeq, epoch: room.epoch, snapshotSeq: room.snapshotSeq, stale: false });
        return;
      }
      case 'status':
        reply('status', { checkpointSeq: room.checkpointSeq, nextSeq: room.nextSeq - 1, snapshotSeq: room.snapshotSeq, epoch: room.epoch, operations: room.rows.length });
        return;
      case 'publishDeviceKey': {
        const publicKey = String(request.publicKey ?? '');
        let decoded: Uint8Array;
        try { decoded = fromBase64Url(publicKey); } catch { return refuse('invalid_request'); }
        if (!decoded.length) return refuse('invalid_request');
        if (decoded.length > MAX_PUBLIC_KEY_BYTES) return refuse('public_key_too_large');
        const known = this.service.courierKeys.get(room.room) ?? new Map<string, string>();
        const stored = known.get(this.deviceOf(room)) !== publicKey;
        if (stored && known.size >= MAX_LISTED_DEVICES) return refuse('too_many_device_keys');
        known.set(this.deviceOf(room), publicKey);
        this.service.courierKeys.set(room.room, known);
        // `stored: false` answers an identical re-publish: an idempotent no-op.
        reply('deviceKeyStored', { stored });
        return;
      }
      case 'listDeviceKeys': {
        const known = this.service.courierKeys.get(room.room) ?? new Map<string, string>();
        reply('deviceKeys', { devices: [...known].map(([deviceKeyId, publicKey]) => ({ deviceKeyId, publicKey })) });
        return;
      }
      case 'publishKeyGrants': {
        const grants = Array.isArray(request.grants) ? (request.grants as Frame[]) : [];
        if (!grants.length || grants.length > MAX_GRANTS_PER_PUBLISH) return refuse('batch_too_large');
        for (const grant of grants) {
          let envelope: Uint8Array;
          try { envelope = fromBase64Url(String(grant.envelope ?? '')); } catch { return refuse('invalid_request'); }
          if (envelope.length > MAX_ENVELOPE_BYTES) return refuse('envelope_too_large');
        }
        // Replace per (sender, recipient); a refused batch stored nothing above.
        const table = this.service.courierGrants.get(room.room) ?? [];
        for (const grant of grants) {
          const existing = table.find(row => row.from === this.deviceOf(room) && row.to === String(grant.deviceKeyId));
          if (existing) existing.envelope = String(grant.envelope);
          else table.push({ from: this.deviceOf(room), to: String(grant.deviceKeyId), envelope: String(grant.envelope) });
        }
        this.service.courierGrants.set(room.room, table);
        reply('keyGrantsStored', { stored: grants.length });
        return;
      }
      case 'fetchKeyGrants': {
        // Only rows addressed to this connection's authenticated device id.
        const table = this.service.courierGrants.get(room.room) ?? [];
        reply('keyGrants', { grants: table.filter(row => row.to === this.deviceOf(room)).map(row => ({ fromDeviceKeyId: row.from, envelope: row.envelope })) });
        return;
      }
      default:
        return refuse('invalid_request');
    }
  }
}

export class FakeSignaling {
  readonly sockets: FakeSocketImpl[] = [];
  /** Durable, per `FakeSignalingStore`: the same Map object on every instance
   * sharing a store, so a restart preserves rows and their `seq`. */
  get rooms(): Map<string, FakeRoom> { return this.store.rooms; }
  /** Volatile: the board-grant cache is a process-RAM `HashMap` in the real
   * service (`GrantCache`, `board_grants.rs`) — published grants die with a restart. */
  readonly grants = new Map<string, { version: number; authority: Frame; history: { payload: string; signature: string }[] }>();
  /** Volatile: the identity directory is process RAM in the real service. */
  readonly directory = new Map<string, DirectoryEntry>();
  /** Volatile: short-lived admission tickets. */
  readonly accountHints = new Map<string, Frame[]>();
  readonly driveTickets = new Map<string, { room: string; board: string; challenge: string; session: string; email: string; role: string }>();
  readonly receipts = new Map<string, { challenge: string; session: string; room: string; deviceKeyId: string; email: string; expiresAt: number }>();
  get courierKeys(): Map<string, Map<string, string>> { return this.store.courierKeys; }
  get courierGrants(): Map<string, CourierGrant[]> { return this.store.courierGrants; }
  /** Every room admission the service answered, with the Google account behind
   * it and which frame carried it: `authenticate` opened a socket, `attach`
   * joined a room to one already up. */
  readonly admitted: { room: string; deviceKeyId: string; email: string; kind: 'authenticate' | 'attach' }[] = [];
  /** Every successful v3 `attach`, kept apart from `admitted` so the admission
   * count — which scenarios use as "did a socket open" — keeps its meaning. */
  readonly attached: { room: string; deviceKeyId: string; email: string }[] = [];
  /** Every `detached` frame the service sent, by code, so a scenario can assert
   * that a room ended without the connection ending. */
  readonly detached: { room: string; code: string }[] = [];
  readonly refusals: { code: string; room: string; deviceKeyId: string }[] = [];
  /** The protocol this service speaks. 3 (the default) negotiates attach/detach;
   * 2 is the deployed server, which a v3 client must fall back to. */
  protocolVersion: 2 | 3 = 3;
  /** Per-room attach refusals, armed by `refuseAttach`, keyed by room id. */
  readonly attachRefusals = new Map<string, string>();
  /** Per-board attach refusals for a room that has not been admitted yet. */
  readonly attachRefusalsByBoard = new Map<string, string>();
  /** Device key + board id → the role its manifest declared, so a `role` on
   * `attached` is the manifest's answer rather than a constant. */
  readonly roles = new Map<string, string>();

  /** Arm one refusal for a room's next `attach`/`authenticate`: the service's
   * own answer, which never closes the socket. */
  refuseAttach(room: string, code: string): void { this.attachRefusals.set(room, code); }

  /**
   * Arm a refusal for whichever room carries `board`. The room id is derived from
   * the board's manifest and binding, so a scenario names the board and the
   * fixture resolves the room the same way the client does.
   */
  refuseAttachRoom(board: string, code: string): void {
    const room = [...this.rooms.values()].find(entry => entry.board === board)?.room;
    if (room) { this.attachRefusals.set(room, code); return; }
    // Not admitted yet: arm every possible room of this board by board, resolved
    // lazily when the attach arrives.
    this.attachRefusalsByBoard.set(board, code);
  }
  /** The role this service admitted `deviceKeyId` as on one board. */
  roleOf(deviceKeyId: string, board: string): string | undefined { return this.roles.get(`${deviceKeyId}|${board}`); }
  /** Transport outage as the clients see it: while true, every socket created
   * against this service opens and immediately dies — no welcome, no refusal,
   * no service state touched — the way a socket dies when the process or the
   * proxy in front of it is gone. Unlike an armed refusal it does not consume
   * anything and does not stop: a scenario holds it for the whole outage and
   * clears it when the service comes back, and the clients' own backoff owns
   * the retry pacing in between. Volatile and never durable: an outage is
   * service behavior, not service data. */
  unreachable = false;
  /** Connections attempted against a down service — the scenario's proof that
   * the client kept retrying on its own, without anyone calling `start()`. */
  unreachableAttempts = 0;
  /** Queued insufficient-history answers per room (`insufficientHistory`);
   * each `subscribe` consumes the room's next entry. Volatile: an armed fault
   * is service behavior, not service data, so a restart clears it. */
  readonly replayFaults = new Map<string, GapFault[]>();
  /** Every identity-exchange call the service saw: which operation and what status it answered. */
  readonly exchangeLog: { operation: string | null; publication: boolean; status: number }[] = [];
  private readonly issuedChallenges = new Map<string, 'grants' | 'identity'>();
  private readonly accounts: Map<string, string>;
  private readonly store: FakeSignalingStore;
  /**
   * Whether a room admission must present a Google service-admission receipt.
   *
   * The real service asks for one only when it both has Google enrollment
   * configured **and** holds the board-grant directory it verifies the account
   * against (`lib.rs:1081`/`:1205`: `app.google_enrollment.is_some() &&
   * app.board_grants`), and it advertises exactly that on the welcome
   * (`lib.rs:883`). Here the pair is "at least one Google account is connected
   * to this cloud", so a scenario with no Google account at all gets a relay
   * that does not demand a credential none of its clients could mint — while
   * every scenario that does have an account keeps the full receipt contract.
   *
   * It is derived, never toggled mid-scenario: a welcome describes the service
   * an attach is admitted against, and the two must agree at the moment the
   * frame is checked.
   */
  get requiresServiceAdmission(): boolean { return this.accounts.size > 0; }
  /** The class the runtime instantiates (`new WebSocket(url)`): the service
   * is bound per instance, mimicking one service per origin — except that the
   * instance a socket lands on is whichever instance most recently came up
   * over this instance's store, which is what makes a restarted process
   * reachable by browsers that captured the class before the restart. */
  readonly WebSocket: { new (url: string | URL, protocols?: string | string[]): FakeSocketImpl };

  constructor(accounts: Map<string, string>, store: FakeSignalingStore = createSignalingStore()) {
    this.accounts = accounts;
    this.store = store;
    liveServices.set(store, this);
    this.WebSocket = class BoundFakeSocket extends FakeSocketImpl {
      constructor(url: string | URL, _protocols?: string | string[]) { super(url, liveService(store)); }
    };
  }

  /** Bring the service down and back up over the same durable data (T11).
   * Every live socket is killed — abnormal close 1006, no `server_shutdown`,
   * no clean close-by-agreement — and the returned instance comes up with the
   * volatile halves empty (grant cache, directory, receipts, armed replay
   * faults) while the operation log, checkpoints, and courier rows persist in
   * the shared `FakeSignalingStore`. Sockets created afterwards — including by
   * a browser that captured `WebSocket` before the restart — reach the new
   * instance; HTTP reaches it only once the caller repoints its cloud
   * (`createCloud`'s `restartSignaling`). */
  restart(): FakeSignaling {
    for (const socket of [...this.sockets]) socket.kill();
    return new FakeSignaling(this.accounts, this.store);
  }

  /** Arm one insufficient-history answer for this room's next `subscribe`
   * (the `writeFaults` pattern applied to the replay window). Defaults: the
   * fault reason is `history_unavailable`, and its fields fall back to the
   * room's real retained state when it fires. */
  insufficientHistory(room: string, fault: { reason?: GapFaultReason; oldestRetainedSeq?: number; checkpointSeq?: number; checkpointEpoch?: number; snapshotSeq?: number } = {}): void {
    const queue = this.replayFaults.get(room) ?? [];
    queue.push({
      reason: fault.reason ?? 'history_unavailable',
      oldestRetainedSeq: fault.oldestRetainedSeq,
      checkpointSeq: fault.checkpointSeq,
      checkpointEpoch: fault.checkpointEpoch,
      snapshotSeq: fault.snapshotSeq,
    });
    this.replayFaults.set(room, queue);
  }

  /** The service's per-connection view (`identity(room, deviceKeyId)`,
   * `lib.rs:623`): each socket this instance currently holds and the room it
   * was admitted to. A browser keeping its board rooms and its account room
   * open at once appears once per handle. */
  roomsHeld(deviceKeyId?: string): { room: string; deviceKeyId: string }[] {
    const held: { room: string; deviceKeyId: string }[] = [];
    for (const socket of this.sockets) {
      if (socket.deviceKeyId && deviceKeyId !== undefined && socket.deviceKeyId !== deviceKeyId) continue;
      // Every room the socket holds, so a multiplexed connection appears once per
      // attached room — the count the client's gauge is cross-checked against.
      if (socket.rooms.size) for (const room of socket.rooms.keys()) held.push({ room, deviceKeyId: socket.deviceKeyId });
      else if (socket.room) held.push({ room: socket.room.room, deviceKeyId: socket.deviceKeyId });
    }
    return held;
  }

  /** The live sockets, each with every room it currently holds. A multiplexed
   * context is one socket here however many boards it carries. */
  socketCount(): number { return this.sockets.length; }

  /** Every live socket that currently holds a room of this board — the v2
   * `socket.room?.board === board` filter, widened to a socket that carries
   * several rooms. */
  socketsForBoard(board: string): FakeSocketImpl[] {
    return this.sockets.filter(socket => [...socket.rooms.values()].some(room => room.board === board) || socket.room?.board === board);
  }

  /** Every live socket that holds any board room at all (the account room and
   * the courier's own connections excluded), which is "how many sockets this
   * browser uses for boards". */
  boardSockets(): FakeSocketImpl[] {
    return this.sockets.filter(socket => [...socket.rooms.values()].some(room => !room.board.startsWith('account:')));
  }

  /**
   * The server ends *one room's* attachment on the socket that holds it — the
   * v3 `detached` frame with a code, which is how a revocation, an expiry or a
   * byte budget reaches a client without touching the connection or its
   * siblings.
   */
  detachRoom(room: string, code: string): boolean {
    for (const socket of this.sockets) {
      if (!socket.rooms.has(room)) continue;
      socket.rooms.delete(room);
      socket.deviceForRoom.delete(room);
      const replaced = socket.room?.room === room ? [...socket.rooms.values()][0] : socket.room;
      socket.room = replaced;
      this.detached.push({ room, code });
      socket.push({ type: 'detached', room, code });
      return true;
    }
    return false;
  }

  roomFor(room: string, board: string): FakeRoom {
    let entry = this.rooms.get(room);
    if (!entry) {
      entry = { room, board, rows: [], nextSeq: 1, checkpointSeq: 0, snapshotSeq: 0, epoch: 0, lease: null, submissions: [] };
      this.rooms.set(room, entry);
    }
    return entry;
  }

  /** Number of distinct board authorities the grant service holds (a second
   * authority for one board would add a second entry here). */
  authorityCount(board: string): number {
    return [...this.directory.values()].filter(entry => (entry.publication as { policy?: { boardId?: string } }).policy?.boardId === board).length;
  }

  async handleHttp(input: string | URL, init: RequestInit = {}): Promise<Response | null> {
    const url = new URL(String(input));
    if (url.origin !== RELAY_ORIGIN) return null;
    const body = init.body ? (parseStrictJson(String(init.body), 4_194_304) as Frame | null) : null;
    if (url.pathname === '/grants/challenge') {
      const challenge = random43();
      this.issuedChallenges.set(challenge, 'grants');
      return json({ version: 2, challenge });
    }
    if (url.pathname === '/grants/publish' && body) return this.publishGrant(body);
    const scope = /^\/grants\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1];
    if (scope) {
      const stored = this.grants.get(scope);
      if (!stored) return json({ error: { message: 'no grant for this authority scope' } }, 404);
      return json(stored);
    }
    if (url.pathname === '/identity/challenge') {
      const challenge = random43();
      this.issuedChallenges.set(challenge, 'identity');
      return json({ version: 1, challenge });
    }
    if (url.pathname === '/identity/exchange' && body) {
      const response = await this.exchange(url, body, init);
      const operation = body.operation as Frame | undefined;
        this.exchangeLog.push({ operation: typeof operation?.type === 'string' ? operation.type : null, publication: Boolean(operation?.publication), status: response.status });
      return response;
    }
    return json({ error: { message: `fake signaling: unhandled ${url.pathname}` } }, 404);
  }

  /** The board-grant publication contract (version 2, replay-resistant): the
   * authority signs over the fresh challenge and the manifest digest, the
   * publishing device signs its admission, and only the original authority
   * whose manifest lists the device may publish. */
  private async publishGrant(body: Frame): Promise<Response> {
    const refused = (status: number, code: string) => json({ error: { status, message: code } }, status === 403 ? 403 : 400);
    if (body.version !== 2 || !this.issuedChallenges.get(String(body.challenge ?? ''))) return refused(400, 'invalid_request');
    const bundle = body.bundle as { version?: number; authority?: Frame; history?: { payload: string; signature: string }[] } | undefined;
    const history = bundle?.history;
    const head = history?.at(-1);
    if (!bundle || bundle.version !== 1 || !bundle.authority || !head || !history) return refused(400, 'invalid_request');
    const authority = bundle.authority as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    const authorityKeyId = await publicKeyFingerprint(authority);
    let manifest;
    try {
      manifest = await verifyManifest({ payload: parseStrictJson(new TextDecoder().decode(fromBase64Url(head.payload)), 1_048_576) as SignedManifest['payload'], signature: head.signature }, authority, authorityKeyId);
    } catch { return refused(400, 'invalid_request'); }
    const deviceKeyId = String(body.deviceKeyId ?? '');
    const device = manifest.devices.find(row => row.deviceKeyId === deviceKeyId);
    if (!device || manifest.devices.find(row => row.role === 'owner')?.deviceKeyId !== deviceKeyId) return refused(403, 'not_authority');
    // Grant publication derives the room from the manifest exactly like socket
    // admission does (`admission.rs:181-197`): a board manifest names
    // `pboard-collab-<board>-cards`; an account manifest (boardId
    // `account:<hash>`, empty Drive bindings) names `pboard-account-<hash>-order`,
    // and a mismatched binding is refused rather than stored unreachable.
    const account = manifest.boardId.startsWith('account:') ? manifest.boardId.slice('account:'.length) : null;
    if (account !== null && (!validRoomId(account) || manifest.driveProjectFileId !== '' || manifest.driveFolderId !== '')) return refused(400, 'invalid_request');
    const topic = account !== null ? `pboard-account-${account}-order` : `pboard-collab-${manifest.boardId}-cards`;
    const digest = await sha256url(canonicalBytes(manifest as unknown as Json));
    if (!await verifyBytes(authority, String(body.authoritySignature ?? ''), utf8(JSON.stringify(['pboard-grant-publish-v2', String(body.challenge), authorityKeyId, manifest.boardId, digest])))) return refused(403, 'bad_authority_signature');
    const roomHash = await sha256url(utf8(JSON.stringify(['pboard-ws-room-v2', topic, manifest.driveProjectFileId, manifest.driveFolderId])));
    const room = `pboard-v2-${authorityKeyId}-${roomHash}`;
    if (!await verifyBytes(device.publicKey, String(body.signature ?? ''), utf8(JSON.stringify(['pboard-ws-auth-v2', 'publish', 'publish', room, deviceKeyId, digest])))) return refused(403, 'bad_device_signature');
    const scope = await sha256url(utf8(JSON.stringify(['pboard-board-grants-v1', authorityKeyId, manifest.boardId])));
    this.grants.set(scope, { version: 1, authority: bundle.authority, history: history.map(entry => ({ payload: entry.payload, signature: entry.signature })) });
    return new Response(null, { status: 204 });
  }

  /** The identity exchange: the Google bearer names the account, the body
   * signature proves the device key, and every directory write is attributed
   * to the authenticated account — never to a body field. */
  private async exchange(url: URL, body: Frame, init: RequestInit): Promise<Response> {
    const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    const email = this.accounts.get(token);
    if (!email || body.version !== 1 || !this.issuedChallenges.get(String(body.challenge ?? ''))) return json({ error: { status: 401 } }, 401);
    const publicKey = body.publicKey as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    const operation = body.operation as Frame;
    const deviceKeyId = await publicKeyFingerprint(publicKey);
    if (!await verifyBytes(publicKey, String(body.signature ?? ''), canonicalBytes(asJson(['pboard-identity-v1', String(body.challenge), deviceKeyId, operation])))) {
      return json({ error: { status: 403, code: 'bad_signature', message: 'device signature does not verify' } }, 403);
    }
    if (operation.type === 'admit') {
      const admission = random43();
      this.receipts.set(admission, { challenge: String(operation.challenge), session: String(operation.session),
        room: String(operation.room), deviceKeyId, email, expiresAt: Date.now() + 300_000 });
      return json({ version: 1, admission, expiresAt: Date.now() + 300_000 });
    }
    if (operation.type === 'sync') {
      const publication = operation.publication as Frame | null | undefined;
      if (publication) {
        const policy = publication.policy as { boardId: string; ownerEmail: string };
        if (policy.ownerEmail !== email) return json({ error: { status: 403, code: 'not_owner', message: 'only the board owner advertises a policy' } }, 403);
        const entry = this.directory.get(policy.boardId) ?? { publication, pending: [] };
        entry.publication = publication;
        this.directory.set(policy.boardId, entry);
      }
      return json({ version: 1, email, boards: this.boardsFor(email) });
    }
    if (operation.type === 'request') {
      const request = operation.request as { boardId: string; deviceKeyId: string };
      const entry = this.directory.get(request.boardId);
      if (!entry) return json({ error: { status: 404 } }, 404);
      const policy = entry.publication.policy as { ownerEmail: string; members: { email: string; role: string }[] };
      const role = email === policy.ownerEmail ? 'owner' : policy.members.find(member => member.email === email)?.role;
      if (!role) return json({ error: { status: 403, code: 'not_member', message: 'device belongs to an account the policy does not list' } }, 403);
      entry.pending = entry.pending.filter(row => row.request.deviceKeyId !== request.deviceKeyId);
      entry.pending.push({ email, request });
      // The real service answers a filed request with the same directory
      // listing as a sync (services/pboard-signaling identity_enrollment.rs
      // falls through to the shared tail); the client parses every exchange
      // reply as one, so answering `{ok:true}` here would mis-model the
      // service and make device admission impossible to exercise.
      return json({ version: 1, email, boards: this.boardsFor(email) });
    }
    return json({ error: { status: 400 } }, 400);
  }

  /** A device request is visible only to the account whose policy lists the
   * requester; that is what makes the owner's automatic approval role-aware. */
  private boardsFor(email: string): { publication: Frame; pending: { email: string; request: Frame }[] }[] {
    return [...this.directory.values()].filter(entry => {
      const policy = entry.publication as { policy?: { ownerEmail?: string; members?: { email: string }[] } };
      return policy.policy?.ownerEmail === email || policy.policy?.members?.some(member => member.email === email) === true;
    }).map(entry => ({ publication: entry.publication, pending: entry.pending }));
  }
}
