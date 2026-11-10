/**
 * Moving a deleted board's Drive folder to Trash — the second half of the
 * deletion state machine.
 *
 * The first half (`storage/boardTombstone.ts`) is the decision, written durably
 * and replicated. This half acts on it, once, against this device's Drive
 * account, and it is deliberately paranoid:
 *
 * - it runs only for a board whose latest tombstone fact, in the account list
 *   that wrote the cleanup record, is a **deletion**;
 * - it addresses the folder by a **verified id**, never by a name search; an id
 *   it does not already hold is resolved with the create-free listing
 *   (`DriveBoardStore.boardFolderCandidates`), which cannot mint a folder;
 * - before the write it re-reads that id and refuses unless the folder is named
 *   after this board, is a child of this account's `/pboard` root, and Drive
 *   reports this account as its **owner**;
 * - it moves the folder to **Trash** (never a permanent delete), and confirms
 *   the result before recording success. A folder Drive no longer serves, or
 *   serves as trashed, is confirmed — it is not a failure;
 * - a failure records the reason and keeps the intent, so the next scheduled
 *   attempt is a retry of one known folder rather than a Drive enumeration.
 *
 * Nothing here runs at startup or on a board open; the caller is the reconcile
 * round's cleanup pass (`sync/runtime.ts`), which is the scheduler Drive work
 * already rides.
 */
import { isDriveGone } from "./driveHttp";
import { boardFolderName, type DriveBoardStore } from "./driveBoardStore";
import { boardCleanupDue } from "../storage/boardCleanup";
import type { ChangeJournal } from "../storage/changeJournal";

/** Which safety rule stopped an attempt. Reported verbatim to the UI, so the
 *  reason a folder was left alone is never guessed. */
export type BoardCleanupRefusal = "not-tombstoned" | "not-owner" | "root-folder" | "foreign-folder";

export type BoardCleanupOutcome =
  /** Nothing was owed, or the retry window has not opened; no Drive request. */
  | { status: "skipped"; reason: string }
  /** A safety rule refused; **nothing was written, here or on Drive**. */
  | { status: "refused"; refusal: BoardCleanupRefusal; reason: string }
  /** Every folder this board had is in Trash (or was already gone). */
  | { status: "trashed"; folderIds: string[]; alreadyTrashed: boolean }
  /** The attempt failed; the intent is retained and scheduled. */
  | { status: "failed"; reason: string };

/** What the executor needs from the journal: the cleanup record, the tombstone
 *  it is authorised by, and the two recorders. Narrow on purpose — the pass
 *  must not be able to reach any other store. */
type CleanupJournal = Pick<ChangeJournal,
  "boardCleanup" | "boardTombstone" | "confirmBoardCleanup" | "failBoardCleanup">;

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Attempts the pending cleanup for one board.
 *
 * Idempotent: a confirmed board performs no Drive request at all, a folder
 * already in Trash confirms without a write, and a retry re-uses the folder id
 * the previous attempt verified so it does not have to list the root again.
 */
export async function runBoardCleanup(input: {
  boardId: string;
  journal: CleanupJournal;
  store: DriveBoardStore;
  /** A forced round (worker cold start, Sync now) ignores the backoff window. */
  force?: boolean;
  /** Injected clock, epoch ms; tests drive the retry ladder with it. */
  now?: number;
  /**
   * The Google account this context is connected as, or null when none is
   * connected. Passed in rather than read here so the executor has no auth
   * dependency; `undefined` means "the caller did not scope the account" and
   * skips the check.
   *
   * The check matters in both directions. With **no** account connected the
   * attempt is skipped, not failed: an offline browser must not spend the
   * backoff ladder on a network it does not have. With a **different** account
   * connected the attempt is skipped too — that account's `/pboard` is not the
   * one that holds this folder, and answering "no folder, confirmed" against it
   * would settle a cleanup that never happened.
   */
  account?: string | null;
}): Promise<BoardCleanupOutcome> {
  const { boardId, journal, store } = input;
  const now = input.now ?? Date.now();
  const at = new Date(now).toISOString();

  const record = await journal.boardCleanup(boardId);
  if (!record) return { status: "skipped", reason: "This device owes no Drive cleanup for the board" };
  if (input.account !== undefined) {
    if (!input.account) return { status: "skipped", reason: "Google Drive is not connected" };
    if (record.accountId && record.accountId !== input.account) {
      return { status: "skipped", reason: "The cleanup belongs to a different Google account" };
    }
  }
  if (!boardCleanupDue(record, input.force === true, now)) {
    return { status: "skipped", reason: "Waiting for the next Drive cleanup attempt" };
  }
  // The tombstone is the authorisation. Checked before anything is resolved or
  // written, so a live board's folder can never be touched even if a stale
  // cleanup record survived a restore.
  if (!(await journal.boardTombstone(boardId, record.accountId)).deleted) {
    return { status: "refused", refusal: "not-tombstoned", reason: "The board is not tombstoned; its Google Drive folder was left alone" };
  }

  let verified: string[] = [];
  try {
    const rootId = await store.existingRootFolder();
    // No `/pboard` root under this account means this account holds no copy of
    // the board's folder: there is nothing to move, and nothing to look up.
    if (!rootId) {
      await journal.confirmBoardCleanup(boardId, [], at);
      return { status: "trashed", folderIds: [], alreadyTrashed: true };
    }
    const known = record.folderId ? [record.folderId] : await store.boardFolderCandidates(boardId);
    if (!known.length) {
      // Drive lists no live folder for this board. That is the terminal state a
      // Trash produces (and the state of a board whose folder never existed), so
      // it is confirmed rather than retried: no later attempt could differ.
      await journal.confirmBoardCleanup(boardId, [], at);
      return { status: "trashed", folderIds: [], alreadyTrashed: true };
    }
    // Every candidate must pass every rule before a single write happens; a set
    // that is half this board's is not a set to act on.
    for (const folderId of known) {
      if (folderId === "root" || folderId === rootId) {
        return { status: "refused", refusal: "root-folder", reason: "The board folder resolved to the pboard root; nothing was trashed" };
      }
      let state: Awaited<ReturnType<DriveBoardStore["folderState"]>>;
      try {
        state = await store.folderState(folderId);
      } catch (error) {
        // Drive no longer serves the id: it is in Trash or permanently gone.
        // Drive never reuses an id, so this is terminal, not a retry.
        if (isDriveGone(error)) continue;
        throw error;
      }
      if (state.trashed) continue;
      if (state.name !== boardFolderName(boardId) || !state.parents.includes(rootId)) {
        return { status: "refused", refusal: "foreign-folder", reason: "The folder is not this board's pboard folder; nothing was trashed" };
      }
      if (state.role !== "owner") {
        return { status: "refused", refusal: "not-owner", reason: "Google Drive does not report this account as the board folder's owner; nothing was trashed" };
      }
      verified.push(folderId);
    }
    if (!verified.length) {
      // Every id was already trashed or gone.
      await journal.confirmBoardCleanup(boardId, known, at);
      return { status: "trashed", folderIds: known, alreadyTrashed: true };
    }
    for (const folderId of verified) await store.trashFile(folderId);
    // Confirmation, not assumption. The read is per id and cannot be satisfied
    // by a listing: it answers whether Drive itself considers the folder trashed.
    for (const folderId of verified) {
      try {
        const state = await store.folderState(folderId);
        if (!state.trashed) throw new Error("Google Drive did not move the board folder to Trash");
      } catch (error) {
        if (!isDriveGone(error)) throw error;
      }
    }
    await journal.confirmBoardCleanup(boardId, verified, at);
    return { status: "trashed", folderIds: verified, alreadyTrashed: false };
  } catch (error) {
    const reason = describe(error);
    // A verified id is kept on the failure so the retry re-checks that one
    // folder instead of listing the root again.
    await journal.failBoardCleanup(boardId, reason, at, now, verified[0]);
    return { status: "failed", reason };
  }
}

/**
 * The reconcile round's cleanup pass: every board this device still owes, one
 * attempt each. Failures and refusals are recorded per board and never thrown,
 * so one stuck folder cannot fail a round or delay a board open.
 */
export async function runPendingBoardCleanups(input: {
  journal: CleanupJournal & Pick<ChangeJournal, "pendingBoardCleanups">;
  store: DriveBoardStore;
  force?: boolean;
  now?: number;
  /**
   * Resolved lazily, and only once something is owed. Reading the connected
   * account costs a Drive identity check, and this pass runs at the front of
   * every reconcile round: a round with nothing to clean up must not pay it,
   * and must not perturb the ordering of the round's other work either.
   */
  account?: () => Promise<string | null>;
}): Promise<BoardCleanupOutcome[]> {
  const pending = await input.journal.pendingBoardCleanups();
  if (!pending.length) return [];
  const account = input.account ? await input.account().catch(() => null) : undefined;
  const outcomes: BoardCleanupOutcome[] = [];
  for (const { boardId } of pending) {
    outcomes.push(await runBoardCleanup({ boardId, journal: input.journal, store: input.store,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(account === undefined ? {} : { account }) }).catch(error => ({ status: "failed" as const, reason: describe(error) })));
  }
  return outcomes;
}
