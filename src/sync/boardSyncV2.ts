/**
 * Sync v2 board persistence over the unified `/pboard` Drive store.
 *
 * Replaces the AppData-backed provider for websocket-provider (Sync v2)
 * operation on the exact same triggers the legacy path uses (background
 * loop, blur/pagehide flush, connect/reconcile, project deletion) — no new
 * loops. Canonical state is one gzip snapshot per board
 * (`/pboard/<boardId>/board.json.gz`), written with If-Match preconditions;
 * a concurrent writer surfaces as a conflict and the board is re-pulled and
 * re-pushed instead of overwritten. AppData plays no role here.
 */
import { deserializeBoardSnapshotV2, serializeBoardSnapshotV2, v1SnapshotToEntities, v2EntitiesToV1 } from "./snapshotV2";
import { compareProjectTimestamps, type ProjectSnapshot, type ProjectSnapshotStore } from "./snapshot";
import type { DriveSyncStateStore, DriveTombstoneStore } from "./state";
import type { DriveBoardStore } from "./driveBoardStore";
import type { DriveReconcileResult, ProjectSyncResult } from "./googleDriveProvider";
import type { RxRepository } from "../storage/rxdbRepository";

export type BoardSyncV2 = {
  syncProject(projectId: string, options?: { force?: boolean }): Promise<ProjectSyncResult>;
  reconcileAll(): Promise<DriveReconcileResult>;
  deleteProject(projectId: string): Promise<"deleted" | "pending">;
  pullProject(projectId: string): Promise<ProjectSnapshot | null>;
  pushProject(projectId: string): Promise<{ id: string; name: string }>;
};

/** The state/tombstone surfaces board persistence actually needs; keeps the
 * engine injectable without the full legacy stores. */
type SyncStateView = Pick<DriveSyncStateStore, "get" | "ensureInitiallyDirty" | "markSynced" | "markError" | "forget">;
type TombstoneView = Pick<DriveTombstoneStore, "getAll" | "get" | "add" | "clear">;

export function createBoardSyncV2(options: {
  store: DriveBoardStore;
  snapshots: ProjectSnapshotStore;
  syncState: SyncStateView;
  tombstones: TombstoneView;
  getRepository: () => Promise<RxRepository | null>;
  connectionState: () => Promise<string>;
  deviceKeyId: () => Promise<string>;
  appVersion?: string;
}): BoardSyncV2 {
  const appVersion = options.appVersion ?? "0.11.0";
  const { store, snapshots, syncState, tombstones } = options;
  const inflight = new Map<string, Promise<ProjectSyncResult>>();
  async function syncProject(projectId: string, opts: { force?: boolean } = {}): Promise<ProjectSyncResult> {
    const running = inflight.get(projectId);
    if (running) return running;
    const operation = performSync(projectId, opts.force ?? false, false).finally(() => inflight.delete(projectId));
    inflight.set(projectId, operation);
    return operation;
  }

  async function performSync(projectId: string, force: boolean, retried: boolean): Promise<ProjectSyncResult> {
    const rx = await options.getRepository();
    if (!rx) throw new Error("Local storage is unavailable for board synchronization");
    if (await rx.isDeletedProject(projectId) || await tombstones.get(projectId)) return "not-dirty";
    await syncState.ensureInitiallyDirty(projectId);
    const state = await syncState.get(projectId);
    const meta = await store.meta(projectId);
    let remote: ProjectSnapshot | undefined;
    let remoteSeq = 0;
    if (meta) {
      const bytes = await store.download(projectId);
      if (bytes) {
        const parsed = await deserializeBoardSnapshotV2(bytes, { expectBoardId: projectId });
        remote = v2EntitiesToV1(parsed.entities, parsed.exportedAt);
        remoteSeq = parsed.snapshotSeq;
      }
    }
    const applied = remote ? await snapshots.applyIfNewer(remote) : "local-newer";
    if (applied === "blocked") return "not-dirty";
    const local = await snapshots.read(projectId);
    // Applying a newer remote snapshot supersedes whatever flagged the board
    // dirty locally; re-pushing that content would clobber the newer remote.
    const dirty = applied === "applied" ? false : (await syncState.get(projectId)).dirty;
    const localNewer = !remote || compareProjectTimestamps(local.project, remote.project) > 0;
    if (!force && !dirty && !localNewer) {
      await syncState.markSynced(projectId, local.project.revision,
        state.remoteFileId ?? await store.snapshotFileId(projectId) ?? "");
      return applied === "applied" ? "pulled" : "not-dirty";
    }
    const bytes = await serializeBoardSnapshotV2(v1SnapshotToEntities(local), {
      boardId: projectId, appVersion, snapshotSeq: remoteSeq + 1, epoch: 0,
      writtenBy: { deviceKeyId: await options.deviceKeyId() }
    });
    const fileId = meta
      ? state.remoteFileId ?? await store.snapshotFileId(projectId) ?? await store.ensureSnapshotFile(projectId)
      : await store.ensureSnapshotFile(projectId);
    const outcome = await store.publish(projectId, meta?.etag ?? "", bytes);
    if (outcome.status === "published") {
      await syncState.markSynced(projectId, local.project.revision, fileId);
      return "pushed";
    }
    if ((outcome.status === "conflict" || outcome.status === "missing") && !retried) {
      // A concurrent writer (leader cycle or another device) landed first:
      // re-pull, merge, and push once against the fresh revision.
      store.reset();
      return performSync(projectId, force, true);
    }
    const reason = outcome.status === "forbidden"
      ? "Google Drive write access was revoked for this board"
      : `Drive snapshot publish failed (${outcome.status})`;
    await syncState.markError(projectId, reason);
    throw new Error(reason);
  }

  async function reconcileAll(): Promise<DriveReconcileResult> {
    const result: DriveReconcileResult = { status: "disconnected", imported: 0, pulled: 0, pushed: 0, deleted: 0 };
    if (await options.connectionState() !== "connected") return result;
    const failures: unknown[] = [];
    for (const tombstone of await tombstones.getAll()) {
      try {
        const fileId = tombstone.remoteFileId ?? await store.snapshotFileId(tombstone.projectId);
        if (fileId) await store.trashFile(fileId);
        await tombstones.clear(tombstone.projectId);
        await syncState.forget(tombstone.projectId);
        result.deleted += 1;
      } catch (error) { failures.push(error); }
    }
    const rx = await options.getRepository();
    if (!rx) throw new Error("Local storage is unavailable for board reconciliation");
    const local = new Set((await rx.listProjects()).map(project => project.id));
    let remoteBoards: string[] = [];
    try { remoteBoards = await store.listBoards(); } catch (error) {
      failures.push(error);
      throw new AggregateError(failures, "Google Drive board discovery failed");
    }
    const boards = new Set([...local, ...remoteBoards]);
    for (const boardId of boards) {
      if (await rx.isDeletedProject(boardId) || await tombstones.get(boardId)) continue;
      try {
        const existed = local.has(boardId);
        const outcome = await syncProject(boardId);
        if (outcome === "pushed") result.pushed += 1;
        else if (outcome === "pulled") { if (existed) result.pulled += 1; else result.imported += 1; }
        else if (!existed && await rx.getProject(boardId)) result.imported += 1;
      } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const reason = failures[0] instanceof Error ? failures[0].message.slice(0, 240) : "Reconciliation failed";
      throw new AggregateError(failures, `Google Drive reconciliation is incomplete; other boards were checked. ${reason}`);
    }
    result.status = "reconciled";
    return result;
  }

  async function deleteProject(projectId: string): Promise<"deleted" | "pending"> {
    await inflight.get(projectId)?.catch(() => undefined);
    if (!await tombstones.get(projectId)) return "deleted";
    if (await options.connectionState() !== "connected") return "pending";
    try {
      const tombstone = await tombstones.get(projectId);
      const fileId = tombstone?.remoteFileId ?? await store.snapshotFileId(projectId);
      if (fileId) await store.trashFile(fileId);
      await tombstones.clear(projectId);
      await syncState.forget(projectId);
      return "deleted";
    } catch {
      // The local tombstone keeps the board hidden; the remote file is
      // retried on the next reconciliation.
      return "pending";
    }
  }

  async function pullProject(projectId: string): Promise<ProjectSnapshot | null> {
    const bytes = await store.download(projectId);
    if (!bytes) return null;
    const parsed = await deserializeBoardSnapshotV2(bytes, { expectBoardId: projectId });
    return v2EntitiesToV1(parsed.entities, parsed.exportedAt);
  }

  async function pushProject(projectId: string): Promise<{ id: string; name: string }> {
    const rx = await options.getRepository();
    if (!rx) throw new Error("Local storage is unavailable for board upload");
    const local = await snapshots.read(projectId);
    const existing = await store.download(projectId);
    const remoteSeq = existing
      ? (await deserializeBoardSnapshotV2(existing, { expectBoardId: projectId })).snapshotSeq : 0;
    const bytes = await serializeBoardSnapshotV2(v1SnapshotToEntities(local), {
      boardId: projectId, appVersion, snapshotSeq: remoteSeq + 1, epoch: 0,
      writtenBy: { deviceKeyId: await options.deviceKeyId() }
    });
    const meta = await store.meta(projectId);
    const fileId = await store.ensureSnapshotFile(projectId);
    const outcome = await store.publish(projectId, meta?.etag ?? "", bytes);
    if (outcome.status !== "published") throw new Error(`Drive snapshot publish failed (${outcome.status})`);
    await syncState.markSynced(projectId, local.project.revision, fileId);
    return { id: fileId, name: "board.json.gz" };
  }

  return { syncProject, reconcileAll, deleteProject, pullProject, pushProject };
}
