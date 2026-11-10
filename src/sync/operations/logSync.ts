/**
 * Durable operation-log transport (Sync v3).
 *
 * The board's unconsolidated operations travel over the already-authenticated
 * relay WebSocket and are stored server-side until a Drive snapshot covers them.
 * This replaces peer-to-peer delivery: there is no roster, no ICE and no
 * requirement that another browser be online, so an edit is durable the moment
 * the log acknowledges it rather than the moment a peer happens to receive it.
 *
 * Two properties are load-bearing and both come from the wire format:
 *
 * 1. Replies carry **no request id**. The relay answers sync requests in the
 *    order it received them, on this connection, so requests are correlated by a
 *    FIFO. A reply that arrives with nothing outstanding — or a timeout waiting
 *    for one — means that correlation is broken, and the only honest recovery is
 *    to drop the connection and rebuild it. A second request sent while the first
 *    is unanswered would otherwise be attributed to the wrong batch of
 *    operations, and an operation attributed to the wrong acknowledgment is an
 *    edit believed saved when it is not.
 * 2. Payloads are opaque strings. The relay stores and forwards them without
 *    parsing, so the caller supplies `seal`/`open`: a plaintext default here is
 *    how board contents end up on a server that is not supposed to read them.
 *
 * Since protocol 3 this file is a **room**, not a connection. The cursor, the
 * applied sequence, the unacknowledged queue and the bootstrap live per room and
 * are shared by both transports (`logRoom.ts`). Whether the room's frames travel
 * over a socket of its own (protocol 2 — the deployed server, one socket per
 * room, byte for byte unchanged) or over the context's single socket
 * (protocol 3 — `logSession.ts`) is decided by the first welcome this context
 * sees and is invisible everywhere else here.
 */
import { parseStrictJson } from '../../collab/security/canonical';
import { importSigningKey, signBytes, type StoredDeviceKey } from '../../collab/security/keys';
import { prepareRelayAdmission, type RelayAuthorization } from '../../collab/security/relayAdmission';
import { validateWebSocketEndpoint } from '../../collab/security/endpoint';
import { collaborationDiagnostic } from '../../collab/diagnostics';
import { collaborationCounters } from '../../collab/counters';
import { trackTransportSocket, emitBridgeFrame, type TransportDial, type TransportTrigger } from '../transportDiagnostics';
import { emit } from '../../debug/bus';
import { automaticAuthBudget, type AuthBudget } from '../../collab/authBudget';
import type { ServiceAdmissionRequest } from '../../collab/experimentalWebSocketSignaling';
import type { Operation } from './protocol';
import { readLegacyMigrationWindow } from './legacyMigrationWindow';
import { createGoogleDriveRoomProof, type GoogleDriveCredentials } from './googleDriveAdmission';
import type { LegacyRelayRow } from './legacyRelayRecovery';
import { clearReconnectLedger as clearPolicyLedger, protocolRefusal, reconnectDelay, reconnectLedger, terminalRefusal, ServiceAdmissionUnavailable } from './logPolicy';
import {
  aBoolean, aNumber, aString, createRoomCore, frames, proveRoom, type Frame, type LogMetrics, type RoomCore
} from './logRoom';
import {
  AttachRefused, SessionThrottled, relaySessions, releaseRelaySessions,
  type RelaySession, type SessionAttachment, type SessionWelcome
} from './logSession';

export { createOperationLogCodec, OperationBindingError, LOG_PROTOCOL_VERSION } from './logRoom';

const LOG_CONNECT_TIMEOUT_MS = 10_000;
const LOG_REQUEST_TIMEOUT_MS = 20_000;
const LOG_HEARTBEAT_MS = 15_000;

export type LogSyncPhase = 'connecting' | 'bootstrap' | 'synced' | 'snapshot' | 'offline' | 'error';
export type LogSyncStatus = {
  phase: LogSyncPhase;
  /** Highest log sequence applied locally; the cursor the next subscribe resumes from. */
  appliedSeq: number;
  /** Sequence a published Drive snapshot already covers, when the log reported one. */
  checkpointSeq: number;
  /** Operations submitted and not yet acknowledged. */
  pending: number;
  error: string | null;
  /** Why the connection last fell over and is being retried: one of
   * `refused:<code>`, `detached:<code>`, `timeout:<action>`, `network`, `closed`,
   * `shutdown`, or null while the first connection is still up. A throttled
   * background tab whose tunnel the proxy aged out reads `closed` — the expected
   * state, not a fault — and it is what made console triage impossible without
   * proxy logs. */
  reconnectReason: string | null;
  /** True when the board stopped reconnecting on its own: the reconnect
   * ceiling engaged, which happens only if attempts outpace what backoff alone
   * could produce — a loop the transport cannot fix by itself. Nothing automatic
   * will connect again; an explicit Reconnect clears it deliberately. */
  throttled: boolean;
};
export type LogGap = { reason: string; checkpointSeq?: number; checkpointEpoch?: number; snapshotSeq?: number; oldestRetainedSeq?: number };
export type LogLease = { holder: string; epoch: number; expiresAt: number };
export type LogCommit = { checkpointSeq: number; epoch: number; snapshotSeq: number; stale: boolean };

/**
 * What the sidebar says about the log, in the same voice as the peer transport's
 * "N connected browsers". A reconnect is not an error and an unsent edit is not
 * a failure: both have to be distinguishable from "the server refused this
 * board", because only the last one needs the board re-shared.
 */
export function describeLogStatus(status: LogSyncStatus): string {
  switch (status.phase) {
    case 'synced': return status.pending
      ? `Connected to the Pboard server; ${status.pending} edit${status.pending === 1 ? '' : 's'} still waiting to be stored.`
      : 'Connected to the Pboard server; edits are stored there as you type.';
    case 'bootstrap': return 'Reading the board’s stored history from the Pboard server…';
    case 'snapshot': return 'This board needs a newer snapshot before it can continue; your edits stay on this device until it is published.';
    // A protocol-family verdict names a mismatch between *this build and that
    // service*, not a fault of the board. Saying "refused this board" here sends
    // the person to re-share something that needs updating instead. The service's
    // own code stays in the sentence because it is the diagnostic.
    case 'error': return status.error && protocolRefusal(status.error)
      ? `This browser and the Pboard server do not speak the same protocol (${status.error}); one of them needs to be updated.`
      : `The Pboard server refused this board (${status.error ?? 'reason unknown'}).`;
    default: return 'Reconnecting to the Pboard server; your edits stay on this device until it returns.';
  }
}

/** Refusals that reconnecting with the same grant cannot fix — one copy of the
 * list, shared with the session. */
const terminal = (code: string) => terminalRefusal(code);

/**
 * Test seam: forgets reconnect history (one board, or every board) and closes
 * the context's shared session, so the next scenario starts from a cold context
 * rather than inheriting a socket and a mode from the previous one.
 */
export function clearReconnectLedger(topic?: string): void {
  clearPolicyLedger(topic);
  releaseRelaySessions();
}

/** One outstanding request on a private (v2) connection. */
type Outstanding = { resolve: (reply: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export type LogSyncOptions = {
  /** Board identifier used to validate operation payloads. */
  boardId: string;
  /** Relay room the connection is admitted to (`pboard-collab-<board>-cards`); the log calls this the board. */
  topic: string;
  url: string;
  getKey: () => Promise<StoredDeviceKey>;
  getAuthorization: () => Promise<RelayAuthorization>;
  getServiceAdmission?: (request: ServiceAdmissionRequest) => Promise<string>;
  /** Drive authorization replaces manifest admission on the v3 path. */
  googleDrive?: { folderId: string; accountRoom?: boolean; actorId: string; getCredentials(): Promise<GoogleDriveCredentials>; fetcher?: typeof fetch };
  seal: (operation: Operation) => Promise<string>;
  open: (payload: string, opId: string) => Promise<Operation>;
  receive: (operations: Operation[]) => Promise<void>;
  onAccountHint?: (hint: Frame) => void;
  /**
   * Called for every log row this device could not open — a seal from a key
   * the board no longer carries, or (the designed case) the handoff beacon of
   * an admitted writer waiting for the board key. The row is skipped and the
   * cursor moves past it; this callback is the board's chance to re-wrap or
   * re-fetch the key. It must never throw.
   */
  foreignRow?: (sequence: number) => void;
  /** The requested history was pruned because a snapshot covers it, or is unavailable. */
  gap?: (gap: LogGap) => void;
  status?: (status: LogSyncStatus) => void;
  /** Last applied sequence, persisted so a browser restart does not re-read retained history. */
  cursor?: { load: () => Promise<number>; save: (sequence: number) => Promise<void> };
  webSocket?: typeof WebSocket;
  loopbackDevelopment?: boolean;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Reconnect backoff base; the ceiling stays 30 s. Tests shorten it, nobody else should. */
  reconnectBaseMs?: number;
  /** When supplied, every scheduled reconnect is recorded here — newest
   * first, at most five — with the reason the connection fell over and the
   * backoff that was waited out. */
  reconnects?: { reason: string; delayMs: number }[];
  /** Hard ceiling on connection attempts per window, whatever the reason.
   * Backoff is a schedule; a schedule can be reset by enough triggers, a
   * ceiling cannot. Six attempts fit inside thirty seconds only if something
   * keeps reopening the door (backoff says 0.5+1+2+4+8+16 s ≥ 31 s), so the
   * seventh attempt in the window is proof of a loop — and loops are what
   * carried this relay's clients past the proxy's per-IP denial rate. When it
   * engages the room stops, reports `reconnect:throttled`, and waits for an
   * explicit Reconnect. */
  reconnectCeiling?: number;
  reconnectCeilingMs?: number;
  /** Recognizes an admission refusal that retrying cannot fix (a service
   * 403): the connection ends terminally with `admission:refused` instead of
   * re-presenting the same superseded authorization every backoff. */
  isTerminalAdmissionError?: (error: unknown) => boolean;
  /** True for exactly the connection an explicit Reconnect opened: it may
   * pass the ceiling once, because the person pressing it just changed
   * something the ledger cannot see. It does NOT let the attempt spend budget
   * the context has not got. */
  reconnectCeilingBypassOnce?: boolean;
  /** The shared per-context automatic-auth budget every automatic relay dial
   * must pass before its socket is built. */
  authBudget?: AuthBudget;
  /** Which subsystem this room belongs to, recorded on the connection record
   * when this room's attach is the one that dials the context's socket.
   * Diagnostic only. */
  dialTrigger?: TransportTrigger;
};

/** The public handle: one per room, whatever the transport underneath. */
export type OperationLogSync = {
  metrics: LogMetrics;
  status(): LogSyncStatus;
  reconnectNow(opts?: { userInitiated?: boolean }): boolean;
  broadcast(operations: Operation[]): Promise<boolean>;
  publishAccountHint(to: string, hintId: string, payload: string): Promise<void>;
  replayAccountHints(afterSeq: number): Promise<Frame>;
  lease(leaseMs?: number): Promise<LogLease>;
  release(): Promise<void>;
  commit(lease: LogLease, sequence: number, snapshotSequence: number, driveEtag: string): Promise<LogCommit>;
  beginMigration(generation: string): Promise<number>;
  cancelMigration(generation: string): Promise<void>;
  readMigrationWindow(after: number, through: number): Promise<LegacyRelayRow[]>;
  diagnose(): Promise<Frame>;
  catchUpTo(sequence: number): Promise<'ready' | 'gap'>;
  resend(): Promise<boolean>;
  resumeFrom(sequence: number): Promise<void>;
  close(): Promise<void>;
};

/** The status one room reports, filled from its own core. */
function announceFor(options: LogSyncOptions, room: { phase: LogSyncPhase; error: string | null; reconnectReason: string | null; throttled: boolean; core?: RoomCore }) {
  options.status?.({
    phase: room.phase, appliedSeq: room.core?.appliedSeq() ?? 0, checkpointSeq: room.core?.checkpointSeq() ?? 0,
    pending: room.core?.pendingCount() ?? 0, error: room.error, reconnectReason: room.reconnectReason, throttled: room.throttled
  });
}

/** The status one room reports, filled from its own core. */
function statusFor(room: {
  core: RoomCore; phase: LogSyncPhase; error: string | null; reconnectReason: string | null; throttled: boolean;
}): LogSyncStatus {
  return {
    phase: room.phase, appliedSeq: room.core.appliedSeq(), checkpointSeq: room.core.checkpointSeq(),
    pending: room.core.pendingCount(), error: room.error, reconnectReason: room.reconnectReason, throttled: room.throttled
  };
}

/**
 * Connects to the operation log for one board and keeps it open. Resolves once
 * the first replay window has been applied, so a caller never reports a board as
 * collaboratively live before it has caught up.
 */
export async function createOperationLogSync(options: LogSyncOptions): Promise<OperationLogSync> {
  const url = new URL(options.url);
  const loopback = import.meta.env.DEV && options.loopbackDevelopment && url.protocol === 'ws:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (!loopback && validateWebSocketEndpoint(options.url).check !== 'ok')) throw new Error('Invalid operation log endpoint');
  const Socket = options.webSocket ?? WebSocket;
  // Dials spend from the same per-context budget as the identity and grant
  // callers, because the proxy counts an upgrade in the same stick table.
  const budget = options.authBudget ?? automaticAuthBudget;
  const room = { phase: 'connecting' as LogSyncPhase, error: null as string | null, reconnectReason: null as string | null, throttled: false, core: undefined as unknown as RoomCore };

  // The first room on this URL is the prober: its welcome decides the mode for
  // the whole context. Its own reconnect ceiling is checked *before* anything is
  // dialled, exactly as protocol 2 always did, so a throttled board cannot spend
  // a socket proving it is throttled. A bypass is spent here, not carried in.
  //
  // Only the prober is gated here. Once the context has a session, a room that
  // opens on it is an attach, not a dial — the connection's own ledger decides
  // how often it may reconnect, and charging each attach against the board's
  // dial ceiling would turn ordinary board switching into a throttled outage.
  // The device this room signs with (`board-device:<board>`, normally). It is
  // *not* the connection's identity any more: a v3 socket carries one
  // `deviceKeyId` per attach, so each room is admitted under its own device. It
  // is passed to the session for diagnostics only — the session is keyed by the
  // relay URL, and one socket holds rooms of many devices.
  const identity = options.googleDrive?.actorId ?? (await options.getKey()).keyId;
  const claim = relaySessions.claim({
    url: options.url, Socket, topic: options.topic, identity, authBudget: budget,
    reconnectBaseMs: options.reconnectBaseMs, connectTimeoutMs: options.connectTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs, reconnectCeiling: options.reconnectCeiling,
    reconnectCeilingMs: options.reconnectCeilingMs
  });
  let spentBypass = false;
  if (claim.first) {
    const ledger = reconnectLedger(options.topic);
    let bypass = options.reconnectCeilingBypassOnce === true;
    ledger.prune(options.reconnectCeilingMs ?? 30_000);
    if (ledger.count >= (options.reconnectCeiling ?? 6)) {
      if (!bypass) {
        relaySessions.relinquish(options.url);
        room.phase = 'error'; room.error = 'reconnect:throttled'; room.throttled = true;
        announceFor(options, room);
        throw new Error('reconnect:throttled');
      }
      bypass = false;
      spentBypass = true;
    }
    // The attempt is booked at the dial, exactly as protocol 2 always booked it:
    // the ceiling counts what the network was asked for, not what answered.
    ledger.record();
  } else {
    // The context already decided. A shared context multiplexes; a legacy one
    // (or one whose probe is still in flight) keeps the deployed behaviour.
    const mode = await relaySessions.mode(options.url);
    if (mode !== 'multiplexed' && options.googleDrive) throw new Error('Drive authorization requires relay protocol 3');
    return mode === 'multiplexed'
      ? await openSharedRoom(options, claim.session, room)
      : await openPrivateRoom(options, Socket, budget, room, identity);
  }
  let probe;
  // The label the dial carries when *this* room is the one that dials: the
  // account channel calls itself `account:attach`, a board room nothing (so the
  // session's own default applies), and a legacy relay's first room is relabelled
  // by the private transport it ends up in.
  try { probe = await claim.session.probe({ trigger: options.dialTrigger }); }
  catch (cause) {
    relaySessions.relinquish(options.url);
    room.phase = 'error'; room.error = cause instanceof Error ? cause.message : String(cause);
    room.throttled = cause instanceof SessionThrottled;
    throw cause;
  }
  const versions = Array.isArray(probe.welcome.supportedVersions)
    ? probe.welcome.supportedVersions.filter((value): value is number => typeof value === 'number') : [];
  if (versions.includes(3)) {
    relaySessions.settle(options.url, 'multiplexed');
    try { claim.session.begin(probe); }
    catch (cause) { relaySessions.relinquish(options.url); throw cause; }
    return await openSharedRoom(options, claim.session, room);
  }
  relaySessions.settle(options.url, 'legacy');
  relaySessions.relinquish(options.url);
  if (options.googleDrive) {
    probe.release();
    probe.socket.close();
    throw new Error('Drive authorization requires relay protocol 3');
  }
  // The socket tracked by the probe turned out to be a private per-room
  // connection, not the context's shared one: the ledger says so rather than
  // leaving the dial attributed to the transport it never became.
  probe.dial?.relabel('v2:room');
  return await openPrivateRoom(options, Socket, budget, room, identity, { ...probe, bypassSpent: spentBypass, dial: probe.dial });
}

// --- the shared (v3) room ----------------------------------------------------

async function openSharedRoom(options: LogSyncOptions, session: RelaySession, room: {
  phase: LogSyncPhase; error: string | null; reconnectReason: string | null; throttled: boolean; core: RoomCore;
}): Promise<OperationLogSync> {
  let stopped = false, settled = false, roomId = '';
  let resolveStart: () => void = () => {}, rejectStart: (cause: Error) => void = () => {};
  const started = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  // A refusal can settle this before the `await` below is reached (the session
  // dispatches `failed` and rejects the attach in the same turn), and a promise
  // rejected with no handler is an unhandled rejection the test runner reports
  // as a failure unrelated to what was refused. The observer below marks it
  // handled; the explicit `await started` still sees the rejection.
  void started.catch(() => {});
  const settleStart = () => { if (!settled) { settled = true; resolveStart(); } };
  const refuseStart = (cause: Error) => { if (!settled) { settled = true; rejectStart(cause); } };
  const announce = () => {
    options.status?.(statusFor(room));
  };

  // One queue per room, exactly as the private transport has: an inbound
  // broadcast may arrive while a replay window is being applied, and both write
  // the same cursor. Serializing them is what makes a duplicate row a no-op
  // (`seq <= appliedSeq`) instead of a second delivery to the engine.
  let serialized: Promise<unknown> = Promise.resolve();
  const request = <T>(work: () => Promise<T>): Promise<T> => {
    const result = serialized.then(work, work);
    serialized = result.then(() => undefined, () => undefined);
    return result;
  };
  const ask = async (action: string, body: Frame = {}) => {
    if (!roomId) throw new Error('Operation log room is not attached');
    return await session.request(roomId, action, body);
  };
  const core = await createRoomCore({
    boardId: options.boardId, seal: options.seal, open: options.open, receive: options.receive,
    foreignRow: options.foreignRow, gap: options.gap, cursor: options.cursor,
    ask, announce,
    synchronized: (outcome, detail) => {
      if (outcome === 'snapshot') {
        room.phase = 'snapshot'; room.error = `Operation log gap: ${detail.reason ?? 'history_unavailable'}`;
        settleStart(); announce();
        return;
      }
      room.phase = 'synced'; room.error = null;
      // The connection carried a full room to `synced`: it has proved itself, so
      // its recovery ladder (and the ceiling built from it) start over.
      session.healthy();
      settleStart(); announce();
    },
    background: work => { void work().catch(cause => { room.error = cause instanceof Error ? cause.message : String(cause); announce(); }); }
  });
  room.core = core;

  const attachment: SessionAttachment = {
    topic: options.topic,
    dialCause: options.dialTrigger,
    async prepare() {
      // Re-resolve the admission now, so an expired manifest is reported (and
      // retried on backoff) without a socket or a dial attempt being spent.
      if (!options.googleDrive) {
        await options.getKey();
        await options.getAuthorization();
      }
    },
    async prove(welcome: SessionWelcome) {
      if (options.googleDrive) {
        const proof = await createGoogleDriveRoomProof({ relayUrl: options.url, boardId: options.boardId,
          ...options.googleDrive, welcome });
        roomId = proof.room;
        return proof;
      }
      const key = await options.getKey();
      const proof = await proveRoom({
        topic: options.topic,
        authorization: await options.getAuthorization(),
        key,
        challenge: welcome.challenge, session: welcome.session,
        serviceAdmissionRequired: welcome.requiresServiceAdmission,
        getServiceAdmission: options.getServiceAdmission,
        isTerminalAdmissionError: options.isTerminalAdmissionError
      });
      roomId = proof.room;
      return {
        room: proof.room, deviceKeyId: key.keyId, signature: proof.signature,
        authorization: proof.authorization, serviceAdmission: proof.serviceAdmission
      };
    },
    attached: ({ reattached }) => {
      if (stopped) return;
      if (reattached) collaborationDiagnostic('logsync.reattached');
      room.phase = 'bootstrap'; announce();
      // Detached on purpose: the bootstrap's reply arrives through the same
      // session that is calling this, and awaiting it here would make the
      // session wait for a frame it is still dispatching.
      void request(() => core.bootstrap()).catch(cause => {
        room.error = cause instanceof Error ? cause.message : String(cause);
        room.phase = 'offline'; announce();
        session.breakConnection('bootstrap');
      });
    },
    lost: (reason, delayMs, cause) => {
      if (stopped) return;
      core.metrics.reconnects++;
      room.reconnectReason = reason;
      // A retry that never reached the relay has a cause of its own — an expired
      // manifest, a superseded grant — and that cause is the answer the sidebar
      // has to give. It does not end the room: the ladder keeps trying.
      if (cause) { room.error = cause; room.phase = 'offline'; }
      if (options.reconnects) {
        options.reconnects.unshift({ reason, delayMs });
        if (options.reconnects.length > 5) options.reconnects.length = 5;
      }
      if (room.phase === 'error') return;
      room.phase = 'offline'; announce();
    },
    failed: code => {
      // The room's own cause, in the vocabulary the sidebar already speaks.
      stopped = true;
      room.throttled = code === 'reconnect:throttled';
      room.phase = 'error';
      room.error = code;
      room.reconnectReason = room.throttled ? 'throttled' : `detached:${code}`;
      announce();
      refuseStart(new Error(`Operation log refused: ${code}`));
    },
    accountHint: frame => { if (!stopped) options.onAccountHint?.(frame); },
    deliver: frame => {
      if (stopped) return;
      void request(() => core.apply([frame])).catch(cause => {
        room.error = cause instanceof Error ? cause.message : String(cause);
        announce();
        session.breakConnection('apply');
      });
    }
  };

  try {
    if (options.reconnectCeilingBypassOnce) session.reconnectNow({ userInitiated: true });
    await session.attach(attachment);
  } catch (cause) {
    stopped = true;
    room.phase = 'error';
    room.throttled = cause instanceof SessionThrottled;
    room.error = cause instanceof AttachRefused ? cause.code : cause instanceof Error ? cause.message : String(cause);
    announce();
    if (roomId) session.detach(roomId);
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
  try { await started; } catch (cause) { await closeRoom(); throw cause; }
  announce();

  /**
   * Leaving a board detaches its room and nothing else. The socket is the
   * context's, and it outlives any one board: that is what makes a switch an
   * attach/detach rather than a dial. Teardown is a separate, explicit act
   * (`releaseRelaySessions`, from the account channel's sign-out or the test
   * seam), because a switch is indistinguishable from a close by looking at one
   * room.
   */
  async function closeRoom() {
    stopped = true;
    // Ownership matters here: a room this handle no longer owns (a newer handle
    // took it over) must not be detached by this one's teardown.
    if (roomId) session.detach(roomId, attachment);
    announce();
  }

  return {
    metrics: core.metrics,
    status: () => statusFor(room),
    /**
     * The session owns dialing, so this answers only for the explicit gesture:
     * a Reconnect clears the ceiling, re-admits a refused room and re-attaches
     * it. Anything automatic belongs to the session's own schedule.
     */
    reconnectNow: (opts = {}) => {
      if (!opts.userInitiated) return false;
      if (!stopped && session.isAttached(roomId)) return false;
      stopped = false; room.throttled = false;
      if (room.phase === 'error') { room.phase = 'offline'; room.error = null; }
      room.phase = 'connecting'; announce();
      // The session's state is reset here, but the re-attach below is the dial:
      // letting the session redial as well would race two sockets for one room.
      session.reconnectNow({ userInitiated: true, redial: false });
      void session.attach(attachment).catch(cause => {
        // `attached`/`failed` normally own this; a rejection here is the attach
        // that never reached the server, and the room must say so.
        stopped = true; room.phase = 'error';
        room.throttled = cause instanceof SessionThrottled;
        room.error = cause instanceof AttachRefused ? cause.code : cause instanceof Error ? cause.message : String(cause);
        announce();
      });
      return true;
    },
    async broadcast(operations: Operation[]) {
      if (!operations.length || stopped) return false;
      // Never throws: the caller's answer is "did this reach the log", and an
      // exception would look like a programming error to a session that has to
      // keep the operation in its journal either way.
      try { return await request(() => core.publish(operations)); }
      catch (cause) { room.error = cause instanceof Error ? cause.message : String(cause); announce(); return false; }
    },
    async publishAccountHint(to: string, hintId: string, payload: string) { await ask('publishAccountHint', { to, hintId, payload }); },
    async replayAccountHints(afterSeq: number) { return await ask('replayAccountHints', { afterSeq }); },
    async lease(leaseMs?: number) {
      const reply = await ask('lease', leaseMs ? { leaseMs } : {});
      const lease = { holder: aString(reply.holder) ?? '', epoch: aNumber(reply.epoch) ?? 0, expiresAt: aNumber(reply.expiresAt) ?? 0 };
      if (!lease.epoch) throw new Error('Operation log lease reply is missing its fencing epoch');
      return lease;
    },
    async release() { await ask('release'); },
    async commit(lease: LogLease, sequence: number, snapshotSequence: number, driveEtag: string) {
      const reply = await ask('commit', { epoch: lease.epoch, seq: sequence, snapshotSeq: snapshotSequence, driveEtag });
      const commit = {
        checkpointSeq: aNumber(reply.checkpointSeq) ?? core.checkpointSeq(), epoch: aNumber(reply.epoch) ?? lease.epoch,
        snapshotSeq: aNumber(reply.snapshotSeq) ?? snapshotSequence, stale: aBoolean(reply.stale) === true
      };
      core.setCheckpoint(commit.checkpointSeq);
      if (commit.stale) collaborationDiagnostic('logsync.stale_commit');
      announce();
      return commit;
    },
    async beginMigration(generation: string) {
      const reply = await ask('beginMigration', { generation });
      if (reply.action !== 'migrationFenced' || reply.generation !== generation || !Number.isSafeInteger(reply.throughSeq) || Number(reply.throughSeq) < 0)
        throw new Error('Invalid migration fence reply');
      return Number(reply.throughSeq);
    },
    async cancelMigration(generation: string) {
      const reply = await ask('cancelMigration', { generation });
      if (reply.action !== 'migrationCancelled' || reply.generation !== generation) throw new Error('Invalid migration cancellation reply');
    },
    async readMigrationWindow(after: number, through: number) {
      return await request(() => readLegacyMigrationWindow(afterSeq => ask('subscribe', { afterSeq }), after, through));
    },
    async diagnose() { return await ask('status'); },
    async catchUpTo(sequence: number) { return await request(() => core.catchUpTo(sequence)); },
    async resend() { if (stopped) return true; return await request(() => core.resend()); },
    async resumeFrom(sequence: number) {
      if (stopped) return;
      await request(async () => { await core.resumeFrom(sequence); });
      announce();
    },
    close: closeRoom
  };
}

// --- the private (v2) room ---------------------------------------------------

async function openPrivateRoom(options: LogSyncOptions, Socket: typeof WebSocket, budget: AuthBudget, room: {
  phase: LogSyncPhase; error: string | null; reconnectReason: string | null; throttled: boolean; core: RoomCore;
}, identity: string, preDialed?: { socket: WebSocket; welcome: Frame; release: () => void; bypassSpent: boolean; dial?: TransportDial }): Promise<OperationLogSync> {
  // The reconnect ceiling's ledger: when the last attempts began (shared per
  // board across every connection this context opens), and whether the ceiling
  // has engaged (which only an explicit Reconnect may clear).
  const ledger = reconnectLedger(options.topic);
  // The prober already decided whether the caller's bypass was spent getting
  // this socket; the room must not spend it a second time.
  let bypassRemaining = options.reconnectCeilingBypassOnce === true && preDialed?.bypassSpent !== true;

  // The prober's socket is handed over exactly once: any later dial is this
  // room's own.
  let handed = preDialed;
  let socket: WebSocket | undefined = preDialed?.socket;
  let releaseDial: (() => void) | undefined = preDialed?.release;
  /** The diagnostics record of the socket this room currently owns: the
   * prober's when the socket was handed over, otherwise this room's own dial. */
  let roomDial: TransportDial | undefined = preDialed?.dial;
  let stopped = false, session = '', attempts = 0;
  let connecting = false, settled = false, authenticated = false, roomId = '';
  let retryTimer: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let resolveStart: () => void = () => {}, rejectStart: (cause: Error) => void = () => {};
  const started = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  // A refusal can settle this before the `await` below is reached (the session
  // dispatches `failed` and rejects the attach in the same turn), and a promise
  // rejected with no handler is an unhandled rejection the test runner reports
  // as a failure unrelated to what was refused. The observer below marks it
  // handled; the explicit `await started` still sees the rejection.
  void started.catch(() => {});
  const settleStart = () => { if (!settled) { settled = true; resolveStart(); } };
  const refuseStart = (cause: Error) => { if (!settled) { settled = true; rejectStart(cause); } };
  const announce = () => {
    options.status?.(statusFor(room));
  };
  const fail = (cause: unknown) => { room.error = cause instanceof Error ? cause.message : String(cause); announce(); };

  const waiting: Outstanding[] = [];
  const send = (message: unknown) => {
    if (!socket || socket.readyState !== Socket.OPEN) throw new Error('Operation log is disconnected');
    socket.send(JSON.stringify(message));
    // `message` is a Frame at every call site; only its `type` is read here.
    const frame = message as Frame;
    if (roomDial) emitBridgeFrame(roomDial, "sent", frame, frame?.type === "authenticate" ? { severity: "info" } : {});
  };
  const abandon = (cause: Error) => {
    for (const entry of waiting.splice(0)) { clearTimeout(entry.timer); entry.reject(cause); }
    fail(cause);
  };
  // One request in flight per connection: the reply has no id, so two concurrent
  // requests cannot be told apart. Everything that talks to the log is serialized.
  let serialized: Promise<unknown> = Promise.resolve();
  const request = <T>(work: () => Promise<T>): Promise<T> => {
    const result = serialized.then(work, work);
    serialized = result.then(() => undefined, () => undefined);
    return result;
  };
  const ask = (action: string, body: Frame = {}) => new Promise<Frame>((resolve, reject) => {
    if (!socket || socket.readyState !== Socket.OPEN) { reject(new Error('Operation log is disconnected')); return; }
    waiting.push({
      resolve, reject,
      timer: setTimeout(() => {
        room.reconnectReason = `timeout:${action}`;
        abandon(new Error(`Operation log ${action} request timed out`));
        socket?.close(); // Correlation is only rebuildable by reconnecting.
      }, options.requestTimeoutMs ?? LOG_REQUEST_TIMEOUT_MS)
    });
    send({ type: 'sync', request: { action, board: roomId, ...body } });
  });

  const core = await createRoomCore({
    boardId: options.boardId, seal: options.seal, open: options.open, receive: options.receive,
    foreignRow: options.foreignRow, gap: options.gap, cursor: options.cursor,
    ask, announce,
    synchronized: (outcome, detail) => {
      if (outcome === 'snapshot') {
        // A gap is a working connection with unusable history, not a failed
        // connect: the caller has to go get a snapshot, so it needs the handle.
        room.phase = 'snapshot'; room.error = `Operation log gap: ${detail.reason ?? 'history_unavailable'}`;
        settleStart(); announce();
        return;
      }
      room.phase = 'synced'; room.error = null; settleStart(); announce();
    },
    background: work => { void request(work).catch(fail); }
  });
  room.core = core;

  const debug = (event: string, count?: number) => collaborationDiagnostic(event, { room: options.topic, session, count });
  // One place owns reconnect timing; the ladder itself lives in `logPolicy`, so
  // the shared session and this room cannot drift apart.
  const scheduleReconnect = () => {
    if (attempts > 0) core.metrics.reconnects++;
    const delay = Math.round(reconnectDelay(options.reconnectBaseMs ?? 1_000, attempts++));
    debug('logsync.reconnect_scheduled', delay);
    collaborationCounters.countEvent('logsync.reconnect');
    if (options.reconnects) {
      options.reconnects.unshift({ reason: room.reconnectReason ?? 'closed', delayMs: delay });
      if (options.reconnects.length > 5) options.reconnects.length = 5;
    }
    // On the record of the connection being replaced: it answers "was this one
    // followed by another, and after how long".
    roomDial?.reconnected(delay);
    retryTimer = setTimeout(() => { retryTimer = undefined; dial(); }, delay);
    return delay;
  };
  /** Dials, and owns the failure. A reconnect attempt can die before it ever
   * reaches the socket — the authorization it presents can be expired at
   * admission, the device key read can fail — and that is not a close any
   * `onclose` will report: leaving it at `fail` alone strands the handle forever
   * (nothing schedules another attempt). */
  const dial = () => {
    void connect().catch(cause => {
      fail(cause);
      if (settled && !stopped && !retryTimer) scheduleReconnect();
    });
  };
  const settle = (reply: Frame) => {
    const entry = waiting.shift();
    if (!entry) { abandon(new Error('Unexpected operation log reply')); socket?.close(); return; }
    clearTimeout(entry.timer);
    const code = aString(reply.code);
    if (reply.action === 'error' && code) entry.reject(new Error(code));
    else entry.resolve(reply);
  };

  async function connect() {
    if (stopped || connecting) return;
    // The per-topic ceiling engages before the socket is even built: attempts
    // inside thirty seconds more than backoff could schedule means a trigger,
    // not the network, is driving, and this board stops here rather than at
    // the proxy.
    const windowMs = options.reconnectCeilingMs ?? 30_000;
    ledger.prune(windowMs);
    if (!handed && ledger.count >= (options.reconnectCeiling ?? 6)) {
      // A bypass is spent by the attempt that used it: the Reconnect gesture
      // passes the ceiling once, not for the rest of the handle's life.
      if (!bypassRemaining) {
        room.throttled = true; stopped = true; connecting = false;
        room.phase = 'error'; room.error = 'reconnect:throttled'; room.reconnectReason = 'throttled';
        debug('logsync.reconnect_ceiling');
        announce();
        refuseStart(new Error(room.error));
        return;
      }
      bypassRemaining = false;
    }
    // A handed socket was gated and recorded by the prober (the first room's
    // own ceiling), so it is neither checked nor counted a second time here.
    if (!handed) ledger.record();
    room.throttled = false;
    connecting = true;
    // The context-wide allowance, in addition to the per-topic ceiling above.
    if (!handed) {
      await budget.acquireRelayAttempt();
      if (stopped) { connecting = false; return; }
      const beforeGate = Date.now();
      const gate = await budget.acquireRelayDial();
      if (stopped) { connecting = false; return; }
      if (gate.paced) debug('logsync.dial_paced', Date.now() - beforeGate);
      const ws = new Socket(options.url);
      socket = ws;
      // A private per-room connection: this is the v2 path, where one board
      // holds one socket of its own.
      roomDial = trackTransportSocket(ws, 'v2:room', options.topic, identity);
      // Counted where the socket is built, not where the handle is created: a
      // handle that never dials is not a socket, and this gauge is the one the
      // connection-count invariant reads.
      collaborationCounters.noteSocketOpen(options.topic);
      let dialLed = true;
      releaseDial = () => {
        if (!dialLed) return;
        dialLed = false;
        collaborationCounters.noteSocketClose(options.topic);
      };
      install(ws, roomDial);
      deadline = setTimeout(() => {
        if (ws.readyState === Socket.OPEN) return;
        // Nothing answered: the client calls `close()` on a socket that never
        // opened, and the ledger has to read "the network did not answer"
        // rather than "we hung up on purpose".
        roomDial?.closed(undefined, { by: 'network' });
        ws.close();
      }, options.connectTimeoutMs ?? LOG_CONNECT_TIMEOUT_MS);
    } else {
      const probe = handed;
      handed = undefined;
      // The prober booked this topic's first attempt before it dialled and this
      // room shares that ledger, so the handed socket is counted exactly once.
      install(probe.socket, roomDial);
      deadline = setTimeout(() => { if (probe.socket.readyState !== Socket.OPEN) probe.socket.close(); }, options.connectTimeoutMs ?? LOG_CONNECT_TIMEOUT_MS);
      authenticated = false;
      await handleWelcome(probe.welcome);
      return;
    }
    authenticated = false;
  }

  /** Everything before the socket exists fails in the caller's promise, not in
   * an `onclose` the transport owns: if `connecting` survived that failure, the
   * handle would believe an attempt were still in flight forever. */
  async function handleWelcome(message: Frame) {
    const challenge = aString(message.challenge);
    if (typeof challenge !== 'string' || typeof message.session !== 'string' || session) throw new Error('Invalid operation log welcome');
    session = message.session;
    if (!Array.isArray(message.supportedVersions) || !message.supportedVersions.includes(2)) throw new Error('Relay does not support automatic authorization; no insecure downgrade permitted');
    const key = await options.getKey().catch(cause => { connecting = false; throw cause; });
    const admission = await prepareRelayAdmission(options.topic, await options.getAuthorization(), key.keyId)
      .catch(cause => { connecting = false; throw cause; });
    if (stopped) { connecting = false; return; }
    // The log's board id is the authenticated room, not the Drive topic: every
    // frame is checked against the room this connection was admitted to.
    roomId = admission.room;
    let serviceAdmission: string | undefined;
    if (message.requiresServiceAdmission === true) {
      if (!options.getServiceAdmission) { connecting = false; throw new ServiceAdmissionUnavailable('Verified Google service admission is required', false); }
      try {
        serviceAdmission = await options.getServiceAdmission({ challenge, session, room: admission.room, key });
      } catch (cause) {
        // One room's ticket, one room's cause: raised as the typed failure so
        // the caller reports `admission:refused` (terminal) or retries this
        // room alone, rather than failing the whole handle untyped.
        connecting = false;
        throw new ServiceAdmissionUnavailable(cause instanceof Error ? cause.message : String(cause), options.isTerminalAdmissionError?.(cause) === true);
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(serviceAdmission)) { connecting = false; throw new ServiceAdmissionUnavailable('Invalid service admission response', false); }
    }
    const signature = await signBytes(await importSigningKey(key.privateJwk), new TextEncoder().encode(JSON.stringify(
      ['pboard-ws-auth-v2', challenge, session, admission.room, key.keyId, admission.digest])));
    if (stopped || !socket || socket.readyState !== Socket.OPEN) return;
    if (roomDial?.debugConnectionId)
      emit({ component: "auth", event: "authentication.started", severity: "info", connectionId: roomDial.debugConnectionId, boardId: admission.room, details: { version: 2, serviceAdmission: serviceAdmission !== undefined } });
    send({ type: 'authenticate', version: 2, room: admission.room, deviceKeyId: key.keyId, signature,
      authorization: admission.authorization, ...(serviceAdmission ? { serviceAdmission } : {}) });
  }

  function install(ws: WebSocket, dial?: TransportDial) {
    let inbound = Promise.resolve(), pending = 0;
    ws.onmessage = (event) => {
      if (++pending > 64) { abandon(new Error('Operation log inbound queue exceeded')); ws.close(); return; }
      inbound = inbound.then(async () => {
        if (stopped || socket !== ws || ws.readyState !== Socket.OPEN) return;
        const message = parseStrictJson(String(event.data), 256 * 1024) as Frame | null;
        if (!message || typeof message.type !== 'string') return;
        if (dial) emitBridgeFrame(dial, "received", message);
        // Roster and signaling frames belong to the peer transport; ignoring them
        // keeps this client working against a relay that still sends them.
        if (!['welcome', 'authenticated', 'sync', 'error', 'pong', 'server_shutdown'].includes(message.type)) return;
        switch (message.type) {
          case 'welcome':
            await handleWelcome(message);
            break;
          case 'authenticated': {
            const key = await options.getKey();
            if (message.peerId !== key.keyId || message.session !== session) throw new Error('Operation log identity mismatch');
            clearTimeout(deadline);
            authenticated = true;
            if (dial?.debugConnectionId)
              emit({ component: "auth", event: "authentication.completed", severity: "info", connectionId: dial.debugConnectionId, boardId: roomId, details: { version: 2 } });
            // `attempts` is deliberately NOT reset here: only a connection that
            // reaches `synced` has earned the reset.
            connecting = false;
            room.reconnectReason = null;
            debug('logsync.authenticated');
            heartbeat = collaborationCounters.countedInterval('logsync.heartbeat', () => { if (socket?.readyState === Socket.OPEN) { collaborationCounters.countEvent('logsync.ping'); send({ type: 'ping' }); } }, LOG_HEARTBEAT_MS);
            // Detached on purpose: bootstrap waits for the replay window, and that
            // reply arrives on this very queue. Awaiting it here would make the
            // transport wait for a frame it is refusing to read.
            room.phase = 'bootstrap'; announce();
            void request(async () => { await core.bootstrap(); }).then(() => {
              if (room.phase === 'synced') attempts = 0;
            }).catch(cause => { abandon(cause instanceof Error ? cause : new Error(String(cause))); ws.close(); });
            break;
          }
          case 'sync': {
            if (message.board !== roomId) throw new Error('Operation log frame names another board');
            if (message.action === 'operation') { await core.apply([message]); break; }
            settle(message);
            break;
          }
          case 'error': {
            const code = aString(message.code) ?? 'server_error';
            core.metrics.refused++;
            room.reconnectReason = `refused:${code}`;
            debug('logsync.rejected');
            if (dial?.debugConnectionId)
              emit({ component: "auth", event: "authentication.failed", severity: "error", connectionId: dial.debugConnectionId, boardId: roomId, details: { code, terminal: terminal(code) } });
            if (terminal(code)) {
              stopped = true;
              room.phase = 'error'; room.error = code; announce();
              abandon(new Error(`Operation log refused: ${code}`));
              refuseStart(new Error(`Operation log refused: ${code}`));
              // The server ended this connection with its refusal; calling
              // `close()` is the acknowledgement, not the cause. The refusal
              // code is carried into the ledger verbatim: it is this protocol's
              // whole vocabulary and therefore safe to report.
              dial?.closed(undefined, { by: 'server', reason: `refused:${code}` });
              ws.close();
            } else fail(new Error(`Operation log refused: ${code}`));
            break;
          }
          case 'server_shutdown':
            room.reconnectReason = 'shutdown'; stopped = true;
            abandon(new Error('Operation log is shutting down'));
            dial?.closed(undefined, { by: 'server', reason: 'server_shutdown' });
            ws.close();
            break;
          default: break;
        }
      }).catch(cause => {
        const reason = cause instanceof Error ? cause : new Error(String(cause));
        // A refused admission is terminal by this protocol's own rule: the
        // service has already superseded the authorization being presented, so
        // no retry can succeed and every one spends the shared budget. The
        // typed failure already carries that verdict (it asked the same hook
        // when it wrapped the identity error), so this does not depend on
        // re-recognizing a message after wrapping.
        if (cause instanceof ServiceAdmissionUnavailable ? cause.terminal : options.isTerminalAdmissionError?.(cause)) {
          stopped = true; room.reconnectReason = 'admission:refused';
          for (const entry of waiting.splice(0)) { clearTimeout(entry.timer); entry.reject(reason); }
          room.phase = 'error'; room.error = 'admission:refused';
          debug('logsync.admission_refused');
          announce();
          refuseStart(reason);
          ws.close();
          return;
        }
        abandon(reason); ws.close();
      }).finally(() => { pending--; });
    };
    ws.onerror = () => { room.reconnectReason = 'network'; debug('logsync.network_error'); fail(new Error('Operation log WebSocket failed')); };
    ws.onclose = (event?: { code?: number; reason?: string; wasClean?: boolean }) => {
      // Recorded before the ownership guard, below: a dial that a newer socket
      // has already replaced still ended, and the ledger counts connections.
      dial?.closed(event);
      // Released before the guard: this dial is over whether or not a newer
      // socket has already replaced it, and the gauge counts dials.
      releaseDial?.();
      releaseDial = undefined;
      if (socket !== ws) return;
      socket = undefined; session = ''; connecting = false; roomId = '';
      collaborationCounters.clearCountedTimer(heartbeat); clearTimeout(deadline);
      // The upgrade never became a session. An over-budget proxy denial lands
      // exactly here — Firefox reports it as the socket failure behind
      // `NS_ERROR_WEBSOCKET_CONNECTION_REFUSED` — so the budget records the
      // spend as failed instead of letting the snapshot read like healthy dials.
      if (!authenticated) { budget.noteRelayDialFailure(); debug('logsync.dial_failed'); }
      if (stopped) {
        // Nothing may out-talk a terminal reason: the close that follows a
        // refusal is that refusal's own doing, not a new event to report.
        for (const entry of waiting.splice(0)) { clearTimeout(entry.timer); entry.reject(new Error('Operation log connection closed')); }
        return;
      }
      abandon(new Error('Operation log connection closed'));
      // A proxy that ages an idle tunnel out from under a throttled background
      // tab closes the socket with no client-side reason of its own: that is
      // `closed`, an expected state with an expected recovery.
      room.reconnectReason ??= 'closed';
      // A connection that never finished its first bootstrap is the caller's
      // problem, not something to retry silently: the board has to say why it is
      // not collaborative, and a background reconnect loop hides that reason
      // forever. Later drops do reconnect on their own.
      if (!settled) {
        stopped = true; room.phase = 'error'; room.error = 'Operation log closed before it synchronized'; announce();
        rejectStart(new Error(room.error));
        return;
      }
      lastHealthyOffline = room.phase === 'synced' || room.phase === 'bootstrap' || room.phase === 'snapshot';
      room.phase = 'offline'; announce();
      scheduleReconnect();
    };
  }

  // Whether the connection that just ended was healthy when it ended — the only
  // state from which an immediate reconnect is justified.
  let lastHealthyOffline = false;

  serialized = serialized.then(() => connect(), () => connect()).catch(cause => {
    // A failure before the socket even opens (no board grant, an expired
    // manifest) has to reach the caller: waiting for the connect deadline would
    // report "closed before it synchronized" and hide the only useful reason.
    const reason = cause instanceof Error ? cause : new Error(String(cause));
    abandon(reason);
    if (!settled) { stopped = true; room.phase = 'error'; room.error = reason.message; announce(); rejectStart(reason); }
  });

  try { await started; } catch (cause) {
    stopped = true; clearTimeout(retryTimer); socket?.close();
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
  announce();

  const metrics = core.metrics;
  return {
    metrics,
    status: () => statusFor(room),
    reconnectNow(opts: { userInitiated?: boolean } = {}): boolean {
      if (opts.userInitiated) {
        if (socket && socket.readyState === Socket.OPEN) return false;
        room.throttled = false; stopped = false;
        if (room.phase === 'error') { room.error = null; room.phase = 'offline'; }
        attempts = 0; ledger.clear();
        clearTimeout(retryTimer); retryTimer = undefined;
        dial();
        return true;
      }
      if (room.throttled || stopped || !settled || connecting) return false;
      if (socket) return false;
      if (!retryTimer && room.phase !== 'offline') return false;
      if (!lastHealthyOffline) {
        // A failing connection: do not skip anything, just guarantee that the
        // next attempt is scheduled at the delay backoff has reached.
        if (!retryTimer) scheduleReconnect();
        return false;
      }
      clearTimeout(retryTimer); retryTimer = undefined;
      dial();
      return true;
    },
    async broadcast(operations: Operation[]) {
      if (!operations.length || stopped) return false;
      try { return await request(() => core.publish(operations)); }
      catch (cause) { fail(cause); return false; }
    },
    async publishAccountHint(to: string, hintId: string, payload: string) { await request(() => ask('publishAccountHint', { to, hintId, payload })); },
    async replayAccountHints(afterSeq: number) { return await request(() => ask('replayAccountHints', { afterSeq })); },
    async lease(leaseMs?: number): Promise<LogLease> {
      const reply = await request(() => ask('lease', leaseMs ? { leaseMs } : {}));
      const lease = { holder: aString(reply.holder) ?? '', epoch: aNumber(reply.epoch) ?? 0, expiresAt: aNumber(reply.expiresAt) ?? 0 };
      if (!lease.epoch) throw new Error('Operation log lease reply is missing its fencing epoch');
      return lease;
    },
    async release() { await request(() => ask('release')); },
    async commit(lease: LogLease, sequence: number, snapshotSequence: number, driveEtag: string): Promise<LogCommit> {
      const reply = await request(() => ask('commit', { epoch: lease.epoch, seq: sequence, snapshotSeq: snapshotSequence, driveEtag }));
      const commit = {
        checkpointSeq: aNumber(reply.checkpointSeq) ?? core.checkpointSeq(), epoch: aNumber(reply.epoch) ?? lease.epoch,
        snapshotSeq: aNumber(reply.snapshotSeq) ?? snapshotSequence, stale: aBoolean(reply.stale) === true
      };
      core.setCheckpoint(commit.checkpointSeq);
      if (commit.stale) debug('logsync.stale_commit');
      announce();
      return commit;
    },
    async beginMigration(generation: string) {
      const reply = await request(() => ask('beginMigration', { generation }));
      if (reply.action !== 'migrationFenced' || reply.generation !== generation || !Number.isSafeInteger(reply.throughSeq) || Number(reply.throughSeq) < 0)
        throw new Error('Invalid migration fence reply');
      return Number(reply.throughSeq);
    },
    async cancelMigration(generation: string) {
      const reply = await request(() => ask('cancelMigration', { generation }));
      if (reply.action !== 'migrationCancelled' || reply.generation !== generation) throw new Error('Invalid migration cancellation reply');
    },
    async readMigrationWindow(after: number, through: number) {
      return await request(() => readLegacyMigrationWindow(afterSeq => ask('subscribe', { afterSeq }), after, through));
    },
    async diagnose() { return await request(() => ask('status')); },
    async catchUpTo(sequence: number) { return await request(() => core.catchUpTo(sequence)); },
    async resend() {
      if (stopped) return true;
      return await request(async () => await core.resend());
    },
    async resumeFrom(sequence: number) {
      if (stopped) return;
      await request(async () => {
        await core.resumeFrom(sequence);
        if (room.phase !== 'snapshot') { room.phase = 'synced'; attempts = 0; }
        announce();
      });
    },
    async close() {
      stopped = true; connecting = false;
      // Teardown is a close this client asked for, and the browser cannot say
      // so (it reports 1000/clean, exactly like a server's own close).
      roomDial?.closed(undefined, { by: 'client', reason: 'closed' });
      clearTimeout(retryTimer); collaborationCounters.clearCountedTimer(heartbeat); clearTimeout(deadline);
      abandon(new Error('Operation log closed'));
      try { if (socket?.readyState === Socket.OPEN) send({ type: 'leave' }); } catch { /* already gone */ }
      // The close event is a task and `socket` is already gone, so the live
      // dial's release is taken here rather than waiting for a handler that will
      // now return at its guard.
      releaseDial?.(); releaseDial = undefined;
      socket?.close(); socket = undefined;
    }
  };
}

/** Kept for the historic import site: `frames` is used by `accountChannel`'s
 * tests through this module. */
export { frames as operationLogFrames, aString as operationLogString };
