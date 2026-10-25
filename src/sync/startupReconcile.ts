/**
 * Startup reconciliation ladder (Sync v2, milestone M4).
 *
 * Opening a shared board costs network only when something actually moved:
 * the plan is computed from three cheap facts — the snapshot's revision
 * (etag + watermarks), the etag this device last saw, and the local journal's
 * per-device watermarks. The buffered-op list is fetched only when the
 * snapshot itself changed; a board reopened against the same revision with no
 * newer remote writes pulls nothing.
 *
 * Pure decision function: the runtime adapter supplies the facts.
 */

export type StartupFacts = {
  /** Watermarks embedded in the current v2 snapshot, or null if none exists. */
  snapshot: { snapshotSeq: number; watermarks: Record<string, number> } | null;
  /** Drive revision the snapshot was read from. */
  snapshotEtag: string | null;
  /** Revision persisted by the previous successful sync of this device. */
  lastSeenEtag: string | null;
  /** Highest committed op sequence this device already holds, per device. */
  localWatermarks: Record<string, number>;
  hasLocalData: boolean;
};

export type StartupPlan = {
  /** Snapshot contains operations the local journal has not applied. */
  pullSnapshot: boolean;
  /** Buffered ops newer than the snapshot may exist; list and merge them. */
  collectBuffer: boolean;
  /** This device should try to become persistence leader and publish. */
  leaderCandidate: boolean;
  /** Fresh board with nothing anywhere: start empty and let the first writer bootstrap. */
  bootstrap: boolean;
};

/** Parses the `device:seq` op identifiers the buffer protocol carries. */
export function deviceSeqFromOpId(opId: string): { device: string; seq: number } | null {
  const at = opId.lastIndexOf(":");
  if (at <= 0) return null;
  const seq = Number(opId.slice(at + 1));
  if (!Number.isFinite(seq)) return null;
  return { device: opId.slice(0, at), seq };
}

export function watermarksFromOpIds(opIds: string[]): Record<string, number> {
  const watermarks: Record<string, number> = {};
  for (const opId of opIds) {
    const parsed = deviceSeqFromOpId(opId);
    if (parsed) watermarks[parsed.device] = Math.max(watermarks[parsed.device] ?? 0, parsed.seq);
  }
  return watermarks;
}

export function planStartup(facts: StartupFacts): StartupPlan {
  const { snapshot, localWatermarks } = facts;
  if (!snapshot) {
    return {
      pullSnapshot: false,
      collectBuffer: false,
      leaderCandidate: facts.hasLocalData,
      bootstrap: !facts.hasLocalData
    };
  }
  // Behind if any device has published operations this device has not applied.
  const behind = Object.entries(snapshot.watermarks).some(([device, seq]) => (localWatermarks[device] ?? 0) < seq);
  const revisionChanged = facts.snapshotEtag !== facts.lastSeenEtag;
  return {
    pullSnapshot: behind,
    collectBuffer: revisionChanged || behind,
    // A board with a snapshot only needs a new leader publish after local
    // mutations; the runtime arms cycles from the journal anyway, so the
    // startup plan flags leadership only for the bootstrap case.
    leaderCandidate: false,
    bootstrap: false
  };
}
