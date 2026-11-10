import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_BUDGET_CAPACITY, AUTH_BUDGET_RELAY_DIALS, AUTH_BUDGET_RELAY_DIAL_WINDOW_MS, AUTH_BUDGET_RELAY_KIND,
  AUTH_BUDGET_REFILL_PER_SECOND, createAuthBudget
} from "../../src/collab/authBudget";

/**
 * The bounds are the contract two browsers share over one proxy IP, so this
 * file pins the policy, not an implementation: burst size, sustained refill,
 * the shared 429 pause with its jitter bound, the per-window dial allowance and
 * the attempt allowance.
 *
 * The budget reads its clock through `Date.now` and waits through `setTimeout`,
 * so virtual timers are the injection seam: `vi.useFakeTimers` replaces both
 * (installed before any budget is constructed, so the captured `Date.now` is
 * the fake one). Every assertion is therefore about **budget state at a
 * controlled instant** — a token count, a `cooldownUntil` timestamp, or a
 * caller that has settled versus one that still waits — never about how long
 * the machine took. Nothing here can pass because the box was slow, and nothing
 * can fail because it was busy.
 */
// The contract numbers are pinned as literals, not read back from the module:
// a test that derives its expectation from the constant under test would move
// with it and could never catch a changed bound. The exported constants are
// then asserted to equal these, so the two cannot drift either.
/** One token's worth of time at the sustained 2.5 requests/second. */
const TOKEN_INTERVAL_MS = 400;
/** Burst: five requests, no wait. */
const BURST = 5;

/** Yields the microtask queue without running any timer, so a caller that
 * needed no wait has settled and one that needs a timer provably has not. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 32; turn++) await Promise.resolve();
}

describe("automatic-auth budget", () => {
  beforeEach(() => {
    // Timers and `Date` only: microtasks stay real, which is what makes
    // `drain()` able to distinguish "resolved without waiting" from "waiting".
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("admits a burst of exactly the capacity with no wait", async () => {
    const budget = createAuthBudget();
    // "No wait" is asserted structurally: with the clock frozen no timer can
    // fire, so five tokens can only be handed out if `acquire` does not wait at
    // all. `served` moves synchronously, before the promise even settles.
    const taken = Array.from({ length: BURST }, () => budget.acquire("identity/challenge"));
    const beforeDrain = budget.snapshot();
    expect(beforeDrain.served).toBe(BURST);
    expect(beforeDrain.byKind["identity/challenge"]).toBe(BURST);
    await drain();
    const snapshot = budget.snapshot();
    expect(snapshot.served).toBe(BURST);
    expect(snapshot.byKind["identity/challenge"]).toBe(BURST);
    expect(snapshot.waiting).toBe(0);
    void taken;
    // The sixth is where the burst ends: it does not settle with the clock
    // frozen, because the capacity — not the caller — is what ran out.
    const sixth = budget.acquire("identity/challenge");
    await drain();
    expect(budget.snapshot().served).toBe(BURST);
    expect(budget.snapshot().waiting).toBe(1);
    // …and it settles once exactly one interval has passed.
    await vi.advanceTimersByTimeAsync(TOKEN_INTERVAL_MS);
    expect(budget.snapshot().served).toBe(BURST + 1);
    expect(budget.snapshot().waiting).toBe(0);
    await sixth;
  });

  it("paces the request past capacity at exactly the sustained refill interval", async () => {
    const budget = createAuthBudget();
    for (let i = 0; i < BURST; i++) await budget.acquire("grants/read");
    budget.acquire("grants/read");
    expect(budget.snapshot().waiting).toBe(1);
    // One millisecond short of the interval the bucket holds no whole token, so
    // the request has not been served.
    await vi.advanceTimersByTimeAsync(Math.ceil(TOKEN_INTERVAL_MS) - 1);
    expect(budget.snapshot().served).toBe(BURST);
    expect(budget.snapshot().waiting).toBe(1);
    // Exactly the interval: one token, one request served. This fails if the
    // refill rate is lowered (the wait grows), raised (the request is served
    // early), or dropped to zero (it never settles).
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.snapshot().served).toBe(BURST + 1);
    expect(budget.snapshot().waiting).toBe(0);
    // The bucket is empty again rather than ahead of itself.
    budget.acquire("grants/read");
    await drain();
    expect(budget.snapshot().served).toBe(BURST + 1);
  });

  it("jitter bounds follow the refusal pattern: base, doubling while pressured, 30s ceiling, restart after a clean minute", async () => {
    // Full jitter is `random() * delay`, so pinning `random` to 0 makes every
    // pause empty — the bound, not the wait, is what this test reads. The clock
    // advances half a second between refusals: enough refill for the reporting
    // caller's own retry to pass, and the gap stays under a minute so the
    // refusals count as one pressure pattern.
    const budget = createAuthBudget({ random: () => 0 });
    expect(budget.snapshot().cooldownDelayMs).toBe(0);
    await budget.reportRateLimited();
    expect(budget.snapshot().cooldownDelayMs).toBe(1_000);
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(500); await budget.reportRateLimited(); }
    expect(budget.snapshot().cooldownDelayMs).toBe(8_000);
    for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(500); await budget.reportRateLimited(); }
    expect(budget.snapshot().cooldownDelayMs).toBe(30_000); // the ceiling, not past it
    await vi.advanceTimersByTimeAsync(60_000);
    await budget.reportRateLimited();
    expect(budget.snapshot().cooldownDelayMs).toBe(1_000); // one clean minute restarts the bound
    expect(budget.snapshot().cooldowns).toBe(11);
  });

  it("a reported 429 pauses every caller until the timestamp it drew", async () => {
    // `random() === 1` draws the full bound, so the pause is exactly the
    // one-second base and its end is a computable instant, not a guess.
    const budget = createAuthBudget({ random: () => 1 });
    const at = Date.now();
    budget.reportRateLimited(); // deliberately not awaited: it waits out the pause
    // The pause is set synchronously from the budget's own clock, and it is
    // what the console reads.
    expect(budget.snapshot().cooldownUntil).toBe(at + budget.snapshot().cooldownDelayMs);
    expect(budget.snapshot().cooldownDelayMs).toBe(1_000);
    // One millisecond short of it the reporting caller has not been served…
    await vi.advanceTimersByTimeAsync(999);
    expect(budget.snapshot().served).toBe(0);
    expect(budget.snapshot().waiting).toBe(1);
    // …and at the instant it drew, it proceeds exactly once, for its single
    // permitted retry.
    await vi.advanceTimersByTimeAsync(1);
    const after = budget.snapshot();
    expect(after.cooldowns).toBe(1);
    expect(after.served).toBe(1);
    expect(after.byKind["rate-limited-retry"]).toBe(1);
    expect(after.waiting).toBe(0);
    // A second refusal engages a new pause and a caller behind it waits for
    // that pause, not for its own private sleep.
    budget.reportRateLimited();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(budget.snapshot().cooldowns).toBe(2);
    expect(budget.snapshot().byKind["rate-limited-retry"]).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.snapshot().byKind["rate-limited-retry"]).toBe(2);
  });

  it("admits relay dials from the same bucket, under their own kind, up to the per-window allowance", async () => {
    // The proxy counts a `GET /ws` upgrade in the same stick table as the
    // identity calls, so a dial is a request: it spends a token, it is counted
    // by kind, and it is bounded by a hard per-window count on top of the rate.
    const windowMs = 2_000;
    const budget = createAuthBudget({ relayDialLimit: 3, relayDialWindowMs: windowMs });
    for (let i = 0; i < 3; i++) await budget.acquireRelayDial();
    const after = budget.snapshot();
    expect(after.byKind[AUTH_BUDGET_RELAY_KIND]).toBe(3);
    expect(after.served).toBe(3);
    expect(after.relayDials.usedInWindow).toBe(3);
    // The fourth waits for the window, not for the bucket: the allowance is a
    // count, and a token bucket alone would have admitted it on refill (the
    // bucket is full again after two seconds of fake time).
    budget.acquireRelayDial();
    expect(budget.snapshot().waiting).toBe(1);
    expect(budget.snapshot().relayDials.deferred).toBe(1);
    await vi.advanceTimersByTimeAsync(windowMs - 1);
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    // The window rolled: one dial in it, the bucket refilled by the same wait
    // rather than being overdrawn, and the deferral counted once.
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(4);
    expect(budget.snapshot().relayDials.usedInWindow).toBe(1);
    expect(budget.snapshot().relayDials.deferred).toBe(1);
  });

  it("books whole dial slots before any token wait, so a full window cannot be overrun", async () => {
    // The bug this pins: checking the window, awaiting a token, then recording
    // the dial lets every concurrent caller pass the check while the first one
    // waits — exactly the startup burst the allowance exists to stop. With the
    // bucket drained to one token, three dials against a two-slot window must
    // admit two, not three.
    const windowMs = 10_000;
    const budget = createAuthBudget({ relayDialLimit: 2, relayDialWindowMs: windowMs });
    for (let i = 1; i < BURST; i++) await budget.acquire("identity/challenge");
    expect(budget.snapshot().served).toBe(BURST - 1); // exactly one token left
    for (let i = 0; i < 3; i++) budget.acquireRelayDial();
    await drain();
    // Two slots were booked without waiting for a token, so at most two dials
    // can ever spend this window — the third is held for the next one.
    expect(budget.snapshot().relayDials.usedInWindow).toBe(2);
    expect(budget.snapshot().relayDials.deferred).toBe(1);
    // Even after enough virtual time for every token to exist, the third dial
    // has not been admitted inside this window.
    await vi.advanceTimersByTimeAsync(TOKEN_INTERVAL_MS * (BURST + 2));
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(2);
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(3);
  });

  it("caps relay attempts per window, and paces rather than refuses", async () => {
    const windowMs = 1_000;
    const budget = createAuthBudget({ relayDialLimit: 2, relayDialWindowMs: windowMs });
    await budget.acquireRelayAttempt();
    await budget.acquireRelayAttempt();
    expect(budget.snapshot().relayAttempts).toMatchObject({ limit: 2, windowMs, usedInWindow: 2, deferred: 0 });
    // Attempts are not tokens: they count even though the bucket is untouched,
    // which is what makes a retry loop that dies before the socket finite.
    expect(budget.snapshot().served).toBe(0);
    budget.acquireRelayAttempt();
    expect(budget.snapshot().relayAttempts.deferred).toBe(1);
    await vi.advanceTimersByTimeAsync(windowMs - 1);
    expect(budget.snapshot().relayAttempts.usedInWindow).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.snapshot().relayAttempts.usedInWindow).toBe(1);
  });

  it("reports the dial allowance and the bucket bounds in its snapshot", () => {
    const budget = createAuthBudget();
    const snapshot = budget.snapshot();
    // The console answer the next lockout needs: which kinds spent what, how
    // many dials the context may make per window, how many it has made, and how
    // many were refused after being admitted.
    expect(snapshot.relayDials).toEqual({
      limit: AUTH_BUDGET_RELAY_DIALS, windowMs: AUTH_BUDGET_RELAY_DIAL_WINDOW_MS, usedInWindow: 0, deferred: 0, failed: 0
    });
    expect(snapshot.relayAttempts).toEqual({
      limit: AUTH_BUDGET_RELAY_DIALS, windowMs: AUTH_BUDGET_RELAY_DIAL_WINDOW_MS, usedInWindow: 0, deferred: 0
    });
    // The exported constants and the pinned literals agree — the one place the
    // two can be compared, so a changed bound fails here as well as in the
    // behaviour it would have permitted.
    expect(AUTH_BUDGET_CAPACITY).toBe(BURST);
    expect(AUTH_BUDGET_REFILL_PER_SECOND).toBe(1000 / TOKEN_INTERVAL_MS);
    expect(snapshot.ratePerSecond).toBe(AUTH_BUDGET_REFILL_PER_SECOND);
    expect(snapshot.capacity).toBe(BURST);
    budget.noteRelayDialFailure();
    expect(budget.snapshot().relayDials.failed).toBe(1);
    budget.reset();
    expect(budget.snapshot().relayDials).toMatchObject({ usedInWindow: 0, deferred: 0, failed: 0 });
  });

  it("a reported 429 gates relay dials as well as identity calls", async () => {
    const budget = createAuthBudget({ random: () => 1 });
    const pause = budget.reportRateLimited();
    await vi.advanceTimersByTimeAsync(1_000);
    await pause;
    // The pause is over: a dial now proceeds with no further time passing, and
    // it is counted under its own kind.
    await budget.acquireRelayDial();
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(1);
    // A second refusal engages a new pause, and a dial started inside it waits
    // for that pause to end — the gate is the shared one, not a dial-private
    // sleep.
    budget.reportRateLimited();
    budget.acquireRelayDial();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(1);
    expect(budget.snapshot().waiting).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(2);
    expect(budget.snapshot().byKind["rate-limited-retry"]).toBe(2);
  });

  it("a dial does not book its window slot while the 429 pause is running", async () => {
    // A pause is absolute: a dial that booked a slot and then waited inside the
    // pause would spend the window's allowance on requests that could not be
    // made, and the next eight rooms would be paced for nothing.
    const budget = createAuthBudget({ random: () => 1 });
    budget.reportRateLimited();
    budget.acquireRelayDial();
    await vi.advanceTimersByTimeAsync(999);
    expect(budget.snapshot().relayDials.usedInWindow).toBe(0);
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // Once the pause is over it books one slot and spends one token, not two.
    expect(budget.snapshot().relayDials.usedInWindow).toBe(1);
    expect(budget.snapshot().byKind[AUTH_BUDGET_RELAY_KIND]).toBe(1);
  });

  it("reset forgets history for the next holder of the context", async () => {
    const budget = createAuthBudget({ random: () => 0 });
    await budget.reportRateLimited(); // one token, jittered to nothing
    // Exactly the rest of the burst, so every one of these resolves without a
    // timer firing.
    for (let i = 1; i < BURST; i++) await budget.acquire("grants/publish");
    expect(budget.snapshot().served).toBe(BURST);
    await budget.acquireRelayAttempt();
    // Two attempts in the window and an empty bucket: both states reset must
    // clear, so this is not a vacuous assertion.
    await budget.acquireRelayAttempt();
    budget.acquire("grants/read");
    await drain();
    expect(budget.snapshot().relayAttempts.usedInWindow).toBe(2);
    expect(budget.snapshot().waiting).toBe(1);
    budget.reset();
    const after = budget.snapshot();
    expect(after.served).toBe(0);
    expect(after.byKind).toEqual({});
    expect(after.cooldowns).toBe(0);
    expect(after.cooldownUntil).toBe(0);
    expect(after.relayAttempts).toMatchObject({ usedInWindow: 0, deferred: 0 });
    // A full burst is available again with no time passing, which is the whole
    // point of a reset (a new account takes over the context).
    for (let i = 0; i < BURST; i++) await budget.acquire("identity/exchange");
    expect(budget.snapshot().served).toBe(BURST);
  });
});
