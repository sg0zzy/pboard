/**
 * Split-brain detect-and-repair (Sync v2, accepted design §8).
 *
 * Drive cannot block a stale leader's in-flight upload, so a lower-epoch
 * snapshot may momentarily win the file. The repair rule must therefore be
 * convergent and content-preserving: merge two snapshot views by taking, per
 * document, the side whose causal metadata (revision, then updatedAt, then
 * device tie-break) is not dominated, and per device the max op watermark.
 * Merging is idempotent and order-independent: merge(a, b) equals
 * merge(b, a), and merge(a, a) equals a — which is what lets every leader
 * repair the same way without coordinating.
 */
import type { BoardSnapshotV2 } from "./snapshotV2";

type Document = { id?: string; revision?: number; updatedAt?: string };

export type MergeResult = {
  entities: BoardSnapshotV2["entities"];
  watermarks: Record<string, number>;
  /** Documents whose losing version existed on both sides and was dropped. */
  droppedVersions: { collection: string; id: string }[];
};

function dominates(left: Document, right: Document): boolean {
  const leftRev = left.revision ?? 0;
  const rightRev = right.revision ?? 0;
  if (leftRev !== rightRev) return leftRev > rightRev;
  const leftAt = Date.parse(left.updatedAt ?? "") || 0;
  const rightAt = Date.parse(right.updatedAt ?? "") || 0;
  if (leftAt !== rightAt) return leftAt > rightAt;
  return false;
}

function mergeCollection<T extends Document>(winner: T[], loser: T[], dropped: MergeResult["droppedVersions"], collection: string): T[] {
  const byId = new Map<string, T>();
  for (const document of winner) if (document.id) byId.set(document.id, document);
  for (const document of loser) {
    if (!document.id) continue;
    const current = byId.get(document.id);
    if (!current) {
      byId.set(document.id, document);
      continue;
    }
    if (dominates(document, current) || dominates(current, document)) {
      dropped.push({ collection, id: document.id });
      if (dominates(document, current)) byId.set(document.id, document);
    }
    // Equal causal position: both sides carry the same content by contract.
  }
  return [...byId.values()];
}

export function mergeSnapshotViews(left: BoardSnapshotV2, right: BoardSnapshotV2): MergeResult {
  // The view with the higher (snapshotSeq, epoch) provides the base; the
  // other contributes documents it has and the base lost or superseded.
  const rank = (snapshot: BoardSnapshotV2) => snapshot.snapshotSeq * 1_000_000 + snapshot.epoch;
  const [winner, loser] = rank(left) >= rank(right) ? [left, right] : [right, left];
  const droppedVersions: MergeResult["droppedVersions"] = [];
  const watermarks: Record<string, number> = { ...winner.watermarks };
  for (const [device, seq] of Object.entries(loser.watermarks)) {
    watermarks[device] = Math.max(watermarks[device] ?? 0, seq);
  }
  return {
    entities: {
      projects: mergeCollection(winner.entities.projects, loser.entities.projects, droppedVersions, "projects"),
      cards: mergeCollection(winner.entities.cards, loser.entities.cards, droppedVersions, "cards"),
      settings: mergeCollection(winner.entities.settings, loser.entities.settings, droppedVersions, "settings")
    },
    watermarks,
    droppedVersions
  };
}

/** True when `candidate` cannot supersede `current` (stale-leader write). */
export function isStaleSnapshot(candidate: BoardSnapshotV2, current: BoardSnapshotV2): boolean {
  return candidate.boardId === current.boardId && candidate.snapshotSeq < current.snapshotSeq;
}
