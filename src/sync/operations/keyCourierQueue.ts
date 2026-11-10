/**
 * One key-courier pass per relay room at a time, and one pass per quiet window.
 *
 * A courier pass is a *self-closing socket* (`keyCourierTransport.ts`): it dials,
 * authenticates, publishes this device's wrap key, reads the board's device list
 * and its own mailbox, seals for whoever joined, and closes.
 *
 * Four of the six call sites in `runtime.ts` route through here — the account
 * room (three triggers can open that channel in the same turn), a device
 * approval, the repair leg and the debounced foreign-row pass. The board-attach
 * pass and the joiner's handoff ladder deliberately keep their own socket: each
 * runs inside a board open, each must reach the relay on every attempt, and the
 * attach pass's lifetime is bound to the board's open/close cycle.
 *
 * Measured on a cold load before this module existed (a stack captured at the
 * socket constructor, attributed to the `runtime.ts` line that dialled):
 *
 * | phase                   | courier dials | by call site                               |
 * |-------------------------|---------------|--------------------------------------------|
 * | first board open        | 4             | `courier:account` ×3, `courier:attach` ×1  |
 * | each further board open | 2             | `courier:account` ×1, `courier:attach` ×1  |
 * | one reconcile round     | 1             | `courier:account` ×1                       |
 *
 * Five boards therefore cost **13** courier dials, of which **8** were the
 * account room answering the same question ("is my wrap key published, and is
 * there a grant for me?") once per trigger. Those 8 are what this module
 * removes; the 5 attach passes stay, because each board room's key is its own.
 * The account room's passes were sequential, not concurrent (max concurrent
 * sockets on that room: 1), so this is churn, not fan-out.
 *
 * Three rules replace that, and none of them changes the exchange itself:
 *
 *  - **At most one pass runs per room, and at most one waits behind it.** A
 *    request that arrives while a pass runs joins it when that pass answers its
 *    question at least as well (`covers`); otherwise it takes the single waiting
 *    slot, and every later request that the waiting slot also covers shares it.
 *    A request the waiting slot does *not* cover — a genuinely different
 *    exchange arriving in the same instant — runs after that slot drains rather
 *    than beside it, so the room still never has two sockets, and the number of
 *    answers is never more than the number of distinct questions asked.
 *
 *  - **A pass that produced a key answers another maintenance request, inside a
 *    quiet window.** All the maintenance triggers ask the same question, and the
 *    pass resolved a key, so the device is provisioned; asking again a moment
 *    later can only discover that a peer joined — and a peer's join is answered
 *    by the pass the join itself causes (a `fresh` request), never by this rule.
 *    A pass that resolved *no* key is never reused: that caller is a device
 *    waiting for a grant, and its own bounded ladder (`attempts`, backoff) is
 *    what must keep asking.
 *
 *  - **A `fresh` request never rides a pass that has begun reading.** A device
 *    that was just approved, an unreadable row, or a repair exists because
 *    something changed after the running pass listed the room; it takes the
 *    waiting slot, which starts afterwards by construction.
 *
 * Failure policy is a property of the pass and is unchanged: `runKeyCourier`
 * never rejects, and a `run` that throws anyway becomes an outcome with a stated
 * `error`, so one caller's crash can never fail another caller's board open or
 * sync round. Nothing here holds a socket, a timer or a credential; it decides
 * only *when* a pass runs.
 */
import { runKeyCourier, type KeyCourierOptions, type KeyCourierOutcome } from './keyCourierTransport';

/**
 * How long a pass that resolved a key answers another maintenance request for
 * the same room. Long enough to cover one cold load (five board opens, each a
 * Drive read plus a relay round trip, measured at well under a second) and
 * therefore to collapse the account room's per-trigger passes into one; short
 * enough that a device which joined with no signal of its own — a reader, which
 * never writes a handoff beacon — waits at most this long beyond its next
 * trigger rather than a full heartbeat.
 */
export const KEY_COURIER_QUIET_MS = 5_000;

/** The transport's own resolution of `attempts` (`keyCourierTransport.ts`): a
 * writer holding the board authority stops after one pass because it can create
 * what it cannot find; every other device keeps asking. Resolved here so two
 * requests can be compared without opening a connection. */
function passesOf(options: KeyCourierOptions): number {
  return options.isWriter && options.isAuthority ? 1 : Math.max(1, options.attempts ?? 4);
}

/**
 * Whether a pass run with `of` answers the request `wants` at least as well —
 * the one question sharing has to get right. Only the transport's own behaviour
 * is compared, never a caller's identity: two requests that compare equal here
 * ask the relay the same question and differ only in which local key store they
 * read, which the room this queue is keyed on already fixes.
 *
 *  - **Attempts:** a pass that retried four times found anything a one-attempt
 *    pass would have found; the reverse is false, so a joiner's ladder is never
 *    shortened by sharing an authority's single pass.
 *  - **Writer:** only a writer pass publishes the board key to the peers it
 *    listed, so a writer's request cannot ride a reader's pass. The reverse is
 *    fine — a reader receives a key from either.
 *  - **Authority:** only an authority pass may create the board key when no
 *    grant exists, so a request that needs creation cannot ride a pass that
 *    refuses to create. The reverse is fine.
 *  - **Sealed peers:** a pass that seals for everyone (`sealedPeers` absent) did
 *    the work of one that skips the peers it already sealed for. A pass that
 *    skipped peers cannot answer a request that wants them all.
 */
function covers(of: KeyCourierOptions, wants: KeyCourierOptions): boolean {
  return passesOf(of) >= passesOf(wants)
    && (of.isWriter || !wants.isWriter)
    && (of.isAuthority || !wants.isAuthority)
    && (of.sealedPeers === undefined || wants.sealedPeers !== undefined);
}

/** The pass running now. A pass is only ever put here by starting it, so it has
 * already begun reading the room — which is why a `fresh` request may not join
 * it. */
type Pass = { options: KeyCourierOptions; run: Promise<KeyCourierOutcome> };

/** The single waiting slot: one pass, and the promise every request that joined
 * it awaits. */
type Pending = { options: KeyCourierOptions; run: Promise<KeyCourierOutcome>; start: () => void };

type Room = {
  /** The pass running now, if any. */
  running?: Pass;
  /** The one pass queued behind it, if any. */
  pending?: Pending;
  /** The last pass that finished, for the quiet-window rule. Its `options` are
   * kept because whether its answer can be reused is the same question as
   * whether its pass answered the request: a reader must never be handed a
   * writer's outcome, whose key it never stored. */
  completed?: { at: number; options: KeyCourierOptions; outcome: KeyCourierOutcome };
  /** When a pass was last *requested*, for the debounced trigger's rate bound. */
  requestedAt?: number;
};

/** Keyed by relay URL and room topic: together they are the room's identity
 * (`prepareRelayAdmission` derives the wire room from the topic and the verified
 * manifest), and the topic is what every caller already names. */
const rooms = new Map<string, Room>();
const roomKey = (options: { url: string; topic: string }) => `${options.url}\u0000${options.topic}`;

function roomFor(options: { url: string; topic: string }): Room {
  const key = roomKey(options);
  const existing = rooms.get(key);
  if (existing) return existing;
  // Prune first, so a context that has opened a hundred boards over a long
  // session keeps only the rooms it is still using: a room is forgettable once
  // nothing runs or waits in it and its last answer is outside the window that
  // could reuse it. Dropping it costs one pass if that room is asked again.
  const stale = Date.now() - KEY_COURIER_QUIET_MS;
  for (const [otherKey, other] of rooms)
    if (!other.running && !other.pending && (other.completed?.at ?? 0) < stale) rooms.delete(otherKey);
  const room: Room = {};
  rooms.set(key, room);
  return room;
}

/** One pass, and never a rejection: the caller's failure vocabulary is the
 * outcome's `error`, exactly as `runKeyCourier` states it. */
async function runOne(options: KeyCourierOptions): Promise<KeyCourierOutcome> {
  try {
    return await runKeyCourier(options);
  } catch (cause) {
    return { source: 'none', peers: 0, published: 0, peerIds: [],
      error: cause instanceof Error ? cause.message : 'Key courier failed' };
  }
}

/** Runs one pass for `options` and starts the waiting slot when it ends. */
function runPass(room: Room, options: KeyCourierOptions): Promise<KeyCourierOutcome> {
  const started = runOne(options);
  room.running = { options, run: started };
  return started.then(outcome => {
    room.running = undefined;
    room.completed = { at: Date.now(), options, outcome };
    room.pending?.start();
    return outcome;
  });
}

/** Puts `options` in the single waiting slot and starts it when nothing runs. */
function enqueue(room: Room, options: KeyCourierOptions): Promise<KeyCourierOutcome> {
  let start: () => void = () => {};
  const run = new Promise<KeyCourierOutcome>(resolve => {
    // Promoted out of the slot the moment it starts, so a request arriving while
    // it runs sees `room.running` (and must respect the fresh rule) rather than
    // joining a pass that has already begun.
    start = () => {
      if (room.pending?.run !== run) return;
      room.pending = undefined;
      resolve(runPass(room, options));
    };
  });
  room.pending = { options, run, start };
  room.requestedAt = Date.now();
  if (!room.running) start();
  return run;
}

export type KeyCourierRequest = KeyCourierOptions & {
  /**
   * True when the answer must reflect the room *now*: a device was just
   * approved, a row this device cannot open just arrived (an admitted writer's
   * handoff beacon), or a person pressed repair. A fresh request never rides a
   * pass that has begun reading — that pass may already have listed the devices
   * or fetched the mailbox this request exists to re-read — and never reuses a
   * completed one.
   */
  fresh?: boolean;
  /** Override the quiet window. Tests set `0` to run every request; the product
   * never sets it. */
  quietMs?: number;
};

/**
 * Runs one courier pass for this room, or answers from one that already did.
 * Never rejects: a failure is the outcome's `error`, and every caller's own
 * catch treats it as "no key yet" exactly as before.
 */
export function requestKeyCourier(options: KeyCourierRequest): Promise<KeyCourierOutcome> {
  const room = roomFor(options);
  const running = room.running;
  // A running pass has already begun reading the room, so it answers a
  // maintenance request but never a fresh one: a fresh caller exists because
  // something changed after that pass started listing.
  if (running && !options.fresh && covers(running.options, options)) return running.run;
  // The waiting slot has not read anything yet, so it answers a fresh request
  // too — and every later request it covers shares it.
  const pending = room.pending;
  if (pending && covers(pending.options, options)) return pending.run;
  // A completed pass that resolved a key answers a maintenance request inside
  // the quiet window — and only a request that pass would itself have satisfied:
  // a reader must never be handed a writer's outcome (it never stored that key),
  // and a joiner must never be handed an authority's. Everything else reaches
  // the relay again, and a fresh request always does: it exists to see the room
  // as it is now.
  const completed = room.completed;
  if (!options.fresh && !running && !pending && completed
    && completed.outcome.key && covers(completed.options, options)
    && Date.now() - completed.at < (options.quietMs ?? KEY_COURIER_QUIET_MS))
    return Promise.resolve(completed.outcome);
  // A different exchange arriving this instant waits for the slot to drain and
  // then runs, rather than becoming the room's second socket. It re-decides from
  // scratch, so if the pass that just ran does answer it, it is reused rather
  // than repeated.
  if (pending) return pending.run.then(() => requestKeyCourier(options));
  return enqueue(room, options);
}

/**
 * The debounced trigger: at most one pass per room per `minGapMs`, and the
 * requests in between are *dropped*, not queued. Resolves `undefined` when this
 * call was dropped, so the caller's follow-up work (a session rebuild after a
 * rotated key) simply does not run for it.
 *
 * A burst is the normal shape of this trigger — a row this device cannot open
 * arrives once per foreign broadcast, and an admitted writer's handoff beacon
 * repeats for as long as its bounded ladder runs — so the bound has to be a
 * rate, not a queue: a queue would turn a burst into a stream of passes, and a
 * timer would leave an armed handle behind a board that has closed.
 */
export function requestKeyCourierBounded(options: KeyCourierRequest & { minGapMs: number }): Promise<KeyCourierOutcome | undefined> {
  const room = roomFor(options);
  const last = room.requestedAt;
  if (last !== undefined && Date.now() - last < options.minGapMs) return Promise.resolve(undefined);
  return requestKeyCourier({ ...options, fresh: true });
}

/** Test seam: the queue is module memory shared by every room in the process. */
export function clearKeyCourierQueue(): void {
  rooms.clear();
}

/** The queue's own state, for diagnostics and tests: whether a pass is running
 * per room, whether one waits behind it, and when the last one finished. */
export function keyCourierQueueSnapshot(): { room: string; running: boolean; queued: boolean; lastCompletedAt: number | null }[] {
  return [...rooms].map(([key, room]) => ({
    room: key.slice(key.indexOf('\u0000') + 1),
    running: room.running !== undefined,
    queued: room.pending !== undefined,
    lastCompletedAt: room.completed?.at ?? null
  }));
}
