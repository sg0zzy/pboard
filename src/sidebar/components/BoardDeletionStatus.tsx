import { useEffect, useState } from "react";
import { repository } from "../../storage/browser";
import type { BoardCleanupState } from "../../storage/boardCleanup";

/**
 * The deletion report: what happened to the Drive folder of boards this device
 * deleted.
 *
 * A deletion is two steps — the tombstone (the decision, always durable) and
 * the folder move (Drive's half, which can wait for an outage, a role check, or
 * a browser restart). The board row is gone by the time the second step runs,
 * so there is no board panel left to put this in. It goes where the board's own
 * sync status is reported — beside `DriveSyncControls` in the header — because
 * that is the last place the person saw this board ("Synchronization pending")
 * before removing it.
 *
 * Nothing renders in the steady state: a confirmed Trash is silent, and a device
 * that owed no cleanup — a collaborator's leave, or a board deleted before this
 * existed — shows nothing at all. The record is re-read whenever the journal
 * changes, which is the only thing that writes it and already crosses contexts
 * (the worker is usually the one performing the move), so no polling and no
 * second channel is introduced.
 */
export function BoardDeletionStatus() {
  const [pending, setPending] = useState<{ boardId: string; cleanup: BoardCleanupState }[]>([]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    const read = async () => {
      try {
        const rows = await repository.boardCleanupReport!();
        // The report is already ordered by the repository's own scan; sorting
        // keeps the line stable if that ever stops being true.
        if (active) setPending([...rows].sort((a, b) => a.boardId.localeCompare(b.boardId)));
      } catch {
        if (active) setPending([]);
      }
    };
    // Both calls are capabilities, not assumptions: a storage backend (or a
    // host that replaced the facade) without the record owes no cleanup, which
    // is the silent state this component renders as nothing.
    const report = repository.boardCleanupReport;
    const subscribe = repository.subscribeBoardCleanups;
    if (typeof report !== "function") return () => { active = false; };
    void read();
    if (typeof subscribe !== "function") return () => { active = false; };
    // `Promise.resolve` on both edges: a host may answer the subscription
    // synchronously, and an unsubscribe is only ever called once either way.
    void Promise.resolve(subscribe.call(repository, rows =>
      { if (active) setPending([...rows].sort((a, b) => a.boardId.localeCompare(b.boardId))); }))
      .then(unsubscribe => { if (active) stop = unsubscribe; else unsubscribe(); })
      .catch(() => undefined);
    return () => { active = false; stop?.(); };
  }, []);

  if (!pending.length) return null;
  const failed = pending.filter(row => row.cleanup.stage === "failed");
  const subject = pending.length === 1
    ? `${pending[0].cleanup.name ? `“${pending[0].cleanup.name}”` : "A board"} was`
    : `${pending.length} boards were`;
  return (
    <p className="deletion-cleanup-status" role="status" data-cleanup-stage={failed.length ? "failed" : "pending"}>
      {failed.length
        ? `${subject} removed. Clearing the Google Drive folder failed and will be retried: ${failed[0].cleanup.reason ?? "Google Drive did not answer"}`
        : `${subject} removed. Clearing the Google Drive folder is pending.`}
    </p>
  );
}
