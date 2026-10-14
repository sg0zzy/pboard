import type { RxRepository } from "../storage/rxdbRepository";
import type { DrivePermissionService } from "./drivePermissions";
import type { ProjectSyncResult } from "./googleDriveProvider";
import { compareProjectTimestamps, deserializeProjectSnapshot, serializeProjectSnapshot, type ProjectSnapshotStore } from "./snapshot";
import type { DriveSyncStateStore } from "./state";

/** Persist shared boards without applying whole snapshots over live documents. */
export function createSharedProjectSync(options: {
  permissions: Pick<DrivePermissionService, "myRole" | "projectFileId" | "readSharedSnapshot" | "writeSharedSnapshot">;
  snapshots: Pick<ProjectSnapshotStore, "read">;
  syncState: DriveSyncStateStore;
  getRepository: () => Promise<Pick<RxRepository, "importImages"> | null>;
}) {
  return async (projectId: string, changeToken: number): Promise<ProjectSyncResult> => {
    const role = await options.permissions.myRole(projectId);
    if (!role) throw new Error("You no longer have access to this shared project");
    const fileId = await options.permissions.projectFileId(projectId);
    if (!fileId) throw new Error("Shared project file is unavailable");
    const remote = deserializeProjectSnapshot(await options.permissions.readSharedSnapshot(projectId));
    if (remote.project.id !== projectId) throw new Error("Shared snapshot belongs to a different project");
    const rx = await options.getRepository();
    if (!rx) throw new Error("Shared project sync requires the RxDB storage backend");
    // Matching images can be restored even when live text is newer. Never
    // import remote card/project documents over WebRTC's individual merges.
    await rx.importImages(projectId, remote.items);
    const local = await options.snapshots.read(projectId);
    if (role === "viewer") {
      await options.syncState.markSynced(projectId, local.project.revision, fileId, changeToken);
      return "pulled";
    }
    if (compareProjectTimestamps(remote.project, local.project) > 0) {
      throw new Error("The shared Drive backup is newer. Connect to a browser with the latest board before backing up your edits");
    }
    await options.permissions.writeSharedSnapshot(projectId, serializeProjectSnapshot(local.project, local.items));
    const latest = await options.snapshots.read(projectId);
    if (latest.project.revision !== local.project.revision || latest.project.updatedAt !== local.project.updatedAt) {
      await options.syncState.markUploadStale(projectId, fileId);
    } else {
      await options.syncState.markSynced(projectId, local.project.revision, fileId, changeToken);
    }
    return "pushed";
  };
}

/** Pull only: retain pending uploads and merge newer saved documents before WebRTC recovery. */
export function createSharedProjectRefresh(options: {
  connected: () => Promise<boolean>;
  permissions: Pick<DrivePermissionService, "myRole" | "readSharedSnapshot">;
  getRepository: () => Promise<Pick<RxRepository, "mergeSharedSnapshot"> | null>;
  isDeleted: (projectId: string) => Promise<boolean>;
}) {
  return async (projectId: string, isActive: () => boolean): Promise<void> => {
    if (!isActive() || !await options.connected() || await options.isDeleted(projectId)) return;
    if (!await options.permissions.myRole(projectId)) throw new Error("You no longer have access to this shared project");
    const snapshot = deserializeProjectSnapshot(await options.permissions.readSharedSnapshot(projectId));
    if (snapshot.project.id !== projectId) throw new Error("Shared snapshot belongs to a different project");
    const rx = await options.getRepository();
    if (!rx || !isActive()) return;
    await rx.mergeSharedSnapshot(snapshot.project, snapshot.items, async () =>
      isActive() && !await options.isDeleted(projectId));
  };
}
