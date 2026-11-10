/**
 * The reconnect and refusal policy the operation-log transport has always run
 * on, extracted so that both the per-room sender (`logSync.ts`) and the
 * context's socket owner (`logSession.ts`) consult **one** copy of it.
 *
 * Nothing here is new behaviour. The bounds are the ones the November incident
 * forced — a 1 s base doubling to a 30 s ceiling, jittered, a per-topic attempt
 * ledger that a fresh handle cannot reset, and a fixed list of refusals that no
 * retry can cure. Keeping them in one module is what makes "the socket owner
 * reused the policy" checkable instead of a claim: there is only one
 * implementation to reuse.
 */

/** The log heartbeat: keeps a proxied tunnel alive between edits. One per
 * socket, which is the point of a single owner. */
export const LOG_HEARTBEAT_MS = 15_000;
/** How long a dial may stay unauthenticated before it is abandoned. */
export const LOG_CONNECT_TIMEOUT_MS = 10_000;
/** How long a reply may take before the correlation is declared broken. */
export const LOG_REQUEST_TIMEOUT_MS = 20_000;
/** Backoff ceiling: nothing reconnects faster than this, whatever the reason. */
export const LOG_MAX_BACKOFF_MS = 30_000;

/**
 * Refusals that reconnecting with the same grant cannot fix. A retry loop over
 * one of these hides the reason from the person who has to re-share the board,
 * so the room stops and says which code it was.
 */
const TERMINAL_REFUSALS = [
  'unauthorized',
  'grant_expired',
  'authorization_changed',
  'authorization_stale',
  'service_auth_required',
  'service_binding_invalid',
  // The protocol family: the service could not interpret what this client
  // sent, or refuses the version/action it sent. Reconnecting with the same
  // frames produces the identical verdict, so these are failures of the *pair*
  // of builds in play, not of the network. Left retryable they were the worst
  // possible class to retry: a per-room refusal of this kind re-dials the whole
  // shared connection (`attachWanted` treats a non-terminal failure as a reason
  // to rebuild the socket), so every attempt cost the context a dial until the
  // reconnect ceiling engaged — and the ceiling's `reconnect:throttled` then
  // replaced the real cause in the sidebar. `malformed` is the service's strict
  // parse failing before the connection negotiated v3, `invalid_state` is a
  // frame arriving out of order for the negotiated version, `unknown_action` is
  // an action this build does not know, `invalid_frame` a frame it cannot read
  // at all, and `version_unsupported` a version it will not speak.
  'malformed',
  'invalid_state',
  'invalid_frame',
  'unknown_action',
  'version_unsupported'
] as const;

/** Refusals that say *this build and that service do not speak the same
 * protocol*. Terminal like the rest, and reported in different words, because
 * the thing that has to change is one of the two builds — not the board's
 * sharing, not the network, and not a retry. */
const PROTOCOL_REFUSALS = [
  'malformed',
  'invalid_state',
  'invalid_frame',
  'unknown_action',
  'version_unsupported'
] as const;

export const terminalRefusal = (code: string): boolean => (TERMINAL_REFUSALS as readonly string[]).includes(code);
export const protocolRefusal = (code: string): boolean => (PROTOCOL_REFUSALS as readonly string[]).includes(code);

/**
 * One room's service-admission receipt could not be obtained.
 *
 * It is a failure of **that room's proof**, not of the connection: the socket,
 * its welcome and every sibling attachment are untouched, so the transport must
 * retry this room alone instead of rebuilding the connection under the others.
 * `terminal` says whether another attempt with the same material can succeed —
 * a 403 from the identity service cannot, a disconnected Google account or a
 * rate-limited exchange can.
 */
export class ServiceAdmissionUnavailable extends Error {
  constructor(readonly cause: string, readonly terminal: boolean) { super(cause); }
}

/**
 * Exponential (base 1 s by default), jittered ±25 %, 30 s ceiling — the same
 * 1 s → 30 s policy the HTTP 429 pause uses, so no failure class can find a
 * cheaper retry than the one the shared budget already bounded.
 */
export function reconnectDelay(baseMs: number, attempts: number, random: () => number = Math.random): number {
  return Math.min(LOG_MAX_BACKOFF_MS, baseMs * 2 ** Math.min(attempts, 6)) * (0.75 + random() * 0.5);
}

/**
 * Per-board reconnect-attempt ledgers, shared by every connection this context
 * opens for that board. The ledger has to outlive one handle: the room's own
 * re-entry path (close + re-enable) creates a fresh connection, and a ceiling
 * that a re-create could reset would be a schedule again, not a ceiling.
 */
const contextAttemptTimes = new Map<string, number[]>();

/** Test seam: forgets reconnect history (one board, or every board). A real
 * context only ever resets this by restarting the browser; a test file that
 * opens many short-lived connections for one topic needs the same reset. */
export function clearReconnectLedger(topic?: string): void {
  if (topic === undefined) contextAttemptTimes.clear();
  else contextAttemptTimes.delete(topic);
}

/** One topic's attempt ledger. The ceiling reads `count`, the dial path adds
 * one `record` per attempt, and `clear` is the explicit-Reconnect gesture —
 * nothing else may reset it. */
export type ReconnectLedger = {
  /** Drops attempts older than the ceiling window. */
  prune(windowMs: number, at?: number): void;
  /** Attempts still inside the window. */
  readonly count: number;
  record(at?: number): void;
  clear(): void;
};

export function reconnectLedger(topic: string): ReconnectLedger {
  const times = contextAttemptTimes.get(topic) ?? [];
  contextAttemptTimes.set(topic, times);
  return {
    prune(windowMs, at = Date.now()) {
      while (times.length && at - times[0] > windowMs) times.shift();
    },
    get count() { return times.length; },
    record(at = Date.now()) { times.push(at); },
    clear() { times.length = 0; }
  };
}
