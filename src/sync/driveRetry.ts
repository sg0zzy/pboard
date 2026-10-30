/**
 * Google documents 429 and 500/502/503/504 (e.g. `internalError`) as transient
 * failures to retry with exponential backoff:
 * https://developers.google.com/workspace/drive/api/guides/handle-errors
 */
export const DRIVE_TRANSIENT_STATUSES: Record<number, true> = { 429: true, 500: true, 502: true, 503: true, 504: true };

/** Total attempts for one transient Drive request. */
export const DRIVE_TRANSIENT_ATTEMPTS = 3;

/**
 * Whether repeating a request cannot duplicate state. POST creates a file or a
 * permission and Google can answer 500 after the write already landed, so a
 * failed POST is surfaced instead of replayed.
 */
export function isDriveReplayableMethod(method?: string): boolean {
  return !method || method === "GET" || method === "HEAD" || method === "DELETE" || method === "PATCH";
}
/**
 * Ceiling for the whole backoff window of one request. A `Retry-After` longer
 * than this is still clamped so a sync cycle cannot stall indefinitely; the
 * quota throttle owns longer cooldowns.
 */
export const DRIVE_TRANSIENT_MAX_TOTAL_MS = 8000;

/** `Retry-After` as delta-seconds or an HTTP date; `nowMs` is only used for dates. */
export function driveRetryAfterMs(retryAfter: string | null, nowMs: number = Date.now()): number | null {
  if (retryAfter === null) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 10) * 1000;
  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.min(date - nowMs, 10_000));
}

/** `second delays (1-30 seconds)` from a rate-limit body; the upper bound of the advertised range. */
export function driveSecondDelayMs(detail: string): number | null {
  const range = detail.match(/second delays \((\d+)-(\d+) seconds\)/);
  if (!range) return null;
  const high = Number(range[2]);
  if (!Number.isFinite(high)) return null;
  return Math.min(Math.max(high, 0), 30) * 1000;
}

/** Backoff for one attempt within the remaining budget; the unbounded value is kept for pins. */
export function driveBoundedRetryDelayMs(
  attempt: number,
  retryAfter: string | null,
  spentMs = 0,
  detail = "",
  nowMs: number = Date.now(),
): number {
  const hint = driveSecondDelayMs(detail) ?? driveRetryAfterMs(retryAfter, nowMs);
  const delay = hint === null ? driveRetryDelayMs(attempt, retryAfter) : hint;
  const remaining = DRIVE_TRANSIENT_MAX_TOTAL_MS - spentMs;
  return remaining > 0 ? Math.min(delay, remaining) : 0;
}

/** Exponential backoff with jitter; a delta-seconds `Retry-After` wins, capped at 10s. */
export function driveRetryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 10) * 1000;
  const cap = Math.min(500 * 2 ** attempt, 8000);
  return cap / 2 + Math.random() * (cap / 2);
}
