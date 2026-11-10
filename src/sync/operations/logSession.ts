/**
 * The browser context's relay connection (protocol v3) and the rooms that share
 * it.
 *
 * Protocol v2 ties one room to one socket: every board switch pays a dial, a
 * `GET /ws` upgrade and a full admission round, and the connect-to-die storm
 * that follows a flaky tunnel multiplies all of it by the number of boards. A v3
 * server says `supportedVersions: [1,2,3]` on the welcome and then accepts
 * `attach`/`detach` **on the connection it already authenticated**, so the
 * context can hold one socket and move rooms in and out of it:
 *
 *  - a board switch is `detach(old)` + `attach(new)`: no dial, no re-authentication;
 *  - the account channel is one more room on the same socket;
 *  - a `refused` or a server-initiated `detached` is scoped to the room it names
 *    and never closes the connection, so one board losing its grant cannot take
 *    the tab's transport down with it.
 *
 * This module owns exactly that: the socket, the welcome challenge, the
 * authenticated identity, the reply FIFO (replies still carry no request id, so
 * the head of the queue is the only request a reply can belong to), the
 * heartbeat, dial metering, the reconnect ceiling and backoff, and the
 * re-attachment of every room that was attached when the tunnel died.
 *
 * Per-room state — cursor, applied sequence, unacknowledged operations,
 * bootstrap — stays with each room's own handle in `logSync.ts`, which is what
 * makes a room's behaviour identical on a shared socket and on a private one.
 *
 * Version negotiation is here too and it is deliberately conservative: a session
 * only exists once a welcome has advertised 3, decided by the first room that
 * dialled (the "prober"). Against a deployed v2 server the prober's socket is
 * handed back and every room keeps dialing its own, byte for byte as before.
 */
import { parseStrictJson } from '../../collab/security/canonical';
import { collaborationDiagnostic } from '../../collab/diagnostics';
import { collaborationCounters } from '../../collab/counters';
import { trackTransportSocket, type TransportDial, type TransportTrigger } from '../transportDiagnostics';
import { automaticAuthBudget, type AuthBudget } from '../../collab/authBudget';
import {
  LOG_CONNECT_TIMEOUT_MS, LOG_HEARTBEAT_MS, LOG_REQUEST_TIMEOUT_MS, protocolRefusal, reconnectDelay, terminalRefusal, ServiceAdmissionUnavailable
} from './logPolicy';

export type Frame = Record<string, unknown>;
const aString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const aNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The connection's welcome, as every room attached to it needs it. */
export type SessionWelcome = {
  challenge: string;
  session: string;
  requiresServiceAdmission: boolean;
  versions: number[];
};

/** One room's admission material for one attach attempt. Rebuilt for every
 * welcome — a signature bound to a dead socket's challenge proves nothing on
 * the next one. */
export type RoomProof = {
  room: string;
  deviceKeyId: string;
  signature: string;
  authorization: unknown;
  serviceAdmission?: string;
  /** Present only for Drive-authorized rooms; expiry is Unix seconds. */
  google?: { expiresAt: number; renew(welcome: SessionWelcome): Promise<{ ticket: string; room: string; expiresAt: number }> };
};

/** What a room hands the session. */
export type SessionAttachment = {
  /** The room's Drive topic, for diagnostics only (the wire identity is the
   * room id the proof names). */
  topic: string;
  /**
   * Re-resolves the room's admission material *before* anything is dialled, so
   * a cause that is local — an expired manifest, a superseded grant — fails
   * without spending a socket or a dial attempt. This is the rule the per-room
   * transport always stated: a dial that never reaches the network spends
   * nothing, and a retry loop a fresh manifest can cure must not walk into the
   * ceiling that exists for loops a fresh manifest cannot.
   */
  prepare?(): Promise<void>;
  prove(welcome: SessionWelcome): Promise<RoomProof>;
  /** The room is attached and may bootstrap from its own cursor. `reattached`
   * is true for the recovery of a room that was already live. */
  attached(info: { role: string; reattached: boolean }): void;
  /** The connection ended under the room, or the session is waiting out a
   * backoff before re-attaching it. `cause` is the room's own stated reason when
   * the retry that just failed never reached the relay (an expired manifest, a
   * key read that threw) — the words the sidebar has to show. */
  lost(reason: string, delayMs: number, cause?: string): void;
  /** The room's own stated cause: a refusal, a per-room detach, the ceiling. */
  failed(code: string): void;
  /** A renewed Drive grant may change the effective role without reconnecting. */
  roleChanged?(role: string): void;
  accountHint?(frame: Frame): void;
  /** A frame the server addressed to this room. */
  deliver(frame: Frame): void;
  /** Which subsystem this room belongs to, for the connection diagnostics when
   * this room's attach is the one that dials. Diagnostic only. */
  dialCause?: TransportTrigger;
};

/** An `attach` the server declined. `refused` never closes the socket, so the
 * refusal belongs to the room that asked and to nothing else. */
export class AttachRefused extends Error {
  constructor(readonly code: string) { super(`Operation log refused: ${code}`); }
}

/** The connection-level ceiling engaged: this context has dialled too often for
 * one window and nothing automatic may try again until a person asks. */
export class SessionThrottled extends Error {
  constructor() { super('reconnect:throttled'); }
}

type PendingReply = { room: string; action: string; timer: ReturnType<typeof setTimeout>; resolve: (frame: Frame) => void; reject: (error: Error) => void };
type PendingAttach = { attachment: SessionAttachment; proof: RoomProof; timer: ReturnType<typeof setTimeout>; resolve: (value: { room: string; role: string }) => void; reject: (error: Error) => void };

export type SessionOptions = {
  url: string;
  Socket: typeof WebSocket;
  /** The first room's topic: the transport gauge counts a socket once, under the
   * room that dialled it, so `transport.open` stays "sockets", never "rooms". */
  topic: string;
  /** The device that dialled, for diagnostics only: the socket is not bound to
   * it (one connection carries one device key per room). */
  identity?: string;
  authBudget?: AuthBudget;
  reconnectBaseMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectCeiling?: number;
  reconnectCeilingMs?: number;
};

/** The socket this session dialled before it knew the server's version. `dial`
 * is the diagnostics record for it, when this build collects them. */
export type Probe = { socket: WebSocket; welcome: Frame; release: () => void; dial?: TransportDial };

export class RelaySession {
  private readonly budget: AuthBudget;
  /** This connection lifecycle's dial attempts. It is scoped to the session, not
   * to the context: a context released and re-created (a sign-out, a stopped
   * collaboration manager) is a new connection, and inheriting the dead one's
   * attempts would turn a legitimate re-open into a throttled outage. What the
   * ceiling bounds is a *loop* — a connection that keeps dialling and failing —
   * and that is exactly what one lifecycle sees. */
  private readonly attemptsAt: number[] = [];
  private socket: WebSocket | undefined;
  private welcome: SessionWelcome | undefined;
  private mode: 'open' | 'closed' = 'open';
  /** How many sockets this session has dialled, including the probe. */
  dials = 0;
  /** Rooms the server currently holds, by room id. */
  private readonly live = new Map<string, { attachment: SessionAttachment; role: string }>();
  /** Rooms this connection is responsible for re-attaching after a drop. A room
   * leaves this set on `detach`, on a refusal, and on teardown — never because
   * the socket died, which is the whole point of the set. */
  private readonly wanted = new Map<string, SessionAttachment>();
  private readonly replies: PendingReply[] = [];
  private readonly googleRenewals = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: boolean; expiresAt: number; proof: NonNullable<RoomProof['google']> }>();
  private readonly pending = new Map<string, PendingAttach>();
  /** One room's own retry, for a cause that is the room's alone — an admission
   * receipt it could not obtain. Kept apart from the connection's ladder
   * because re-dialling to cure one credential would take the socket down under
   * every sibling room. */
  private readonly roomRetries = new Map<SessionAttachment, ReturnType<typeof setTimeout>>();
  private readonly roomAttempts = new WeakMap<SessionAttachment, number>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private opening: Promise<void> | undefined;
  private attempts = 0;
  private bypassRemaining = false;
  private throttled = false;
  /** The service's protocol-family verdict (`malformed`, `unknown_action`, …)
   * that stopped this connection, when that is why it stopped. Kept apart from
   * `throttled` because the two need different words: one is "this browser and
   * that service do not speak the same protocol", the other is "this context
   * dialled too often". Both stop automatic dials; only one is cured by a person
   * pressing Reconnect, and reporting the ceiling's reason for the other hid the
   * cause entirely. */
  private protocolVerdict: string | undefined;
  private lastDisconnect: string | null = null;
  private releaseDial: (() => void) | undefined;
  /** The diagnostics record of the socket this session currently owns. */
  private connectionDial: TransportDial | undefined;
  private welcomeWaiter: { resolve: (frame: Frame) => void; reject: (error: Error) => void } | undefined;
  private primaryPending: string | undefined;
  /** Whether *this socket* has already been authenticated. A connection is
   * authenticated exactly once; every room after that — including one re-attached
   * after the previous room was detached, which leaves `live` empty — is an
   * `attach` on the same identity. Getting this wrong is what would make a board
   * switch a re-admission. */
  private authenticated = false;

  constructor(private readonly options: SessionOptions) {
    this.budget = options.authBudget ?? automaticAuthBudget;
  }

  /** Narrowed through a method so the compiler does not treat the field as a
   * constant across the awaits in a dial. */
  private isClosed(): boolean { return this.mode === 'closed'; }

  connected(): boolean { return !!this.socket && !!this.welcome && this.socket.readyState === this.options.Socket.OPEN; }

  isAttached(room: string): boolean { return this.connected() && this.live.has(room); }

  /**
   * Whether any room still belongs to this connection — attached now, or
   * waiting to be re-attached after a drop. A context's socket is only worth
   * keeping while this is true, and only *teardown* may say it is not: a board
   * switch detaches and attaches a millisecond apart, so an implicit close on
   * "no live rooms" would turn every switch back into a dial.
   */
  holdsRooms(): boolean { return this.live.size > 0 || this.wanted.size > 0; }

  status() {
    return {
      connected: this.connected(),
      rooms: [...this.live.keys()],
      wanted: [...this.wanted.keys()],
      dials: this.dials,
      throttled: this.throttled,
      reconnectReason: this.lastDisconnect
    };
  }

  /**
   * Dials once, exactly as a v2 room always did — ceiling, attempt allowance,
   * dial allowance, gauge — and returns the welcomed socket without deciding
   * anything. The caller settles the mode: `begin` for a server that offered 3,
   * or its own private transport for one that did not.
   */
  async probe(options: { recovery?: boolean; trigger?: TransportTrigger } = {}): Promise<Probe> {
    if (this.mode === 'closed') throw new Error('Operation log session is closed');
    // The ceiling is the connection's own: one socket per context means one dial
    // ledger. It is consulted only for a *recovery* dial — a connection that
    // keeps dialling and failing — never for the dial that opens the context,
    // because a first dial is a page load, not a loop. The explicit Reconnect
    // gesture is the ceiling's only bypass.
    const windowMs = this.options.reconnectCeilingMs ?? 30_000;
    const at = Date.now();
    while (this.attemptsAt.length && at - this.attemptsAt[0] > windowMs) this.attemptsAt.shift();
    if (options.recovery) {
      if (this.attemptsAt.length >= (this.options.reconnectCeiling ?? 6)) {
        if (!this.bypassRemaining) {
          this.throttled = true;
          this.lastDisconnect = 'throttled';
          collaborationDiagnostic('logsync.session_ceiling');
          throw new SessionThrottled();
        }
        this.bypassRemaining = false;
      }
    }
    this.attemptsAt.push(at);
    this.attempts++;
    this.throttled = false;
    // The same two gates every relay dial passes: the context-wide attempt
    // allowance (a retry loop that dies before the socket must still be counted)
    // and the dial allowance with its token.
    await this.budget.acquireRelayAttempt();
    if (this.isClosed()) throw new Error('Operation log session is closed');
    const gate = await this.budget.acquireRelayDial();
    if (gate.paced) collaborationDiagnostic('logsync.session_dial_paced');
    if (this.isClosed()) throw new Error('Operation log session is closed');
    const socket = new this.options.Socket(this.options.url);
    this.dials++;
    // The diagnostics record is taken here, where the request is actually
    // issued: `session:attach` for the dial that opens the context's
    // connection, `session:recovery` for a redial after it fell over.
    const dial = trackTransportSocket(
      socket,
      options.trigger ?? (options.recovery ? 'session:recovery' : 'session:attach'),
      this.options.topic,
      this.options.identity
    );
    // Counted where the socket is built, exactly as the per-room path counts it:
    // one dial, one gauge, one release.
    collaborationCounters.noteSocketOpen(this.options.topic);
    let dialLed = true;
    const release = () => {
      if (!dialLed) return;
      dialLed = false;
      collaborationCounters.noteSocketClose(this.options.topic);
    };
    const welcome = new Promise<Frame>((resolve, reject) => { this.welcomeWaiter = { resolve, reject }; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Frame>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation log connection timed out')), this.options.connectTimeoutMs ?? LOG_CONNECT_TIMEOUT_MS);
    });
    // The probe reads only the welcome; every other frame is the transport's
    // once the mode is known, and a v2 server sends nothing else before
    // `authenticate`. A socket that dies before welcoming fails the probe *now*
    // rather than at its deadline: an outage has to be visible to the backoff
    // that owns it, not to a ten-second timeout.
    socket.onmessage = event => {
      const message = parseStrictJson(String(event.data), 256 * 1024) as Frame | null;
      if (message?.type === 'welcome') { this.welcomeWaiter?.resolve(message); this.welcomeWaiter = undefined; }
    };
    socket.onerror = () => {
      this.welcomeWaiter?.reject(new Error('Operation log WebSocket failed'));
      this.welcomeWaiter = undefined;
    };
    socket.onclose = (event?: CloseEvent) => {
      dial?.closed(event);
      this.welcomeWaiter?.reject(new Error('Operation log connection closed before it welcomed'));
      this.welcomeWaiter = undefined;
    };
    try {
      const frame = await Promise.race([welcome, deadline]);
      clearTimeout(timer);
      return { socket, welcome: frame, release, dial };
    } catch (cause) {
      clearTimeout(timer);
      this.budget.noteRelayDialFailure();
      release();
      // The dial failed (a timeout, a refused upgrade): the client calls
      // `close()`, but the connection was ended by the network, and the ledger
      // must not report that as a deliberate client close.
      dial?.closed(undefined, { by: 'network' });
      socket.close();
      this.welcomeWaiter = undefined;
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
  }

  /** Takes the probe over as this context's connection. The dial's spend is
   * inherited, never repeated. */
  begin(probe: Probe): void {
    const versions = Array.isArray(probe.welcome.supportedVersions)
      ? probe.welcome.supportedVersions.filter((value): value is number => typeof value === 'number') : [];
    if (!versions.includes(3)) throw new Error('The relay did not offer protocol 3');
    // A socket can enter CLOSING before its close event runs. A new attachment
    // can start a dial in that interval, so retire the old socket and its
    // authentication state before adopting the new welcome.
    if (this.socket) this.dropSocket('replaced', { reconnect: false });
    this.authenticated = false;
    this.primaryPending = undefined;
    this.install(probe.socket, probe.dial);
    this.socket = probe.socket;
    this.welcome = this.readWelcome(probe.welcome);
    this.connectionDial = probe.dial;
    this.releaseDial = probe.release;
    this.lastDisconnect = null;
    this.startHeartbeat();
  }

  /**
   * Attaches one room, dialing first when there is no live socket. Resolves
   * once the server answered `authenticated`/`attached`; rejects with
   * `AttachRefused` when the room was declined (every other room keeps serving)
   * and with `SessionThrottled` when the context may not dial again.
   */
  async attach(attachment: SessionAttachment): Promise<{ room: string; role: string }> {
    if (this.mode === 'closed') throw new Error('Operation log session is closed');
    // The ceiling is the connection's, so a room attaching to a connection that
    // has stopped is refused with the connection's verdict — not retried into
    // another dial. Only an explicit Reconnect clears either stop.
    if (this.protocolVerdict !== undefined) throw new AttachRefused(this.protocolVerdict);
    if (this.throttled) throw new SessionThrottled();
    // The room joins the wanted set *before* the dial: a dial is "attach every
    // room this connection is responsible for", and a room that is not wanted yet
    // would make the recovery of a dead context find nothing to carry.
    this.wanted.set(this.roomKey(attachment), attachment);
    let proof: RoomProof | undefined;
    // An admission ticket is tied to one welcome. If that socket disappears
    // during the HTTP/key work, discard the ticket and retry against the new
    // welcome; the session's dial budget still bounds reconnect attempts.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.protocolVerdict !== undefined) throw new AttachRefused(this.protocolVerdict);
      if (this.throttled) throw new SessionThrottled();
      await this.ensureSocket(attachment.dialCause);
      const welcome = this.requireWelcome();
      try {
        const candidate = await attachment.prove(welcome);
        if (this.protocolVerdict !== undefined) throw new AttachRefused(this.protocolVerdict);
        if (this.connected() && this.welcome === welcome) { proof = candidate; break; }
      } catch (failure) {
        if (this.protocolVerdict !== undefined) throw new AttachRefused(this.protocolVerdict);
        if (!this.connected() || this.welcome !== welcome) continue;
        this.wanted.delete(this.roomKey(attachment));
        if (failure instanceof ServiceAdmissionUnavailable && failure.terminal) throw new AttachRefused('service_auth_required');
        throw failure;
      }
    }
    if (!proof) throw new Error('Operation log connection repeatedly changed during attachment');
    // A room already carried by this connection is the *hand-over* case: the
    // caller built a fresh handle for a board the context still holds (a heal, a
    // close-and-re-enable, a session re-created after a refusal, or a second
    // context of one profile whose account device key makes it compute the very
    // same room). The new handle becomes the room's owner — its cursor and its
    // state machine are the ones that must speak for it — and the old attachment
    // is retired without a detach, because the room itself never left the server.
    //
    // The successor must still be *announced*: a handle that never hears
    // `attached` never bootstraps, and `openSharedRoom` waits on exactly that
    // event before it resolves — so this branch returning silently left the
    // caller hanging in `starting` for as long as the context lived. `reattached`
    // is the truthful flag: the room is live on the wire, and the handle resuming
    // it bootstraps from its *own* cursor.
    const held = this.live.get(proof.room);
    this.wanted.delete(this.roomKey(attachment));
    if (held) {
      this.wanted.set(proof.room, attachment);
      held.attachment = attachment;
      attachment.attached({ role: held.role, reattached: true });
      return { room: proof.room, role: held.role };
    }
    if (this.pending.has(proof.room)) throw new Error('Operation log room is already attaching');
    this.wanted.delete(this.roomKey(attachment));
    const admitted = await this.send(proof, attachment);
    this.wanted.set(proof.room, attachment);
    // The room is in and must now bootstrap from its own cursor. This is the
    // only place a first attachment is announced: recovery announces through
    // `attachWanted`, and double-announcing would run two bootstraps over one
    // cursor.
    attachment.attached({ role: admitted.role, reattached: false });
    return admitted;
  }

  /**
   * Detaches a room on the caller's instruction. Idempotent and never throws.
   *
   * `owner` is the attachment asking: a handle that has been replaced by a newer
   * one for the same room must not take the room away from its successor, which
   * is exactly what a late `close()` of the old handle would otherwise do.
   */
  detach(room: string, owner?: SessionAttachment): void {
    if (owner) this.forgetRoomRetry(owner);
    if (owner && this.wanted.get(room) !== owner) {
      // The room belongs to somebody else now: this close is a no-op for it.
      this.wanted.delete(this.roomKey(owner));
      return;
    }
    // A room filed under its pre-proof key is the same room; drop both.
    for (const [key, attachment] of [...this.wanted]) if (key === room || attachment.topic.endsWith(room)) {
      this.forgetRoomRetry(attachment);
      this.wanted.delete(key);
    }
    this.wanted.delete(room);
    this.clearGoogleRenewal(room);
    if (!this.live.delete(room)) return;
    if (!this.connected()) return;
    try { this.transmit({ type: 'detach', room }); } catch { /* the close path owns a dead socket */ }
  }

  /** One request, answered in the order the connection received them. */
  request(room: string, action: string, body: Frame = {}): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };
      if (!this.live.has(room) || !this.connected()) { reject(new Error('Operation log is disconnected')); return; }
      const entry: PendingReply = {
        room, action,
        resolve: frame => settle(() => resolve(frame)),
        reject: error => settle(() => reject(error)),
        timer: setTimeout(() => {
          settle(() => reject(new Error(`Operation log ${action} request timed out`)));
          this.lastDisconnect = `timeout:${action}`;
          this.breakConnection(`timeout:${action}`);
        }, this.options.requestTimeoutMs ?? LOG_REQUEST_TIMEOUT_MS)
      };
      this.replies.push(entry);
      try { this.transmit({ type: 'sync', request: { action, board: room, ...body } }); }
      catch (cause) {
        const index = this.replies.indexOf(entry);
        if (index >= 0) this.replies.splice(index, 1);
        clearTimeout(entry.timer);
        settle(() => reject(cause instanceof Error ? cause : new Error(String(cause))));
      }
    });
  }

  /**
   * The reply correlation broke (a reply with nothing outstanding, or a frame
   * for a room this connection never attached). Only rebuilding the connection
   * restores it, and every room on it is told.
   */
  breakConnection(reason: string): void {
    this.lastDisconnect = reason;
    this.dropSocket(reason, { reconnect: true });
  }

  /**
   * Reconnects now instead of waiting out the backoff. `userInitiated` is the
   * explicit Reconnect gesture: it clears the dial ceiling and re-admits rooms
   * that had been refused, because the person just changed something the ledger
   * could not see. It does not exempt the dial from the shared budget.
   */
  reconnectNow(options: { userInitiated?: boolean; redial?: boolean } = {}): boolean {
    const redial = options.redial !== false;
    if (options.userInitiated) {
      // The person pressed Reconnect: they may have renewed exactly the material
      // that was refused, so both the ceiling and its ledger start again. A
      // protocol verdict is cleared by the same gesture — pressing it is how a
      // person says "I updated something the ledger cannot see" — and unlike the
      // ceiling it may genuinely be worth another try, because the thing that
      // changed can be the extension or the service.
      this.throttled = false;
      this.protocolVerdict = undefined;
      this.attempts = 0;
      this.attemptsAt.length = 0;
      this.bypassRemaining = false;
      clearTimeout(this.retry); this.retry = undefined;
    }
    if (this.connected() && !options.userInitiated) return false;
    if (this.throttled && !options.userInitiated) return false;
    if (redial) void this.recover();
    return true;
  }

  /** A room reached `synced`: the connection proved itself, so the recovery
   * ladder's history — and the ceiling built from it — start again from
   * nothing. A connection that authenticates and dies before any room syncs
   * never earns this, which is what keeps a connect-to-die loop climbing. */
  healthy(): void {
    // Only the *backoff exponent* is forgiven by a connection that syncs. The
    // ceiling's ledger is not: a socket that syncs and then dies, six times in a
    // window, is exactly the connect-to-die loop the ceiling exists to stop, and
    // resetting it here would turn the ceiling back into a schedule.
    this.attempts = 0;
    this.lastDisconnect = null;
  }

  /** The context's teardown.
   *
   * Every room this connection carried is told, with `shutdown` as its own
   * cause. Without that the handles kept reporting `synced` on a socket the
   * registry had already deleted — the account channel was the visible case: a
   * stopped collaboration manager released the session, and the channel went on
   * claiming `connected` with nothing behind it, so it never rejoined and a
   * reopened board ended up on a socket of its own. A room whose connection is
   * gone is `failed`, and a failed handle is exactly what `start()` rebuilds. */
  close(): void {
    if (this.mode === 'closed') return;
    this.mode = 'closed';
    clearTimeout(this.retry); this.retry = undefined;
    const carried = [...this.wanted.values()];
    this.wanted.clear();
    this.dropSocket('shutdown', { reconnect: false });
    for (const attachment of carried) attachment.failed('shutdown');
  }

  // --- the dial -------------------------------------------------------------

  private async ensureSocket(trigger?: TransportTrigger): Promise<void> {
    if (this.mode === 'closed') throw new Error('Operation log session is closed');
    if (this.connected()) return;
    if (this.opening) return await this.opening;
    this.opening = this.dial(trigger).finally(() => { this.opening = undefined; });
    return await this.opening;
  }

  /** A dial after the mode is known: the ceiling and both budget gates, then the
   * handshake, then every wanted room goes back in. */
  private async dial(trigger?: TransportTrigger): Promise<void> {
    // No path into a dial bypasses the connection's protocol verdict: re-asking
    // a relay that answered `malformed` buys the identical verdict and spends a
    // shared-budget upgrade to get it.
    if (this.protocolVerdict !== undefined) throw new AttachRefused(this.protocolVerdict);
    // Everything local is settled before the network is asked for anything: a
    // room whose authorization has expired must not spend this context's dial
    // attempt — the recovery ladder it belongs to is backoff, not the ceiling.
    const unprepared: { attachment: SessionAttachment; cause: string }[] = [];
    for (const [, attachment] of [...this.wanted]) {
      if (!attachment.prepare) continue;
      try { await attachment.prepare(); }
      catch (failure) {
        // The cause belongs to that room and is reported as such. The room stays
        // wanted: an expired manifest is cured by renewing it, and the room that
        // gave up on ever attaching would never come back. Nothing was dialled
        // *for it*, so the ladder — not the ceiling — owns its retry.
        const cause = failure instanceof Error ? failure.message : String(failure);
        unprepared.push({ attachment, cause });
        attachment.lost('prepare:failed', 0, cause);
      }
    }
    // A room whose admission cannot be resolved is skipped for this dial, not
    // obeyed. It used to abort the whole dial, which meant one room holding an
    // expired manifest stopped *every other room on the connection* from
    // re-attaching — and an account room and a board room routinely have
    // different manifests with different expiries, so the healthy one was held
    // hostage by the stale one. Skipping costs the stale room nothing: it stays
    // `wanted` (so the next dial carries it), the `lost()` above already
    // reported its own cause, and the ladder gives it another attempt.
    const skipped = new Set(unprepared.map(entry => entry.attachment));
    const prepared = [...this.wanted.values()].some(attachment => !skipped.has(attachment));
    if (!prepared) {
      // Nothing at all could be prepared: no socket is worth spending, and the
      // ladder owns the retry for every room that is waiting.
      this.scheduleRecovery(unprepared[0]?.cause);
      return;
    }
    const probe = await this.probe({ recovery: true, trigger });
    const versions = Array.isArray(probe.welcome.supportedVersions)
      ? probe.welcome.supportedVersions.filter((value): value is number => typeof value === 'number') : [];
    if (!versions.includes(3)) {
      probe.release();
      probe.socket.close();
      // The same stop as a protocol refusal, with the same reporting: the
      // service does not speak this context's protocol, so no further dial can
      // change the answer. Recorded as the verdict so a later `attach` says
      // `version_unsupported` instead of the ceiling's reason.
      this.throttled = true;
      this.protocolVerdict = 'version_unsupported';
      this.dropSocket('version_unsupported', { reconnect: false });
      throw new Error('The relay does not offer protocol 3');
    }
    this.begin(probe);
    await this.attachWanted(skipped);
  }

  /**
   * Re-puts every room this connection is responsible for. Each room proves
   * against the current welcome and, once attached, bootstraps from its own
   * cursor — which is what "reconnect re-attaches exactly the rooms that were
   * attached, each from its own cursor" means in code.
   *
   * A room's failure is that room's own: a terminal refusal stops it for good
   * (with its code as the cause), a service-admission receipt this room could
   * not obtain is retried on the room's own ladder, and any other retryable
   * one — an expired manifest, a key read that threw — keeps it wanted and asks
   * the connection for another attempt. Only the last needs a fresh welcome;
   * the others never touch the socket or the siblings.
   */
  private async attachWanted(skipped: ReadonlySet<SessionAttachment> = new Set()): Promise<void> {
    let retryable = false, cause: string | undefined;
    for (const [key, attachment] of [...this.wanted]) {
      // A room whose local admission could not be resolved this dial was already
      // reported by `dial`; proving it now would fail the same way and, worse,
      // would put every healthy room through a reconnect for one stale manifest.
      if (skipped.has(attachment)) continue;
      // A `pending:` entry belongs to an `attach()` that is still running (it
      // filed the room before dialling so this dial would know to carry it); that
      // call sends and announces its own room, and sending it twice here would
      // put two attaches in flight for one room.
      if (key.startsWith('pending:')) continue;
      // This room is already waiting out its own retry; its timer re-enters here.
      if (this.roomRetries.has(attachment)) continue;
      try {
        // A room the primary `authenticate` already put in (the first one of a
        // fresh dial) is live but has not been told to bootstrap; every other
        // room still has to be attached. Both end in `attached(...)`, because
        // being in the server's map is not the same as resuming from a cursor.
        if (!this.live.has(key)) {
          const proof = await attachment.prove(this.requireWelcome());
          await this.send(proof, attachment);
        }
        attachment.attached({ role: this.live.get(key)?.role ?? 'viewer', reattached: true });
      } catch (failure) {
        collaborationDiagnostic('logsync.attach_failed');
        const code = failure instanceof AttachRefused ? failure.code : undefined;
        const message = failure instanceof Error ? failure.message : String(failure);
        if (code !== undefined && (terminalRefusal(code) || code === 'room_limit')) {
          this.wanted.delete(key);
          this.forgetRoomRetry(attachment);
          attachment.failed(code);
          continue;
        }
        // The transport itself is healthy; what this room lacks is one
        // credential. Re-dialling cannot mint it faster than the room's own
        // backoff, and it *would* cost every sibling its socket — so the room
        // waits on its own ladder and the connection stays up.
        if (failure instanceof ServiceAdmissionUnavailable) {
          if (failure.terminal) {
            this.wanted.delete(key);
            this.forgetRoomRetry(attachment);
            attachment.failed('service_auth_required');
            continue;
          }
          this.scheduleRoomRetry(attachment, key, failure.message);
          continue;
        }
        retryable = true;
        cause ??= message;
        attachment.lost(`attach:${code ?? 'failed'}`, 0, message);
      }
    }
    if (retryable) {
      // A room that could not prove itself against this socket's welcome has to
      // be re-dialled, not re-presented: its proof is bound to a challenge whose
      // authorization material (the manifest) is exactly what went stale. A
      // fresh dial re-reads that material and lands a new welcome, which is the
      // recovery the deployed v2 path performed by construction. The room stays
      // `wanted`, so the dial that follows carries it again.
      this.lastDisconnect = `attach:${cause ?? 'failed'}`;
      this.breakConnection(this.lastDisconnect);
    }
  }

  /**
   * One room waits out its own backoff, then tries its own proof again on the
   * socket that is still up. The ladder is the shared policy's (1 s doubling,
   * jittered, 30 s ceiling), and it is scoped to the *attachment*: a room that
   * gives up and is re-opened starts from the base again, and a sibling's
   * failure never advances it.
   *
   * Nothing here can storm the identity service: each attempt is one
   * `admitService` call, which is serialised and budget-gated, and the wait
   * between attempts is the same exponential one the connection uses.
   */
  private scheduleRoomRetry(attachment: SessionAttachment, room: string, reason: string): void {
    if (this.mode === 'closed' || this.roomRetries.has(attachment)) return;
    const attempt = this.roomAttempts.get(attachment) ?? 0;
    this.roomAttempts.set(attachment, attempt + 1);
    const delay = Math.round(reconnectDelay(this.options.reconnectBaseMs ?? 1_000, attempt));
    collaborationDiagnostic('logsync.attach_ticket_retry');
    // The room's own stated cause, and the wait that follows it — the sidebar
    // shows `admission:refused`-vocabulary text, never a silent `offline`.
    attachment.lost('attach:service_admission', delay, reason);
    this.roomRetries.set(attachment, setTimeout(() => {
      this.roomRetries.delete(attachment);
      if (this.mode === 'closed' || !this.wanted.has(room) || !this.connected()) return;
      void this.retryRoom(attachment, room);
    }, delay));
  }

  /**
   * One room's own re-attempt, on a socket that stayed up: prove it again and
   * send it, or hand the failure back to its ladder. Deliberately *not*
   * `attachWanted`, which re-announces every wanted room and would run a second
   * bootstrap over a sibling that is already live.
   */
  private async retryRoom(attachment: SessionAttachment, key: string): Promise<void> {
    if (this.live.has(key)) return;
    try {
      const proof = await attachment.prove(this.requireWelcome());
      // The socket can die between the proof and the frame; `send` reports that
      // as a transport failure and the connection's own recovery takes over.
      if (!this.connected()) return;
      // Another attach for this room is already in flight (a caller re-opened it
      // while this timer was pending): that one owns the room, and this retry
      // leaves the wanted entry exactly as it found it rather than orphaning it.
      if (this.pending.has(proof.room)) return;
      this.wanted.delete(key);
      try {
        await this.send(proof, attachment);
      } catch (failure) {
        // The room stays wanted: the connection's ladder carries it again.
        this.wanted.set(key, attachment);
        throw failure;
      }
      this.wanted.set(proof.room, attachment);
      attachment.attached({ role: this.live.get(proof.room)?.role ?? 'viewer', reattached: true });
    } catch (failure) {
      if (this.mode === 'closed') return;
      const code = failure instanceof AttachRefused ? failure.code : undefined;
      const message = failure instanceof Error ? failure.message : String(failure);
      if (code !== undefined && (terminalRefusal(code) || code === 'room_limit')) {
        this.wanted.delete(key);
        this.forgetRoomRetry(attachment);
        attachment.failed(code);
        return;
      }
      // Still no receipt: the room waits its own backoff again, and the socket
      // and its siblings are untouched either way.
      if (failure instanceof ServiceAdmissionUnavailable && !failure.terminal) {
        this.scheduleRoomRetry(attachment, key, failure.message);
        return;
      }
      if (failure instanceof ServiceAdmissionUnavailable) {
        this.wanted.delete(key);
        this.forgetRoomRetry(attachment);
        attachment.failed('service_auth_required');
        return;
      }
      this.wanted.delete(key);
      this.forgetRoomRetry(attachment);
      attachment.lost(`attach:${code ?? 'failed'}`, 0, message);
    }
  }

  /** The room is no longer this connection's problem: drop its pending retry so
   * a detached room cannot re-attach itself behind the caller's back. */
  private forgetRoomRetry(attachment: SessionAttachment): void {
    const timer = this.roomRetries.get(attachment);
    if (timer !== undefined) { clearTimeout(timer); this.roomRetries.delete(attachment); }
  }

  /** The map key a fresh attachment is filed under before it has proved its room
   * id: the topic is unique per room, and `attachWanted` re-keys on the proof. */
  private roomKey(attachment: SessionAttachment): string { return `pending:${attachment.topic}`; }

  private requireWelcome(): SessionWelcome {
    if (!this.welcome) throw new Error('Operation log session has no welcome');
    return this.welcome;
  }

  /** The retry ladder for a connection that died under its rooms. */
  private scheduleRecovery(cause?: string, ended?: TransportDial): void {
    if (this.mode === 'closed' || this.retry) return;
    const delay = Math.round(reconnectDelay(this.options.reconnectBaseMs ?? 1_000, this.attempts++));
    collaborationDiagnostic('logsync.reconnect_scheduled');
    collaborationCounters.countEvent('logsync.reconnect');
    // Attached to the connection that just ended, not to the one that will
    // dial next: the question this answers is "was this one replaced, and how
    // soon", which is only meaningful on the record being replaced.
    ended?.reconnected(delay);
    for (const attachment of this.wanted.values()) attachment.lost(this.lastDisconnect ?? 'closed', delay, cause);
    this.retry = setTimeout(() => { this.retry = undefined; void this.recover(); }, delay);
  }

  private async recover(): Promise<void> {
    if (this.mode === 'closed' || this.wanted.size === 0) return;
    try {
      if (!this.connected()) { await this.ensureSocket(); return; }
      // The socket is up; what is missing is a room that never made it back in.
      await this.attachWanted();
    } catch (failure) {
      if (failure instanceof AttachRefused) {
        // The connection carries a protocol verdict, so `dial` refused to ask the
        // relay again. Reporting the service's own code and stopping is the whole
        // point: the ladder would otherwise wake forever to produce the identical
        // verdict, and every room's status would end up reading as a reconnect.
        for (const [room, attachment] of [...this.wanted]) {
          this.wanted.delete(room);
          attachment.failed(failure.code);
        }
        return;
      }
      if (failure instanceof SessionThrottled) {
        // The ceiling engaged: nothing automatic may try again. Every room this
        // connection was carrying is stopped with that verdict — the ceiling is
        // the context's, so it is reported to all of them — and only an explicit
        // Reconnect (the person changed something the ledger cannot see) resumes
        // it.
        for (const [room, attachment] of [...this.wanted]) {
          this.wanted.delete(room);
          attachment.failed('reconnect:throttled');
        }
        return;
      }
      this.scheduleRecovery(failure instanceof Error ? failure.message : String(failure));
    }
  }

  private readWelcome(welcome: Frame): SessionWelcome {
    const challenge = aString(welcome.challenge), session = aString(welcome.session);
    if (!challenge || !session) throw new Error('Invalid operation log welcome');
    return {
      challenge, session,
      requiresServiceAdmission: welcome.requiresServiceAdmission === true,
      versions: Array.isArray(welcome.supportedVersions) ? welcome.supportedVersions.filter((value): value is number => typeof value === 'number') : []
    };
  }

  // --- the wire -------------------------------------------------------------

  private install(socket: WebSocket, dial?: TransportDial): void {
    socket.onmessage = event => { if (this.socket === socket) void this.receive(String(event.data)); };
    socket.onerror = () => { if (this.socket === socket) this.lastDisconnect ??= 'network'; };
    // Recorded before the ownership guard in `onClose`: a dial that a *newer*
    // socket has already replaced still ended, and the diagnostics ledger
    // counts connections, not the session's current one.
    socket.onclose = (event?: CloseEvent) => { dial?.closed(event); this.onClose(socket); };
  }

  private transmit(frame: Frame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.options.Socket.OPEN) throw new Error('Operation log is disconnected');
    socket.send(JSON.stringify(frame));
  }

  private async receive(raw: string): Promise<void> {
    if (this.mode === 'closed' || !this.connected()) return;
    const message = parseStrictJson(raw, 256 * 1024) as Frame | null;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'welcome':
        // A second welcome on a live socket is a protocol violation; ignoring it
        // keeps the connection serving rather than punishing every room for it.
        break;
      case 'authenticated': {
        if (aNumber(message.version) !== 3 || aString(message.session) !== this.welcome?.session) { this.breakConnection('correlation'); break; }
        const room = this.primaryPending;
        this.primaryPending = undefined;
        const pending = room ? this.takePending(room) : undefined;
        if (!pending) { this.breakConnection('correlation'); break; }
        this.settleAttach(pending, aString(message.role));
        break;
      }
      case 'attached': {
        const room = aString(message.room);
        const pending = room ? this.takePending(room) : undefined;
        // An answer to a detach race has nothing to resolve; the room is gone.
        if (pending) this.settleAttach(pending, aString(message.role));
        break;
      }
      case 'refused': {
        const room = aString(message.room);
        const code = aString(message.code) ?? 'refused';
        if (room && this.googleRenewals.get(room)?.pending) {
          this.failGoogleRenewal(room, code);
          break;
        }
        collaborationDiagnostic('logsync.session_refused');
        const pending = room ? this.takePending(room) : undefined;
        if (pending) {
          // Scoped to that room: the socket keeps serving, and the room says why.
          this.wanted.delete(pending.proof.room);
          clearTimeout(pending.timer);
          pending.reject(new AttachRefused(code));
          pending.attachment.failed(code);
          break;
        }
        if (room) break; // not an answer this connection has outstanding
        // No room named: the connection itself was declined.
        const failure = new AttachRefused(code);
        for (const entry of [...this.pending.values()]) { clearTimeout(entry.timer); entry.reject(failure); entry.attachment.failed(code); }
        this.pending.clear();
        this.lastDisconnect = `refused:${code}`;
        for (const attachment of this.wanted.values()) attachment.failed(code);
        this.wanted.clear();
        this.dropSocket(`refused:${code}`, { reconnect: false, by: 'server' });
        break;
      }
      case 'detached': {
        const room = aString(message.room);
        if (!room) break;
        const code = aString(message.code);
        // The protocol sends a *coded* `detached` only on the server's own
        // initiative; a code-less one is the answer to our `detach` (or a
        // `not_attached` no-op). Testing the code and not a local "we asked"
        // set is what makes a server-initiated detach impossible to swallow:
        // that set could go stale across a re-attach of the same room and turn
        // a revocation into silence.
        // The room is addressed by id and the server can speak about it at any
        // point in its lifecycle, so the state is looked up in *both* maps. A
        // room whose `attach` is still in flight is in `pending` only — the
        // server can detach a room it has just admitted before this client has
        // processed the `attached` that admitted it — and a room the server
        // detached while the connection was busy is in `wanted` only. Reading
        // `live` alone was the bug: the frame named a room that was in neither
        // the pending map nor (yet) `live`, the handler had no state to route
        // to, and the room went on reporting `synced` with its cursor frozen.
        const state = this.live.get(room);
        this.clearGoogleRenewal(room);
        this.live.delete(room);
        // A room is filed under its proof's key once it is live, but under
        // `pending:<topic>` before that (see `roomKey`); the detach has to clear
        // whichever of the two this connection actually holds, or the recovery
        // set would keep dialling for a room the server has already dropped.
        const wantedKeys = [...this.wanted]
          .filter(([key, attachment]) => key === room || attachment.topic.endsWith(room))
          .map(([key]) => key);
        if (!state) {
          // Nothing live: either our own detach echoed back (already removed
          // from `live` by `detach`), a `not_attached` no-op, or a room whose
          // attach never landed. Only the last one owes the room a cause, and
          // it is the one the `pending` map still holds.
          const pending = this.takePending(room);
          if (!pending) break;
          clearTimeout(pending.timer);
          if (!code || code === 'not_attached') {
            // Our own detach echoed, or a no-op for a room the server never
            // held: the attach that was in flight is answered, not failed.
            pending.reject(new AttachRefused(code ?? 'detached'));
            break;
          }
          this.live.delete(pending.proof.room);
          for (const key of wantedKeys) this.wanted.delete(key);
          pending.reject(new AttachRefused(code));
          pending.attachment.failed(code);
          break;
        }
        if (!code) break; // our own detach, echoed
        // Routed to the room it names and nobody else: the socket, the other
        // rooms and their cursors are untouched, which is the whole point of the
        // v3 frame. The cause is stated in the room's own vocabulary.
        //
        // Deliberately *not* written to `lastDisconnect`: that field is the
        // connection's report, and one room losing its grant is not the tunnel
        // falling over. Writing it made the next unrelated room's reconnect
        // message claim this room's cause, which is a per-room event leaking
        // into every sibling's state.
        collaborationDiagnostic('logsync.room_detached');
        if (code === 'not_attached') break;
        for (const key of wantedKeys) this.wanted.delete(key);
        state.attachment.failed(code);
        break;
      }
      case 'accountHint': {
        for (const state of this.live.values()) state.attachment.accountHint?.(message);
        break;
      }
      case 'renewedGoogle': {
        const room = aString(message.room);
        const renewal = room ? this.googleRenewals.get(room) : undefined;
        const state = room ? this.live.get(room) : undefined;
        const role = aString(message.role);
        if (!room || !renewal?.pending || !state || (role !== 'editor' && role !== 'viewer')) {
          this.breakConnection('correlation');
          break;
        }
        state.role = role;
        state.attachment.roleChanged?.(role);
        this.scheduleGoogleRenewal(room, renewal.proof, renewal.expiresAt);
        break;
      }
      case 'sync': {
        const board = aString(message.board);
        if (message.action === 'operation') {
          const state = board ? this.live.get(board) : undefined;
          if (!state) { this.breakConnection('correlation'); break; }
          state.attachment.deliver(message);
          break;
        }
        const entry = this.replies.shift();
        if (!entry) { this.breakConnection('correlation'); break; }
        clearTimeout(entry.timer);
        // Replies carry no request id, so the head of the queue is the only
        // request a reply can belong to — and a reply naming another room means
        // that correlation is broken, exactly as a stray reply would.
        if (board !== entry.room) { entry.reject(new Error('Unexpected operation log reply')); this.breakConnection('correlation'); break; }
        const code = aString(message.code);
        if (message.action === 'error' && code) entry.reject(new Error(code));
        else entry.resolve(message);
        break;
      }
      case 'error': {
        // A connection-level refusal: the server answers `authenticate` with
        // `error` (v2's frame, unchanged) and closes. It is terminal for every
        // room this connection was opening — the grant being presented is what
        // was refused, so no retry can fix it.
        const code = aString(message.code) ?? 'server_error';
        collaborationDiagnostic('logsync.session_refused');
        this.lastDisconnect = `refused:${code}`;
        // A protocol-family verdict is about *this build's frames*, not about the
        // network: every further dial this context makes will be answered the same
        // way, and each one costs a shared-budget request. So the connection stops
        // as `version_unsupported` already does — `attach` refuses to dial and only
        // an explicit Reconnect may try again — and it stops *as that verdict*:
        // `attach` reports the service's own code rather than the ceiling's, which
        // is what previously let `reconnect:throttled` replace the real cause in the
        // sidebar after a few re-opened boards had spent the dial allowance.
        const protocol = protocolRefusal(code);
        this.throttled = protocol;
        if (protocol) this.protocolVerdict = code;
        const failure = new AttachRefused(code);
        for (const entry of [...this.pending.values()]) { clearTimeout(entry.timer); entry.reject(failure); entry.attachment.failed(code); }
        this.pending.clear();
        for (const attachment of this.wanted.values()) attachment.failed(code);
        this.wanted.clear();
        this.dropSocket(`refused:${code}`, { reconnect: false, by: 'server' });
        break;
      }
      case 'server_shutdown':
        this.lastDisconnect = 'shutdown';
        for (const attachment of this.wanted.values()) attachment.failed('shutdown');
        this.wanted.clear();
        this.dropSocket('shutdown', { reconnect: false, by: 'server' });
        break;
      default: break; // roster/signaling frames belong to another transport
    }
  }

  private settleAttach(pending: PendingAttach, role: string | undefined): void {
    this.authenticated = true;
    const resolved = role ?? 'viewer';
    // The room's own admission succeeded, so its private ladder starts over: a
    // room that recovers and later loses its ticket again waits the base delay,
    // not the ceiling it earned while it was failing.
    this.roomAttempts.delete(pending.attachment);
    this.live.set(pending.proof.room, { attachment: pending.attachment, role: resolved });
    if (pending.proof.google) this.scheduleGoogleRenewal(pending.proof.room, pending.proof.google, pending.proof.google.expiresAt);
    clearTimeout(pending.timer);
    pending.resolve({ room: pending.proof.room, role: resolved });
  }

  private clearGoogleRenewal(room: string): void {
    const state = this.googleRenewals.get(room);
    if (state) clearTimeout(state.timer);
    this.googleRenewals.delete(room);
  }

  private failGoogleRenewal(room: string, code: string): void {
    const state = this.live.get(room);
    this.clearGoogleRenewal(room);
    if (!state) return;
    this.detach(room, state.attachment);
    state.attachment.failed(code);
  }

  private scheduleGoogleRenewal(room: string, proof: NonNullable<RoomProof['google']>, expiresAt: number): void {
    this.clearGoogleRenewal(room);
    const remaining = expiresAt * 1000 - Date.now();
    if (!Number.isSafeInteger(expiresAt) || remaining <= 0) { this.failGoogleRenewal(room, 'grant_expired'); return; }
    const timer = setTimeout(() => { void this.renewGoogle(room); }, Math.max(0, remaining - Math.min(30_000, remaining / 2)));
    this.googleRenewals.set(room, { timer, pending: false, expiresAt, proof });
  }

  private async renewGoogle(room: string): Promise<void> {
    const state = this.googleRenewals.get(room);
    if (!state || !this.live.has(room) || !this.connected()) return;
    state.pending = true;
    // Bound both the HTTP request and the server reply by the existing grant.
    const timeout = Math.min(this.options.requestTimeoutMs ?? LOG_REQUEST_TIMEOUT_MS, Math.max(0, state.expiresAt * 1000 - Date.now()));
    state.timer = setTimeout(() => this.failGoogleRenewal(room, 'service_auth_required'), timeout);
    try {
      const next = await state.proof.renew(this.requireWelcome());
      if (this.googleRenewals.get(room) !== state) return;
      if (next.room !== room || !/^[A-Za-z0-9_-]{43}$/.test(next.ticket) || !Number.isSafeInteger(next.expiresAt) || next.expiresAt * 1000 <= Date.now()) {
        throw new Error('Invalid Google renewal');
      }
      state.expiresAt = next.expiresAt;
      this.transmit({ type: 'renewGoogle', room, serviceAdmission: next.ticket });
    } catch {
      if (this.googleRenewals.get(room) === state) this.failGoogleRenewal(room, 'service_auth_required');
    }
  }

  private send(proof: RoomProof, attachment: SessionAttachment): Promise<{ room: string; role: string }> {
    // The first room of a connection is its `authenticate`; every further room
    // is an `attach` on the same authenticated socket, with its own proof.
    const first = !this.authenticated && !this.primaryPending;
    if (first) this.primaryPending = proof.room;
    return new Promise<{ room: string; role: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(proof.room);
        reject(new Error('Operation log attach timed out'));
        this.breakConnection('timeout:attach');
      }, this.options.connectTimeoutMs ?? LOG_CONNECT_TIMEOUT_MS);
      this.pending.set(proof.room, { attachment, proof, timer, resolve, reject });
      try {
        const envelope = proof.serviceAdmission ? { serviceAdmission: proof.serviceAdmission } : {};
        if (first) {
          this.transmit({ type: 'authenticate', version: 3, room: proof.room, deviceKeyId: proof.deviceKeyId,
            signature: proof.signature, authorization: proof.authorization, ...envelope });
        } else {
          // `deviceKeyId` names *the device that signed this room's proof*. A
          // client enrols a separate device per board (`board-device:<board>`),
          // so an attach carrying only a room id leaves the server with nothing
          // to verify the proof against except the connection's own device — and
          // then a second board can never join the socket. Sending it is what
          // the v3 `attach` frame needs to accept one device per room; a server
          // that does not know the field ignores it (unknown fields on `attach`
          // are tolerated by design) and refuses exactly as it does today.
          this.transmit({ type: 'attach', room: proof.room, deviceKeyId: proof.deviceKeyId,
            signature: proof.signature, authorization: proof.authorization, ...envelope });
        }
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(proof.room);
        // A failed first send never authenticated anything. Leaving this set
        // makes the next room send `attach` as the first frame on the socket.
        if (first && this.primaryPending === proof.room) this.primaryPending = undefined;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  private takePending(room: string): PendingAttach | undefined {
    const entry = this.pending.get(room);
    if (entry) this.pending.delete(room);
    return entry;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = collaborationCounters.countedInterval('logsync.heartbeat', () => {
      if (!this.connected()) return;
      collaborationCounters.countEvent('logsync.ping');
      try { this.transmit({ type: 'ping' }); } catch { /* the close path owns this */ }
    }, LOG_HEARTBEAT_MS);
  }

  private failAll(cause: Error): void {
    for (const entry of this.replies.splice(0)) { clearTimeout(entry.timer); entry.reject(cause); }
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(cause); }
    this.pending.clear();
    this.welcomeWaiter?.reject(cause);
    this.welcomeWaiter = undefined;
  }

  /** Drops the current socket. `reconnect` starts the ladder for the rooms that
   * are still wanted; teardown and terminal refusals do not. `by` names the
   * author of the close for the transport ledger when the server's own frame is
   * what moved us to close: the client called `close()`, but the connection was
   * ended by the server, and saying so is the whole point of the record. */
  private dropSocket(reason: string, options: { reconnect: boolean; by?: 'client' | 'server' }): void {
    const socket = this.socket;
    this.socket = undefined;
    this.welcome = undefined;
    this.primaryPending = undefined;
    // A new socket is a new identity: it authenticates before it attaches.
    this.authenticated = false;
    for (const room of this.googleRenewals.keys()) this.clearGoogleRenewal(room);
    this.live.clear();
    // A room's ticket retry is bound to *this* socket's welcome: the receipt it
    // would mint is worthless on the next one. The connection's own recovery
    // re-proves every wanted room against the fresh welcome, which is strictly
    // better than letting a per-room timer fire at a proof built for a dead
    // challenge.
    for (const timer of this.roomRetries.values()) clearTimeout(timer);
    this.roomRetries.clear();
    clearTimeout(this.deadline); this.deadline = undefined;
    collaborationCounters.clearCountedTimer(this.heartbeat); this.heartbeat = undefined;
    this.failAll(new Error('Operation log connection closed'));
    this.releaseDial?.(); this.releaseDial = undefined;
    const dial = this.connectionDial;
    this.connectionDial = undefined;
    // Recorded before the close event can arrive, and only when this call is
    // *why* the socket ends: an explicit author, or a socket still open that we
    // are about to close. A socket the browser has already closed is left to
    // its own event, which knows whether the peer or the network did it.
    if (dial && (options.by !== undefined || socket?.readyState === this.options.Socket.OPEN)) {
      // The drop's own reason is this connection's cause vocabulary
      // (`refused:<code>`, `shutdown`, `timeout:<action>`, `correlation`), and
      // it is what the ledger reports when the browser has nothing better.
      dial.closed(undefined, { by: options.by ?? 'client', reason });
    }
    if (socket) {
      if (socket.readyState === this.options.Socket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'leave' })); } catch { /* already gone */ }
      }
      try { socket.close(); } catch { /* already gone */ }
    }
    this.lastDisconnect ??= reason;
    if (options.reconnect && this.mode === 'open' && this.wanted.size) this.scheduleRecovery(undefined, dial);
  }

  private onClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.lastDisconnect ??= 'closed';
    this.dropSocket(this.lastDisconnect, { reconnect: true });
  }
}

/**
 * One session per context per relay URL. The session outlives every individual
 * room, which is what makes a board switch an attach/detach instead of a dial.
 *
 * **The key is the URL alone, because one socket now holds many device keys.**
 * A client enrols a separate device per board (`board-device:<board>`), and the
 * v3 `attach` frame carries that room's own `deviceKeyId`; the service verifies
 * each attach's proof against the device it presents, so rooms under different
 * keys are admissible on one connection. Keying this map by `(url, deviceKey)`
 * would therefore reintroduce the very thing v3 exists to remove: one socket per
 * board.
 *
 * `identity` is still recorded, for diagnostics — it is the device that dialled
 * the socket — but it is not part of the key.
 */
class RelaySessions {
  private readonly sessions = new Map<string, {
    url: string;
    /** The device key of whichever room dialled this socket first. Informational:
     * the socket is not bound to it (see the class comment). */
    identity: string;
    session: RelaySession;
    decided: Promise<'multiplexed' | 'legacy'>;
    decide: (mode: 'multiplexed' | 'legacy') => void;
  }>();

  /** The session for this relay, created on first use. The caller then reserves
   * the right to probe by being the one that calls `probe()`. */
  claim(options: SessionOptions & { identity: string }): { session: RelaySession; first: boolean } {
    const existing = this.sessions.get(options.url);
    if (existing) return { session: existing.session, first: false };
    let decide: (mode: 'multiplexed' | 'legacy') => void = () => {};
    const decided = new Promise<'multiplexed' | 'legacy'>(resolve => { decide = resolve; });
    const session = new RelaySession(options);
    this.sessions.set(options.url, { url: options.url, identity: options.identity, session, decided, decide });
    return { session, first: true };
  }

  /** How the prober's attempt ended. The first answer wins: a second settle is a
   * lost race, not a mode change. */
  settle(url: string, mode: 'multiplexed' | 'legacy'): void {
    this.sessions.get(url)?.decide(mode);
  }

  mode(url: string): Promise<'multiplexed' | 'legacy'> {
    const entry = this.sessions.get(url);
    return entry ? entry.decided : Promise.resolve('legacy');
  }

  live(url: string): RelaySession | undefined { return this.sessions.get(url)?.session; }

  /** The prober never reached a version: this relay is not multiplexing. */
  relinquish(url: string): void {
    const entry = this.sessions.get(url);
    if (!entry) return;
    entry.decide('legacy');
    entry.session.close();
    this.sessions.delete(url);
  }

  /** Closes one relay's session, or every session when no relay is named. */
  release(url?: string): void {
    for (const [key, entry] of [...this.sessions]) {
      if (url !== undefined && key !== url) continue;
      entry.decide('legacy');
      entry.session.close();
      this.sessions.delete(key);
    }
  }

  snapshots() {
    return [...this.sessions.values()].map(({ url, identity, session }) => ({ url, identity, ...session.status() }));
  }
}

export const relaySessions = new RelaySessions();

/** The context's sessions, for the diagnostics console. */
export function relaySessionSnapshots() {
  return relaySessions.snapshots();
}

/** Test seam and teardown: closes the context's socket(s). */
export function releaseRelaySessions(url?: string): void {
  relaySessions.release(url);
}

export { reconnectDelay };
