import type { GoogleAuthProvider, GoogleConnectionState } from "./googleAuth";
import type { DriveAppDataFile, DriveTransport } from "./driveTransport";
import {
  compareProjectTimestamps,
  deserializeProjectSnapshot,
  serializeProjectSnapshot,
  type ProjectSnapshot,
  type ProjectSnapshotStore
} from "./snapshot";
import type { DriveSyncStateStore, DriveTombstoneStore } from "./state";

export type ProjectSyncResult = "not-dirty" | "pushed" | "pulled";
export type DriveReconcileResult = {
  status: "disconnected" | "reconciled";
  imported: number;
  pulled: number;
  pushed: number;
  deleted: number;
};

export interface GoogleDriveProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionState(): Promise<GoogleConnectionState>;
  pullProject(projectId: string): Promise<ProjectSnapshot | null>;
  pushProject(projectId: string): Promise<DriveAppDataFile>;
  syncProject(projectId: string): Promise<ProjectSyncResult>;
  reconcileAll(): Promise<DriveReconcileResult>;
  deleteProject(projectId: string): Promise<"deleted" | "pending">;
}

type Dependencies = {
  auth: GoogleAuthProvider;
  transport: DriveTransport;
  snapshots: ProjectSnapshotStore;
  syncState: DriveSyncStateStore;
  tombstones: DriveTombstoneStore;
  beforeReconcile?: () => Promise<void>;
  isSharedProject?: (projectId: string) => Promise<boolean>;
};

type RemoteSnapshot = { file: DriveAppDataFile; snapshot: ProjectSnapshot };

export function createGoogleDriveProvider({ auth, transport, snapshots, syncState, tombstones, beforeReconcile,
  isSharedProject = async () => false }: Dependencies): GoogleDriveProvider {
  const syncInFlight = new Map<string, Promise<ProjectSyncResult>>();
  let reconciliationInFlight: Promise<DriveReconcileResult> | null = null;

  async function resolveFile(projectId: string): Promise<DriveAppDataFile | null> {
    const state = await syncState.get(projectId);
    if (state.remoteFileId) return { id: state.remoteFileId, name: `project-${projectId}.pboard` };
    return await transport.findProjectFile(projectId);
  }

  async function readRemote(file: DriveAppDataFile): Promise<RemoteSnapshot> {
    const snapshot = deserializeProjectSnapshot(await transport.download(file.id));
    return { file, snapshot };
  }

  async function markDirtyIfNeeded(projectId: string): Promise<void> {
    if (!(await syncState.get(projectId)).dirty) await syncState.markDirty(projectId);
  }

  async function canApplyRemote(projectId: string): Promise<boolean> {
    return (await tombstones.get(projectId)) === null;
  }

  async function uploadSnapshot(
    snapshot: ProjectSnapshot,
    file: DriveAppDataFile | null,
    expectedChangeToken?: number
  ): Promise<DriveAppDataFile> {
    const uploaded = await transport.upload(
      snapshot.project.id,
      serializeProjectSnapshot(snapshot.project, snapshot.items),
      file?.id
    );
    // A save may have landed locally while this request was in flight. Keep
    // the remote file association, but leave the newer local snapshot pending.
    const latest = await snapshots.read(snapshot.project.id).catch(() => null);
    if (!latest || latest.project.revision !== snapshot.project.revision || latest.project.updatedAt !== snapshot.project.updatedAt) {
      await syncState.markUploadStale(snapshot.project.id, uploaded.id);
      return uploaded;
    }
    await syncState.markSynced(
      snapshot.project.id,
      snapshot.project.revision,
      uploaded.id,
      expectedChangeToken
    );
    return uploaded;
  }

  async function pullProject(projectId: string): Promise<ProjectSnapshot | null> {
    const file = await resolveFile(projectId);
    if (!file) return null;
    const { snapshot } = await readRemote(file);
    if (snapshot.project.id !== projectId) throw new Error("Google Drive returned a snapshot for a different project");
    const stateBeforePull = await syncState.get(projectId);
    const result = await snapshots.applyIfNewer(snapshot, () => canApplyRemote(projectId));
    if (result === "local-newer" || result === "blocked") return null;
    await syncState.markSynced(projectId, snapshot.project.revision, file.id, stateBeforePull.changeToken ?? 0);
    return snapshot;
  }

  async function pushProject(projectId: string, expectedChangeToken?: number): Promise<DriveAppDataFile> {
    const stateBeforePush = await syncState.get(projectId);
    const guardedChangeToken = expectedChangeToken ?? stateBeforePush.changeToken ?? 0;
    const snapshot = await snapshots.read(projectId);
    return uploadSnapshot(snapshot, await resolveFile(projectId), guardedChangeToken);
  }

  async function performProjectSync(projectId: string): Promise<ProjectSyncResult> {
    if (await isSharedProject(projectId)) return "not-dirty";
    if (await tombstones.get(projectId)) return "not-dirty";
    const state = await syncState.get(projectId);
    if (!state.dirty) return "not-dirty";
    if (await auth.getConnectionState() !== "connected") throw new Error("Google Drive is not connected");
    await syncState.markSyncing(projectId);
    try {
      const local = await snapshots.read(projectId);
      const remoteFile = await resolveFile(projectId);
      if (remoteFile) {
        const remote = await readRemote(remoteFile);
        if (remote.snapshot.project.id !== projectId) {
          throw new Error("Google Drive returned a snapshot for a different project");
        }
        const comparison = compareProjectTimestamps(local.project, remote.snapshot.project);
        if (comparison < 0) {
          const applied = await snapshots.applyIfNewer(remote.snapshot, () => canApplyRemote(projectId));
          if (applied === "blocked") return "not-dirty";
          if (applied === "local-newer") {
            const latest = await snapshots.read(projectId);
            await uploadSnapshot(latest, remoteFile, (await syncState.get(projectId)).changeToken ?? 0);
            return "pushed";
          }
          await syncState.markSynced(projectId, remote.snapshot.project.revision, remoteFile.id, state.changeToken ?? 0);
          return "pulled";
        }
        if (comparison === 0) {
          await syncState.markSynced(projectId, remote.snapshot.project.revision, remoteFile.id, state.changeToken ?? 0);
          return "not-dirty";
        }
      }
      await uploadSnapshot(local, remoteFile, state.changeToken ?? 0);
      return "pushed";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Drive sync failed";
      await syncState.markError(projectId, message);
      throw error;
    }
  }

  function syncProject(projectId: string): Promise<ProjectSyncResult> {
    const current = syncInFlight.get(projectId);
    if (current) return current;
    const operation = performProjectSync(projectId).finally(() => syncInFlight.delete(projectId));
    syncInFlight.set(projectId, operation);
    return operation;
  }

  async function deleteProject(projectId: string): Promise<"deleted" | "pending"> {
    const inFlight = syncInFlight.get(projectId);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // The tombstone remains authoritative even if an older upload failed.
      }
    }
    const tombstone = await tombstones.get(projectId);
    if (!tombstone) return "deleted";
    // A shared board's content lives in a Drive folder owned by the sharer.
    // Deleting locally only hides it for this account (the folder is not removed),
    // so the tombstone must persist to stop discovery from importing it back.
    if (await isSharedProject(projectId)) return "deleted";
    if (await auth.getConnectionState() !== "connected") return "pending";
    try {
      const fileId = tombstone.remoteFileId ?? (await resolveFile(projectId))?.id;
      if (fileId) await transport.delete(fileId);
      await tombstones.clear(projectId);
      await syncState.forget(projectId);
      return "deleted";
    } catch {
      return "pending";
    }
  }

  async function performReconciliation(): Promise<DriveReconcileResult> {
    const pendingTombstones = await tombstones.getAll();
    // Shared boards keep a permanent local tombstone (their Drive folder is not
    // deleted); it only hides the project, so reconcile must not delete it.
    const privateTombstones: typeof pendingTombstones = [];
    for (const tombstone of pendingTombstones) {
      if (!await isSharedProject(tombstone.projectId)) privateTombstones.push(tombstone);
    }
    // Explicit local deletes stay hidden even when Drive is unavailable.
    for (const tombstone of privateTombstones) await snapshots.remove(tombstone.projectId);
    const empty: DriveReconcileResult = { status: "disconnected", imported: 0, pulled: 0, pushed: 0, deleted: 0 };
    if (await auth.getConnectionState() !== "connected") return empty;
    await beforeReconcile?.();

    // A failed list is allowed to reject the whole reconciliation. It must never
    // be converted into an empty remote set.
    const listedFiles = await transport.listProjectFiles();
    const tombstonedIds = new Set(privateTombstones.map((entry) => entry.projectId));
    const deletionSucceeded = new Map(privateTombstones.map((entry) => [entry.projectId, true]));
    const knownTombstoneFileIds = new Map(
      privateTombstones.flatMap((entry) => entry.remoteFileId ? [[entry.remoteFileId, entry.projectId] as const] : [])
    );

    for (const tombstone of privateTombstones) {
      if (!tombstone.remoteFileId) continue;
      try {
        await transport.delete(tombstone.remoteFileId);
      } catch {
        deletionSucceeded.set(tombstone.projectId, false);
      }
    }

    const downloadableFiles = listedFiles.filter((file) => !knownTombstoneFileIds.has(file.id));
    const remoteEntries = await Promise.all(downloadableFiles.map(readRemote));

    for (const tombstone of pendingTombstones) {
      const matching = remoteEntries.filter((entry) => entry.snapshot.project.id === tombstone.projectId);
      for (const entry of matching) {
        try {
          await transport.delete(entry.file.id);
        } catch {
          deletionSucceeded.set(tombstone.projectId, false);
        }
      }
      if (deletionSucceeded.get(tombstone.projectId)) {
        await tombstones.clear(tombstone.projectId);
        await syncState.forget(tombstone.projectId);
      }
    }

    const remoteByProject = new Map<string, RemoteSnapshot>();
    for (const entry of remoteEntries) {
      const projectId = entry.snapshot.project.id;
      if (await isSharedProject(projectId)) continue;
      if (tombstonedIds.has(projectId)) continue;
      const current = remoteByProject.get(projectId);
      if (!current || compareProjectTimestamps(entry.snapshot.project, current.snapshot.project) > 0) {
        remoteByProject.set(projectId, entry);
      }
    }

    const localByProject = new Map((await snapshots.list()).map((snapshot) => [snapshot.project.id, snapshot]));
    const result: DriveReconcileResult = { status: "reconciled", imported: 0, pulled: 0, pushed: 0, deleted: 0 };
    result.deleted = privateTombstones.filter((entry) => deletionSucceeded.get(entry.projectId)).length;

    for (const [projectId, remote] of remoteByProject) {
      if (await tombstones.get(projectId)) {
        await snapshots.remove(projectId);
        if (await deleteProject(projectId) === "deleted") result.deleted += 1;
        continue;
      }
      const local = localByProject.get(projectId);
      const syncStateBefore = await syncState.get(projectId);
      if (!local) {
        const applied = await snapshots.apply(remote.snapshot, () => canApplyRemote(projectId));
        if (!applied) {
          if (await deleteProject(projectId) === "deleted") result.deleted += 1;
          continue;
        }
        await syncState.markSynced(projectId, remote.snapshot.project.revision, remote.file.id, syncStateBefore.changeToken ?? 0);
        result.imported += 1;
        continue;
      }

      const comparison = compareProjectTimestamps(local.project, remote.snapshot.project);
      if (comparison < 0) {
        const applied = await snapshots.applyIfNewer(remote.snapshot, () => canApplyRemote(projectId));
        if (applied === "applied" || applied === "equal") {
          await syncState.markSynced(projectId, remote.snapshot.project.revision, remote.file.id, syncStateBefore.changeToken ?? 0);
          if (applied === "applied") result.pulled += 1;
        } else if (applied === "local-newer") {
          await markDirtyIfNeeded(projectId);
          if (await syncProject(projectId) === "pushed") result.pushed += 1;
        } else if (applied === "blocked") {
          if (await deleteProject(projectId) === "deleted") result.deleted += 1;
        }
      } else if (comparison > 0) {
        await markDirtyIfNeeded(projectId);
        if (await syncProject(projectId) === "pushed") result.pushed += 1;
      } else {
        await syncState.markSynced(projectId, remote.snapshot.project.revision, remote.file.id, syncStateBefore.changeToken ?? 0);
      }
      localByProject.delete(projectId);
    }

    for (const [projectId] of localByProject) {
      if (await isSharedProject(projectId)) continue;
      if (tombstonedIds.has(projectId)) continue;
      if (await tombstones.get(projectId)) {
        await snapshots.remove(projectId);
        if (await deleteProject(projectId) === "deleted") result.deleted += 1;
        continue;
      }
      await markDirtyIfNeeded(projectId);
      if (await syncProject(projectId) === "pushed") result.pushed += 1;
    }
    for (const tombstone of await tombstones.getAll()) {
      if (await isSharedProject(tombstone.projectId)) continue;
      await snapshots.remove(tombstone.projectId);
      if (await deleteProject(tombstone.projectId) === "deleted") result.deleted += 1;
    }
    return result;
  }

  function reconcileAll(): Promise<DriveReconcileResult> {
    reconciliationInFlight ??= performReconciliation().finally(() => { reconciliationInFlight = null; });
    return reconciliationInFlight;
  }

  return {
    connect: () => auth.connect(),
    disconnect: () => auth.disconnect(),
    getConnectionState: () => auth.getConnectionState(),
    pullProject,
    pushProject,
    syncProject,
    reconcileAll,
    deleteProject
  };
}
