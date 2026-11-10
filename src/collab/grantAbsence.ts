/**
 * Negative cache for `GET /grants/<scope>` answers of 404.
 *
 * The relay publishes a board grant only while the authority browser is open
 * and renewing it, so a 404 means "not published *right now*" — a state that
 * can resolve (the owner opens the board) but just as often cannot (the board
 * has never had a grant published, and no authority browser is coming). Before
 * this cache existed, every caller treated a 404 as "ask again immediately",
 * and a browser pointed at a never-published board polled it in a tight loop —
 * ten identical requests at fifteen-millisecond spacing observed in the field,
 * spending the very automatic-auth budget that other boards need.
 *
 * The cache therefore keeps the *ask* bounded (retry at most once per backoff
 * window, capped at one minute) while the *answer* stays honest: the recorded
 * reason names the action that can actually resolve the state (open the board
 * on the device that owns it), and the deliberate retry paths — the Reconnect
 * action — clear the record so a person pressing a button is never served a
 * cached refusal.
 */

const MAX_WINDOW_MS = 60_000;
const BASE_WINDOW_MS = 1_000;

type Absence = { boardId: string; attempts: number; retryAt: number; expired: boolean };
const absences = new Map<string, Absence>();
// Boards this context has actually been served a grant for. The relay cannot
// tell "expired" from "never published" — both are 404 — but this browser can:
// if a grant for this key was served before, a 404 now means the five-minute
// lifetime lapsed while the authority browser slept. Without this split the
// diagnostics called an expired grant "not yet", which is why the joiner's
// polite forever-poll looked intentional.
const servedBoards = new Set<string>();

const windowFor = (attempts: number) => Math.min(MAX_WINDOW_MS, BASE_WINDOW_MS * 2 ** Math.min(attempts - 1, 6));

/** Why is this scope not readable right now, and in how long may the caller
 * ask again? Returns null when the caller may go to the network. */
export function grantAbsenceReason(scope: string, boardId: string): string | null {
  const entry = absences.get(scope);
  if (!entry) return null;
  const waitMs = entry.retryAt - Date.now();
  if (waitMs <= 0) return null;
  return `${boardGrantAbsentMessage(boardId)} (re-checking in at most ${Math.ceil(waitMs / 1000)} s)`;
}

/** Records that the service answered 404 for this scope; returns the reason to
 * throw. Every attempt doubles the retry window up to one minute, so a poll
 * that can never succeed settles into once a minute, never a burst. */
export function noteGrantAbsent(scope: string, boardId: string): string {
  const entry = absences.get(scope) ?? { boardId, attempts: 0, retryAt: 0, expired: false };
  // A record may predate this context ever being served; the flag tracks the
  // moment the answer changed from "not yet" to "not any more".
  entry.expired ||= servedBoards.has(boardId);
  entry.attempts++;
  entry.retryAt = Date.now() + windowFor(entry.attempts);
  absences.set(scope, entry);
  return boardGrantAbsentMessage(boardId);
}

/** Records that this context actually read this board's grant once. The
 * relay cannot tell "expired" from "never published" (both are 404); this
 * set is what lets the diagnostics name an expired grant when a later 404
 * follows a served one. */
export function noteGrantServed(boardId: string): void { servedBoards.add(boardId); }

/** Forgets the record for a board: a deliberate retry (the Reconnect action)
 * must reach the service, not a cached answer. */
export function clearGrantAbsence(boardId: string): void {
  for (const [scope, entry] of absences) if (entry.boardId === boardId) absences.delete(scope);
}

/** What the console (`pboardCollaboration()`) reports about absent grants:
 * the retry window and — the part the relay cannot answer — whether this key
 * was served before (`expired`) or never has been (`never-published`). */
export function grantAbsenceSnapshot(): Record<string, { boardId: string; attempts: number; retryInMs: number; reason: 'expired' | 'never-published' }> {
  const now = Date.now();
  const snapshot: Record<string, { boardId: string; attempts: number; retryInMs: number; reason: 'expired' | 'never-published' }> = {};
  for (const [scope, entry] of absences) snapshot[scope] = { boardId: entry.boardId, attempts: entry.attempts, retryInMs: Math.max(0, entry.retryAt - now), reason: entry.expired ? 'expired' : 'never-published' };
  return snapshot;
}

/** Test seam. */
export function clearAllGrantAbsences(): void { absences.clear(); servedBoards.clear(); }

const boardGrantAbsentMessage = (boardId: string) =>
  `Board grant expired. The original authority browser must be online to renew it. ` +
  `No grant is currently published for ${boardId.slice(0, 8)} (the authority browser publishes it only while open); ` +
  `polling it is rate-limited in this browser, so open the board on the device that owns it, or use Reconnect to retry now.`;
