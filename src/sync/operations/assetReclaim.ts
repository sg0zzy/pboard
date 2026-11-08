/**
 * One reclamation pass for a board's Drive asset files, in the
 * `runLogConsolidationCycle` style: this module owns only the *order* of
 * operations and the failure semantics — scheduling and the trigger conditions
 * belong to the caller — so every branch is testable without timers or network.
 * All deletion policy lives in the pure `planAssetReclamation`; this driver may
 * delete exactly the ids that plan declared eligible and nothing else.
 *
 *   owner -> lease -> listing -> live references -> retained coverage ->
 *   plan -> delete each eligible file -> audit what actually happened.
 *
 * The order is the whole safety story (spec rules,
 * docs/architecture/board-assets.md "Reclamation"):
 *
 * - Ownership is checked **before** the lease, because acquiring a lease is
 *   itself a write to shared board state: an editor or viewer attempting a
 *   reclamation must leave no trace at all, not even a held lease. This is the
 *   same owner-only rule the consolidation service enforces for snapshots, and
 *   reclamation is strictly more dangerous than publishing.
 * - The pass runs under the consolidation lease, so a reclamation can never
 *   race a snapshot into deleting a file a snapshot was about to take
 *   responsibility for. A busy lease means another device is mid-cycle: return
 *   before the try, so `release` is never called on a lease we do not hold,
 *   and every later exit still releases through the finally.
 * - **A partial or failed listing makes the whole pass a no-op. This is the
 *   rule that prevents data loss.** Drive throttling one request is the
 *   ordinary way a listing comes back short, and a short listing looks exactly
 *   like a board whose files were removed: every file it failed to mention is
 *   "unreferenced". The driver therefore refuses to even read the references
 *   against an index it cannot trust, and defers the blocked verdict — and its
 *   wording — to the planner, so the driver never holds a private opinion
 *   about when deletion is safe.
 * - Live references and retained-snapshot coverage are read after the listing
 *   is known complete, and a failure to read either is treated the same way:
 *   unknown protection is protection. The pass blocks instead of deleting.
 * - Deletions are per-file and independent: one Drive failure (a file already
 *   gone, a transient error) does not abort the other candidates, because the
 *   survivors are independently eligible and the next pass retries whatever
 *   failed. The outcome separates deleted / failed / skipped so the caller can
 *   surface exactly what happened.
 * - The audit record is written **from the observed results, after the
 *   deletes**, never from the plan: a file whose deletion failed was not
 *   reclaimed, and an audit that claimed otherwise would justify a future
 *   pass for a file that still exists.
 */
import { planAssetReclamation } from './assets';
import type { LogLease } from './logSync';

/** One Drive file as the reclamation index needs it. `createdTime` is the raw
 * Drive timestamp: the planner parses it and keeps the file when the parse
 * fails, so a listing port that has no timestamp passes a non-date string —
 * unknown age protects the file, it never condemns it. */
export type AssetListFile = { driveFileId: string; name: string; createdTime: string };
/** `complete: false` means the listing may be missing files; it is the only
 * input the planner cannot work around, and the driver cannot either. */
export type AssetDriveListing = { complete: boolean; files: AssetListFile[] };
/** What one pass deleted and why, in the planner's own policy words. Written
 * after the deletions, from observed results. */
export type AssetReclamationAudit = { at: number; policy: string; deleted: string[]; failed: string[] };

export type AssetReclamationCycle = {
  /** Fresh Drive folder role: only the board owner may reclaim. Checked first,
   * before any read-modify-write, so a non-owner pass is indistinguishable
   * from a pass that never ran. */
  owner(): Promise<boolean>;
  /** Null when another device holds the board's lease — the same lease
   * consolidation uses, so reclamation and snapshots are mutually exclusive. */
  lease(): Promise<LogLease | null>;
  release(): Promise<void>;
  /** Lists the board folder's candidate files. Must report `complete: false`
   * when it could not enumerate everything (a paged request failed, Drive
   * throttled); may throw, which the driver treats as incomplete. */
  listing(): Promise<AssetDriveListing>;
  /** driveFileIds referenced by the live board state. */
  referenced(): Promise<string[]>;
  /** snapshotId → the driveFileIds that snapshot's receipts still reference.
   * Any retained snapshot naming a file protects it. */
  retainedSnapshotCoverage(): Promise<Record<string, string[]>>;
  /** Deletes exactly one Drive file. 'failed' keeps the file under
   * protection: it will be re-planned next pass. */
  remove(driveFileId: string): Promise<'deleted' | 'failed'>;
  /** Persists one record of what this pass actually removed, and the policy it
   * acted under. Failure propagates: deletes already happened, and silently
   * losing their record is worse than an error at the caller. */
  audit(record: AssetReclamationAudit): Promise<void>;
  /** Injectable clock; the grace window is the planner's number, not this
   * module's. */
  now(): number;
  /** Passed through to the planner. Absent means the module default. */
  graceMs?: number;
};

export type AssetReclamationOutcome =
  | { status: 'idle'; reason: string }
  | { status: 'blocked'; reason: string }
  /** `skipped` counts listed files the plan did not declare eligible — kept,
   * not examined further by this driver. */
  | { status: 'reclaimed'; deleted: string[]; failed: string[]; skipped: number }
  | { status: 'forbidden' };

export async function runAssetReclamation(cycle: AssetReclamationCycle): Promise<AssetReclamationOutcome> {
  // Owner-only, before anything that could touch shared state: not even the
  // lease is acquired for a non-owner.
  if (!await cycle.owner()) return { status: 'forbidden' };

  const lease = await cycle.lease();
  // Another device holds the board. Return before the try so the finally below
  // cannot release a lease this pass never held — releasing someone else's
  // lease would let a reclamation race the very snapshot the lease forbids.
  if (!lease) return { status: 'idle', reason: 'lease-busy' };
  try {
    // A listing that throws is a listing that may be missing files: exactly
    // `complete: false` with nothing trustworthy in it. Synthesizing that shape
    // (rather than inventing a driver-side reason) keeps the planner the sole
    // place deletion-safety is decided, including its wording.
    let listed: AssetDriveListing;
    try {
      listed = await cycle.listing();
    } catch {
      listed = { complete: false, files: [] };
    }
    // Spec rule 4, the data-loss rule: an incomplete listing makes the whole
    // pass a no-op. Deliberately do not read references or coverage either —
    // against an untrustworthy index those reads buy nothing, and skipping
    // them keeps the blocked pass cheap.
    if (!listed.complete) {
      const blocked = planAssetReclamation({
        listing: listed, referenced: [], retainedSnapshotCoverage: {},
        now: cycle.now(), graceMs: cycle.graceMs,
      });
      return { status: 'blocked', reason: blocked.blocked ?? 'Drive listing is incomplete.' };
    }

    // Unknown protection is protection: if either guard input cannot be read,
    // every file stays. These are the only two reasons this driver itself can
    // block — everything else is the planner's call.
    let referenced: string[];
    try {
      referenced = await cycle.referenced();
    } catch {
      return { status: 'blocked', reason: 'Live references are unavailable; every file is treated as referenced.' };
    }
    let coverage: Record<string, string[]>;
    try {
      coverage = await cycle.retainedSnapshotCoverage();
    } catch {
      return { status: 'blocked', reason: 'Retained snapshot coverage is unavailable; every file is treated as covered.' };
    }

    const plan = planAssetReclamation({
      listing: listed, referenced, retainedSnapshotCoverage: coverage,
      now: cycle.now(), graceMs: cycle.graceMs,
    });
    // Defensive: a plan that reports itself blocked while also naming
    // candidates is a contradiction, and the safe reading is the block. The
    // planner never does this today; neither may a future one by accident.
    if (plan.blocked) return { status: 'blocked', reason: plan.blocked };
    if (plan.eligibleDriveFileIds.length === 0) return { status: 'idle', reason: 'nothing-eligible' };

    // Each candidate independently; one failure must not strand the rest.
    // Deleting twice is impossible in Drive, but a duplicated listing entry
    // must not double-count in the audit either, so the candidate set dedupes.
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const driveFileId of new Set(plan.eligibleDriveFileIds)) {
      try {
        (await cycle.remove(driveFileId) === 'deleted' ? deleted : failed).push(driveFileId);
      } catch {
        failed.push(driveFileId);
      }
    }
    // The audit records what actually happened: a failed delete is absent from
    // `deleted` even though the plan intended it, so no later pass can read
    // this record as evidence that the file is gone.
    await cycle.audit({ at: cycle.now(), policy: plan.policy, deleted, failed });
    return { status: 'reclaimed', deleted, failed, skipped: Math.max(0, listed.files.length - deleted.length - failed.length) };
  } finally {
    await cycle.release();
  }
}
