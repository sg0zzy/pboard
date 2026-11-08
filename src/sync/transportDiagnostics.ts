/**
 * Per-connection transport diagnostics: every relay socket this context dials,
 * what caused the dial, and who ended it.
 *
 * A browser context holds one standing WebSocket (`logSession.ts`), plus a
 * short-lived one per key-courier pass and — against a relay that predates v3 —
 * one per board. When the network panel shows a stream of `/ws` upgrades, the
 * question the panel cannot answer is *which of those* a given request was, and
 * whether they overlapped. This module keeps the last few connections as one
 * record each: a monotonic id, the trigger that dialled it, the room and device
 * it was admitted as, when it opened, and how it ended. Ids and timestamps are
 * enough to read "sequential" (entry n closed before entry n+1 opened) from
 * "concurrent" (their lifetimes overlap) in a single paste.
 *
 * Only identifiers and outcomes are stored, never tokens, payloads or keys: the
 * device key id is truncated to a prefix, and a server-supplied close reason is
 * stripped of control characters and capped. The whole point is that the
 * snapshot can go into a bug report.
 *
 * **Instrumentation only.** Nothing here may change how a connection behaves:
 * the socket is constructed by its owner exactly as before and is never
 * mutated. In a production build the entry point returns `undefined` — one
 * boolean test, no allocation, no wrapper — and every call site reads it
 * through optional chaining.
 */

/** What asked for the socket. A stable string: the console groups by it.
 *
 *  - `session:attach` — the probe dial that opens the shared (v3) connection
 *    from a room attach (`logSession.ts`).
 *  - `session:recovery` — a redial of that connection after it fell over.
 *  - `account:attach` — the account lifecycle channel's room, which is
 *    routinely the first room a board open starts and so the one whose attach
 *    dials.
 *  - `v2:room` — a private per-room connection against a relay without v3.
 *  - `courier:*` — the key courier's short-lived exchange (one socket per
 *    pass), by call site:
 *    `courier:pass` (the generic pass), `courier:attach` (a board attach),
 *    `courier:account` (the account room), `courier:device-approved` (a newly
 *    admitted device), `courier:foreign-row` (the debounced pass a row this
 *    device cannot open triggers) and `courier:repair` (the role-heal pass).
 *  - `beacon:handoff` — a key-handoff wait's beacon log, when that is what
 *    dialled.
 *  - `signaling:room` — the experimental peer-signaling socket.
 */
export type TransportTrigger =
  | 'session:attach'
  | 'session:recovery'
  | 'account:attach'
  | 'v2:room'
  | 'courier:pass'
  | 'courier:attach'
  | 'courier:account'
  | 'courier:device-approved'
  | 'courier:foreign-row'
  | 'courier:repair'
  | 'beacon:handoff'
  | 'signaling:room';

/** Who ended the connection: this client asked for it, the server did, or the
 *  transport failed without either side saying so (a proxy ageing a tunnel out,
 *  a refused upgrade — the browser reports 1006). */
export type TransportCloseCause = 'client' | 'server' | 'network';

/** One connection's whole life, as the console reports it. */
export type TransportHistoryEntry = {
  /** Unique and monotonic within this context; the order dials happened. */
  id: number;
  /** What caused the dial (`session:attach`, `courier:foreign-row`, …). */
  trigger: TransportTrigger;
  /** The room/topic the dial was attributed to, or `null` when it had none. */
  room: string | null;
  /** Prefix of the device key id that dialled; never the whole identifier and
   *  never key material. */
  device: string | null;
  /** Epoch milliseconds, taken immediately after the socket was constructed. */
  openedAt: number;
  /** Epoch milliseconds, or `null` while the socket is still open. */
  closedAt: number | null;
  /** `closedAt - openedAt`, or `null` while open. */
  lifetimeMs: number | null;
  open: boolean;
  close: { code: number; reason: string; by: TransportCloseCause } | null;
  /** Whether the connection was redialled after it ended, and after how long.
   *  Set at creation so a redial scheduled before the close event arrives (the
   *  browser delivers it on a later task) still lands on the right record. */
  reconnect: { scheduled: boolean; delayMs: number | null };
};

/** The handle a dial site keeps and hands to its close handler. */
export type TransportDial = {
  readonly id: number;
  readonly trigger: TransportTrigger;
  /** Record the socket's close. Idempotent: the first close wins.
   *
   *  `known` names a cause the caller established itself and the browser cannot
   *  report: a `refused`/`server_shutdown` frame we acted on ended the
   *  connection, though this client called `close()`, and its refusal code is a
   *  better answer than the synthetic status the browser then reports. When
   *  `known` is given it also records the close *before* the event arrives, and
   *  the event is not allowed to overwrite the reason. */
  closed(event?: { code?: number; reason?: string; wasClean?: boolean }, known?: { by?: TransportCloseCause; code?: number; reason?: string }): void;
  /** The connection that just ended is being redialled after `delayMs`. */
  reconnected(delayMs: number): void;
  /** Re-attribute the dial. A socket is tracked before its welcome says which
   *  transport it will end up in — a probe that a relay without v3 hands back as
   *  a private per-room connection is `v2:room`, not a shared `session:*` dial —
   *  and a record that keeps the first guess would attribute the request to the
   *  wrong subsystem, which is the one thing this ledger exists to prevent. */
  relabel(trigger: TransportTrigger): void;
};

/** The live counters and the bounded history, as `pboardCollaboration()` shows them. */
export type TransportSnapshot = {
  /** Whether this build collects transport diagnostics at all. */
  enabled: boolean;
  /** Connections constructed and not yet closed. */
  open: number;
  /** Total sockets constructed in this context, ever. */
  dials: number;
  /** Total closed connections. `dials - closed` equals `open` unless history
   *  has evicted an entry that was still open. */
  closed: number;
  /** Dials by their trigger. */
  byTrigger: Record<string, number>;
  /** Closes by who ended them, in total. */
  byClose: Record<TransportCloseCause, number>;
  /** Closes by reason key `"<by>:<code>"` or `"<by>:<code>:<reason>"`. */
  byCloseReason: Record<string, number>;
  /** Newest last, at most `MAX_TRANSPORT_HISTORY` entries. */
  history: TransportHistoryEntry[];
};

/** How many connections the console retains. Enough for a churn burst, small
 *  enough that the object stays pasteable. */
export const MAX_TRANSPORT_HISTORY = 32;

// Read once, exactly as `collab/counters` reads it: a production build gets a
// module whose entry point returns `undefined` and never allocates.
declare const __PBOARD_DIAGNOSTICS__: boolean;
const DIAGNOSTICS: boolean = typeof __PBOARD_DIAGNOSTICS__ === "undefined" ? false : __PBOARD_DIAGNOSTICS__;

/** The id prefix kept for a device key: enough to tell two devices apart in a
 *  paste, far too short to be any use as a credential. */
const DEVICE_PREFIX_LENGTH = 8;
/** A close reason is server text; it is truncated and stripped, never trusted. */
const REASON_LIMIT = 64;

const history: TransportHistoryEntry[] = [];
const byTrigger = new Map<string, number>();
const byCloseReason = new Map<string, number>();
const byClose: Record<TransportCloseCause, number> = { client: 0, server: 0, network: 0 };
let openCount = 0;
let dialCount = 0;
let closeCount = 0;
let nextId = 1;

/** Decrements a count, removing the key at zero so the map reads as "what
 *  actually happened" rather than accumulating stale buckets. */
function decrement(counts: Map<string, number>, key: string): void {
  const left = (counts.get(key) ?? 0) - 1;
  if (left > 0) counts.set(key, left); else counts.delete(key);
}

/** Server text, made safe to paste: control characters removed, capped. */
function sanitiseReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason) return '';
  return reason.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, REASON_LIMIT);
}

/** The close event's code, with the protocol's own "no status received" as the
 *  fallback: 1006 when the transport failed, 1005 when it ended without one. */
function closeCode(event: { code?: number } | undefined, by: TransportCloseCause): number {
  const code = event?.code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  return by === 'network' ? 1006 : 1005;
}

/**
 * Starts tracking one socket that has just been constructed. Returns
 * `undefined` in a build without diagnostics, so a dial site does
 * `const dial = trackTransportSocket(socket, trigger, topic, keyId)` and passes
 * `dial` to its close handler without branching.
 *
 * **The socket is not modified at all** — no property is added, shadowed or
 * wrapped, not even `close`. A client-initiated close cannot be told apart from
 * a server's clean one by the event (both are 1005/`wasClean: true`), so it is
 * recorded by the *call site* that asked for it instead; inferring it by
 * shadowing `close` was tried and changed behaviour, which this module must
 * never do.
 */
export function trackTransportSocket(
  socket: WebSocket,
  trigger: TransportTrigger,
  room?: string | null,
  device?: string | null
): TransportDial | undefined {
  // A production build stops here: one boolean test, no record, no wrapper, no
  // allocation beyond the arguments the caller already had. The parameters are
  // primitives rather than an options object precisely so that call sites
  // allocate nothing when this returns immediately.
  if (!DIAGNOSTICS) return undefined;
  const entry: TransportHistoryEntry = {
    id: nextId++,
    trigger,
    room: room ?? null,
    device: device ? device.slice(0, DEVICE_PREFIX_LENGTH) : null,
    openedAt: Date.now(),
    closedAt: null,
    lifetimeMs: null,
    open: true,
    close: null,
    reconnect: { scheduled: false, delayMs: null }
  };
  history.push(entry);
  while (history.length > MAX_TRANSPORT_HISTORY) history.shift();
  openCount++;
  dialCount++;
  byTrigger.set(entry.trigger, (byTrigger.get(entry.trigger) ?? 0) + 1);

  /** Whether the recorded close carried the browser's own event. Only the first
   *  record may set the author; a late event only refines code and reason. */
  let fromEvent = false;
  /** Whether the close was recorded with a cause the caller established — in
   *  which case the browser's later event is our own `close()` talking and must
   *  not overwrite it. */
  let knownCause = false;
  /** The `byCloseReason` key this entry currently accounts for. */
  let countedReasonKey = '';

  return {
    id: entry.id,
    trigger: entry.trigger,
    closed(event, known) {
      // A close whose cause is already known is recorded *before* the browser
      // delivers the event, and must be: our own `close()` would otherwise
      // attribute a server's refusal to this client. The event that then
      // arrives may only fill in what the caller could not know.
      if (entry.close) {
        // Only a close the caller knew *only* by its author benefits from the
        // event: the code and reason it carries are the server's own words. A
        // close with a stated cause is already complete, and what the browser
        // then reports is our own `close()` talking.
        if (fromEvent || !event || knownCause || entry.close.by !== 'server') return;
        fromEvent = true;
        // The placeholder counted when the author was recorded was the
        // protocol's "no status received"; it is replaced, not added to.
        decrement(byCloseReason, countedReasonKey);
        entry.close.code = closeCode(event, entry.close.by);
        entry.close.reason = sanitiseReason(event.reason);
        countedReasonKey = entry.close.reason
          ? `${entry.close.by}:${entry.close.code}:${entry.close.reason}`
          : `${entry.close.by}:${entry.close.code}`;
        byCloseReason.set(countedReasonKey, (byCloseReason.get(countedReasonKey) ?? 0) + 1);
        return;
      }
      fromEvent = Boolean(event);
      knownCause = known?.code !== undefined || known?.reason !== undefined;
      // Nothing is inferred about this client's intent from the socket itself:
      // the socket is never wrapped. A close this client performed is recorded
      // as such by the call site (`closed(undefined, { by: 'client' })`), and a
      // close the browser reports without that is the peer's or the network's.
      const by: TransportCloseCause = known?.by ?? (!event || event.code === undefined || event.code === 1006 || event.wasClean === false
        ? 'network' : 'server');
      const code = known?.code ?? closeCode(event, by);
      const reason = sanitiseReason(known?.reason ?? event?.reason);
      entry.closedAt = Date.now();
      entry.lifetimeMs = entry.closedAt - entry.openedAt;
      entry.open = false;
      entry.close = { code, reason, by };
      openCount--;
      closeCount++;
      byClose[by]++;
      countedReasonKey = reason ? `${by}:${code}:${reason}` : `${by}:${code}`;
      byCloseReason.set(countedReasonKey, (byCloseReason.get(countedReasonKey) ?? 0) + 1);
    },
    reconnected(delayMs) {
      entry.reconnect = { scheduled: true, delayMs: Math.max(0, Math.round(delayMs)) };
    },
    relabel(next) {
      if (entry.trigger === next) return;
      decrement(byTrigger, entry.trigger);
      entry.trigger = next;
      byTrigger.set(next, (byTrigger.get(next) ?? 0) + 1);
    }
  };
}

/** The counters and history as one pasteable object. Always readable, even in a
 *  build that collects nothing, so a report can say "diagnostics were off". */
export function transportSnapshot(): TransportSnapshot {
  return {
    enabled: DIAGNOSTICS,
    open: openCount,
    dials: dialCount,
    closed: closeCount,
    byTrigger: Object.fromEntries(byTrigger),
    byClose: { ...byClose },
    byCloseReason: Object.fromEntries(byCloseReason),
    history: history.map(entry => ({
      ...entry,
      close: entry.close ? { ...entry.close } : null,
      reconnect: { ...entry.reconnect }
    }))
  };
}

/** Test seam: the history and counters are module memory shared by every
 *  transport in the process. */
export function clearTransportDiagnostics(): void {
  history.length = 0;
  byTrigger.clear();
  byCloseReason.clear();
  byClose.client = 0;
  byClose.server = 0;
  byClose.network = 0;
  openCount = 0;
  dialCount = 0;
  closeCount = 0;
  nextId = 1;
}
