/**
 * Key courier transport (Sync v3): carries wrapped board content keys over
 * the already-authenticated relay WebSocket.
 *
 * The four actions ride the existing `sync` envelope with the log's own
 * ordering rule — one reply per request, in arrival order, no request ids —
 * and the same authenticated identity: the caller's `deviceKeyId` comes from
 * the `authenticate` handshake, never from a body, so a connection can only
 * ever touch the keys of the room it was admitted to. Like the log, this
 * connection is opaque to the relay: it stores and forwards base64url blobs
 * it cannot open.
 *
 * Why not the log's own connection: the log builds its seal/open codec from
 * the content key *before* it connects, so the key cannot arrive over that
 * connection — the socket that needs the key cannot carry it. This is
 * therefore one short-lived, self-closing exchange, not a second standing
 * WebSocket: connect, authenticate, publish our wrap key, fetch grants
 * addressed to us, (writer) generate the board key once and wrap it for every
 * peer whose wrap key is known, close.
 *
 * Could those four actions ride the shared session instead? On the server they
 * can: `sync_api.rs::handle` resolves the acting device and role from
 * `identity.access(board)` — the attachment map — and the courier arms are
 * ordinary `Request` variants inside the same `sync` envelope, exactly like
 * `subscribe`/`submit`. On the client `RelaySession.request(room, action, body)`
 * would carry them. Three things nevertheless keep the exchange on its own
 * socket:
 *
 *  1. **The board attach needs the key before the room is attached.** The
 *     codec (`createOperationLogCodec(logKey)`) is built before
 *     `createOperationLogSync`, and `openSharedRoom` bootstraps the room through
 *     that codec; `request()` also refuses a room the connection has not
 *     attached. Serving the key over the shared socket would therefore mean
 *     attaching the room, running the courier, then building the codec and
 *     re-bootstrapping — inverting the ordering every recovery path depends on.
 *  2. **A v2 relay has no shared session at all** (`logSync.ts` falls back to one
 *     socket per room), so the courier would keep a private path regardless, and
 *     two transports for one exchange is how they drift apart.
 *  3. **Reply correlation is a single FIFO** (`replies` is matched by head, with
 *     no request ids). A courier refusal or timeout interleaved into the same
 *     queue is indistinguishable from a bad acknowledgment of a log request, and
 *     misattributed acknowledgments are how a log believes its writes are durable.
 *
 * The churn those passes caused is removed where it belongs instead — by running
 * far fewer of them (`keyCourierQueue.ts`: one pass per room at a time, one
 * queued behind it, a quiet window for repeats, and a rate bound on the
 * foreign-row trigger) — with the exchange, the protocol and its failure
 * vocabulary untouched.
 *
 * Failure policy: the exchange never rejects the caller. Absent grants are
 * normal on first run — a peer that has not published its wrap key yet must
 * not block a writer's attach — and a refusal arrives with a server code that
 * the board should show, not throw. Nothing here may put key material,
 * plaintext or an envelope into a returned string or a diagnostic: the codes
 * below are the entire outward vocabulary of failure.
 */
import { parseStrictJson } from '../../collab/security/canonical';
import { ensureWrapKey, importSigningKey, importWrapKey, signBytes, type StoredDeviceKey } from '../../collab/security/keys';
import { validateWebSocketEndpoint } from '../../collab/security/endpoint';
import { prepareRelayAdmission, type RelayAuthorization } from '../../collab/security/relayAdmission';
import { collaborationDiagnostic } from '../../collab/diagnostics';
import { collaborationCounters } from '../../collab/counters';
import { trackTransportSocket, type TransportTrigger } from '../transportDiagnostics';
import { automaticAuthBudget, type AuthBudget } from '../../collab/authBudget';
import type { ServiceAdmissionRequest } from '../../collab/experimentalWebSocketSignaling';
import { exportBoardContentKey, type BoardContentKey } from '../bufferCrypto';
import { exportCourierPublicKey, importCourierPeerKey, openKeyEnvelope, sealKeyEnvelope } from './keyCourier';

/** The server's whole refusal vocabulary; anything else is reported generically. */
const REFUSAL_CODES: Record<string, true> = {
  invalid_request: true, public_key_too_large: true, envelope_too_large: true,
  batch_too_large: true, too_many_device_keys: true, board_mismatch: true
};
const isRefusal = (code: string) => Object.hasOwn(REFUSAL_CODES, code);
/** The id charset the service (and every other id on this wire) accepts. */
const DEVICE_ID = /^[A-Za-z0-9:_.-]{1,256}$/;
/** Wire caps, mirrored so a client never learns about them from a refusal: ≤32 grants per publish, ≤64 device keys per board. */
const MAX_GRANTS_PER_PUBLISH = 32;
const MAX_LISTED_DEVICES = 64;

type Frame = Record<string, unknown>;
const aString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const aNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const frames = (value: unknown): Frame[] => Array.isArray(value)
  ? value.filter((row): row is Frame => !!row && typeof row === 'object' && !Array.isArray(row)) : [];

export type KeyCourierOptions = {
  /** Relay room this connection is admitted to; its id is both the wire `board` and the envelope salt. */
  topic: string;
  url: string;
  getKey: () => Promise<StoredDeviceKey>;
  getAuthorization: () => Promise<RelayAuthorization>;
  getServiceAdmission?: (request: ServiceAdmissionRequest) => Promise<string>;
  /** True only for `owner`/`editor`: the only devices that hand grants to peers, and — together with `isAuthority` — the ones that may ever hold a created board key. Receiving is admission-gated, not role-gated — readers may fetch grants too. */
  isWriter: boolean;
  /**
   * True only for the device that holds this board's authority, as decided by
   * the single decision point (`boardCollaboration.adoptAuthority`/
   * `ownsAuthority`). Key creation follows authority: with every writer free
   * to generate, an admitted editor that fetches nothing because the owner
   * wrapped its key before this device was known would mint a *second* board
   * key, and a board with two content keys has silently split. A writer
   * without the authority therefore waits for a grant instead; a reader is
   * already limited to fetching.
   */
  isAuthority: boolean;
  /** The key this device already holds, if any; a held key always wins over a grant (an established key is never silently replaced). */
  heldKey: () => Promise<BoardContentKey | undefined>;
  /** Creates the board key — writer only, and only when nobody has handed one over. */
  ensureKey: () => Promise<BoardContentKey>;
  /** Persists an unwrapped grant and returns the usable key. */
  storeKey: (material: string) => Promise<BoardContentKey>;
  webSocket?: typeof WebSocket;
  /** Shared per-context automatic-auth budget; every courier dial is one
   * `GET /ws` in the proxy's stick table too. Production omits it. */
  authBudget?: AuthBudget;
  /** Grant-fetch attempts for a device that must wait for a writer; each passes with backoff rather than failing the board. */
  attempts?: number;
  /** Peers this caller already sealed an envelope for. When every listed peer is
   * in here, the pass publishes nothing — which is what makes an automatic
   * authority pass cost zero writes when no device has joined since the last
   * one. Omitted means "seal for everyone". */
  sealedPeers?: readonly string[];
  retryBaseMs?: number;
  connectTimeoutMs?: number;
  /** Which call site dialled, for the connection diagnostics: a courier pass is
   * short-lived and several distinct things run one, so the console must be
   * able to tell "the debounced foreign-row pass" from "the attach pass".
   * Diagnostic only; it changes nothing about the exchange. */
  trigger?: TransportTrigger;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type KeyCourierOutcome = {
  key?: BoardContentKey;
  source: 'none' | 'granted' | 'generated' | 'local';
  peers: number;
  published: number;
  /** The peer wrap keys this pass actually saw, by device key id. The caller
   * uses it as its "has anything changed?" signal: a pass that sees the same set
   * again has nothing new to seal for, which is what makes an automatic
   * authority pass free when no device joined. Empty when the pass never got a
   * listing (no connection, refusal). */
  peerIds: string[];
  error: string | null;
};

type Pending = { resolve: (reply: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

type CourierConnection = {
  room: string;
  /** The authenticated identity peers address rows by — the signing key id, never the wrap fingerprint. */
  deviceKeyId: string;
  ask: (action: string, body?: Record<string, unknown>) => Promise<Frame>;
  close: () => Promise<void>;
};

/** Connects, authenticates exactly like the operation log (version 2, service admission when required), and resolves once the relay has accepted this identity. */
async function openCourier(options: KeyCourierOptions): Promise<CourierConnection> {
  if (options.url.includes('://') && (new URL(options.url).username || new URL(options.url).password)
    || (!options.webSocket && validateWebSocketEndpoint(options.url).check !== 'ok')) {
    throw new Error('Invalid key courier endpoint');
  }
  const Socket = options.webSocket ?? WebSocket;
  const budget = options.authBudget ?? automaticAuthBudget;
  const key = await options.getKey();
  const admission = await prepareRelayAdmission(options.topic, await options.getAuthorization(), key.keyId);
  const room = admission.room;
  // The courier is a second, short-lived socket per board — one more `GET /ws`
  // per exchange. Which exchanges happen, and how many, is decided by
  // `keyCourierQueue.ts`: one pass per room at a time, one queued behind it, and
  // a quiet window that answers a repeat maintenance request without a socket.
  // This function still waits for the same per-context slot and token as the
  // log's dial, immediately before the socket is built, so a page load with N
  // boards cannot turn its key exchanges into an unmetered burst beside the
  // standing connections.
  await budget.acquireRelayDial();

  // The relay accepts our identity from inside socket callbacks, so the
  // resolvers are held outside the promise — the same shape the log uses.
  let resolveConnected: () => void = () => {}, rejectConnected: (cause: Error) => void = () => {};
  const connected = new Promise<void>((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
  const pending: Pending[] = [];
  let socket: WebSocket | undefined, session = '', inbound = Promise.resolve(), seen = 0;
  const abandon = (cause: Error) => { for (const entry of pending.splice(0)) { clearTimeout(entry.timer); entry.reject(cause); } };
  const send = (message: unknown) => {
    if (!socket || socket.readyState !== Socket.OPEN) throw new Error('Key courier connection closed');
    socket.send(JSON.stringify(message));
  };
  const ws = new Socket(options.url);
  socket = ws as unknown as WebSocket;
  const dial = trackTransportSocket(socket, options.trigger ?? 'courier:pass', options.topic, key.keyId);
  // Counted where the socket is built. The courier exchange is short-lived, so
  // its socket is expected to appear and disappear inside one pass — the gauge
  // is what makes "and no more than one at a time" a measurement.
  collaborationCounters.noteSocketOpen(options.topic);
  let dialLed = true;
  const releaseDial = () => {
    if (!dialLed) return;
    dialLed = false;
    collaborationCounters.noteSocketClose(options.topic);
  };
  // A refused upgrade reaches the browser as a socket failure with no `429`;
  // counting it keeps the budget honest about what its dials bought.
  let authenticated = false;
  const deadline = setTimeout(() => {
    // The upgrade never answered: the client calls `close()`, but the cause is
    // the network, and a pass that waits out its deadline must not read as a
    // deliberate hang-up in the ledger.
    dial?.closed(undefined, { by: 'network' });
    try { ws.close(); } catch { /* already gone */ }
  }, options.connectTimeoutMs ?? 10_000);

  ws.onmessage = (event) => {
    if (++seen > 256) { abandon(new Error('Key courier inbound limit exceeded')); ws.close(); return; }
    inbound = inbound.then(async () => {
      const message = parseStrictJson(String(event.data), 256 * 1024) as Frame | null;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'welcome') {
        const challenge = aString(message.challenge);
        if (typeof challenge !== 'string' || typeof message.session !== 'string' || session || !Array.isArray(message.supportedVersions) || !message.supportedVersions.includes(2)) {
          throw new Error('Invalid key courier welcome');
        }
        session = message.session;
        let serviceAdmission: string | undefined;
        if (message.requiresServiceAdmission === true) {
          if (!options.getServiceAdmission) throw new Error('Verified Google service admission is required');
          serviceAdmission = await options.getServiceAdmission({ challenge, session, room: admission.room, key });
          if (!/^[A-Za-z0-9_-]{43}$/.test(serviceAdmission)) throw new Error('Invalid service admission response');
        }
        const signature = await signBytes(await importSigningKey(key.privateJwk), new TextEncoder().encode(JSON.stringify(
          ['pboard-ws-auth-v2', challenge, session, admission.room, key.keyId, admission.digest])));
        send({ type: 'authenticate', version: 2, room: admission.room, deviceKeyId: key.keyId, signature,
          authorization: admission.authorization, ...(serviceAdmission ? { serviceAdmission } : {}) });
      } else if (message.type === 'authenticated') {
        clearTimeout(deadline);
        if (message.peerId !== key.keyId || message.session !== session) throw new Error('Key courier identity mismatch');
        authenticated = true;
        resolveConnected();
      } else if (message.type === 'sync') {
        if (message.board !== room) throw new Error('Key courier frame names another board');
        // The room publishes operations to every subscriber; a reply has no id,
        // so anything that is not ours must never consume the queue head.
        if (message.action === 'operation') return;
        const entry = pending.shift();
        if (!entry) throw new Error('Unexpected key courier reply');
        clearTimeout(entry.timer);
        const code = aString(message.code);
        if (message.action === 'error' && code) {
          // Only the contract's own codes leave this module, in diagnostics
          // and in the caller's message alike: a server that invents a code
          // gets the generic word, never its raw text echoed onward.
          const refusal = isRefusal(code) ? code : 'rejected';
          collaborationDiagnostic(`keycourier.refused.${refusal}`, { room });
          entry.reject(new Error(`Key courier refused: ${refusal}`));
        } else entry.resolve(message);
      } else if (message.type === 'error') {
        const refusal = isRefusal(aString(message.code) ?? '') ? aString(message.code)! : 'rejected';
        collaborationDiagnostic(`keycourier.refused.${refusal}`, { room });
        throw new Error(`Key courier refused: ${refusal}`);
      } else if (message.type === 'server_shutdown') {
        throw new Error('Key courier is shutting down');
      }
      // Roster/pong frames belong to other transports on this room; ignoring
      // them keeps the exchange working against a relay that still sends them.
    }).catch(cause => {
      rejectConnected(cause instanceof Error ? cause : new Error(String(cause)));
      abandon(cause instanceof Error ? cause : new Error('Key courier failed'));
      try { ws.close(); } catch { /* already gone */ }
    });
  };
  ws.onerror = () => { const cause = new Error('Key courier connection failed'); rejectConnected(cause); abandon(cause); };
  ws.onclose = (event?: { code?: number; reason?: string; wasClean?: boolean }) => {
    dial?.closed(event);
    releaseDial();
    clearTimeout(deadline);
    if (!authenticated) budget.noteRelayDialFailure();
    const cause = new Error('Key courier connection closed');
    rejectConnected(cause);
    abandon(cause);
  };
  await connected;

  return {
    room,
    deviceKeyId: key.keyId,
    ask: (action, body = {}) => new Promise<Frame>((resolve, reject) => {
      // One reply per request, in arrival order, exactly like the log: two
      // requests in flight could not be told apart, and misattributed
      // acknowledgments are how a wrapped key gets believed stored when it
      // is not. Callers await each ask before issuing the next.
      if (!socket || socket.readyState !== Socket.OPEN) { reject(new Error('Key courier connection closed')); return; }
      pending.push({
        resolve, reject,
        timer: setTimeout(() => {
          abandon(new Error(`Key courier ${action} request timed out`));
          // A request that never answered is the network's failure, not a
          // deliberate hang-up.
          dial?.closed(undefined, { by: 'network', reason: `timeout:${action}` });
          try { ws.close(); } catch { /* already gone */ }
        }, options.requestTimeoutMs ?? 15_000)
      });
      try { send({ type: 'sync', request: { action, board: room, ...body } }); }
      catch (cause) { const entry = pending.pop(); clearTimeout(entry?.timer); reject(cause instanceof Error ? cause : new Error('Key courier send failed')); }
    }),
    async close() {
      // The pass finished: this client closes its own socket, and the browser's
      // later event would report that as a clean server close.
      dial?.closed(undefined, { by: 'client', reason: 'exchange-finished' });
      abandon(new Error('Key courier exchange finished'));
      try { send({ type: 'leave' }); } catch { /* already gone */ }
      try { ws.close(); } catch { /* already gone */ }
      releaseDial();
    }
  };
}

/** Peers known to this board's courier, excluding this device and any row
 * without a syntactically present wrap key — a peer that has not published
 * one yet is normal on first run and must never block the exchange. */
function knownPeers(devices: Frame[], ownDeviceKeyId: string) {
  return devices.filter(device => typeof device.publicKey === 'string'
    && DEVICE_ID.test(String(device.deviceKeyId ?? '')) && device.deviceKeyId !== ownDeviceKeyId)
    .slice(0, MAX_LISTED_DEVICES)
    .map(device => ({ deviceKeyId: String(device.deviceKeyId), publicKey: String(device.publicKey) }));
}

export async function runKeyCourier(options: KeyCourierOptions): Promise<KeyCourierOutcome> {
  const outcome: KeyCourierOutcome = { source: 'none', peers: 0, published: 0, peerIds: [], error: null };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const backoff = (attempt: number) => Math.min(4_000, (options.retryBaseMs ?? 500) * 2 ** Math.min(attempt, 3));
  // A writer that also holds the board's authority stops waiting after its
  // first pass (it can create what it cannot find, and an absent peer key
  // must not delay its attach); every other device — a reader, and a joined
  // writer that will only ever receive the key — keeps asking, because the
  // authority device may only be finishing its own run or re-wrapping.
  const attempts = options.isWriter && options.isAuthority ? 1 : Math.max(1, options.attempts ?? 4);
  let connection: CourierConnection | undefined;
  try {
    connection = await openCourier(options);
    const { room, deviceKeyId, ask, close } = connection;
    const wrap = await ensureWrapKey();
    const wrapPrivate = await importWrapKey(wrap.privateJwk as JsonWebKey);
    // `deviceKeyStored` answers even when the row was unchanged (`stored:
    // false`): re-publishing an identical key is an idempotent no-op, not a
    // failure, and nothing here treats it as one.
    await ask('publishDeviceKey', { publicKey: await exportCourierPublicKey(wrap.publicJwk) });

    // A key this device already holds always wins over any grant: a grant
    // may replace the *creation* of a second key, never an established one.
    let key = await options.heldKey();
    if (key) outcome.source = 'local';
    let devices: Frame[] = [];
    for (let attempt = 0; !key && attempt < attempts; attempt++) {
      if (attempt) await sleep(backoff(attempt - 1));
      devices = frames((await ask('listDeviceKeys')).devices);
      const publicKeys = new Map(knownPeers(devices, deviceKeyId).map(peer => [peer.deviceKeyId, peer.publicKey]));
      for (const grant of frames((await ask('fetchKeyGrants')).grants)) {
        const from = aString(grant.fromDeviceKeyId), envelope = aString(grant.envelope);
        const peerPublicKey = from ? publicKeys.get(from) : undefined;
        if (!from || !envelope || !peerPublicKey) continue;
        try {
          // The first envelope that opens wins; a peer re-wrapped after
          // rotation, so several may exist and only the addressed device can
          // tell which one is current by opening it.
          const material = await openKeyEnvelope({ board: room, privateKey: wrapPrivate, peerPublicKey: await importCourierPeerKey(peerPublicKey), envelope });
          key = await options.storeKey(material);
          outcome.source = 'granted';
          break;
        } catch { /* not for us, stale, or corrupt — try the next one */ }
      }
    }
    if (!key && options.isWriter && options.isAuthority) {
      // Prefer-everything-else failed: this is the first device (or the only
      // one that ever will be) and the board gets its key here, once. A
      // writer without the board authority never reaches this line — its
      // board's key, if one exists, comes to it as a grant, and if none
      // exists the authority device creates it. That is what keeps a board
      // with two writers to one content key.
      key = await options.ensureKey();
      outcome.source = 'generated';
    }
    if (key && options.isWriter) {
      if (!devices.length) devices = frames((await ask('listDeviceKeys')).devices);
      const material = await exportBoardContentKey(key.key);
      const peers = knownPeers(devices, deviceKeyId);
      outcome.peers = peers.length;
      // What this pass sealed for, so the caller can tell "a device joined" from
      // "the same set again" without spending a second listing on it.
      const already = options.sealedPeers ? new Set(options.sealedPeers) : undefined;
      outcome.peerIds = peers.map(peer => peer.deviceKeyId);
      const fresh = already ? peers.filter(peer => !already.has(peer.deviceKeyId)) : peers;
      if (already && !fresh.length) { outcome.key = key; await close(); return outcome; }
      const grants: { deviceKeyId: string; envelope: string }[] = [];
      for (const peer of fresh) {
        try {
          grants.push({ deviceKeyId: peer.deviceKeyId,
            envelope: await sealKeyEnvelope({ board: room, privateKey: wrapPrivate, peerPublicKey: await importCourierPeerKey(peer.publicKey), material }) });
        } catch {
          // A peer whose published key is not a usable P-256 SPKI is skipped;
          // one broken row cannot hold the board's other devices hostage,
          // and a refusal for a whole batch stores nothing server-side, so
          // the next pass retries it.
          collaborationDiagnostic('keycourier.peer_key_skipped', { room });
        }
      }
      // ≤32 envelopes per publish; batches beyond the cap chunk forward.
      for (let start = 0; start < grants.length; start += MAX_GRANTS_PER_PUBLISH) {
        const batch = grants.slice(start, start + MAX_GRANTS_PER_PUBLISH);
        const reply = await ask('publishKeyGrants', { grants: batch });
        outcome.published += aNumber(reply.stored) ?? batch.length;
      }
    }
    outcome.key = key;
    await close();
  } catch (cause) {
    outcome.error = cause instanceof Error ? cause.message : 'Key courier failed';
    await connection?.close().catch(() => undefined);
  }
  return outcome;
}
