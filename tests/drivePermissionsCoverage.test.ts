// Drive-backed sharing service. The transport (Drive API) and the shared-layout
// store are both faked; no live Drive, no RxDB. Asserts the service is the only
// place that writes collaborator ACLs: invite is the sole `createPermission`
// entry point, role changes are `updatePermission`, removals are
// `deletePermission`, and everything else is read-only.

import { describe, expect, it, vi } from "vitest";
import {
  createDrivePermissionService,
  type Collaborator,
  type DriveFileRef,
  type DrivePermission,
  type DrivePermissionTransport,
  type DriveSharedProjectRecord,
  type DriveSharedProjectStore,
  type PboardCollaboratorRole,
} from "../src/sync/drivePermissions";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------
const FOLDER_MIME = "application/vnd.google-apps.folder";
const JSON_MIME = "application/json";

function folderRef(id: string, name: string): DriveFileRef {
  return { id, name, mimeType: FOLDER_MIME, parents: [] };
}
function fileRef(id: string, name: string): DriveFileRef {
  return { id, name, mimeType: JSON_MIME, parents: [] };
}
function userPerm(
  id: string,
  role: "reader" | "writer" | "owner",
  emailAddress: string,
  displayName?: string,
): DrivePermission {
  return { id, type: "user", role, emailAddress, displayName };
}
function nonUserPerm(
  id: string,
  type: "group" | "anyone",
  role: "reader" | "writer",
): DrivePermission {
  return { id, type, role };
}

/** Fake `DrivePermissionTransport`. All reads resolve; every `vi.fn` is
    * recorded so callers can inspect which Drive API calls the service made. */
function makeTransport(opts: {
  identity?: { email: string; name?: string } | null;
  sharedRoot?: DriveFileRef | null;
  filesById?: Record<string, DriveFileRef>;
  fileParents?: Record<string, string[]>;
  findFile?: (name: string, parentId: string) => DriveFileRef | null;
  listFilesByNameResult?: DriveFileRef[];
  listPermissions?: (fileId: string) => DrivePermission[];
  snapshot?: string;
} = {}) {
  return {
    currentIdentity: vi
      .fn()
      .mockResolvedValue(opts.identity !== undefined ? opts.identity : { email: "me@example.com", name: "Me" }),
    findSharedRoot: vi.fn().mockResolvedValue(opts.sharedRoot ?? null),
    createFolder: vi.fn(async (name: string, parentId: string = "") => ({
      id: name,
      name,
      mimeType: FOLDER_MIME,
      parents: parentId ? [parentId] : [],
    })),
    findFile: vi.fn(async (name: string, parentId: string) =>
      opts.findFile?.(name, parentId) ?? null,
    ),
    createJsonFile: vi.fn(async (name: string, parentId: string) =>
      fileRef(`${name}@${parentId}`, name),
    ),
    uploadJsonFile: vi.fn().mockResolvedValue(
      ({ id: "uploaded", name: "project.json", mimeType: JSON_MIME } as const),
    ),
    downloadFile: vi.fn().mockResolvedValue("{}"),
    downloadFileOrNull: vi.fn().mockResolvedValue(null),
    getFile: vi.fn(async (fileId: string) => opts.filesById?.[fileId] ?? folderRef(fileId, "f")),
    listFiles: vi.fn().mockResolvedValue([]),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    getFileParents: vi.fn(async (fileId: string) => opts.fileParents?.[fileId] ?? []),
    listFilesByName: vi.fn(async (name: string, mimeType: string) => {
      if (name !== "project.json" || mimeType !== JSON_MIME) {
        throw new Error(`unexpected listFilesByName(${name}, ${mimeType})`);
      }
      return opts.listFilesByNameResult ?? [];
    }),
    listPermissions: vi.fn(async (fileId: string) => opts.listPermissions?.(fileId) ?? []),
    createPermission: vi
      .fn(async (fileId: string, role: PboardCollaboratorRole, email: string): Promise<DrivePermission> => ({
        id: `perm-${fileId}-${email}`,
        type: "user",
        role: role === "editor" ? "writer" : "reader",
        emailAddress: email,
      })),
    updatePermission: vi
      .fn(async (fileId: string, permissionId: string, role: PboardCollaboratorRole): Promise<DrivePermission> => ({
        id: permissionId,
        type: "user",
        role: role === "editor" ? "writer" : "reader",
      })),
    deletePermission: vi.fn().mockResolvedValue(undefined),
  } satisfies DrivePermissionTransport;
}

/** Fake `DriveSharedProjectStore`, seeded with an optional initial layout. */
function makeStore(seed: Record<string, DriveSharedProjectRecord> = {}) {
  const map: Record<string, DriveSharedProjectRecord> = { ...seed };
  return {
    get: vi.fn(async (projectId: string) =>
      map[projectId] ?? { folderId: null, projectFileId: null, realtimeFolderId: null },
    ),
    set: vi.fn(async (projectId: string, patch: Partial<DriveSharedProjectRecord>) => {
      map[projectId] = { ...map[projectId], ...patch };
    }),
    delete: vi.fn(async (projectId: string) => {
      delete map[projectId];
    }),
    // Test-only: synchronous view of the store's current state.
    state: () => ({ ...map }),
  };
}

/** Build a service, and hand back the service + its doubles for assertions. */
function makeService(opts: {
  identity?: { email: string; name?: string } | null;
  layout?: { folderId: string; projectFileId: string; realtimeFolderId: string };
  sharedRoot?: DriveFileRef | null;
  filesById?: Record<string, DriveFileRef>;
  fileParents?: Record<string, string[]>;
  findFile?: (name: string, parentId: string) => DriveFileRef | null;
  listFilesByNameResult?: DriveFileRef[];
  listPermissions?: (fileId: string) => DrivePermission[];
  snapshot?: string;
} = {}) {
  const sharedProjects = makeStore(
    opts.layout
      ? { p1: { ...opts.layout } }
      : {},
  );
  const transport = makeTransport({
    identity: opts.identity,
    sharedRoot: opts.sharedRoot,
    filesById: opts.filesById,
    fileParents: opts.fileParents,
    findFile: opts.findFile,
    listFilesByNameResult: opts.listFilesByNameResult,
    listPermissions: opts.listPermissions,
    snapshot: opts.snapshot ?? '{"id":"p1"}',
  });
  const service = createDrivePermissionService({
    transport,
    sharedProjects,
    readSnapshot: async (projectId: string) => opts.snapshot ?? JSON.stringify({ id: projectId }),
  });
  return { service, transport, store: sharedProjects };
}

// ---------------------------------------------------------------------------
// myRole
// ---------------------------------------------------------------------------
describe("myRole", () => {
  it("returns null when the project is not shared", async () => {
    const { service, transport } = makeService();
    await expect(service.myRole("p1")).resolves.toBeNull();
    expect(transport.listPermissions).not.toHaveBeenCalled();
  });

  it('returns "owner" when the account is the file owner', async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) => (id === "proj" ? [userPerm("o", "owner", "me@example.com", "Me")] : []),
    });
    await expect(service.myRole("p1")).resolves.toBe("owner");
  });

  it('returns "editor" for a Drive writer permission', async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) => (id === "proj" ? [userPerm("w", "writer", "me@example.com", "Me")] : []),
    });
    await expect(service.myRole("p1")).resolves.toBe("editor");
  });

  it('returns "viewer" for a Drive reader permission', async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) => (id === "proj" ? [userPerm("r", "reader", "me@example.com", "Me")] : []),
    });
    await expect(service.myRole("p1")).resolves.toBe("viewer");
  });

  it("returns null when the account has no permission of its own", async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) => (id === "proj" ? [userPerm("x", "writer", "other@example.com")] : []),
    });
    await expect(service.myRole("p1")).resolves.toBeNull();
  });

  it("returns null when there is no signed-in identity", async () => {
    const { service } = makeService({
      identity: null,
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) => (id === "proj" ? [userPerm("o", "owner", "me@example.com", "Me")] : []),
    });
    await expect(service.myRole("p1")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// projectFileId
// ---------------------------------------------------------------------------
describe("projectFileId", () => {
  it("returns null when the project is not shared", async () => {
    const { service } = makeService();
    await expect(service.projectFileId("p1")).resolves.toBeNull();
  });

  it("returns the cached file id when the project is shared", async () => {
    const { service } = makeService({ layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" } });
    await expect(service.projectFileId("p1")).resolves.toBe("pf");
  });

  it("discovers and caches the file id when only discoverable", async () => {
    const { service, store } = makeService({
      fileParents: { "f1": ["p1-folder"] },
      filesById: { "p1-folder": folderRef("p1-folder", "p1") },
      listFilesByNameResult: [fileRef("f1", "project.json")],
    });
    await expect(service.projectFileId("p1")).resolves.toBe("f1");
    expect(store.set).toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ folderId: "p1-folder", projectFileId: "f1" }),
    );
    expect(store.state()).toEqual({ p1: { folderId: "p1-folder", projectFileId: "f1" } });
  });
});

// ---------------------------------------------------------------------------
// listCollaborators
// ---------------------------------------------------------------------------
describe("listCollaborators", () => {
  it("returns [] when the project is not shared", async () => {
    const { service } = makeService();
    await expect(service.listCollaborators("p1")).resolves.toEqual([]);
  });

  it("orders owner first, then editors, then viewers; alphabetically within a role", async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj"
          ? [
              userPerm("o", "owner", "me@example.com", "Me"),
              userPerm("e-a", "writer", "a@y.com", "E A"),
              userPerm("e-b", "writer", "b@y.com", "E B"),
              userPerm("v-a", "reader", "a@x.com", "V A"),
              userPerm("v-b", "reader", "b@x.com", "V B"),
            ]
          : [],
    });
    await expect(service.listCollaborators("p1")).resolves.toEqual(
      [
        { email: "me@example.com", role: "owner", name: "Me", permissionId: "o" },
        { email: "a@y.com", role: "editor", name: "E A", permissionId: "e-a" },
        { email: "b@y.com", role: "editor", name: "E B", permissionId: "e-b" },
        { email: "a@x.com", role: "viewer", name: "V A", permissionId: "v-a" },
        { email: "b@x.com", role: "viewer", name: "V B", permissionId: "v-b" },
      ] as Collaborator[],
    );
  });

  it("skips non-user permission types", async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj"
          ? [
              userPerm("e", "writer", "a@y.com", "E A"),
              nonUserPerm("g", "group", "reader"),
              nonUserPerm("a", "anyone", "reader"),
            ]
          : [],
    });
    await expect(service.listCollaborators("p1")).resolves.toEqual([
      { email: "a@y.com", role: "editor", name: "E A", permissionId: "e" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------
describe("invite", () => {
  it("rejects an invalid email and creates no permission", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      sharedRoot: folderRef("Pboard", "Pboard"),
    });
    for (const bad of ["", "no-at-sign", "a@b", "a b@c.com", "@x.com"]) {
      await expect(service.invite("p1", bad, "editor")).rejects.toThrow("Enter a valid email address");
    }
    expect(transport.createPermission).not.toHaveBeenCalled();
  });

  it("creates the shared layout, then grants both ACLs for a fresh project", async () => {
    const { service, transport, store } = makeService({
      snapshot: '{"id":"p1"}',
    });
    await expect(service.invite("p1", "new@x.com", "editor")).resolves.toBeUndefined();
    // bootstrap created the shared layout
    expect(transport.createFolder).toHaveBeenCalledTimes(3);
    expect(transport.createJsonFile).toHaveBeenCalledTimes(1);
    expect(transport.createJsonFile).toHaveBeenCalledWith("project.json", "p1", '{"id":"p1"}');
    expect(store.set).toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        folderId: "p1",
        projectFileId: "project.json@p1",
        realtimeFolderId: "realtime",
      }),
    );
    // the project ACL uses the requested role; the realtime ACL is always Drive "editor".
    expect(transport.createPermission).toHaveBeenCalledTimes(2);
    expect(transport.createPermission).toHaveBeenCalledWith("p1", "editor", "new@x.com");
    expect(transport.createPermission).toHaveBeenCalledWith("realtime", "editor", "new@x.com");
  });

  it("normalizes the email (trim + lowercase) for every ACL write", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      sharedRoot: folderRef("Pboard", "Pboard"),
    });
    await service.invite("p1", "  New@X.COM  ", "viewer");
    expect(transport.createPermission).toHaveBeenCalledTimes(2);
    expect(transport.createPermission).toHaveBeenCalledWith("proj", "viewer", "new@x.com");
    expect(transport.createPermission).toHaveBeenCalledWith("rt", "editor", "new@x.com");
  });

  it("does not double-grant the realtime ACL when it already exists", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      sharedRoot: folderRef("Pboard", "Pboard"),
      listPermissions: (fileId) =>
        fileId === "rt" ? [userPerm("rt-c", "writer", "new@x.com", "New")] : [],
    });
    await service.invite("p1", "new@x.com", "editor");
    expect(transport.createPermission).toHaveBeenCalledTimes(1);
    expect(transport.createPermission).toHaveBeenCalledWith("proj", "editor", "new@x.com");
  });
});

// ---------------------------------------------------------------------------
// updateRole
// ---------------------------------------------------------------------------
describe("updateRole", () => {
  it("rejects changing the owner's role", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("o", "owner", "me@example.com", "Me")] : [],
    });
    await expect(service.updateRole("p1", "me@example.com", "viewer")).rejects.toThrow(
      "Collaborator not found or is the owner",
    );
    expect(transport.updatePermission).not.toHaveBeenCalled();
  });

  it("rejects updating a collaborator that is not found", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("o", "owner", "me@example.com", "Me")] : [],
    });
    await expect(service.updateRole("p1", "ghost@x.com", "viewer")).rejects.toThrow(
      "Collaborator not found or is the owner",
    );
    expect(transport.updatePermission).not.toHaveBeenCalled();
  });

  it("updates a non-owner collaborator's role", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj"
          ? [userPerm("o", "owner", "me@example.com", "Me"), userPerm("c", "reader", "c@x.com", "C")]
          : [],
    });
    await service.updateRole("p1", "c@x.com", "editor");
    expect(transport.updatePermission).toHaveBeenCalledWith("proj", "c", "editor");
  });

  it("matches collaborator emails case-insensitively", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj"
          ? [userPerm("o", "owner", "me@example.com", "Me"), userPerm("c", "reader", "c@x.com", "C")]
          : [],
    });
    await service.updateRole("p1", "C@X.COM", "viewer");
    expect(transport.updatePermission).toHaveBeenCalledWith("proj", "c", "viewer");
  });
});

// ---------------------------------------------------------------------------
// removeCollaborator
// ---------------------------------------------------------------------------
describe("removeCollaborator", () => {
  it("rejects removing the owner", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("o", "owner", "me@example.com", "Me")] : [],
    });
    await expect(service.removeCollaborator("p1", "me@example.com")).rejects.toThrow(
      "Collaborator not found or is the owner",
    );
    expect(transport.deletePermission).not.toHaveBeenCalled();
  });

  it("rejects removing a non-existent collaborator", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("o", "owner", "me@example.com", "Me")] : [],
    });
    await expect(service.removeCollaborator("p1", "ghost@x.com")).rejects.toThrow(
      "Collaborator not found or is the owner",
    );
    expect(transport.deletePermission).not.toHaveBeenCalled();
  });

  it("removes a non-owner collaborator from both the project and realtime ACLs", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (fileId) =>
        fileId === "proj"
          ? [userPerm("o", "owner", "me@example.com", "Me"), userPerm("c", "reader", "c@x.com", "C")]
          : fileId === "rt"
            ? [userPerm("rt-c", "writer", "c@x.com", "C")]
            : [],
    });
    await service.removeCollaborator("p1", "c@x.com");
    expect(transport.deletePermission).toHaveBeenCalledTimes(2);
    expect(transport.deletePermission).toHaveBeenCalledWith("proj", "c");
    expect(transport.deletePermission).toHaveBeenCalledWith("rt", "rt-c");
  });
});

// ---------------------------------------------------------------------------
// discoverSharedProjects
// ---------------------------------------------------------------------------
describe("discoverSharedProjects", () => {
  it("returns one entry per reachable project.json, named after the parent folder", async () => {
    const { service } = makeService({
      fileParents: { f1: ["proj1-folder"], f2: ["proj2-folder"] },
      filesById: {
        "proj1-folder": folderRef("proj1-folder", "p1"),
        "proj2-folder": folderRef("proj2-folder", "p2"),
      },
      listFilesByNameResult: [fileRef("f1", "project.json"), fileRef("f2", "project.json")],
    });
    const result = await service.discoverSharedProjects();
    expect(result).toEqual([
      { projectId: "p1", name: "p1", fileId: "f1" },
      { projectId: "p2", name: "p2", fileId: "f2" },
    ]);
  });

  it("dedupes multiple project.json files in the same folder (first wins)", async () => {
    const { service } = makeService({
      fileParents: { f1: ["p-folder"], f1b: ["p-folder"] },
      filesById: { "p-folder": folderRef("p-folder", "p1") },
      listFilesByNameResult: [fileRef("f1", "project.json"), fileRef("f1b", "project.json")],
    });
    const result = await service.discoverSharedProjects();
    expect(result).toEqual([{ projectId: "p1", name: "p1", fileId: "f1" }]);
  });

  it("skips files whose parent is not a folder", async () => {
    const { service } = makeService({
      fileParents: { f1: ["file-parent"] },
      filesById: { "file-parent": fileRef("file-parent", "notes.md") },
      listFilesByNameResult: [fileRef("f1", "project.json")],
    });
    const result = await service.discoverSharedProjects();
    expect(result).toEqual([]);
  });

  it("returns an empty list when no project.json files are reachable", async () => {
    const { service } = makeService();
    const result = await service.discoverSharedProjects();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ensureSharedProject
// ---------------------------------------------------------------------------
describe("ensureSharedProject", () => {
  it("creates the shared layout for a fresh project and caches it", async () => {
    const { service, transport, store } = makeService({ snapshot: '{"id":"p1"}' });
    const folderId = await service.ensureSharedProject("p1");
    expect(folderId).toBe("p1");
    expect(transport.createFolder).toHaveBeenCalledTimes(3);
    expect(transport.createJsonFile).toHaveBeenCalledWith("project.json", "p1", '{"id":"p1"}');
    expect(store.set).toHaveBeenCalled();
    expect(store.state()).toEqual({
      p1: { folderId: "p1", projectFileId: "project.json@p1", realtimeFolderId: "realtime" },
    });
  });

  it("is idempotent when the project is already shared", async () => {
    const { service, transport } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      sharedRoot: folderRef("Pboard", "Pboard"),
    });
    expect(await service.ensureSharedProject("p1")).toBe("proj");
    expect(await service.ensureSharedProject("p1")).toBe("proj");
    expect(transport.createFolder).not.toHaveBeenCalled();
    expect(transport.createJsonFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// myRole
// ---------------------------------------------------------------------------
describe("myRole", () => {
  it("returns null when the project is not shared", async () => {
    const { service } = makeService();
    expect(await service.myRole("p1")).toBeNull();
  });

  it("returns owner when the account owns the project", async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("o", "owner", "me@example.com", "Me")] : [],
    });
    expect(await service.myRole("p1")).toBe("owner");
  });

  it("returns editor for a writer permission", async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("w", "writer", "me@example.com", "Me")] : [],
    });
    expect(await service.myRole("p1")).toBe("editor");
  });

  it("returns viewer for a reader permission", async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("r", "reader", "me@example.com", "Me")] : [],
    });
    expect(await service.myRole("p1")).toBe("viewer");
  });

  it("returns null when the account has no permission", async () => {
    const { service } = makeService({
      layout: { folderId: "proj", projectFileId: "pf", realtimeFolderId: "rt" },
      listPermissions: (id) =>
        id === "proj" ? [userPerm("o", "owner", "other@example.com", "Other")] : [],
    });
    expect(await service.myRole("p1")).toBeNull();
  });
});