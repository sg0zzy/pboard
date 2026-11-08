import { AUTH_BUDGET_CAPACITY, AUTH_BUDGET_REFILL_PER_SECOND, AUTH_BUDGET_RELAY_DIALS, AUTH_BUDGET_RELAY_DIAL_WINDOW_MS, type AuthBudget, type AuthBudgetSnapshot } from "../../src/collab/authBudget";

/** A budget that paces nothing, for tests that exercise protocols rather than
 * rate behavior: the production path shares the per-context token bucket, and
 * a protocol test runs its handful of automatic-auth requests a thousand times
 * faster than any browser would, so without this seam the bucket — correctly —
 * spends the test's timeout budget waiting. The policy bounds themselves live
 * in `tests/collab/authBudget.test.ts`, which tests the real thing. */
export function instantAuthBudget(): AuthBudget {
  const empty: AuthBudgetSnapshot = {
    served: 0, byKind: {}, waiting: 0, cooldownUntil: 0, cooldowns: 0, cooldownDelayMs: 0,
    ratePerSecond: AUTH_BUDGET_REFILL_PER_SECOND, capacity: AUTH_BUDGET_CAPACITY,
    relayDials: { limit: AUTH_BUDGET_RELAY_DIALS, windowMs: AUTH_BUDGET_RELAY_DIAL_WINDOW_MS, usedInWindow: 0, deferred: 0, failed: 0 },
    relayAttempts: { limit: AUTH_BUDGET_RELAY_DIALS, windowMs: AUTH_BUDGET_RELAY_DIAL_WINDOW_MS, usedInWindow: 0, deferred: 0 }
  };
  return {
    async acquire() {},
    async acquireRelayDial() { return { paced: false }; },
    async acquireRelayAttempt() {},
    noteRelayDialFailure() {},
    async reportRateLimited() {},
    snapshot: () => ({ ...empty, byKind: {}, relayDials: { ...empty.relayDials }, relayAttempts: { ...empty.relayAttempts } }),
    reset() {},
  };
}
