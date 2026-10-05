import type { DrivePermissionService, DriveSharedProjectStore, PboardRole } from "./drivePermissions";

/** Unknown ownership on a known shared board permits account-only removal. */
export function createProjectDeletionRoleResolver(options: {
  sharedProjects: Pick<DriveSharedProjectStore, "get">;
  permissions: Pick<DrivePermissionService, "myRole">;
  connected: () => Promise<boolean>;
}) {
  return async (projectId: string): Promise<PboardRole> => {
    const cached = await options.sharedProjects.get(projectId);
    const shared = Boolean(cached.folderId || cached.projectFileId);
    if (!await options.connected()) return shared ? "viewer" : "owner";
    try {
      const role = await options.permissions.myRole(projectId);
      if (role) return role;
      // Role discovery may populate an initially empty layout cache even when
      // access was revoked or the current identity cannot be resolved.
      const discovered = await options.sharedProjects.get(projectId);
      return shared || discovered.folderId || discovered.projectFileId ? "viewer" : "owner";
    } catch (error) {
      if (shared) return "viewer";
      // Discovery failed, so we cannot establish whether this is a private board.
      throw error;
    }
  };
}
