import { createRepository } from "./repository";
import { browser } from "../platform/browser";
import { driveSyncState, driveTombstones, googleDrive } from "../sync/browser";

export const repository = createRepository(browser.storage.local, {
  projectChanged: (projectId) => driveSyncState.markDirty(projectId),
  projectDeleting: async (project) => {
    const syncState = await driveSyncState.get(project.id);
    await driveTombstones.add({
      projectId: project.id,
      ...(syncState.remoteFileId ? { remoteFileId: syncState.remoteFileId } : {}),
      deletedAt: new Date().toISOString(),
      projectUpdatedAt: project.updatedAt,
      revision: project.revision
    });
  },
  projectDeleted: (projectId) => { void googleDrive.deleteProject(projectId); }
});
