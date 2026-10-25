/**
 * One leader publish cycle (Sync v2). Scheduling, retries and the lease
 * heartbeat belong to the caller; this module owns the *order* of operations
 * and the failure semantics, so every branch is testable without timers:
 *
 *  claim -> read Drive meta -> download+merge base -> decrypt & merge
 *  buffered ops -> serialize v2 -> conditional upload -> commit ops to the
 *  buffer -> report the Drive revision to the leader registry.
 *
 * A conflict from the conditional upload returns `conflict` without any
 * commit: the buffer keeps every op, and the next cycle re-merges — the
 * detect-and-repair contract, with no partial state left behind.
 */
import type { BoardSnapshotV2 } from "./snapshotV2";
import { deserializeBoardSnapshotV2, serializeBoardSnapshotV2 } from "./snapshotV2";
import { mergeSnapshotViews } from "./snapshotMerge";
import type { BoardContentKey, SealedOp } from "./bufferCrypto";
import { openOp } from "./bufferCrypto";
type Document = { id: string; updatedAt?: string; revision?: number; deleted?: boolean };

export type DriveMeta = { etag: string; version: string } | null;

export type PublishCycle = {
  claim(boardId: string): Promise<{ epoch: number } | null>;
  meta(boardId: string): Promise<DriveMeta>;
  download(boardId: string): Promise<Uint8Array | null>;
  listBuffered(boardId: string): Promise<SealedOp[]>;
  contentKey(boardId: string): Promise<BoardContentKey | undefined>;
  /** Applies one decrypted op to the merged base (document upsert/delete). */
  publish(boardId: string, knownEtag: string, gzipBytes: Uint8Array): Promise<
    | { status: "published"; version: string }
    | { status: "conflict" | "missing" | "forbidden" | "error" }
  >;
  commitOps(boardId: string, epoch: number, ids: string[]): Promise<void>;
  leaderCommit(boardId: string, epoch: number, snapshotSeq: number, driveEtag: string): Promise<{ stale: boolean }>;
  nowIso(): string;
};

export type CycleOutcome =
  | { status: "idle"; reason: string }
  | { status: "published"; snapshotSeq: number; stale: boolean }
  | { status: "conflict" }
  | { status: "forbidden" };

type OpValue = { document?: Record<string, unknown>; deleted?: boolean };

export async function runPublishCycle(boardId: string, cycle: PublishCycle): Promise<CycleOutcome> {
  const lease = await cycle.claim(boardId);
  if (!lease) return { status: "idle", reason: "lease-busy" };
  const meta = await cycle.meta(boardId);
  const base = await cycle.download(boardId);
  const current = base ? await deserializeBoardSnapshotV2(base, { expectBoardId: boardId }) : null;
  const sealed = await cycle.listBuffered(boardId);
  if (current && sealed.length === 0) return { status: "idle", reason: "clean" };

  const key = await cycle.contentKey(boardId);
  if (!key) return { status: "idle", reason: "no-content-key" };

  const buffered = {
    projects: [] as BoardSnapshotV2["entities"]["projects"],
    cards: [] as BoardSnapshotV2["entities"]["cards"],
    settings: [] as BoardSnapshotV2["entities"]["settings"]
  };
  const watermarks: Record<string, number> = {};
  const coveredIds: string[] = [];
  for (const entry of sealed) {
    let value: OpValue;
    try {
      value = (await openOp(key, entry)) as OpValue;
    } catch {
      // Ops sealed under a different content key (a key not yet converged to
      // this device) stay in the buffer untouched; committing or dropping
      // them would be data loss. Convergence happens via peer key exchange.
      continue;
    }
    if (!value.document?.["id"]) continue;
    const collection = (value.document["collection"] as "projects" | "cards" | "settings") ?? "cards";
    const document = { ...value.document } as unknown as Document;
    if (value.deleted) (document as Record<string, unknown>)["deleted"] = true;
    buffered[collection].push(document as never);
    coveredIds.push(entry.opId);
    const [device, seq] = [entry.opId.slice(0, entry.opId.lastIndexOf(":")), Number(entry.opId.slice(entry.opId.lastIndexOf(":") + 1))];
    if (device && Number.isFinite(seq)) watermarks[device] = Math.max(watermarks[device] ?? 0, seq);
  }
  if (sealed.length > 0 && coveredIds.length === 0) return { status: "idle", reason: "foreign-content-keys" };

  const merged = current
    ? mergeSnapshotViews(current, { ...current, snapshotSeq: current.snapshotSeq, epoch: lease.epoch, entities: buffered, watermarks })
    : { entities: buffered, watermarks, droppedVersions: [] };
  // Only ops this cycle actually decrypted-and-merged are covered; foreign-key
  // ops remain buffered until key convergence.

  const snapshotSeq = (current?.snapshotSeq ?? 0) + 1;
  const gzipBytes = await serializeBoardSnapshotV2(merged.entities, {
    boardId,
    appVersion: "0.11.0",
    snapshotSeq,
    epoch: lease.epoch,
    writtenBy: { deviceKeyId: `leader:${lease.epoch}`, at: cycle.nowIso() },
    watermarks: merged.watermarks
  });
  const published = await cycle.publish(boardId, meta?.etag ?? "", gzipBytes);
  if (published.status === "conflict") return { status: "conflict" };
  if (published.status === "forbidden") return { status: "forbidden" };
  if (published.status !== "published") return { status: "idle", reason: `drive-${published.status}` };
  await cycle.commitOps(boardId, lease.epoch, coveredIds);
  const { stale } = await cycle.leaderCommit(boardId, lease.epoch, snapshotSeq, published.version);
  return { status: "published", snapshotSeq, stale };
}
