/**
 * One consolidation cycle for the durable operation log (Sync v3, decision: the
 * log holds what Drive has not published yet, and Drive publishes it under a
 * lease). Like `runPublishCycle`, this module owns only the *order* of operations
 * and the failure semantics — scheduling, retries and the trigger conditions
 * belong to the caller — so every branch is testable without timers or network.
 *
 *   lease -> watermark -> catch the engine up -> build an immutable snapshot ->
 *   remember it -> upload -> commit the checkpoint -> forget it.
 *
 * The order is the whole safety story:
 *
 * - The snapshot is built **after** the engine has applied every operation up to
 *   the sequence being committed. A snapshot that covers *more* than it claims is
 *   harmless (a client replaying from the checkpoint re-applies operations it
 *   already has, and the engine deduplicates by operation id); a snapshot that
 *   covers *less* loses them, because the commit makes the log prune them.
 * - The intended snapshot is remembered before the upload. A browser that dies
 *   between "Drive has the file" and "the log knows about it" comes back, finds
 *   its own immutable file by name, and commits that instead of publishing a
 *   second snapshot that the log would then have to reconcile.
 * - The commit carries the lease epoch. A writer whose lease expired is refused,
 *   so an old snapshot cannot overwrite a newer one; `stale` from a writer that
 *   still holds the lease is detected, not prevented, because Drive has no hook
 *   for the epoch and an upload already in flight cannot be recalled.
 */
import type { LogLease } from './logSync';

/** Thrown by a snapshot build when the engine is merely *busy* — local writes
 * are receipted nowhere else yet — rather than structurally unbuildable. The
 * wiring turns it into an idle cycle outcome so an actively-editing owner
 * retries on the next trigger instead of leaving a board that looks failed. */
export class LogSnapshotPendingError extends Error {}

export type LogPendingConsolidation = { snapshotId: string; name: string; covered: number; epoch: number };
export type LogWatermark = { covered: number; checkpoint: number; snapshotSeq: number };
export type LogBuildResult = { snapshotId: string; name: string };
export type LogUploadResult = { etag: string } | { failed: 'conflict' | 'forbidden' | 'error' | 'missing' };

export type LogConsolidationCycle = {
  /** Null when another device holds the board's lease. */
  lease(): Promise<LogLease | null>;
  /** Retained sequence ceiling, published checkpoint, and snapshot generation. */
  watermark(): Promise<LogWatermark | null>;
  /** Applies log operations up to `covered`; `gap` means a snapshot is required first. */
  catchUp(covered: number): Promise<'ready' | 'gap'>;
  /** Checkpoints the engine at `covered`. Null when there is nothing new to publish. */
  build(covered: number): Promise<LogBuildResult | null>;
  /** Drive file id/version of an already-published snapshot of this name, if any. */
  find(name: string): Promise<string | null>;
  upload(pending: LogPendingConsolidation): Promise<LogUploadResult>;
  commit(lease: LogLease, covered: number, snapshotSeq: number, etag: string): Promise<{ stale: boolean }>;
  release(): Promise<void>;
  pending: {
    load(): Promise<LogPendingConsolidation | null>;
    save(value: LogPendingConsolidation | null): Promise<void>;
  };
};

export type LogCycleOutcome =
  | { status: 'idle'; reason: string }
  | { status: 'published'; snapshotSeq: number; stale: boolean }
  | { status: 'gap' }
  | { status: 'forbidden' };

export async function runLogConsolidationCycle(cycle: LogConsolidationCycle): Promise<LogCycleOutcome> {
  const lease = await cycle.lease();
  if (!lease) return { status: 'idle', reason: 'lease-busy' };
  try {
    const mark = await cycle.watermark();
    if (!mark) return { status: 'idle', reason: 'no-watermark' };

    // An interrupted cycle is finished before a new snapshot is considered: the
    // file may already exist in Drive, and publishing a second one would leave two
    // snapshots with the same coverage and no way to tell which was committed.
    const interrupted = await cycle.pending.load();
    if (interrupted && interrupted.epoch !== lease.epoch) {
      // A different epoch means this browser's earlier attempt is no longer
      // authoritative. The file it left behind is immutable and simply unused.
      await cycle.pending.save(null);
    } else if (interrupted) {
      const existing = await cycle.find(interrupted.name);
      let etag = existing;
      if (etag === null) {
        // The file is not in Drive. Either the upload is still in this process's
        // memory, in which case `upload` finishes it, or the browser that started
        // it is gone: then the intent is worthless, because that snapshot cannot
        // be reproduced and the current engine state is a better one to publish.
        const uploaded = await cycle.upload(interrupted);
        etag = 'failed' in uploaded ? null : uploaded.etag;
        if (etag === null) await cycle.pending.save(null);
      }
      if (etag !== null) {
        const generation = mark.snapshotSeq + 1;
        const committed = await cycle.commit(lease, interrupted.covered, generation, etag);
        await cycle.pending.save(null);
        return { status: 'published', snapshotSeq: generation, stale: committed.stale };
      }
    }

    if (mark.covered <= mark.checkpoint) return { status: 'idle', reason: 'clean' };
    if (await cycle.catchUp(mark.covered) === 'gap') return { status: 'gap' };
    const built = await cycle.build(mark.covered);
    if (!built) return { status: 'idle', reason: 'nothing-to-publish' };

    const pending: LogPendingConsolidation = { ...built, covered: mark.covered, epoch: lease.epoch };
    await cycle.pending.save(pending);
    const uploaded = await cycle.upload(pending);
    if ('failed' in uploaded) {
      // Left remembered on purpose, for the same reason as above.
      return uploaded.failed === 'forbidden' ? { status: 'forbidden' } : { status: 'idle', reason: `drive-${uploaded.failed}` };
    }
    const generation = mark.snapshotSeq + 1;
    const committed = await cycle.commit(lease, mark.covered, generation, uploaded.etag);
    await cycle.pending.save(null);
    return { status: 'published', snapshotSeq: generation, stale: committed.stale };
  } finally {
    await cycle.release();
  }
}
