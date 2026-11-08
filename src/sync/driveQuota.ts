import { driveSecondDelayMs } from "./driveRetry";
/**
 * Drive request-cost accounting and a quota-aware throttle.
 *
 * Two different numbers are kept apart deliberately:
 *
 * - `driveRequestCost` is what Google charges for a request: the documented
 *   flat per-method cost in quota units (read 5, list 100, edit 50, download
 *   200, other 5). This is the only value the ledger accumulates, so the
 *   ledger is comparable with the Cloud console's "Total Query Cost" metric.
 * - `driveProjectedCost` is Pboard's old pre-flight model (base 1, +1 per
 *   projected field, +pageSize for page-priced resources). It is retained for
 *   diagnostics only: page size is NOT part of Google's pricing, so the
 *   projection prices a two-row name lookup at 6 units where Google charges
 *   100, and a 1,000-row changes page at 1,005 where Google charges 100.
 *
 * Either number is a single browser context's view. Google's per-user limit
 * also counts every other device, browser profile and service that calls the
 * API as the same user in the same Cloud project, and Google additionally
 * enforces short-window rate checks that no per-minute budget predicts; a
 * "well under the limit" ledger therefore never proves the traffic is cheap.
 * Google reports the authoritative `X-Drive-Request-Cost` per response when it
 * supplies one, and that reported value always wins over the table.
 *
 * Projected overshoots defer a request. An actual quota denial opens a shared
 * cooldown: subsequent callers receive the quota error without hitting Drive.
 */

export const DRIVE_UNIT_READ = 5;
export const DRIVE_UNIT_LIST = 100;
export const DRIVE_UNIT_EDIT = 50;
export const DRIVE_UNIT_DOWNLOAD = 200;
export const DRIVE_UNIT_OTHER = 5;
export const DRIVE_COST_BASE = 1;
export const DRIVE_COST_FIELD = 1;
export const DRIVE_COST_FIELD_GROUP = 2;
export const DRIVE_COST_PAGETOKEN = 10;
export const DRIVE_COST_WINDOW_MS = 60_000;
export const DRIVE_QUOTA_MAX_COOLDOWN_MS = 5 * DRIVE_COST_WINDOW_MS;
/**
 * What one browser context lets itself spend per minute, as a share of the
 * per-user budget below. The extension runs two independent ledgers (the worker
 * and the sidebar page), and Google's per-user figure also counts every other
 * device, browser profile and app acting as the same user, plus short-window
 * rate checks that no per-minute figure predicts. A context that spends the
 * whole per-user budget therefore guarantees a denial for everything else, and
 * a runaway caller is then denied by Google rather than deferred locally, which
 * is the worst of both: the spend happens, the retry storm follows, and the
 * error names neither the loop nor the caller. Self-limiting at roughly a third
 * of the per-user budget keeps the account headroom for the other context and
 * turns an overrunning loop into a sleep instead of a 403.
 */
export const DRIVE_CONTEXT_COST_BUDGET = 100_000;

/**
 * The documented per-minute budget, in Drive quota units: 1,000,000 per project and
 * 325,000 per user per project
 * (https://developers.google.com/workspace/drive/api/guides/limits, last updated
 * 2026-09-11). A browser client is bounded by the per-user figure, so that is the
 * default. The previous 10,000 was not a documented limit — about 3% of the per-user
 * budget — so a workload Google would serve (50 inventory pages in one minute)
 * tripped a full-window deferral instead of going out.
 */
export const DRIVE_DEFAULT_COST_PER_MINUTE = 325_000;
/**
 * The floor a context backs off to when Google keeps denying it. Low enough that
 * a denied account still edits and syncs, high enough that the extension still
 * polls; the UI reports the deferral rather than silently stalling forever.
 */
export const DRIVE_MIN_COST_PER_MINUTE = 4_000;

/** Resources whose cost is dominated by the page size they ask for. */
export type DriveCostResource = "about" | "get" | "list" | "search" | "permlist" | "flat";
const COSTED_BY_PAGE_SIZE: Record<string, true> = { list: true, search: true, permlist: true };

/** Top-level projection entries; commas inside a nested selection do not split. */
export function fieldEntries(fields: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of fields) {
    if (char === "," && depth === 0) { entries.push(current); current = ""; continue; }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    current += char;
  }
  if (current) entries.push(current);
  return entries;
}

/** A nested selection is priced as one group (2), a bare field as 1. */
export function driveFieldCost(fields: string): number {
  return fieldEntries(fields).reduce((sum, entry) => sum + (entry.includes("(") ? DRIVE_COST_FIELD_GROUP : DRIVE_COST_FIELD), 0);
}

export function driveCostResource(input: string): DriveCostResource {
  const url = new URL(input, "https://www.googleapis.com/drive/v3");
  if (url.searchParams.get("alt") === "media") return "flat";
  if (url.pathname.includes("/generateIds")) return "flat";
  if (url.pathname.includes("/about")) return "about";
  if (url.pathname.endsWith("/changes")) return "list";
  if (url.pathname.endsWith("/permissions")) return "permlist";
  if (url.pathname.endsWith("/files")) return url.searchParams.get("q") ? "search" : "list";
  return "get";
}

/** What Google charges for one request, in quota units: the documented flat
 * per-method cost, independent of projection size or page size.
 * https://developers.google.com/workspace/drive/api/guides/limits */
export function driveRequestCost(input: string, method = "GET"): number {
  const url = new URL(input, "https://www.googleapis.com/drive/v3");
  const path = url.pathname;
  const write = /^(post|patch|put|delete)$/i.test(method);
  if (path.endsWith("/changes/startPageToken") || path.includes("/generateIds") || path.includes("/listLabels")) return DRIVE_UNIT_OTHER;
  if (path.endsWith("/changes")) return DRIVE_UNIT_LIST;
  if (path.includes("/about")) return DRIVE_UNIT_READ;
  if (path.endsWith("/permissions")) return write ? DRIVE_UNIT_EDIT : DRIVE_UNIT_LIST;
  if (url.searchParams.get("alt") === "media") return DRIVE_UNIT_DOWNLOAD;
  if (path.endsWith("/files")) return write ? DRIVE_UNIT_EDIT : DRIVE_UNIT_LIST;
  return write ? DRIVE_UNIT_EDIT : DRIVE_UNIT_READ;
}

/** Pboard's pre-flight projection of a request. Diagnostics only; never
 * charged, because page size is not part of Google's pricing. */
export function driveProjectedCost(input: string): number {
  const url = new URL(input, "https://www.googleapis.com/drive/v3");
  const resource = driveCostResource(input);
  if (resource === "flat") return DRIVE_COST_BASE;
  let cost = DRIVE_COST_BASE + driveFieldCost(url.searchParams.get("fields") ?? "");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "0");
  if (COSTED_BY_PAGE_SIZE[resource] && Number.isFinite(pageSize)) cost += pageSize;
  if (url.searchParams.get("pageToken")) cost += DRIVE_COST_PAGETOKEN;
  return cost;
}

/**
 * A spend signature: the *shape* of a request, with the per-board arguments
 * folded away. Attribution has to group a loop's requests together — a listing
 * of three different board folders is one loop spending three times, not three
 * unrelated things — while still naming the loop well enough to go find it.
 */
export function driveRequestSignature(input: string, method = "GET"): string {
  const url = new URL(input, "https://www.googleapis.com/drive/v3");
  const path = url.pathname
    .replace(/^\/upload\/drive\/v3\//, "upload/")
    .replace(/^\/drive\/v3\//, "")
    // Resource ids vary per file; the endpoint they belong to is the useful part.
    .split("/")
    .map((segment) => (segment.length > 16 ? "*" : segment))
    .join("/");
  const query = url.searchParams.get("q");
  const detail = url.searchParams.get("alt") === "media"
    ? " media"
    : query
      // Keep the predicate, drop the quoted ids and names it is applied to.
      ? `?q=${query.replace(/'[^']*'/g, "'…'").slice(0, 44)}`
      : url.pathname.endsWith("/changes") && url.searchParams.get("pageToken")
        ? "?cursor"
        : "";
  return `${method.toUpperCase()} ${path}${detail}`;
}

/** Quota units and request count charged to one `driveRequestSignature`. */
export type DriveQuotaSpend = { signature: string; units: number; requests: number };

export type DriveQuotaFailure = {
  reason: string;
  metric?: string;
  limit?: string;
  consumer?: string;
  secondDelayRange?: [number, number];
};

/** `rateLimitExceeded` on the Total Query Cost metric is a quota denial, not a permission denial. */
export function parseQuotaFailure(detail: string): DriveQuotaFailure | null {
  if (!/rateLimitExceeded|Quota exceeded for quota metric/i.test(detail)) return null;
  const range = detail.match(/second delays \((\d+)-(\d+) seconds\)/);
  return {
    reason: (detail.match(/rateLimitExceeded/i) ? "rateLimitExceeded" : "quotaExceeded"),
    metric: detail.match(/quota metric '([^']+)'/)?.[1],
    limit: detail.match(/limit '([^']+)'/)?.[1],
    consumer: detail.match(/consumer '([^']+)'/)?.[1],
    secondDelayRange: range ? [Number(range[1]), Number(range[2])] : undefined
  };
}

export function isDriveQuotaFailure(detail: string): boolean {
  return parseQuotaFailure(detail) !== null;
}

export class DriveQuotaExceededError extends Error {
  readonly cost: number;
  readonly waitMs: number;
  readonly failure: DriveQuotaFailure;

  constructor(message: string, failure: DriveQuotaFailure, cost: number, waitMs: number, cause?: Error) {
    super(message);
    this.name = "DriveQuotaExceededError";
    this.failure = failure;
    this.cost = cost;
    this.waitMs = waitMs;
    if (cause) this.cause = cause;
  }
}

/**
 * Keep the existing `Google Drive request failed (403): rateLimitExceeded: …` message
 * and append the accounting the throttle actually holds. The projection is a model
 * that must stay reported as such, and it keeps quota distinguishable from a permission
 * denial, so callers that flatten 403 into a revoked role check this first.
 */
export function driveQuotaError(status: number, detail: string, throttle: DriveQuotaThrottle, projectedCost = 0): Error {
  const failure = parseQuotaFailure(detail);
  const base = `Google Drive request failed (${status})${detail ? `: ${detail}` : ""}`;
  if (!failure) return new Error(base);
  const observation = throttle.reserve(projectedCost);
  const projected = throttle.snapshot();
  const accounted = projected.charged + projectedCost;
  // Google can deny a request while the local window is still inside the budget, so
  // the message states the relation that holds instead of claiming an overshoot.
  // The overshoot branch says "projected" because a request the window cannot hold
  // is never booked: the ledger still holds only `projected.charged`.
  const budget = accounted > projected.limit
    ? `projected cost ${accounted} > limit ${projected.limit}`
    : `charged ${accounted} of limit ${projected.limit}`;
  // The advertised cooldown wins when it is longer than the local window reset.
  const waitMs = Math.max(observation.waitMs, driveSecondDelayMs(detail) ?? 0);
  // Name the spend, not just the total: a denial that says only "charged 175525"
  // cannot be acted on, and the loop that spent it is otherwise found by reading
  // every caller. Two shapes are enough to point at a loop, and the window is
  // quoted so the rate is not overstated by a partial window.
  const windowMs = Math.max(1, projected.windowMs);
  const spenders = projected.spend.slice(0, 2).map((entry) => `${entry.signature} ${entry.units}u/${entry.requests}req`).join(", ");
  const attribution = spenders
    ? `${projected.requests} requests in ${windowMs}ms, largest: ${spenders}`
    : `${projected.requests} requests in ${windowMs}ms`;
  return throttle.cooldown(new DriveQuotaExceededError(`${base}; drive quota ledger: ${budget} units/min for this context only (${attribution}; assumed account figure ${projected.accountLimit}, which the Cloud console may set lower) — Google's metric also counts this account's other devices and short-window rate checks; retry after ${waitMs}ms`, failure, accounted, waitMs));
}

export type DriveQuotaObservation = { cost: number; waitMs: number };
export type DriveQuotaEvent = { type: "defer" | "observed"; projected: number; cost: number; waitMs: number };
export type DriveQuotaSnapshot = {
  /** What this context defers at *now* — the live ceiling, which falls under
   * denial from `DRIVE_CONTEXT_COST_BUDGET` toward `DRIVE_MIN_COST_PER_MINUTE`. */
  limit: number;
  /** The budget this context started the session with, before any backoff. */
  configuredLimit: number;
  /** The documented per-user figure, for comparison with the Cloud console — an
   * assumption, not a measurement of this project's quota. */
  accountLimit: number;
  /** When the current window opened, so a spend rate can be quoted honestly. */
  windowStart: number;
  /** How long the current window has been running, in milliseconds. */
  windowMs: number;
  charged: number;
  requests: number;
  deferrals: number;
  lastWaitMs: number;
  /** This window's spend by request shape, largest first. */
  spend: DriveQuotaSpend[];
};

export interface DriveQuotaThrottle {
  /** Record a real Google denial, independently of the local cost estimate. */
  cooldown(error: DriveQuotaExceededError): DriveQuotaExceededError;
  /** Projection against the current window; computes a deferral, never refuses. */
  reserve(projectedCost: number): DriveQuotaObservation;
  /** Sleeps on projected exhaustion; rejects with the saved quota error during a server cooldown. */
  acquire(projectedCost: number, signal?: AbortSignal | null): Promise<DriveQuotaObservation>;
  /**
   * Corrects the projection that `acquire` booked with the real
   * `X-Drive-Request-Cost`; an observation without an acquire books nothing.
   * `signature` (see `driveRequestSignature`) attributes the charge to a request
   * shape so a denial can name the loop that caused it; requests that fail
   * before a response are counted but not attributed.
   */
  observe(projectedCost: number, headers?: Headers | null, signature?: string): number;
  /**
   * Drop a recorded Google denial so the next caller actually reaches Drive.
   * The charged window stays: this clears the wait, never the accounting. An
   * explicit dismissal also restarts the denial escalation, because a user who
   * dismisses a failure to watch whether it returns must not be held at the
   * five-minute ceiling by the very failure they dismissed.
   */
  clearCooldown(): void;
  snapshot(): DriveQuotaSnapshot;
}

export function createDriveQuotaThrottle(options: {
  maxCostPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  log?: (event: DriveQuotaEvent) => void;
} = {}): DriveQuotaThrottle {
  const limit = options.maxCostPerMinute ?? DRIVE_CONTEXT_COST_BUDGET;
  /**
   * The figure `acquire` actually defers at. It starts at `limit` and falls to
   * `DRIVE_MIN_COST_PER_MINUTE` as Google denies this context, then walks back.
   *
   * `DRIVE_DEFAULT_COST_PER_MINUTE` is a documented figure, not this project's
   * measured one: a project's effective per-user quota can be lower (unverified
   * OAuth consent, a granted quota override elsewhere, a shared billing account),
   * and other devices spend the same bucket. A denial while the local window is
   * well inside the assumed budget is evidence the assumption is wrong, and the
   * only honest response to it is to spend less — waiting for a human to read the
   * Cloud console does not stop the requests that are being refused now.
   */
  let ceiling = limit;
  const now = options.now ?? Date.now;
  const log = options.log;
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }));

  let windowStart = now();
  let charged = 0;
  let requests = 0;
  let deferrals = 0;
  let lastWaitMs = 0;
  let blockedUntil = 0;
  let lastDenial = -Infinity;
  let denials = 0;
  let quotaError: DriveQuotaExceededError | undefined;
  /**
   * Requests `acquire` booked that `observe` has not accounted for yet, oldest
   * first.
   *
   * A queue rather than one slot: several requests are in flight at once (a
   * roster read downloads peer records in parallel, a reconcile round reads
   * several boards), and with a single slot a response corrected whatever the
   * most recent acquire had booked — including a different request's — and a
   * second `observe` for one response charged the difference a second time,
   * because nothing marked the first correction as done. Matching the oldest
   * booking is exact for the serialized traffic that dominates, and keeps the
   * window total right whatever the completion order.
   */
  const pending: number[] = [];
  /** Requests that never saw a response must not grow the queue without bound. */
  const MAX_UNOBSERVED = 256;

  /** This window's charged units per request shape; bounded below. */
  const spendBySignature = new Map<string, DriveQuotaSpend>();
  const MAX_SPEND_SIGNATURES = 40;
  function charge(signature: string | undefined, units: number) {
    const key = signature ?? "unattributed";
    const entry = spendBySignature.get(key);
    if (entry) { entry.units += units; entry.requests += 1; return; }
    // A context touching more distinct shapes than this will not be diagnosed by
    // the fortieth of them; `charged` and `requests` still count everything.
    if (spendBySignature.size >= MAX_SPEND_SIGNATURES) return;
    spendBySignature.set(key, { signature: key, units, requests: 1 });
  }
  const rollWindow = () => {
    if (now() - windowStart >= DRIVE_COST_WINDOW_MS) {
      // A window that closed without a denial earns back a quarter of the gap to
      // the configured budget: recovery is fast enough to be useful the same
      // session and slow enough that a genuinely smaller quota re-triggers the
      // backoff instead of being overrun each minute.
      if (ceiling < limit) ceiling = Math.min(limit, ceiling + Math.max(1_000, Math.ceil((limit - ceiling) / 4)));
      windowStart = now();
      charged = 0;
      spendBySignature.clear();
      // Bookings from the closed window are not corrected into the new one; the
      // requests themselves are already counted where they were spent.
      pending.length = 0;
    }
  };

  function reserve(projectedCost: number): DriveQuotaObservation {
    rollWindow();
    return { cost: projectedCost, waitMs: charged + projectedCost <= ceiling ? 0 : windowStart + DRIVE_COST_WINDOW_MS - now() };
  }

  async function acquire(projectedCost: number, signal?: AbortSignal | null): Promise<DriveQuotaObservation> {
    // Do not queue timer/poll attempts for a burst when the cooldown ends.
    // Only a real response records another denial and increases the backoff.
    if (quotaError && now() < blockedUntil) throw withWait(quotaError, blockedUntil - now());
    const observation = reserve(projectedCost);
    if (observation.waitMs > 0 && !signal?.aborted) {
      deferrals += 1;
      lastWaitMs = observation.waitMs;
      log?.({ type: "defer", projected: projectedCost, cost: projectedCost, waitMs: observation.waitMs });
      await sleep(observation.waitMs, signal);
    }
    if (quotaError && now() < blockedUntil) throw withWait(quotaError, blockedUntil - now());
    rollWindow();
    requests += 1;
    while (pending.length >= MAX_UNOBSERVED) pending.shift();
    pending.push(projectedCost);
    charged += projectedCost;
    return observation;
  }

  function observe(projectedCost: number, headers?: Headers | null, signature?: string): number {
    const header = headers?.get?.("X-Drive-Request-Cost");
    // An absent or blank header is not a zero cost; the projection stands.
    const reported = header ? Number(header) : NaN;
    const cost = Number.isFinite(reported) ? reported : projectedCost;
    rollWindow();
    // An observation with no booked projection is a report, not a charge: a
    // read-only accounting pass must not consume budget, and must not be
    // attributed to a shape as if it had been sent.
    const booked = pending.shift();
    if (booked !== undefined) {
      charged += cost - booked;
      charge(signature, cost);
    }
    log?.({ type: "observed", projected: projectedCost, cost, waitMs: lastWaitMs });
    return cost;
  }

  function snapshot(): DriveQuotaSnapshot {
    // Reading the ledger closes an expired window first: a report of `windowMs`
    // longer than the window, or of a ceiling that a rolled window would have
    // earned back, is worse than no report.
    rollWindow();
    return {
      limit: ceiling, configuredLimit: limit, accountLimit: DRIVE_DEFAULT_COST_PER_MINUTE,
      windowStart, charged, requests, deferrals, lastWaitMs,
      windowMs: Math.max(0, now() - windowStart),
      spend: [...spendBySignature.values()].sort((left, right) => right.units - left.units)
    };
  }

  function withWait(error: DriveQuotaExceededError, waitMs: number) {
    return new DriveQuotaExceededError(error.message.replace(/retry after \d+ms$/, `retry after ${waitMs}ms`), error.failure, error.cost, waitMs);
  }
  function cooldown(error: DriveQuotaExceededError) {
    // Only a real Google response reaches here. Halve the ceiling whatever the
    // local window looked like: the request was refused, and refusing to spend
    // less is how a denied account stays denied.
    // The floor never exceeds the configured budget, which a test or an embedder
    // may set far below it.
    ceiling = Math.max(Math.min(DRIVE_MIN_COST_PER_MINUTE, limit), Math.floor(ceiling / 2));
    if (now() - lastDenial > DRIVE_QUOTA_MAX_COOLDOWN_MS) denials = 0;
    const delay = Math.min(DRIVE_QUOTA_MAX_COOLDOWN_MS, DRIVE_COST_WINDOW_MS * 2 ** Math.min(denials++, 3));
    lastDenial = now();
    blockedUntil = Math.max(blockedUntil, now() + delay, now() + error.waitMs);
    quotaError = withWait(error, blockedUntil - now());
    return quotaError;
  }
  function clearCooldown() {
    blockedUntil = 0;
    denials = 0;
    quotaError = undefined;
  }
  return { reserve, acquire, observe, snapshot, cooldown, clearCooldown };
}

/** One ledger per JS context. Google's quota also includes other contexts/devices. */
let shared: DriveQuotaThrottle | undefined;
export function defaultDriveQuotaThrottle(): DriveQuotaThrottle {
  if (!shared) shared = createDriveQuotaThrottle();
  return shared;
}

/**
 * Publish this context's ledger as `pboardDriveQuota()` in the console.
 *
 * The work counters behind `pboardCounters` are compiled out of a production
 * build, so when Google denies a request there is normally nothing to read
 * except the one line the error carries. The ledger is always collected, and a
 * rate limit is a *sustained* condition: reading `charged`, `requests` and
 * `spend` while the board is idle says whether something is still looping,
 * without waiting for the next denial to print itself.
 */
export function exposeDriveQuotaDiagnostics(): void {
  const target = globalThis as { pboardDriveQuota?: () => DriveQuotaSnapshot };
  target.pboardDriveQuota = () => defaultDriveQuotaThrottle().snapshot();
}

/**
 * Let this context's next Drive request go out instead of replaying the stored
 * denial. Backs the sidebar's "clear error" action, which is the way to find out
 * whether Google still denies the request or whether the failure was a transient
 * window. The charged unit window is deliberately untouched, so the ledger keeps
 * counting; if the limit is still exhausted, the next attempt is denied again and
 * the error reappears.
 */
export function clearDriveQuotaCooldown(): void {
  defaultDriveQuotaThrottle().clearCooldown();
}
