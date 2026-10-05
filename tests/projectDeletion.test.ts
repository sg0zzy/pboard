import { describe, expect, it, vi } from "vitest";
import { createProjectDeletionRoleResolver } from "../src/sync/projectDeletion";

function setup(shared = true, connected = true) {
  const myRole = vi.fn(async (): Promise<"owner" | "editor" | "viewer" | null> => "owner");
  const resolve = createProjectDeletionRoleResolver({
    sharedProjects: { get: async () => ({ folderId: shared ? "folder" : null,
      projectFileId: shared ? "file" : null, realtimeFolderId: null }) },
    permissions: { myRole }, connected: async () => connected
  });
  return { myRole, resolve };
}

describe("project deletion ownership", () => {
  it.each(["owner", "editor", "viewer"] as const)("uses fresh Drive permission for %s", async (role) => {
    const { myRole, resolve } = setup();
    myRole.mockResolvedValue(role);
    expect(await resolve("shared")).toBe(role);
    expect(myRole).toHaveBeenCalledWith("shared");
  });
  it("allows only account removal when access to a known shared board is revoked or unavailable", async () => {
    const { myRole, resolve } = setup();
    myRole.mockResolvedValue(null);
    expect(await resolve("shared")).toBe("viewer");
    myRole.mockRejectedValue(new Error("Network unavailable"));
    expect(await resolve("shared")).toBe("viewer");
    const offline = setup(true, false);
    expect(await offline.resolve("shared")).toBe("viewer");
    expect(offline.myRole).not.toHaveBeenCalled();
  });
  it("discovers shared ownership even without a local sharing cache", async () => {
    const { myRole, resolve } = setup(false);
    myRole.mockResolvedValue("editor");
    expect(await resolve("shared")).toBe("editor");
    myRole.mockRejectedValue(new Error("Discovery failed"));
    await expect(resolve("unknown")).rejects.toThrow("Discovery failed");
  });
  it("keeps private project deletion available online and offline", async () => {
    const { myRole, resolve } = setup(false);
    myRole.mockResolvedValue(null);
    expect(await resolve("private")).toBe("owner");
    expect(await setup(false, false).resolve("private")).toBe("owner");
  });
  it("does not grant ownership when discovery finds a shared layout but no matching permission", async () => {
    let found = false;
    const resolve = createProjectDeletionRoleResolver({
      sharedProjects: { get: async () => ({ folderId: found ? "folder" : null,
        projectFileId: found ? "file" : null, realtimeFolderId: null }) },
      permissions: { myRole: async () => { found = true; return null; } },
      connected: async () => true
    });
    expect(await resolve("shared")).toBe("viewer");
  });
});
