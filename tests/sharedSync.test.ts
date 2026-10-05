import { describe, expect, it, vi } from "vitest";
import { createSharedProjectSync } from "../src/sync/sharedSync";
import { createGoogleDriveProvider } from "../src/sync/googleDriveProvider";
import { createProjectSnapshotStore, serializeProjectSnapshot } from "../src/sync/snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore } from "../src/sync/state";
import type { KeyValueStorage } from "../src/storage/repository";
import type { Project } from "../src/types";
import type { PboardRole } from "../src/sync/drivePermissions";

function setup(role: PboardRole | null = "owner") {
  const data: Record<string, unknown> = {};
  const storage: KeyValueStorage = {
    get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (values) => { Object.assign(data, structuredClone(values)); }
  };
  const project: Project = {
    id: "shared-board", name: "Shared board", template: "project", revision: 2,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z"
  };
  data.projectBoardState = { version: 3, currentProjectId: project.id, projects: [project], boardItems: [] };
  const snapshots = createProjectSnapshotStore(storage);
  const syncState = createDriveSyncStateStore(storage);
  const remote = { ...project, revision: 1, updatedAt: project.createdAt };
  const permissions = {
    myRole: vi.fn(async () => role),
    projectFileId: vi.fn(async () => "shared-file"),
    readSharedSnapshot: vi.fn(async () => serializeProjectSnapshot(remote, [])),
    writeSharedSnapshot: vi.fn(async (_projectId: string, _snapshot: string) => {})
  };
  const rx = { importImages: vi.fn(async () => {}) };
  const syncSharedProject = createSharedProjectSync({ permissions, snapshots, syncState, getRepository: async () => rx });
  const transport = {
    findProjectFile: vi.fn(async () => null), listProjectFiles: vi.fn(async () => []),
    download: vi.fn(async () => ""), upload: vi.fn(async () => ({ id: "private-file", name: "private" })),
    delete: vi.fn(async () => {})
  };
  const provider = createGoogleDriveProvider({
    auth: { connect: async () => {}, disconnect: async () => {}, isConfigured: () => true,
      getConnectionState: async () => "connected", getAccessToken: async () => "token" },
    transport, snapshots, syncState, tombstones: createDriveTombstoneStore(storage),
    isSharedProject: async () => true, syncSharedProject
  });
  return { project, remote, permissions, rx, snapshots, syncState, transport, provider };
}

describe("shared Drive sync", () => {
  it.each(["owner", "editor"] as const)("backs up %s edits and clears pending state using the shared file", async (role) => {
    const { project, permissions, syncState, provider, transport } = setup(role);
    await syncState.markDirty(project.id);
    expect(await provider.syncProject(project.id)).toBe("pushed");
    expect(permissions.writeSharedSnapshot).toHaveBeenCalledWith(project.id, expect.any(String));
    expect(JSON.parse(permissions.writeSharedSnapshot.mock.calls[0][1]).project).toEqual(project);
    expect(await syncState.get(project.id)).toMatchObject({ dirty: false, status: "synced", remoteFileId: "shared-file" });
    expect(transport.upload).not.toHaveBeenCalled();
    expect(transport.findProjectFile).not.toHaveBeenCalled();
  });

  it("lets a viewer refresh matching images without uploading or replacing local documents", async () => {
    const { project, permissions, rx, snapshots, syncState, provider } = setup("viewer");
    await syncState.markDirty(project.id);
    expect(await provider.syncProject(project.id)).toBe("pulled");
    expect(rx.importImages).toHaveBeenCalledWith(project.id, []);
    expect(permissions.writeSharedSnapshot).not.toHaveBeenCalled();
    expect((await snapshots.read(project.id)).project).toEqual(project);
    expect(await syncState.get(project.id)).toMatchObject({ dirty: false, status: "synced" });
  });

  it("keeps edits pending when another save happens during upload", async () => {
    const { project, permissions, syncState, provider } = setup();
    permissions.writeSharedSnapshot.mockImplementation(async () => { await syncState.markDirty(project.id); });
    await syncState.markDirty(project.id);
    await provider.syncProject(project.id);
    expect(await syncState.get(project.id)).toMatchObject({ dirty: true, status: "pending" });
  });

  it("keeps replicated changes pending even if no local dirty notification arrives during upload", async () => {
    const { project, permissions, snapshots, syncState, provider } = setup();
    permissions.writeSharedSnapshot.mockImplementation(async () => {
      await snapshots.apply({ ...(await snapshots.read(project.id)), project: { ...project, revision: 3, updatedAt: "2026-01-03T00:00:00Z" } });
    });
    await syncState.markDirty(project.id);
    await provider.syncProject(project.id);
    expect(await syncState.get(project.id)).toMatchObject({ dirty: true, status: "pending" });
  });

  it("reports upload failures and keeps the project pending for retry", async () => {
    const { project, permissions, syncState, provider } = setup();
    permissions.writeSharedSnapshot.mockRejectedValue(new Error("Drive unavailable"));
    await syncState.markDirty(project.id);
    await expect(provider.syncProject(project.id)).rejects.toThrow("Drive unavailable");
    expect(await syncState.get(project.id)).toMatchObject({ dirty: true, status: "error", error: "Drive unavailable" });
  });

  it("refuses to overwrite a newer Drive backup", async () => {
    const { project, permissions, syncState, provider } = setup();
    permissions.readSharedSnapshot.mockResolvedValue(serializeProjectSnapshot({ ...project, updatedAt: "2026-01-03T00:00:00Z" }, []));
    await syncState.markDirty(project.id);
    await expect(provider.syncProject(project.id)).rejects.toThrow("backup is newer");
    expect(permissions.writeSharedSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a mismatched shared snapshot before importing images", async () => {
    const { project, permissions, rx, syncState, provider } = setup();
    permissions.readSharedSnapshot.mockResolvedValue(serializeProjectSnapshot({ ...project, id: "other-board" }, []));
    await syncState.markDirty(project.id);
    await expect(provider.syncProject(project.id)).rejects.toThrow("different project");
    expect(rx.importImages).not.toHaveBeenCalled();
    expect(permissions.writeSharedSnapshot).not.toHaveBeenCalled();
  });

  it("does not upload after sharing access has been revoked", async () => {
    const { project, permissions, syncState, provider } = setup(null);
    await syncState.markDirty(project.id);
    await expect(provider.syncProject(project.id)).rejects.toThrow("no longer have access");
    expect(permissions.writeSharedSnapshot).not.toHaveBeenCalled();
  });
});
