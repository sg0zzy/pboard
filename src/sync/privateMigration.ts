/**
 * Legacy AppData migration for Sync v2 (audited module; the one migration
 * mechanism — do not add another).
 *
 * A board moves from invisible `appDataFolder` files into the canonical
 * unified store: `/pboard/<projectId>/board.json.gz` (with `attachments/`),
 * the exact layout regular and shared boards use. A private target folder
 * simply carries no extra ACLs; sharing later changes that folder ACL only.
 * The AppData source is only ever read (and optionally marked read-only);
 * it is never deleted or overwritten before the read-back verification
 * passed the flip, and stays protected for 90 days after it, so an
 * interrupted or mistaken migration is recoverable. Steps are idempotent
 * and resume from persisted state.
 *
 * All Drive interaction is injected (`ensureFolder`/`uploadSnapshot` map
 * onto `createDriveBoardStore`); the module owns order, idempotence and the
 * recovery window, and nothing else.
 */

export type MigrationStep = "pending" | "folder" | "snapshot" | "history" | "verified" | "flipped" | "sealed";
const ORDER: MigrationStep[] = ["pending", "folder", "snapshot", "history", "verified", "flipped", "sealed"];

export type MigrationState = {
  projectId: string;
  step: MigrationStep;
  /** Canonical `/pboard/<projectId>/` folder id (present from "snapshot" on). */
  folderId?: string;
  fileId?: string;
  /** Wall-clock ms of the flip; the source becomes deletable after the window. */
  sealedAt?: number;
};

export const READ_ONLY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type MigrationDeps = {
  loadState(projectId: string): Promise<MigrationState | undefined>;
  saveState(state: MigrationState): Promise<void>;
  clearState(projectId: string): Promise<void>;
  /** Converts the current local board into the application-defined v2
   * snapshot format (`board.json.gz` bytes); the AppData source is never
   * rewritten — the local-first copy is the conversion input. */
  exportBoard(projectId: string): Promise<Uint8Array>;
  /** Creates or reuses the canonical `/pboard/<projectId>/` folder; lookup-or-create. */
  ensureFolder(projectId: string): Promise<string>;
  uploadSnapshot(folderId: string, bytes: Uint8Array): Promise<string>;
  uploadHistory(folderId: string, fileId: string): Promise<void>;
  /** Read-back validation: re-download the canonical snapshot and prove it
   * parses, carries this board's id and matches the exported content. Throws
   * on any mismatch; the flip must never happen over an unverified upload. */
  verifySnapshot(projectId: string, fileId: string): Promise<void>;
  /** Atomically points the board layout at the new folder/file. */
  flipTarget(projectId: string, folderId: string, fileId: string): Promise<void>;
  /** Marks the old appData copies read-only (best effort; never blocks). */
  sealSource(projectId: string): Promise<void>;
  now(): number;
};

/** True once the source copies may be deleted; the UI offers cleanup on this. */
export function cleanupDue(state: MigrationState, now: number): boolean {
  return state.step === "sealed" && state.sealedAt !== undefined && now - state.sealedAt >= READ_ONLY_WINDOW_MS;
}

/**
 * Runs (or resumes) the migration. Re-invoking after any failure is always
 * safe: finished steps are skipped from persisted state, `ensureFolder` is
 * lookup-or-create, and the snapshot upload replaces its own file. The export
 * is taken exactly once, immediately before its upload. A failed read-back
 * verification re-uploads once and re-verifies; a second failure aborts
 * before the flip, leaving the source untouched.
 */
export async function migratePrivateBoard(deps: MigrationDeps, projectId: string): Promise<MigrationState> {
  const state: MigrationState = (await deps.loadState(projectId)) ?? { projectId, step: "pending" };
  const at = (step: MigrationStep) => ORDER.indexOf(state.step) >= ORDER.indexOf(step);
  const advance = async (next: MigrationStep) => {
    state.step = next;
    await deps.saveState(state);
  };

  if (!at("folder")) { state.folderId = await deps.ensureFolder(projectId); await advance("folder"); }
  if (!at("snapshot")) { state.fileId = await deps.uploadSnapshot(state.folderId!, await deps.exportBoard(projectId)); await advance("snapshot"); }
  if (!at("history")) { await deps.uploadHistory(state.folderId!, state.fileId!); await advance("history"); }
  if (!at("verified")) {
    try {
      await deps.verifySnapshot(projectId, state.fileId!);
    } catch {
      // A corrupt or racing upload: replace the file once, then insist.
      state.fileId = await deps.uploadSnapshot(state.folderId!, await deps.exportBoard(projectId));
      await deps.verifySnapshot(projectId, state.fileId!);
    }
    await advance("verified");
  }
  if (!at("flipped")) { await deps.flipTarget(projectId, state.folderId!, state.fileId!); await advance("flipped"); }
  if (!at("sealed")) {
    await deps.sealSource(projectId).catch(() => undefined);
    state.sealedAt = deps.now();
    await advance("sealed");
  }
  return state;
}

/** Drops migration bookkeeping once the source data is confirmed gone. */
export async function finishMigration(deps: MigrationDeps, projectId: string, now: number): Promise<boolean> {
  const state = await deps.loadState(projectId);
  if (!state) return false;
  if (!cleanupDue(state, now)) throw new Error("The read-only window has not elapsed");
  await deps.clearState(projectId);
  return true;
}
