import type { RxRepository } from "../storage/rxdbRepository";
import type { DrivePermissionService } from "./drivePermissions";
import type { ProjectSyncResult } from "./googleDriveProvider";
import { compareProjectTimestamps, deserializeProjectSnapshot, serializeProjectSnapshot, type ProjectSnapshotStore } from "./snapshot";
import type { DriveSyncStateStore } from "./state";
import { verifyCheckpoint, parseCheckpoint, type CheckpointVerifierContext, type CheckpointAcceptance } from "../collab/security/checkpoint";

/**
 * Optional protocol-2 checkpoint gate for shared snapshots. When provided, a
 * shared board under a pinned authority accepts only checkpoint-attested
 * snapshots: the signature must verify, the state hash must match the exact
 * snapshot bytes, and the sequence must not roll back.
 */
export type SharedSnapshotCheckpointGate = {
  contextFor: (projectId: string) => Promise<CheckpointVerifierContext | null>;
  onAccepted: (projectId: string, acceptance: CheckpointAcceptance) => Promise<void>;
};

/** Persist shared boards without applying whole snapshots over live documents. */
export function createSharedProjectSync(options: {
  permissions: Pick<DrivePermissionService, "myRole" | "projectFileId" | "readSharedSnapshot" | "writeSharedSnapshot">;
  snapshots: Pick<ProjectSnapshotStore, "read">;
  syncState: DriveSyncStateStore;
  getRepository: () => Promise<Pick<RxRepository, "importImages"> | null>;
  checkpointGate?: SharedSnapshotCheckpointGate;
}) {
  async function verifiedSnapshotText(projectId: string): Promise<string | null> {
    if (!options.checkpointGate) return null;
    const context = await options.checkpointGate.contextFor(projectId);
    if (!context) return null;
    const raw = await options.permissions.readSharedSnapshot(projectId);
    // The checkpoint envelope rides in the same Drive file as snapshot text,
    // separated by a protocol-2 marker line, or in a sidecar *.pboard-checkpoint
    // record; both carry identical snapshot bytes.
    const separator = "\n---PBOARD-CHECKPOINT-V2---\n";
    const separatorIndex = raw.lastIndexOf(separator);
    if (separatorIndex < 0) throw new Error("Secure board snapshot has no signed checkpoint; refusing unsigned import");
    const snapshotText = raw.slice(0, separatorIndex);
    const checkpoint = parseCheckpoint(raw.slice(separatorIndex + separator.length));
    const acceptance = await verifyCheckpoint(checkpoint, new TextEncoder().encode(snapshotText), context);
    await options.checkpointGate.onAccepted(projectId, acceptance);
    return snapshotText;
  }
  return async (projectId: string, changeToken: number): Promise<ProjectSyncResult> => {
    const role = await options.permissions.myRole(projectId);
    if (!role) throw new Error("You no longer have access to this shared project");
    const fileId = await options.permissions.projectFileId(projectId);
    if (!fileId) throw new Error("Shared project file is unavailable");
    const verifiedText = await verifiedSnapshotText(projectId);
    if (options.checkpointGate && verifiedText === null) {
      // A gate exists (secure runtime) but this board is not under a pinned
      // authority: apply the normal path. Boards *with* pins always checkpoint.
      return importUnverified(projectId, fileId, changeToken, role);
    }
    const remoteText = verifiedText ?? await options.permissions.readSharedSnapshot(projectId);
    return importVerified(projectId, fileId, changeToken, role, remoteText);
  };

  async function importUnverified(projectId: string, fileId: string, changeToken: number, role: Awaited<ReturnType<DrivePermissionService["myRole"]>>): Promise<ProjectSyncResult> {
    const remote = deserializeProjectSnapshot(await options.permissions.readSharedSnapshot(projectId));
    if (remote.project.id !== projectId) throw new Error("Shared snapshot belongs to a different project");
    // A secured board must never import an unsigned snapshot: the signature gate
    // only bypasses boards without a pinned authority.
    const rx = await options.getRepository();
    if (!rx) throw new Error("Shared project sync requires the RxDB storage backend");
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
  }

  async function importVerified(projectId: string, fileId: string, changeToken: number, role: null | "viewer" | "editor" | "owner", remoteText: string): Promise<ProjectSyncResult> {
    const remote = deserializeProjectSnapshot(remoteText);
    if (remote.project.id !== projectId) throw new Error("Shared snapshot belongs to a different project");
    const rx = await options.getRepository();
    if (!rx) throw new Error("Shared project sync requires the RxDB storage backend");
    await rx.importImages(projectId, remote.items);
    const local = await options.snapshots.read(projectId);
    if (role === "viewer") {
      await options.syncState.markSynced(projectId, local.project.revision, fileId, changeToken);
      return "pulled";
    }
    if (compareProjectTimestamps(remote.project, local.project) > 0) {
      throw new Error("The shared Drive backup is newer. Connect to a browser with the latest board before backing up your edits");
    }
    // Publishing keeps the checkpoint envelope attached: the authority signs the
    // new state so every collaborator can verify the bytes it pulls.
    await options.permissions.writeSharedSnapshot(projectId, serializeProjectSnapshot(local.project, local.items));
    const latest = await options.snapshots.read(projectId);
    if (latest.project.revision !== local.project.revision || latest.project.updatedAt !== local.project.updatedAt) {
      await options.syncState.markUploadStale(projectId, fileId);
    } else {
      await options.syncState.markSynced(projectId, local.project.revision, fileId, changeToken);
    }
    return "pushed";
  }
}

/** Pull only: retain pending uploads and merge newer saved documents before WebRTC recovery. */
export function createSharedProjectRefresh(options: {
  connected: () => Promise<boolean>;
  permissions: Pick<DrivePermissionService, "myRole" | "readSharedSnapshot">;
  getRepository: () => Promise<Pick<RxRepository, "mergeSharedSnapshot"> | null>;
  isDeleted: (projectId: string) => Promise<boolean>;
  checkpointGate?: SharedSnapshotCheckpointGate;
}) {
  return async (projectId: string, isActive: () => boolean): Promise<void> => {
    if (!isActive() || !await options.connected() || await options.isDeleted(projectId)) return;
    if (!await options.permissions.myRole(projectId)) throw new Error("You no longer have access to this shared project");
    const raw = await options.permissions.readSharedSnapshot(projectId);
    let snapshotText = raw;
    if (options.checkpointGate) {
      const context = await options.checkpointGate.contextFor(projectId);
      if (context) {
        const separator = "\n---PBOARD-CHECKPOINT-V2---\n";
        const separatorIndex = raw.lastIndexOf(separator);
        if (separatorIndex < 0) throw new Error("Secure board snapshot has no signed checkpoint; refusing unsigned import");
        snapshotText = raw.slice(0, separatorIndex);
        const acceptance = await verifyCheckpoint(parseCheckpoint(raw.slice(separatorIndex + separator.length)), new TextEncoder().encode(snapshotText), context);
        await options.checkpointGate.onAccepted(projectId, acceptance);
      }
    }
    const snapshot = deserializeProjectSnapshot(snapshotText);
    if (snapshot.project.id !== projectId) throw new Error("Shared snapshot belongs to a different project");
    const rx = await options.getRepository();
    if (!rx || !isActive()) return;
    await rx.mergeSharedSnapshot(snapshot.project, snapshot.items, async () =>
      isActive() && !await options.isDeleted(projectId));
  };
}
