/**
 * The Drive half of a board deletion: what happened to the board's *folder*.
 *
 * A tombstone (`storage/boardTombstone.ts`) is the deletion decision and is
 * replicated, causally ordered, and retained forever. Moving the folder to
 * Drive Trash is a different kind of fact: it is performed by one device
 * against one Drive account, it can fail for reasons that have nothing to do
 * with the deletion (an outage, a revoked role, an ambiguous folder), and a
 * later attempt by the same or another device is idempotent. It therefore lives
 * **beside** the facts, in the same per-board row, as a small device-local
 * record — never as a tombstone fact, so it can never participate in the
 * deleted/restored ordering, and never as a `BoardErasure` receipt, which is
 * the *permanent* erasure operation (local purge plus private-backup removal)
 * and a different decision entirely.
 *
 * ## The state machine
 *
 * ```
 *            begin                trash + confirm
 *   (none) --------> pending ------------------> trashed   (terminal)
 *                       |  ^
 *          attempt fails|  | next attempt due
 *                       v  |
 *                     failed
 * ```
 *
 * - `pending` — the board is tombstoned and this device owes its folder a move
 *   to Trash. Written by the repository in the same step that decides to
 *   destroy the board's content, which is always after the tombstone is
 *   durable.
 * - `failed` — the last attempt could not complete. The intent is kept (the
 *   stage is not terminal), `reason` says why, and `attempts`/`nextAttemptAt`
 *   carry the bounded backoff the Drive scheduler obeys.
 * - `trashed` — Drive confirmed the folder is gone (or already was). Terminal:
 *   a second cleanup for the same board performs no Drive request at all.
 *
 * `restored` clears the record rather than moving it: a live board's folder
 * must never be trashed, and the executor refuses a board that is not
 * tombstoned anyway.
 *
 * Everything here is pure. The clock is an argument, never `Date.now()`, so a
 * test can drive the retry ladder without sleeping.
 */

/** Where the folder move stands. `trashed` is the only terminal stage. */
export type BoardCleanupStage = "pending" | "trashed" | "failed";

export type BoardCleanupState = {
  stage: BoardCleanupStage;
  /** The account list whose deletion caused this, for diagnostics only; the
   *  executor reads the tombstone, never this field, to decide eligibility. */
  accountId: string | null;
  /** The board's name when the deletion was made. The board row is gone by the
   *  time the UI reads this, so the name has to travel with the record. */
  name?: string;
  /**
   * The verified Drive folder ids the last successful run moved to Trash.
   * Empty until then; `folderId` is the single id an earlier attempt
   * verified, reused so a retry never has to look the folder up by name.
   */
  folderIds?: string[];
  folderId?: string;
  /** Why the last attempt did not reach `trashed`. User-visible. */
  reason?: string;
  /** Failed attempts so far; drives the backoff and survives a restart. */
  attempts: number;
  /** Epoch ms before which a non-forced attempt is skipped. */
  nextAttemptAt: number;
  /** When `stage` last moved. */
  at: string;
};

/** First delay after a failed attempt. */
export const BOARD_CLEANUP_RETRY_BASE_MS = 30_000;
/** Ceiling of the ladder: one attempt per hour per board, never a loop. */
export const BOARD_CLEANUP_RETRY_MAX_MS = 60 * 60_000;

/**
 * Bounded exponential backoff: 30 s, 1 m, 2 m, 4 m, 8 m, 16 m, 32 m, then one
 * hour. The exponent is capped so the value cannot overflow, and the ceiling
 * makes the cost of a permanently failing board one request per hour — an
 * outage does not turn one known folder into a Drive enumeration.
 */
export function boardCleanupRetryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(Math.floor(attempts), 1) - 1, 10);
  return Math.min(BOARD_CLEANUP_RETRY_MAX_MS, BOARD_CLEANUP_RETRY_BASE_MS * 2 ** exponent);
}

/** The record a deletion writes: due immediately, no attempts yet. */
export function pendingBoardCleanup(accountId: string | null, at: string, now: number, name?: string): BoardCleanupState {
  return { stage: "pending", accountId, ...(name ? { name } : {}), attempts: 0, nextAttemptAt: now, at };
}

/** Confirmed: the folder (or every folder) is in Trash. */
export function confirmedBoardCleanup(record: BoardCleanupState, folderIds: readonly string[], at: string): BoardCleanupState {
  return { ...record, stage: "trashed", folderIds: [...new Set(folderIds)], reason: undefined, nextAttemptAt: 0, at };
}

/**
 * The attempt did not reach `trashed`. The stage is `failed` — not terminal —
 * so the intent and the reason survive the restart, and the next attempt is
 * scheduled rather than run in a loop.
 */
export function failedBoardCleanup(record: BoardCleanupState, reason: string, at: string, now: number): BoardCleanupState {
  const attempts = record.attempts + 1;
  return { ...record, stage: "failed", reason: reason.slice(0, 240), attempts,
    nextAttemptAt: now + boardCleanupRetryDelay(attempts), at };
}

/**
 * Whether an attempt may run now. `trashed` never can; a forced round (the
 * user's "sync now", the background worker's cold start) bypasses the wait but
 * still counts its attempts, so forcing cannot turn into a loop either.
 */
export function boardCleanupDue(record: BoardCleanupState, force: boolean, now: number): boolean {
  if (record.stage === "trashed") return false;
  return force || now >= record.nextAttemptAt;
}

/** Whether the record still represents work this device owes. */
export function boardCleanupOwed(record: BoardCleanupState | null | undefined): boolean {
  return !!record && record.stage !== "trashed";
}
