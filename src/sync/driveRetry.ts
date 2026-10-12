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

/** Exponential backoff with jitter; a delta-seconds `Retry-After` wins, capped at 10s. */
export function driveRetryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 10) * 1000;
  const cap = Math.min(500 * 2 ** attempt, 8000);
  return cap / 2 + Math.random() * (cap / 2);
}
