/**
 * One automatic-auth request budget per browser context.
 *
 * The relay serves four automatic-auth endpoints — `POST /identity/challenge`,
 * `POST /identity/exchange`, `POST /grants/publish` (with its `/grants/challenge`
 * handshake) and `GET /grants/<scope>` — and the service counts them all in a
 * single process-wide window (`automatic_auth_per_second`), while the reverse
 * proxy in front of it denies an IP above **60 requests in 10 seconds** (one
 * stick-table over `src`, so every tab, every board room, the account channel
 * and every identity call share it). Two browsers of one account share that IP
 * budget, and a single churning tab used to be able to lock the *other* browser
 * out of every identity round and grant read at once. This module is the
 * client-side answer: instead of asking the operator to raise a limit, every
 * automatic-auth caller spends from one shared token bucket whose sustained
 * rate leaves room for a second browser.
 *
 * A WebSocket dial is a request the same stick table counts, and it is the one
 * that was missing: a page load with five boards plus the account channel used
 * to arrive as a burst of upgrades (measured lockout: 8 × `GET /ws` beside
 * 3 × `POST /identity/exchange` in one denial window), because `GET /ws` is an
 * upgrade and a refused upgrade surfaces as a socket failure, not as a `429`
 * response. So relay dials are admitted from this budget too, under the
 * `relay/ws` kind, and additionally from a **per-window dial allowance** — a
 * hard count, because a token bucket alone still lets a burst through.
 *
 * Policy (bounds are the contract, not tuning):
 *  - sustained **2.5 requests/second** per browser, burst **5**: two browsers
 *    in lockstep stay under the proxy's ~6/s, and a single browser is far
 *    under the service's 32/s;
 *  - at most **8 relay dials per 10 s** per browser context. Arithmetic: one
 *    relay socket costs one upgrade plus, when service admission is required,
 *    `identity/challenge` + `identity/exchange` — three requests. Two browsers
 *    on one IP may claim at most 30 of the proxy's 60 requests each; 8 dials is
 *    24 of those, leaving 6 per window for grant reads, grant publication and
 *    the single retry behind a 429. Eight is also below the burst the cold
 *    start of the user's topology asks for (five boards + the account channel,
 *    duplicated by the worker/sidebar runtimes), so the excess is paced into
 *    the next window rather than refused;
 *  - a dial waits for its slot and for the token *before* the socket is built:
 *    no token is held while a connection is in flight, and a refused upgrade
 *    (which the client cannot distinguish from a network failure) is counted
 *    once, reported, and retried only through this gate again;
 *  - a `429` pauses **every** automatic-auth caller in this context, relay
 *    dials included, for a jittered backoff (full jitter in `[0, delay]`,
 *    `delay` doubling 1s → 30s while refusals keep arriving, decaying after 60
 *    clean seconds), so nothing retries behind a 429 except the one caller
 *    whose request has its single permitted retry; the shared pause is what
 *    turns a retry storm into one retry;
 *  - `acquire()` never rejects: a caller that waits still proceeds, and the
 *    request it eventually makes is counted.
 *
 * Only counts, timestamps and kinds are kept — never bodies, tokens or URLs.
 */

export type AuthBudgetSnapshot = {
  /** Automatic-auth requests admitted by this budget since startup. */
  served: number;
  /** Requests admitted per endpoint kind (e.g. `identity/challenge`,
   * `relay/ws`). A dial is one request: the upgrade the proxy counts. */
  byKind: Record<string, number>;
  /** Callers currently waiting on the bucket, the dial allowance or the 429 pause. */
  waiting: number;
  /** Wall-clock end of the current 429 pause (0 when none is active). */
  cooldownUntil: number;
  /** Number of 429 refusals that engaged or extended the pause. */
  cooldowns: number;
  /** The current maximum of the jitter window, in ms (the bound itself). */
  cooldownDelayMs: number;
  /** Sustained admission per second and burst capacity in force. */
  ratePerSecond: number;
  capacity: number;
  /** The context-wide relay-dial allowance: how many sockets one browser
   * context may open per window, how many it has opened inside the current
   * window, and how often a dial had to wait for a slot. This is the number to
   * read when `GET /ws` is being refused: `usedInWindow === limit` means the
   * client is pacing itself, not the network. `failed` counts dials that never
   * authenticated — an upgrade the proxy refused looks exactly like a network
   * failure from inside the browser, so it is counted rather than hidden, and
   * its retry passes this gate again. */
  relayDials: { limit: number; windowMs: number; usedInWindow: number; deferred: number; failed: number };
  /** The context-wide **attempt** allowance, shared by every topic's log
   * handle. It counts dial attempts, including the ones that die before a
   * socket exists (an expired manifest, a key read that threw) and therefore
   * never reach `relayDials`; that is what makes a retry loop finite. It
   * queues rather than refuses, so a room is paced by another room's churn and
   * never silenced by it. `limit` is the same 8-per-window the dial allowance
   * admits, because the arithmetic comes from the same proxy budget. */
  relayAttempts: { limit: number; windowMs: number; usedInWindow: number; deferred: number };
};

export type AuthBudget = {
  /** Waits until this context may issue one automatic-auth request. */
  acquire(kind: string): Promise<void>;
  /**
   * Waits until this context may open one relay WebSocket, then counts it as
   * `relay/ws`. Call it immediately before constructing the socket — never
   * earlier — so no allowance is held while a connection is in flight:
   *  1. the shared 429 pause, exactly like every other automatic caller;
   *  2. a slot in the context-wide per-window dial allowance, so N boards
   *     plus the account channel cannot multiply the proxy's budget;
   *  3. one token from the same bucket the identity and grant calls spend.
   * Resolves with `paced: true` when a slot had to be waited for, so the
   * caller can name it in its own diagnostics. Never rejects, and never
   * deadlocks: the longest wait is one window (10 s), after which the oldest
   * dial has aged out and this one proceeds. A refused upgrade cannot be told
   * apart from a network failure by the browser, so it is counted once here
   * (see `noteRelayDialFailure`) and retried only by passing this gate again.
   */
  acquireRelayDial(): Promise<{ paced: boolean }>;
  /**
   * Waits for a slot in the context-wide **attempt** allowance, then books it.
   * Every log dial calls this before its own work, so N topics cannot multiply
   * a per-topic ceiling: the proxy's limit is per IP, not per room. Unlike the
   * per-topic reconnect ceiling this **queues** instead of refusing — many
   * healthy rooms opening at once is a page load and must still all open, just
   * spread out — so the longest wait is one window. Never rejects.
   */
  acquireRelayAttempt(): Promise<void>;
  /**
   * Records a dial that was admitted and never authenticated. The proxy
   * refuses an over-budget upgrade with a plain failure — no `429` reaches the
   * client — so without this the budget would show the spend and nothing about
   * the outcome. Counting it is what makes "the budget was burned on refused
   * upgrades" visible in `pboardCollaboration()` instead of only in the proxy's
   * log; it does not refund anything and does not pause the context, because a
   * failed upgrade is not proof of a rate limit.
   */
  noteRelayDialFailure(): void;
  /** Reports a `429` the caller received: pauses every automatic-auth caller
   * for a jittered backoff and returns how long the caller itself must wait
   * before its single retry. The caller never sleeps on its own schedule. */
  reportRateLimited(): Promise<void>;
  /** The posture a diagnostics read wants: rate, waiters, cooldown bounds. */
  snapshot(): AuthBudgetSnapshot;
  /** Test seam: forget history and let the next acquire pass immediately. */
  reset(): void;
};

/** Sustained per-second admission for one browser context; two browsers
 * sharing an IP therefore sum to ~5/s against the proxy's ~6/s. */
export const AUTH_BUDGET_REFILL_PER_SECOND = 2.5;
/** Burst allowance on top of the refill: a board attach may need a short
 * run of requests (challenge, exchange, courier admission) at once. */
export const AUTH_BUDGET_CAPACITY = 5;
/**
 * Relay socket attempts one browser context may make per window.
 *
 * Arithmetic, against the deployed proxy (`stick-table … store
 * http_req_rate(10s)`, `deny if sc_http_req_rate(0) gt 60`):
 *  - the proxy admits 60 requests / 10 s per source IP, and two browsers of
 *    one account share it, so one browser may safely claim 30;
 *  - one relay socket costs one `GET /ws` upgrade, plus a challenge and an
 *    exchange when the relay requires service admission: **3 requests**. Six
 *    rooms (five boards + the account channel) is therefore 18 requests, and
 *    a second board run in the same context (the MV3 worker and the sidebar
 *    each construct their own log handles) would be 36 — over the 30 budget
 *    before a single grant read;
 *  - the cold-start topology's *legitimate* need is one dial per room: five
 *    boards plus the account channel = **6 dials**. Eight leaves headroom for
 *    one re-attach (a board reopened, a socket the proxy aged out) inside the
 *    window while keeping 24 of the 30 requests for admissions and grant
 *    traffic: 8 dials × 3 = 24, leaving 6 for `GET /grants/<scope>`,
 *    `grants/publish` and the single retry behind a 429.
 *  - The excess is *paced*, not refused: a ninth dial waits for the window to
 *    roll, which is what spreads a duplicated page load over two windows
 *    instead of sending twelve upgrades in one.
 */
export const AUTH_BUDGET_RELAY_DIALS = 8;
/** Rolling window the dial allowance is counted over: the proxy's own
 * `http_req_rate(10s)` bucket, so the client's window and the denial window
 * agree about what "too many" means. */
export const AUTH_BUDGET_RELAY_DIAL_WINDOW_MS = 10_000;
const COOLDOWN_BASE_MS = 1_000;
const COOLDOWN_MAX_MS = 30_000;
/** Refusals stop doubling the pause bound once the budget has been clean for
 * this long, so an hour-old 429 cannot make the next one slow. */
const COOLDOWN_DECAY_MS = 60_000;

export const AUTH_BUDGET_RELAY_KIND = 'relay/ws';

export function createAuthBudget(options: {
  now?: () => number;
  random?: () => number;
  relayDialLimit?: number;
  relayDialWindowMs?: number;
  /** The wait seam, paired with `now`: production uses `setTimeout`, and a test
   * hands in a scheduler it drives itself. Injecting both together is what lets
   * the caller's clock and the budget's waiting share one timeline — faking
   * only timers leaves `now` and the real event loop out of step, which is a
   * race, not a shortcut. */
  sleep?: (ms: number) => Promise<void>;
} = {}): AuthBudget {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const relayDialLimit = options.relayDialLimit ?? AUTH_BUDGET_RELAY_DIALS;
  const relayDialWindowMs = options.relayDialWindowMs ?? AUTH_BUDGET_RELAY_DIAL_WINDOW_MS;
  let tokens = AUTH_BUDGET_CAPACITY;
  let lastRefill = now();
  let cooldownUntil = 0, cooldownDelayMs = 0, lastRefusalAt = 0, cooldowns = 0, served = 0;
  let waiting = 0;
  const byKind: Record<string, number> = {};
  /** Timestamps of the relay dials admitted inside the current window. */
  let dials: number[] = [];
  let dialsDeferred = 0, dialsFailed = 0;
  /** Attempt timestamps inside the current window, shared by every topic. */
  let attempts: number[] = [];
  let attemptsDeferred = 0;

  const refill = () => {
    const at = now();
    const elapsed = Math.max(0, at - lastRefill);
    lastRefill = at;
    tokens = Math.min(AUTH_BUDGET_CAPACITY, tokens + (elapsed / 1000) * AUTH_BUDGET_REFILL_PER_SECOND);
  };
  /** Drops entries that have fallen out of the rolling window. */
  const trimWithin = (times: number[]) => {
    const at = now();
    while (times.length && at - times[0] >= relayDialWindowMs) times.shift();
  };
  const trimDials = () => trimWithin(dials);
  // The project's lib target is ES2022, so `Promise.withResolvers` is out.
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, Math.ceil(ms))); }));

  /** One request from the shared bucket, after the shared pause. Split out so
   * a relay dial can take its window slot first and still spend a token.
   * Returns true when the caller had to wait (pause or refill). */
  async function takeToken(kind: string): Promise<boolean> {
    let waited = false;
    // A pause is absolute: nobody acquires inside it, which is what stops
    // every caller from discovering the 429 one by one.
    while (now() < cooldownUntil) { waited = true; await sleep(cooldownUntil - now()); }
    for (;;) {
      refill();
      if (tokens >= 1) { tokens -= 1; served++; byKind[kind] = (byKind[kind] ?? 0) + 1; return waited; }
      waited = true;
      await sleep((1 - tokens) / AUTH_BUDGET_REFILL_PER_SECOND * 1000);
    }
  }

  return {
    async acquire(kind: string) {
      waiting++;
      try { await takeToken(kind); } finally { waiting--; }
    },
    async acquireRelayDial() {
      waiting++;
      let paced = false;
      try {
        // Same pause as every other automatic caller: a 429 answers a dial's
        // identity round or its own token spend, and the next dial must not
        // discover the refusal independently.
        while (now() < cooldownUntil) { paced = true; await sleep(cooldownUntil - now()); }
        // Then the context-wide window allowance. This is a count, not a rate:
        // N boards opening at once each call here, and only `relayDialLimit`
        // of them reach the socket inside one proxy window. The rest wait for
        // the oldest dial to age out, which is what turns a page load with
        // several rooms from one burst into a paced sequence.
        trimDials();
        while (dials.length >= relayDialLimit) {
          dialsDeferred++; paced = true;
          await sleep(relayDialWindowMs - (now() - dials[0]));
          while (now() < cooldownUntil) await sleep(cooldownUntil - now());
          trimDials();
        }
        // The slot is booked **synchronously**, before the token wait. Checking
        // and pushing either side of an `await` would let every caller pass the
        // check while the first one waits for its token, which is exactly the
        // burst this allowance exists to stop.
        dials.push(now());
        // The token is spent last, immediately before the caller builds the
        // socket, so no token is held while a connection is in flight.
        if (await takeToken(AUTH_BUDGET_RELAY_KIND)) paced = true;
        return { paced };
      } finally { waiting--; }
    },
    async acquireRelayAttempt() {
      waiting++;
      try {
        for (;;) {
          trimWithin(attempts);
          if (attempts.length < relayDialLimit) { attempts.push(now()); return; }
          attemptsDeferred++;
          await sleep(relayDialWindowMs - (now() - attempts[0]));
        }
      } finally { waiting--; }
    },
    noteRelayDialFailure() { dialsFailed++; },
    async reportRateLimited() {
      const at = now();
      // Full jitter on the *new* bound, doubling while refusals keep arriving:
      // the wait actually taken lies in [0, delay] and the ceiling follows the
      // service's own pressure, never the caller's.
      cooldownDelayMs = at - lastRefusalAt < COOLDOWN_DECAY_MS ? Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_BASE_MS, cooldownDelayMs * 2)) : COOLDOWN_BASE_MS;
      lastRefusalAt = at;
      cooldowns++;
      cooldownUntil = at + Math.round(random() * cooldownDelayMs);
      // The reporting caller waits like everyone else: its retry goes through
      // the bucket, so a retry storm cannot form behind this answer. It spends
      // a token but not a dial slot — a 429 is an HTTP answer, and the retry it
      // permits must not be refused by the *dial* count on top of it.
      await this.acquire('rate-limited-retry');
    },
    snapshot() {
      refill();
      trimDials();
      trimWithin(attempts);
      return {
        served, byKind: { ...byKind }, waiting, cooldownUntil, cooldowns, cooldownDelayMs,
        ratePerSecond: AUTH_BUDGET_REFILL_PER_SECOND, capacity: AUTH_BUDGET_CAPACITY,
        relayDials: { limit: relayDialLimit, windowMs: relayDialWindowMs, usedInWindow: dials.length, deferred: dialsDeferred, failed: dialsFailed },
        relayAttempts: { limit: relayDialLimit, windowMs: relayDialWindowMs, usedInWindow: attempts.length, deferred: attemptsDeferred }
      };
    },
    reset() {
      tokens = AUTH_BUDGET_CAPACITY; lastRefill = now();
      cooldownUntil = 0; cooldownDelayMs = 0; lastRefusalAt = 0; cooldowns = 0; served = 0; waiting = 0;
      dials = []; dialsDeferred = 0; dialsFailed = 0;
      attempts = []; attemptsDeferred = 0;
      for (const kind of Object.keys(byKind)) delete byKind[kind];
    },
  };
}

/** The context-wide budget every automatic-auth caller shares. One per JS
 * context by construction (module instance), which is the unit the browser
 * throttles and the unit the proxy's per-IP budget sums over. */
export const automaticAuthBudget = createAuthBudget();
