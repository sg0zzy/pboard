/** Local persistence and available WebRTC delivery are immediate. These timers
 * govern automatic Drive work only; explicit Sync now bypasses the flush delay. */
export const DRIVE_EDIT_IDLE_MS = 30 * 60_000;
export const DRIVE_MAX_UNPUBLISHED_MS = 25 * 60_000;
export const DRIVE_POLL_MS = 10 * 60_000;
export const DRIVE_POLL_MAX_MS = 60 * 60_000;

export function driveFlushAt(oldest: number, latest: number, idleMs = DRIVE_EDIT_IDLE_MS, maxAgeMs = DRIVE_MAX_UNPUBLISHED_MS): number {
  return Math.min(latest + idleMs, oldest + maxAgeMs);
}

/** Positive jitter keeps fallback polling at least ten minutes apart. */
export function drivePollDelay(attempt = 0, random = Math.random(), minimum = DRIVE_POLL_MS, maximum = DRIVE_POLL_MAX_MS): number {
  const ceiling = Math.max(minimum, maximum);
  const base = Math.min(ceiling, minimum * 2 ** Math.min(Math.max(attempt, 0), 16));
  return Math.min(ceiling, Math.ceil(base * (1 + 0.2 * Math.max(0, Math.min(1, random)))));
}

export function dirtyFlushAt(state: { firstDirtyAt?: string; dirtyAt?: string }, now = Date.now()): number {
  const latest = Date.parse(state.dirtyAt ?? '');
  const oldest = Date.parse(state.firstDirtyAt ?? state.dirtyAt ?? '');
  return driveFlushAt(Number.isFinite(oldest) ? oldest : now, Number.isFinite(latest) ? latest : now);
}
