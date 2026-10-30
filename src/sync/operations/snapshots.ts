import { OperationEngine, type EngineCheckpoint } from './engine';
import { canonical, digest, record, validId, validateSegment, type Segment } from './protocol';

export type OperationSnapshot = {
  protocol: 'pboard-operation-snapshot-v1'; boardId: string; snapshotId: string;
  parents: string[]; createdAt: string; checkpoint: EngineCheckpoint; integrity: string;
};
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export async function createSnapshot(engine: OperationEngine, parents: string[] = []): Promise<OperationSnapshot> {
  const body = { protocol: 'pboard-operation-snapshot-v1' as const, boardId: engine.boardId, snapshotId: crypto.randomUUID(),
    parents: [...new Set(parents)].sort(), createdAt: new Date().toISOString(), checkpoint: engine.checkpoint() };
  return { ...body, integrity: await digest(body) };
}
export async function validateSnapshot(snapshot: OperationSnapshot, boardId: string): Promise<void> {
  if (!record(snapshot) || snapshot.protocol !== 'pboard-operation-snapshot-v1' || snapshot.boardId !== boardId
    || !validId(snapshot.snapshotId) || !Array.isArray(snapshot.parents) || snapshot.parents.length > 4096
    || snapshot.parents.some(p => !validId(p) || p === snapshot.snapshotId) || new Set(snapshot.parents).size !== snapshot.parents.length
    || !Number.isFinite(Date.parse(snapshot.createdAt)) || snapshot.checkpoint?.boardId !== boardId
    || new TextEncoder().encode(canonical(snapshot)).length > MAX_SNAPSHOT_BYTES) throw new Error('Invalid operation snapshot');
  const { integrity, ...body } = snapshot;
  if (integrity !== await digest(body)) throw new Error('Operation snapshot integrity mismatch');
  OperationEngine.restore(snapshot.checkpoint);
}
/** Selection is only a bootstrap optimization. Union all subsequent logs and
 * unpublished local operations; a candidate is never proof another branch is obsolete. */
export async function selectSnapshot(candidates: OperationSnapshot[], boardId: string): Promise<OperationSnapshot | null> {
  for (const snapshot of candidates) await validateSnapshot(snapshot, boardId);
  return [...candidates].sort((a, b) => {
    const weight = (s: OperationSnapshot) => Object.values(s.checkpoint.frontier).reduce((sum, seq) => sum + seq, 0);
    return weight(b) - weight(a) || (a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0);
  })[0] ?? null;
}
export type GardeningPlan = { eligibleSegmentIds: string[]; retainedSnapshotIds: string[]; eligibleSnapshotIds: string[]; policy: string };
/** Conservative initial policy: retain at least three snapshots. A segment must be old AND
 * byte-identity-covered by every retained, verified candidate. Incomparable
 * branches therefore protect their required history automatically. */
export async function planGardening(options: {
  boardId: string; snapshots: OperationSnapshot[];
  segments: { fileId: string; segment: Segment; createdAt: string }[];
  now?: number; snapshotDates?: Record<string, string>;
}): Promise<GardeningPlan> {
  const { snapshots, boardId } = options;
  for (const snapshot of snapshots) await validateSnapshot(snapshot, boardId);
  const policy = 'Retain at least three verified snapshots, every incomparable branch, and snapshots/segments newer than 90 days. Delete only history covered by every retained recovery checkpoint.';
  const date = (snapshot: OperationSnapshot) => Date.parse(options.snapshotDates?.[snapshot.snapshotId] ?? snapshot.createdAt);
  const ordered = [...snapshots].sort((a, b) => date(b) - date(a) || (a.snapshotId < b.snapshotId ? -1 : 1));
  const covers = (a: OperationSnapshot, b: OperationSnapshot) => Object.entries(b.checkpoint.frontier).every(([actor, seq]) => (a.checkpoint.frontier[actor] ?? 0) >= seq)
    && Object.entries(b.checkpoint.receipts).every(([id, receipt]) => a.checkpoint.receipts[id]?.hash === receipt.hash && a.checkpoint.receipts[id]?.clock === receipt.clock);
  const cutoff = (options.now ?? Date.now()) - 90 * 24 * 60 * 60 * 1000;
  const retained = new Set(ordered.slice(0, 3));
  for (const snapshot of ordered) {
    // A branch is removable only when a verified checkpoint actually covers
    // its identities; neither sequence maxima nor wall-clock age prove this.
    const superseded = ordered.some(other => other !== snapshot && covers(other, snapshot)
      && (!covers(snapshot, other) || ordered.indexOf(other) < ordered.indexOf(snapshot)));
    if (!superseded || !Number.isFinite(date(snapshot)) || date(snapshot) >= cutoff) retained.add(snapshot);
  }
  const kept = [...retained];
  const result: GardeningPlan = { eligibleSegmentIds: [], eligibleSnapshotIds: [], retainedSnapshotIds: kept.map(s => s.snapshotId).sort(), policy };
  if (new Set(result.retainedSnapshotIds).size < 3) return result;
  for (const snapshot of ordered) if (!retained.has(snapshot) && kept.every(other => covers(other, snapshot))) result.eligibleSnapshotIds.push(snapshot.snapshotId);
  for (const candidate of options.segments) {
    validateSegment(candidate.segment, boardId);
    if (!Number.isFinite(Date.parse(candidate.createdAt)) || Date.parse(candidate.createdAt) >= cutoff) continue;
    let covered = true;
    for (const op of candidate.segment.operations) {
      const hash = await digest(op);
      if (!kept.every(s => (s.checkpoint.frontier[op.actorId] ?? 0) >= op.seq && s.checkpoint.receipts[op.opId]?.hash === hash)) { covered = false; break; }
    }
    if (covered) result.eligibleSegmentIds.push(candidate.fileId);
  }
  return result;
}
