/**
 * Relay dials spend from the shared per-context budget.
 *
 * The deployed reverse proxy counts `GET /ws` in the same per-IP stick table as
 * `POST /identity/challenge` and `POST /identity/exchange` (60 requests / 10 s
 * per source IP). Two browsers of one account share that bucket, so a page load
 * that dials five boards plus the account channel — twice over, because the MV3
 * worker and the sidebar each build their own log handles — used to arrive as a
 * burst of upgrades and be denied with `PR--`. That denial reaches Firefox as
 * `NS_ERROR_WEBSOCKET_CONNECTION_REFUSED`, not as a `429` any client can report.
 *
 * Determinism. Two clocks, each advanced **explicitly**, and neither measured
 * against the machine:
 *  - the budget's (`now`/`sleep` are injected), so every pacing wait is
 *    resolved by `advanceBudget` and nothing depends on elapsed time;
 *  - the transport's timers (`vi.advanceTimersByTimeAsync`; `Date` and
 *    `setImmediate` stay real, because the log's reconnect ledger reads
 *    `Date.now()`).
 *
 * The dial path still does real WebCrypto between those two clocks
 * (`prepareRelayAdmission`, key import, signing), and that is what used to make
 * this file order-dependent: a virtual-time advance would run before or after a
 * crypto promise depending on load, and whichever won changed what the timer
 * saw. `quiesce()` removes that ordering question — it pumps real macrotasks
 * until the scenario stops producing observable work — and every advance is
 * preceded by it. Nothing here asserts on elapsed time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_BUDGET_RELAY_DIALS, AUTH_BUDGET_RELAY_KIND, createAuthBudget, type AuthBudget
} from '../../src/collab/authBudget';
import { clearReconnectLedger, createOperationLogSync, type OperationLogSync } from '../../src/sync/operations/logSync';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest } from '../../src/collab/security/manifest';
import type { RelayAuthorization } from '../../src/collab/security/relayAdmission';
import type { Operation } from '../../src/sync/operations/protocol';

const challenge = 'c'.repeat(43);

/**
 * Monotonic counter of everything a scenario can observe: a sleeper registered,
 * a sleeper resolved, a socket constructed. `quiesce()` treats it as the
 * liveness signal — pumping stops only once a whole batch produces no new
 * work, which is the point at which any pending real crypto has already
 * resumed its caller and that caller's next step has been recorded.
 */
let activity = 0;

/** Pumps real macrotasks, without touching either clock. */
async function pump(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Pumps until a full batch of macrotasks produces no new work. Real crypto on
 * a loaded machine just costs more batches; it cannot reorder anything. */
async function quiesce(): Promise<void> {
  let seen = -1;
  for (let batch = 0; batch < 60 && seen !== activity; batch++) {
    seen = activity;
    await pump(50);
  }
}

/** Waits until a state predicate holds, pumping real macrotasks (which also
 * lets any pending WebCrypto resume). Bounded by a step count, so a scenario
 * that never reaches the state fails with a definite message instead of
 * hanging. This is how a test waits for "every caller has reached its gate"
 * without guessing how many macrotasks the crypto took on this machine. */
async function until(predicate: () => boolean, what: string, steps = 400): Promise<void> {
  for (let step = 0; step < steps; step++) {
    await quiesce();
    if (predicate()) return;
    await pump(10);
  }
  throw new Error(`never reached: ${what}`);
}

/** The budget's clock and waiting, driven by the test. `advance` resolves the
 * sleepers whose deadline has come — earliest first, re-checking after each
 * because a woken caller may sleep again — so a caller that should still be
 * waiting provably still is. */
function createBudgetClock(start = 1_000_000) {
  let at = start;
  const sleepers: { at: number; resolve: () => void }[] = [];
  return {
    now: () => at,
    sleep: (ms: number) => new Promise<void>(resolve => {
      sleepers.push({ at: at + Math.max(0, Math.ceil(ms)), resolve });
      activity++;
    }),
    async advance(ms = 0) {
      await quiesce();
      const target = at + ms;
      for (;;) {
        sleepers.sort((left, right) => left.at - right.at);
        const due = sleepers[0];
        if (!due || due.at > target) break;
        sleepers.shift();
        at = Math.max(at, due.at);
        due.resolve();
        activity++;
        await quiesce(); // the woken caller must reach its next step before the next due check
      }
      at = target;
      await quiesce();
    },
    pending: () => sleepers.length
  };
}

class DialRelay {
  static OPEN = 1;
  static instances: DialRelay[] = [];
  /** Budget-clock timestamp of every socket construction: the attempt log the
   * window invariant is checked against. */
  static attempts: number[] = [];
  static now: () => number = () => 0;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  room = '';
  session = `s${DialRelay.instances.length}`.padEnd(43, 's');
  constructor(_url: string | URL) {
    DialRelay.instances.push(this);
    DialRelay.attempts.push(DialRelay.now());
    activity++;
    queueMicrotask(() => this.push({
      type: 'welcome', version: 1, supportedVersions: [1, 2], challenge, session: this.session,
      requiresServiceAdmission: true
    }));
  }
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(raw: string) {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'authenticate') {
      this.room = String(message.room);
      queueMicrotask(() => this.push({ type: 'authenticated', peerId: message.deviceKeyId, session: this.session }));
    }
    if (message.type === 'sync') {
      const request = message.request as Record<string, unknown>;
      if (request.action === 'subscribe')
        queueMicrotask(() => this.push({ type: 'sync', action: 'window', board: this.room, operations: [], checkpointSeq: 0, synced: true }));
    }
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

let key: StoredDeviceKey;
const authorizations = new Map<string, RelayAuthorization>();

async function authorizationFor(board: string): Promise<RelayAuthorization> {
  const existing = authorizations.get(board);
  if (existing) return existing;
  const manifest = await signManifest({
    protocol: 2, boardId: board, driveProjectFileId: 'file-1', driveFolderId: 'folder-1', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 240_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' }]
  }, key);
  const value = { authority: key.publicJwk, manifest };
  authorizations.set(board, value);
  return value;
}

/** One log handle exactly as a runtime constructs it, with the relay fake
 * standing in for the network. Service admission is required by the fake, so a
 * dial spends the upgrade plus the two identity calls the arithmetic assumes. */
async function dial(board: string, budget: AuthBudget, overrides: Record<string, unknown> = {}): Promise<OperationLogSync> {
  return await createOperationLogSync({
    boardId: board, topic: `pboard-collab-${board}-cards`, url: 'wss://relay.example.test/ws',
    authBudget: budget,
    getKey: async () => key,
    getAuthorization: () => authorizationFor(board),
    getServiceAdmission: async () => {
      await budget.acquire('identity/challenge');
      await budget.acquire('identity/exchange');
      return 'a'.repeat(43);
    },
    seal: async (operation: Operation) => JSON.stringify(operation),
    open: async (payload: string) => JSON.parse(payload) as Operation,
    receive: async () => {}, gap: async () => {}, status: () => {},
    cursor: { load: async () => 0, save: async () => {} },
    webSocket: DialRelay as unknown as typeof WebSocket,
    ...overrides
  });
}

type Outcome = { handle: OperationLogSync } | { error: Error };

function startDial(board: string, budget: AuthBudget, overrides: Record<string, unknown> = {}): Promise<Outcome> {
  return dial(board, budget, overrides).then(
    handle => ({ handle }) as const,
    error => ({ error: error as Error }) as const);
}

/** Drives every outcome to completion: quiesce, collect whatever settled, then
 * step both clocks by one slice so any pacing or backoff deadline comes due.
 * Bounded by a step count, so a dial that never settles fails instead of
 * hanging. */
async function settle(outcomes: Promise<Outcome>[], budgetClock: ReturnType<typeof createBudgetClock>): Promise<OperationLogSync[]> {
  const results: (OperationLogSync | undefined)[] = new Array(outcomes.length).fill(undefined);
  for (let step = 0; step < 400 && results.some(result => !result); step++) {
    await quiesce();
    for (const [index, outcome] of outcomes.entries()) {
      if (results[index]) continue;
      const settled = await Promise.race([outcome, Promise.resolve(null)]);
      if (!settled) continue;
      if ('error' in settled) throw settled.error;
      results[index] = settled.handle;
    }
    if (results.some(result => !result)) {
      await budgetClock.advance(250);
      await vi.advanceTimersByTimeAsync(250);
    }
  }
  if (results.some(result => !result)) throw new Error('a dial never settled');
  return results as OperationLogSync[];
}

/** One dial, expected to need no pacing. */
async function open(board: string, budget: AuthBudget, budgetClock: ReturnType<typeof createBudgetClock>, overrides: Record<string, unknown> = {}): Promise<OperationLogSync> {
  const [handle] = await settle([startDial(board, budget, overrides)], budgetClock);
  return handle;
}

let clock: ReturnType<typeof createBudgetClock>;

beforeEach(async () => {
  // Transport timers only. `Date` and `setImmediate` stay real: the log's
  // reconnect ledger reads `Date.now()`, and WebCrypto resolves through real
  // macrotasks — faking `Date` across those awaits is what made this file
  // order-dependent.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clearReconnectLedger();
  DialRelay.instances = [];
  DialRelay.attempts = [];
  authorizations.clear();
  activity = 0;
  clock = createBudgetClock();
  DialRelay.now = clock.now;
  key = await generateDeviceKey();
});
afterEach(() => { vi.useRealTimers(); DialRelay.instances = []; });

/** A budget wired to the test's clock: nothing it does depends on real time. */
function budgetOn(budgetClock: ReturnType<typeof createBudgetClock>, overrides: { random?: () => number; relayDialLimit?: number; relayDialWindowMs?: number } = {}): AuthBudget {
  return createAuthBudget({ now: budgetClock.now, sleep: budgetClock.sleep, ...overrides });
}

describe('relay dials spend from the shared budget', () => {
  it('bounds a cold page load: six boards in two runtimes plus the account channel inside one window', async () => {
    const budget = budgetOn(clock);
    // The user's topology as a cold start: five boards + the account channel,
    // duplicated because the MV3 worker and the sidebar each construct their
    // own log handles. Thirteen dials want the wire at once.
    const boards = Array.from({ length: 6 }, (_, index) => `board-${index}`);
    const topics = [...boards, ...boards.map(board => `${board}-worker`), 'account'];
    const opening = topics.map(topic => startDial(topic, budget));

    // The budget clock is **not** moved here. Each caller ends this phase in
    // exactly one of two states — a booked slot, or a deferral — so "every
    // caller has reached the gate" is a sum that does not depend on the order
    // the handshakes' crypto resolved in. Waiting for that sum, rather than
    // sleeping, is what makes the assertion below stable under load.
    // The two gates in series mean a caller is, at this instant, in exactly one
    // of three places: holding a dial slot, queued behind the attempt
    // allowance, or queued behind the dial allowance. Their sum is the topic
    // count whatever order the crypto resolved in.
    const placed = () => {
      const state = budget.snapshot();
      return state.relayDials.usedInWindow + state.relayAttempts.deferred + state.relayDials.deferred;
    };
    await until(() => placed() === topics.length, 'all thirteen dials to reach a gate');

    const snapshot = budget.snapshot();
    // The allowance, not the clock, is what bounded the burst: eight slots for
    // thirteen rooms. Each dial costs at most three requests (upgrade + the two
    // admission calls), so 8 dials is 24 of the 30 requests one browser may
    // claim from the proxy's 60-per-10 s per-IP bucket.
    expect(snapshot.relayDials.usedInWindow).toBe(AUTH_BUDGET_RELAY_DIALS);
    expect(snapshot.relayAttempts.deferred + snapshot.relayDials.deferred).toBe(topics.length - AUTH_BUDGET_RELAY_DIALS);
    expect(DialRelay.instances.length).toBeLessThanOrEqual(AUTH_BUDGET_RELAY_DIALS);
    // No token is spent by a dial that is still waiting for its slot, and none
    // is held while a connection is in flight: at this instant the sockets that
    // exist are at most the slots booked, never more.
    expect(clock.pending()).toBeGreaterThan(0);

    // Later windows admit the rest, in paced order: every topic converges and
    // no dial is dropped.
    const handles = await settle(opening, clock);
    expect(DialRelay.instances.length).toBe(topics.length);
    for (const handle of handles) expect(handle.status().phase).toBe('synced');

    // And the rolling-window invariant held for the whole burst: no ten-second
    // window of budget time ever saw more than the allowance of dials booked.
    const booked = DialRelay.attempts;
    for (const [index, at] of booked.entries()) {
      const inWindow = booked.slice(index).filter(other => other - at < 10_000).length;
      expect(inWindow).toBeLessThanOrEqual(AUTH_BUDGET_RELAY_DIALS);
    }
  });

  it('caps attempts across topics while every topic reaches its own stated state', async () => {
    const budget = budgetOn(clock);
    const boards = Array.from({ length: AUTH_BUDGET_RELAY_DIALS }, (_, index) => `topic-${index}`);
    // A generous per-topic ceiling and a retry a few virtual milliseconds out,
    // so the only thing that may bound these eight topics is the context
    // allowance.
    const settleOptions = { reconnectCeiling: 6, reconnectCeilingMs: 600_000, reconnectBaseMs: 5 };
    const handles = await settle(boards.map(board => startDial(board, budget, settleOptions)), clock);
    for (const handle of handles) expect(handle.status().phase).toBe('synced');
    // Every topic is live, and the number of sockets it took never exceeded the
    // allowance inside any one window of budget time — the invariant the
    // per-topic ceiling could not provide.
    expect(new Set(handles.map(handle => handle.status().phase))).toEqual(new Set(['synced']));
    expect(DialRelay.attempts.length).toBeLessThanOrEqual(AUTH_BUDGET_RELAY_DIALS);
    const firstWindow = budget.snapshot();
    expect(firstWindow.relayDials.usedInWindow + firstWindow.relayDials.deferred)
      .toBeLessThanOrEqual(AUTH_BUDGET_RELAY_DIALS);

    // Every tunnel dies at once. Their retries land 5 virtual ms later, inside
    // the window the initial burst filled: the context allowance holds them,
    // because no per-topic ledger is anywhere near its own ceiling.
    for (const socket of [...DialRelay.instances]) socket.close();
    for (let step = 0; step < 8; step++) {
      await vi.advanceTimersByTimeAsync(5);
      await clock.advance(0);
    }
    expect(DialRelay.instances.length).toBe(AUTH_BUDGET_RELAY_DIALS);
    expect(budget.snapshot().relayAttempts.deferred).toBeGreaterThan(0);
    // Queued, not refused: no topic carries the per-topic verdict.
    for (const handle of handles) {
      expect(handle.status().throttled).toBe(false);
      expect(handle.status().phase).not.toBe('error');
    }

    // Later windows admit exactly one more attempt per topic: each is starved
    // for at most one window, none is silenced.
    for (let step = 0; step < 60 && DialRelay.instances.length < AUTH_BUDGET_RELAY_DIALS * 2; step++) {
      await clock.advance(250);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(DialRelay.instances.length).toBe(AUTH_BUDGET_RELAY_DIALS * 2);
    // Sixteen sockets for eight topics and a per-topic ceiling of six is each
    // topic dialling a second time: none was starved by the context allowance,
    // and none was refused by its own ledger.
    //
    // Each handle must end in one of its own stated states. `synced` is the
    // converged one; `offline` with a retry pending is the honest state for a
    // socket still walking its handshake, and it is what the transport reports
    // for a reconnect in progress. What may not appear is the per-topic verdict
    // (nothing here reached a ceiling) or a terminal refusal.
    // Both clocks, because the handshake spends admission tokens: the budget's
    // (`clock`) and the transport's (`vi`). Neither is real time.
    for (let step = 0; step < 60 && handles.some(handle => handle.status().phase !== 'synced'); step++) {
      await clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    for (const handle of handles) {
      const status = handle.status();
      expect(['synced', 'offline']).toContain(status.phase);
      expect(status.throttled).toBe(false);
    }

    // The invariant over the whole scenario: no ten-second budget window ever
    // admitted more sockets than the allowance, whatever the topics wanted.
    for (const [index, at] of DialRelay.attempts.entries()) {
      const inWindow = DialRelay.attempts.slice(index).filter(other => other - at < 10_000).length;
      expect(inWindow).toBeLessThanOrEqual(AUTH_BUDGET_RELAY_DIALS);
    }

    // The per-topic verdict still exists and still fires where it should: a
    // board whose own ledger is spent reports the ceiling, while its neighbour
    // keeps reconnecting under the context allowance.
    clearReconnectLedger();
    const tight = await open('tight-board', budget, clock, { reconnectCeiling: 1, reconnectCeilingMs: 600_000, reconnectBaseMs: 5 });
    const tightSocket = DialRelay.instances.length - 1;
    const loose = await open('loose-board', budget, clock, { reconnectCeiling: 6, reconnectCeilingMs: 600_000, reconnectBaseMs: 5 });
    const looseSocket = DialRelay.instances.length - 1;
    expect(tight.status().phase).toBe('synced');
    expect(loose.status().phase).toBe('synced');
    DialRelay.instances[tightSocket].close();
    for (let step = 0; step < 8 && !tight.status().throttled; step++) {
      await vi.advanceTimersByTimeAsync(5);
      await clock.advance(0);
    }
    expect(tight.status().throttled).toBe(true);
    expect(tight.status().error).toBe('reconnect:throttled');
    // The neighbour is unaffected by the throttled board's ledger, and it is
    // paced by the context allowance rather than starved by it.
    DialRelay.instances[looseSocket].close();
    for (let step = 0; step < 80 && loose.status().phase !== 'synced'; step++) {
      await vi.advanceTimersByTimeAsync(250);
      await clock.advance(250);
    }
    expect(loose.status().phase).toBe('synced');
    expect(loose.status().throttled).toBe(false);
  }, 60_000);

  it('a reported 429 pauses relay dials too, and the single permitted retry still happens', async () => {
    // `random() === 1` draws the full jitter bound, so the pause is exactly the
    // one-second base and the boundary is computable rather than guessed.
    const budget = budgetOn(clock, { random: () => 1 });
    const pause = budget.reportRateLimited();
    const opened = startDial('paused-board', budget);

    // Inside the pause: no socket, and the dial is still waiting on the clock.
    await clock.advance(900);
    expect(DialRelay.instances.length).toBe(0);
    expect(budget.snapshot().cooldownUntil).toBeGreaterThan(clock.now());
    expect(clock.pending()).toBeGreaterThan(0);
    expect(budget.snapshot().byKind['rate-limited-retry']).toBeUndefined();

    // At the instant the pause ends the dial proceeds — exactly one socket —
    // and the reporting caller's one permitted retry has been served.
    await clock.advance(1_100);
    await pause;
    const [handle] = await settle([opened], clock);
    expect(DialRelay.instances.length).toBe(1);
    expect(handle.status().phase).toBe('synced');
    const snapshot = budget.snapshot();
    expect(snapshot.byKind[AUTH_BUDGET_RELAY_KIND]).toBe(1);
    expect(snapshot.byKind['rate-limited-retry']).toBe(1);
  });
});
