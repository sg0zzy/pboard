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
import { snapshotFingerprint, type PrivateDriveHistory } from "./privateDriveHistory";

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
  syncProject(projectId: string, options?: { force?: boolean }): Promise<ProjectSyncResult>;
  /**
   * One reconciliation round. `force` (connect, the periodic alarm, an explicit
   * "sync now") always runs; without it a round that just completed in this
   * context, or in the other context sharing this storage, is coalesced.
   */
  reconcileAll(options?: { force?: boolean }): Promise<DriveReconcileResult>;
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
  syncSharedProject?: (projectId: string, changeToken: number) => Promise<ProjectSyncResult>;
  syncPreferences?: () => Promise<void>;
  isDeletedProject?: (projectId: string) => Promise<boolean>;
  history?: PrivateDriveHistory;
  /**
   * Whether a never-before-persisted local board may receive private persistence
   * under the currently connected account. The runtime's policy is "a connected
   * Drive is consent"; leaving this unset falls back to explicit-context-only
   * enrollment, which keeps background reconciliation passive.
   */
  allowBinding?: (projectId: string, context: "reconcile" | "explicit") => Promise<boolean>;
};

type RemoteSnapshot = { file: DriveAppDataFile; snapshot: ProjectSnapshot };

export function createGoogleDriveProvider({ auth, transport, snapshots, syncState, tombstones, beforeReconcile,
  isSharedProject = async () => false, syncSharedProject, syncPreferences,
  isDeletedProject = async () => false, history, allowBinding }: Dependencies): GoogleDriveProvider {
  const syncInFlight = new Map<string, Promise<ProjectSyncResult>>();
  const manualInFlight = new Map<string, Promise<ProjectSyncResult>>();
  let reconciliationInFlight: Promise<DriveReconcileResult> | null = null;
  /** Enrollment policy is injected (`allowBinding`); the runtime treats a connected Drive as consent. */
  const mayUpload = async (projectId: string, context: "reconcile" | "explicit"): Promise<boolean> => {
    if (!history || !await history.available()) return true;
    if (await history.boundAccountFor(projectId)) return true;
    return allowBinding ? await allowBinding(projectId, context) : context === "explicit";
  };

  async function resolveFile(projectId: string): Promise<DriveAppDataFile | null> {
    const state = await syncState.get(projectId);
    if (state.remoteFileId) return { id: state.remoteFileId, name: `project-${projectId}.pboard` };
    return await transport.findProjectFile(projectId);
  }

  async function readRemote(file: DriveAppDataFile, using = transport): Promise<RemoteSnapshot> {
    const snapshot = deserializeProjectSnapshot(await using.download(file.id));
    return { file, snapshot };
  }

  async function markDirtyIfNeeded(projectId: string): Promise<void> {
    if (!(await syncState.get(projectId)).dirty) await syncState.markDirty(projectId);
  }

  async function canApplyRemote(projectId: string): Promise<boolean> {
    return (await tombstones.get(projectId)) === null && !await isDeletedProject(projectId);
  }

  async function uploadSnapshot(
    snapshot: ProjectSnapshot,
    file: DriveAppDataFile | null,
    expectedChangeToken?: number,
    using = transport
  ): Promise<DriveAppDataFile> {
    const uploaded = await using.upload(
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
    if (!file) {
      if (history && await history.available() && (await history.boards()).includes(projectId)) {
        if (!await history.sync(projectId, [], () => canApplyRemote(projectId)) || !await canApplyRemote(projectId)) return null;
        return snapshots.read(projectId).catch(() => null);
      }
      return null;
    }
    const { snapshot } = await readRemote(file);
    if (snapshot.project.id !== projectId) throw new Error("Google Drive returned a snapshot for a different project");
    const stateBeforePull = await syncState.get(projectId);
    if (history && await history.available()) {
      if (!await history.sync(projectId, [snapshot], () => canApplyRemote(projectId)) || !await canApplyRemote(projectId)) return null;
      return snapshots.read(projectId);
    }
    const result = await snapshots.applyIfNewer(snapshot, () => canApplyRemote(projectId));
    if (result === "local-newer" || result === "blocked") return null;
    await syncState.markSynced(projectId, snapshot.project.revision, file.id, stateBeforePull.changeToken ?? 0);
    return snapshot;
  }

  async function pushProject(projectId: string, expectedChangeToken?: number): Promise<DriveAppDataFile> {
    const stateBeforePush = await syncState.get(projectId);
    const guardedChangeToken = expectedChangeToken ?? stateBeforePush.changeToken ?? 0;
    if (history && await history.available() && !await isSharedProject(projectId)) {
      if (!await mayUpload(projectId, "explicit")) throw new Error("This board is not enrolled for private persistence under this account; its local data is retained");
      const remote = await resolveFile(projectId);
      const legacy = remote ? [(await readRemote(remote)).snapshot] : [];
      const bound = await history.sync(projectId, legacy, () => canApplyRemote(projectId));
      if (!bound || !await canApplyRemote(projectId)) throw new Error("Private recovery remains pending");
      return uploadSnapshot(await snapshots.read(projectId), await bound.findProjectFile(projectId), guardedChangeToken, bound);
    }
    const snapshot = await snapshots.read(projectId);
    return uploadSnapshot(snapshot, await resolveFile(projectId), guardedChangeToken);
  }

  async function performProjectSync(projectId: string, force = false): Promise<ProjectSyncResult> {
    if (!force) await history?.flushErasures?.();
    const erasure = await history?.erasureStatus?.(projectId);
    if (erasure) {
      if (erasure.cloudPending) throw new Error('Private Drive board deletion remains pending');
      await syncState.forget(projectId); return 'not-dirty';
    }
    if (!force) await syncPreferences?.();
    if (await isDeletedProject(projectId)) return "not-dirty";
    if (await tombstones.get(projectId)) return "not-dirty";
    if (force) await syncState.markDirty(projectId);
    const state = await syncState.get(projectId);
    if (!state.dirty) return "not-dirty";
    if (await auth.getConnectionState() !== "connected") throw new Error("Google Drive is not connected");
    await syncState.markSyncing(projectId);
    try {
      if (await isSharedProject(projectId)) {
        if (!syncSharedProject) throw new Error("Shared project sync is unavailable");
        return await syncSharedProject(projectId, state.changeToken ?? 0);
      }
      if (history && await history.available()) {
        if (!await mayUpload(projectId, "explicit")) throw new Error("This board is not enrolled for private persistence under this account; its local data is retained");
        const remoteFile = await resolveFile(projectId);
        const remote = remoteFile ? await readRemote(remoteFile) : null;
        if (remote && remote.snapshot.project.id !== projectId) throw new Error("Google Drive returned a snapshot for a different project");
        const bound = await history.sync(projectId, remote ? [remote.snapshot] : [], () => canApplyRemote(projectId));
        if (!bound) {
          await syncState.markDirty(projectId); return "not-dirty";
        }
        if (!await canApplyRemote(projectId)) return "not-dirty";
        const merged = await snapshots.read(projectId);
        const boundFile = await bound.findProjectFile(projectId), cached = boundFile ? await readRemote(boundFile, bound) : null;
        if (cached && await snapshotFingerprint(merged) === await snapshotFingerprint(cached.snapshot)) {
          await syncState.markSynced(projectId, merged.project.revision, boundFile!.id, state.changeToken ?? 0);
          return "not-dirty";
        }
        await uploadSnapshot(merged, boundFile, state.changeToken ?? 0, bound);
        return "pushed";
      }
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

  function syncProject(projectId: string, options?: { force?: boolean }): Promise<ProjectSyncResult> {
    if (options?.force) {
      const pending = manualInFlight.get(projectId); if (pending) return pending;
      const current = syncInFlight.get(projectId);
      const operation = (async () => {
        // Finish the older snapshot first, then read the latest local revision.
        // Concurrent manual requests share this one follow-up pass.
        if (current) await current.catch(() => undefined);
        return startSync(projectId, true);
      })().finally(() => manualInFlight.delete(projectId));
      manualInFlight.set(projectId, operation); return operation;
    }
    return manualInFlight.get(projectId) ?? startSync(projectId);
  }
  function startSync(projectId: string, force = false): Promise<ProjectSyncResult> {
    const current = syncInFlight.get(projectId);
    if (current) return current;
    const operation = performProjectSync(projectId, force).finally(() => syncInFlight.delete(projectId));
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
      if (history && await history.available()) {
        const bound = await history.sync(projectId, [], async () => false);
        if (!bound || await auth.getConnectionState() !== "connected") return "pending";
        const file = await bound.findProjectFile(projectId);
        if (file) await bound.delete(file.id);
        await tombstones.clear(projectId); await syncState.forget(projectId);
        return "deleted";
      }
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
    const failures: unknown[] = [];
    const finish = (result: DriveReconcileResult) => {
      if (failures.length) {
        const reason = failures[0] instanceof Error ? failures[0].message.slice(0, 240) : 'Recovery failed';
        throw new AggregateError(failures, `Google Drive reconciliation is incomplete; other boards were checked. ${reason}`);
      }
      return result;
    };
    await history?.flushErasures?.();
    const pendingTombstones = await tombstones.getAll();
    // Shared boards keep a permanent local tombstone (their Drive folder is not
    // deleted); it only hides the project, so reconcile must not delete it.
    const privateTombstones: typeof pendingTombstones = [];
    for (const tombstone of pendingTombstones) {
      if (await history?.erasureStatus?.(tombstone.projectId)) continue;
      if (!await isSharedProject(tombstone.projectId)) privateTombstones.push(tombstone);
    }
    // Explicit local deletes stay hidden even when Drive is unavailable.
    for (const tombstone of privateTombstones) await snapshots.remove(tombstone.projectId);
    const empty: DriveReconcileResult = { status: "disconnected", imported: 0, pulled: 0, pushed: 0, deleted: 0 };
    if (await auth.getConnectionState() !== "connected") return empty;
    if (history && await history.available()) {
      for (const tombstone of privateTombstones) {
        if (!await history.sync(tombstone.projectId, [], async () => false)) throw new Error("Private deletion backup remains pending");
      }
    }
    // Project ordering is independent of restoring missing board contents.
    try { await syncPreferences?.(); } catch (error) { failures.push(error); }
    // Legacy invitation discovery must not gate account-private restoration.
    // Existing shared-board classification and all per-board checks still apply.
    try { await beforeReconcile?.(); } catch (error) { failures.push(error); }

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
    const downloaded = await Promise.allSettled(downloadableFiles.map(file => readRemote(file)));
    const remoteEntries: RemoteSnapshot[] = [];
    const failedFiles = new Set<string>(), failedNames = new Set<string>();
    for (const [index, entry] of downloaded.entries()) {
      if (entry.status === 'fulfilled') remoteEntries.push(entry.value);
      else {
        failures.push(entry.reason);
        failedFiles.add(downloadableFiles[index].id);
        failedNames.add(downloadableFiles[index].name);
      }
    }
    const unreadableSnapshot = async (boardId: string) => {
      if (!failedFiles.size) return false;
      const state = await syncState.get(boardId);
      if (!failedNames.has(`project-${boardId.replace(/[^a-zA-Z0-9_-]/g, '_')}.pboard`)
        && (!state.remoteFileId || !failedFiles.has(state.remoteFileId))) return false;
      // A failed read is never evidence of remote absence, nor permission to
      // overwrite that file with a possibly stale local compatibility snapshot.
      await syncState.markError(boardId, 'A Drive snapshot could not be read; this board remains pending recovery.');
      return true;
    };

    for (const tombstone of pendingTombstones) {
      if (failedNames.has(`project-${tombstone.projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}.pboard`)) {
        deletionSucceeded.set(tombstone.projectId, false);
      }
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
      if (await isDeletedProject(projectId)) continue;
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

    if (history && await history.available()) {
      const boards = new Set([...localByProject.keys(), ...remoteByProject.keys(), ...await history.boards(error => failures.push(error))]);
      for (const boardId of boards) {
        try {
          if (await unreadableSnapshot(boardId)) continue;
          // A hidden/deleted board's variants still need recovery into the local
          // archive. Its local guard prevents materialization and snapshot upload.
          if (await isSharedProject(boardId)) continue;
          const existed = localByProject.has(boardId);
          // A locally created board with no durable account binding is enrolled
          // only per the injected allowBinding policy (connected Drive = consent).
          if (existed && !remoteByProject.has(boardId) && !await mayUpload(boardId, "reconcile")) continue;
          const state = await syncState.get(boardId);
          const legacy = remoteEntries.filter(entry => entry.snapshot.project.id === boardId).map(entry => entry.snapshot);
          const bound = await history.sync(boardId, legacy, () => canApplyRemote(boardId));
          if (!bound) { await syncState.markDirty(boardId); continue; }
          if (!await canApplyRemote(boardId)) continue;
          const snapshot = await snapshots.read(boardId).catch(() => null);
          if (!snapshot) continue;
          const file = await bound.findProjectFile(boardId);
          const cached = file ? await readRemote(file, bound) : null;
          if (!cached || await snapshotFingerprint(snapshot) !== await snapshotFingerprint(cached.snapshot)) {
            await uploadSnapshot(snapshot, file, state.changeToken ?? 0, bound); result.pushed++;
          } else await syncState.markSynced(boardId, snapshot.project.revision, file!.id, state.changeToken ?? 0);
          if (!existed) result.imported++; else if (legacy.length) result.pulled++;
        } catch (error) {
          // An invalid/expired grant, account binding, or corrupt archive for
          // one board must not prevent recovery of unrelated private boards.
          failures.push(error);
          await syncState.markError(boardId, error instanceof Error ? error.message : 'Private board recovery failed');
        }
      }
      if (await auth.getConnectionState() !== "connected") result.status = "disconnected";
      return finish(result);
    }

    for (const [projectId, remote] of remoteByProject) {
      if (await unreadableSnapshot(projectId)) continue;
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
      if (await unreadableSnapshot(projectId)) continue;
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
      if (await history?.erasureStatus?.(tombstone.projectId)) continue;
      if (await isSharedProject(tombstone.projectId)) continue;
      await snapshots.remove(tombstone.projectId);
      if (await deleteProject(tombstone.projectId) === "deleted") result.deleted += 1;
    }
    return finish(result);
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
