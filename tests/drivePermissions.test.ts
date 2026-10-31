import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDrivePermissionService,
  createDrivePermissionTransport,
  type DriveFileRef,
  type DrivePermission,
  type DrivePermissionTransport,
  type DriveSharedProjectRecord,
  type DriveSharedProjectStore
} from "../src/sync/drivePermissions";
import { defaultDriveIdentityCache } from "../src/sync/driveIdentity";
import type { GoogleAuthProvider } from "../src/sync/googleAuth";
// Each case below stubs its own `about` endpoint. The account-identity cache
// lives as long as a JS context — one extension worker or one sidebar page —
// and a test process runs many fake contexts, so drop it between cases.

beforeEach(() => defaultDriveIdentityCache().invalidate());


describe("Drive account identity", () => {
  function auth(): GoogleAuthProvider {
    return {
      connect: async () => {}, disconnect: async () => {},
      getConnectionState: async () => "connected",
      isConfigured: () => true,
      getAccessToken: vi.fn(async () => "drive-token")
    };
  }

  it("reads the account using Drive authorization instead of People API scopes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      user: { emailAddress: "owner@example.com", displayName: "Owner" }
    })));
    const transport = createDrivePermissionTransport(auth(), fetcher);
    expect(await transport.currentIdentity()).toEqual({ email: "owner@example.com", name: "Owner" });
    expect(fetcher.mock.calls[0][0]).toBe("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer drive-token");
  });

  it("reports account lookup failures instead of silently returning no role", async () => {
    const transport = createDrivePermissionTransport(auth(), async () => new Response("{}", { status: 403 }));
    await expect(transport.currentIdentity()).rejects.toThrow("403");
  });

  it("limits every sharing file search to the Drive space", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("spaces") !== "drive") {
        return new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientScopes" }] } }), { status: 403 });
      }
      return new Response(JSON.stringify({ files: [] }));
    });
    const transport = createDrivePermissionTransport(auth(), fetcher);
    expect(await transport.findSharedRoot()).toBeNull();
    expect(await transport.findFile("project.json", "folder")).toBeNull();
    expect(await transport.listFiles("folder")).toEqual([]);
    expect(await transport.listFilesByName("project.json", "application/json")).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("explains how to recover when sharing authorization is missing", async () => {
    const transport = createDrivePermissionTransport(auth(), async () => new Response(JSON.stringify({
      error: { errors: [{ reason: "insufficientScopes" }], message: "The granted scopes do not give access to all of the requested spaces." }
    }), { status: 403 }));
    await expect(transport.listFilesByName("project.json", "application/json")).rejects.toThrow(/reconnect Google Drive and allow project sharing access/);
  });

  it("replays transient Drive failures for sharing reads without repeating permission writes", async () => {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/permissions")) {
        return new Response(JSON.stringify({ error: { code: 500, message: "Internal Error" } }), { status: 500 });
      }
      reads += 1;
      if (reads === 1) return new Response(JSON.stringify({ error: { code: 503, message: "Internal Error" } }), { status: 503 });
      return new Response(JSON.stringify({ files: [] }));
    });
    const transport = createDrivePermissionTransport(auth(), fetcher);

    expect(await transport.listFilesByName("project.json", "application/json")).toEqual([]);
    await expect(transport.createPermission("file", "editor", "peer@example.com")).rejects.toThrow("(500)");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("observes new peers and updated handshake records instead of cached Drive responses", async () => {
    const cache = new Map<string, string>();
    let files: { id: string; name: string; mimeType: string }[] = [];
    let record = JSON.stringify({ updatedAt: 1, peers: [], outbox: [] });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const contents = new URL(url).searchParams.get("alt") === "media" ? record : JSON.stringify({ files });
      if (init?.cache === "no-store") return new Response(contents);
      if (!cache.has(url)) cache.set(url, contents);
      return new Response(cache.get(url)!);
    };
    const transport = createDrivePermissionTransport(auth(), fetcher);
    expect(await transport.listFiles("room")).toEqual([]);
    files = [{ id: "peer-file", name: "sig-topic-peer.json", mimeType: "application/json" }];
    expect(await transport.listFiles("room")).toEqual(files);
    expect(await transport.findFile("sig-topic-peer.json", "room")).toEqual(files[0]);
    expect(JSON.parse(await transport.downloadFile("peer-file")).updatedAt).toBe(1);
    record = JSON.stringify({ updatedAt: 2, peers: [], outbox: [{ id: "offer", toPeerId: "other", payload: "offer" }] });
    expect(JSON.parse(await transport.downloadFile("peer-file"))).toMatchObject({ updatedAt: 2, outbox: [{ id: "offer" }] });
  });
});

// In-memory fake of the Drive permission transport. It models the shared
// layout (Pboard/<projectId>/project.json + realtime/) and per-folder
// permission lists, which is all the service depends on.
function makeFakeTransport(initial: { identity?: string | null } = {}) {
  const state = {
    folders: new Map<string, { id: string; name: string; parents: string[] }>(),
    files: new Map<string, { id: string; name: string; mimeType: string; parents: string[]; body: string }>(),
    permissions: new Map<string, DrivePermission[]>()
  };
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${++seq}`;
  let identity: { email: string } | null = initial.identity === null ? null : { email: initial.identity ?? "me@example.com" };
  const sharedWithMe: DriveFileRef[] = [];

  function permissionsFor(fileId: string): DrivePermission[] {
    return state.permissions.get(fileId) ?? [];
  }

  const restricted: string[] = [];
  const transport: DrivePermissionTransport = {
    currentIdentity: async () => identity,
    findSharedRoot: async () => {
      const pboard = [...state.folders.values()].find((f) => f.name === "Pboard" && f.parents.length === 0);
      return pboard ? { id: pboard.id, name: "Pboard", mimeType: "application/vnd.google-apps.folder" } : null;
    },
    createFolder: async (name, parentId) => {
      const id = nextId("f");
      state.folders.set(id, { id, name, parents: parentId ? [parentId] : [] });
      return { id, name, mimeType: "application/vnd.google-apps.folder" };
    },
    findFile: async (name, parentId) => {
      const folder = [...state.folders.values()].find((entry) => entry.name === name && entry.parents.includes(parentId));
      if (folder) return { id: folder.id, name, mimeType: "application/vnd.google-apps.folder" };
      const file = [...state.files.values()].find((entry) => entry.name === name && entry.parents.includes(parentId));
      if (file) return { id: file.id, name, mimeType: file.mimeType };
      return null;
    },
    createJsonFile: async (name, parentId, contents) => {
      const id = nextId("file");
      state.files.set(id, { id, name, mimeType: "application/json", parents: [parentId], body: contents });
      return { id, name, mimeType: "application/json" };
    },
    uploadJsonFile: async (fileId, contents) => {
      const file = state.files.get(fileId)!;
      file.body = contents;
      return { id: file.id, name: file.name, mimeType: file.mimeType };
    },
    downloadFile: async (fileId) => state.files.get(fileId)!.body,
    downloadFileOrNull: async (fileId) => state.files.get(fileId)?.body ?? null,
    getFile: async (fileId) => {
      const folder = state.folders.get(fileId);
      if (folder) return { id: folder.id, name: folder.name, mimeType: "application/vnd.google-apps.folder", parents: folder.parents };
      const file = state.files.get(fileId)!;
      return { id: file.id, name: file.name, mimeType: file.mimeType, parents: file.parents };
    },
    listFiles: async (parentId) => [
      ...[...state.folders.values()].filter((f) => f.parents.includes(parentId)).map((f) => ({ id: f.id, name: f.name, mimeType: "application/vnd.google-apps.folder" })),
      ...[...state.files.values()].filter((f) => f.parents.includes(parentId)).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType }))
    ],
    deleteFile: async (fileId) => {
      state.folders.delete(fileId);
      state.files.delete(fileId);
    },
    getFileParents: async (fileId) => state.folders.get(fileId)?.parents ?? state.files.get(fileId)?.parents ?? [],
    listFilesByName: async (name, mimeType) =>
      [...state.files.values()].filter((f) => f.name === name && f.mimeType === mimeType).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
    listSharedWithMe: async () => sharedWithMe,
    listPermissions: async (fileId) => permissionsFor(fileId).map((p) => ({ ...p })),
    createPermission: async (fileId, role, email) => {
      const permission: DrivePermission = {
        id: nextId("perm"),
        type: "user",
        role: role === "editor" ? "writer" : "reader",
        emailAddress: email
      };
      const list = permissionsFor(fileId);
      list.push(permission);
      state.permissions.set(fileId, list);
      return { ...permission };
    },
    updatePermission: async (fileId, permissionId, role) => {
      const permission = permissionsFor(fileId).find((p) => p.id === permissionId)!;
      permission.role = role === "editor" ? "writer" : "reader";
      return { ...permission };
    },
    restrictWriterSharing: async (fileId) => { restricted.push(fileId); },
    deletePermission: async (fileId, permissionId) => {
      state.permissions.set(fileId, permissionsFor(fileId).filter((p) => p.id !== permissionId));
    }
  };
  return { transport, state, sharedWithMe, restricted, setIdentity: (email: string | null) => (identity = email === null ? null : { email }) };
}

// In-memory fake of the local shared-layout cache (browser.storage.local in the app).
function makeFakeStore(): DriveSharedProjectStore & { records: Map<string, DriveSharedProjectRecord> } {
  const records = new Map<string, DriveSharedProjectRecord>();
  const empty: DriveSharedProjectRecord = { folderId: null, projectFileId: null, realtimeFolderId: null };
  return {
    records,
    get: async (projectId) => records.get(projectId) ?? { ...empty },
    set: async (projectId, patch) => {
      const current = records.get(projectId) ?? { ...empty };
      records.set(projectId, { ...current, ...patch });
    },
    delete: async (projectId) => {
      records.delete(projectId);
    }
  };
}

function makeService(initial: { identity?: string | null } = {}) {
  const fake = makeFakeTransport(initial);
  const store = makeFakeStore();
  const service = createDrivePermissionService({
    transport: fake.transport,
    sharedProjects: store,
    readSnapshot: async (projectId) => JSON.stringify({ projectId })
  });
  return { service, fake, store };
}

describe("createDrivePermissionService", () => {
  it("persists shared image assets in the project's folder and isolates private projects", async () => {
    const { service, fake } = makeService();
    const folderId = await service.ensureSharedProject("proj1");
    const imageId = "a".repeat(64);
    const image = { dataUrl: "data:image/png;base64,AAECAwQ=", mimeType: "image/png", width: 1, height: 1 };
    expect(await service.readSharedImage("proj1", imageId)).toBeNull();
    await service.writeSharedImage("proj1", imageId, image);
    const asset = [...fake.state.files.values()].find((file) => file.name === `image-${imageId}.json`)!;
    expect(asset.parents).toEqual([folderId]);
    expect(await service.readSharedImage("proj1", imageId)).toEqual(image);
    expect(await service.readSharedImage("private-project", imageId)).toBeNull();
    await expect(service.readSharedImage("proj1", "invalid-id")).rejects.toThrow("Invalid shared image id");
  });
  it("ensures the shared layout (folder + project.json + realtime) and caches it", async () => {
    const { service, fake, store } = makeService();
    const folderId = await service.ensureSharedProject("proj1");

    const folder = fake.state.folders.get(folderId)!;
    expect(folder.name).toBe("proj1");
    expect(folder.parents).toEqual([[...fake.state.folders.values()].find((f) => f.name === "Pboard")!.id]);
    const projectFile = [...fake.state.files.values()].find((f) => f.name === "project.json" && f.parents.includes(folderId))!;
    expect(projectFile.body).toBe(JSON.stringify({ projectId: "proj1" }));
    const realtime = [...fake.state.folders.values()].find((f) => f.name === "realtime" && f.parents.includes(folderId))!;

    expect(await service.projectFileId("proj1")).toBe(projectFile.id);
    expect(await service.realtimeFolderId("proj1")).toBe(realtime.id);
    expect(store.records.get("proj1")).toMatchObject({ folderId, projectFileId: projectFile.id, realtimeFolderId: realtime.id });
  });

  it("reuses an existing shared layout instead of creating duplicates", async () => {
    const { service, fake } = makeService();
    const first = await service.ensureSharedProject("proj1");
    const fileCount = fake.state.files.size;
    const folderCount = fake.state.folders.size;

    const second = await service.ensureSharedProject("proj1");

    expect(second).toBe(first);
    expect(fake.state.files.size).toBe(fileCount);
    expect(fake.state.folders.size).toBe(folderCount);
  });

  it("reads and writes the shared snapshot", async () => {
    const { service } = makeService();
    await service.ensureSharedProject("proj1");
    expect(await service.readSharedSnapshot("proj1")).toBe(JSON.stringify({ projectId: "proj1" }));

    await service.writeSharedSnapshot("proj1", JSON.stringify({ projectId: "proj1", cards: [1] }));
    expect(await service.readSharedSnapshot("proj1")).toBe(JSON.stringify({ projectId: "proj1", cards: [1] }));
  });

  it("resolves the caller role from the folder ACL", async () => {
    const { service, fake } = makeService({ identity: "me@example.com" });
    const folderId = await service.ensureSharedProject("proj1");
    fake.state.permissions.set(folderId, [{ id: "p1", type: "user", role: "writer", emailAddress: "me@example.com" }]);
    expect(await service.myRole("proj1")).toBe("editor");

    fake.state.permissions.set(folderId, [{ id: "p1", type: "user", role: "reader", emailAddress: "me@example.com" }]);
    expect(await service.myRole("proj1")).toBe("viewer");

    fake.setIdentity(null);
    expect(await service.myRole("proj1")).toBeNull();
  });

  it("returns owner for the file owner and null for a project with no permission", async () => {
    const { service, fake } = makeService({ identity: "owner@example.com" });
    const folderId = await service.ensureSharedProject("proj1");
    fake.state.permissions.set(folderId, [{ id: "own", type: "user", role: "owner", emailAddress: "owner@example.com" }]);
    expect(await service.myRole("proj1")).toBe("owner");

    fake.state.permissions.set(folderId, [{ id: "other", type: "user", role: "writer", emailAddress: "other@example.com" }]);
    expect(await service.myRole("proj1")).toBeNull();

    expect(await service.myRole("neverShared")).toBeNull();
  });

  it("matches the owner's email without case or surrounding whitespace differences", async () => {
    const { service, fake } = makeService({ identity: "Owner@Example.com" });
    const folderId = await service.ensureSharedProject("proj1");
    fake.state.permissions.set(folderId, [{ id: "own", type: "user", role: "owner", emailAddress: " owner@example.com " }]);
    expect(await service.myRole("proj1")).toBe("owner");
  });

  it("lists collaborators sorted owner, editors, viewers (alphabetical within role)", async () => {
    const { service, fake } = makeService();
    const folderId = await service.ensureSharedProject("proj1");
    fake.state.permissions.set(folderId, [
      { id: "p1", type: "user", role: "reader", emailAddress: "zed@example.com" },
      { id: "p2", type: "user", role: "writer", emailAddress: "bob@example.com" },
      { id: "p3", type: "user", role: "owner", emailAddress: "owner@example.com" },
      { id: "p4", type: "user", role: "reader", emailAddress: "amy@example.com" },
      { id: "p5", type: "user", role: "writer", emailAddress: "amy2@example.com" },
      { id: "link", type: "anyone", role: "reader" }
    ]);

    const collaborators = await service.listCollaborators("proj1");
    expect(collaborators.map((c) => c.email)).toEqual(["owner@example.com", "amy2@example.com", "bob@example.com", "amy@example.com", "zed@example.com"]);
    expect(collaborators.map((c) => c.role)).toEqual(["owner", "editor", "editor", "viewer", "viewer"]);
  });

  it("invites a collaborator, granting the project role plus realtime write access", async () => {
    const { service, fake, store } = makeService();
    await service.invite("proj1", "New@Example.com", "editor");

    const layout = store.records.get("proj1")!;
    const folderPerms = fake.state.permissions.get(layout.folderId!)!;
    expect(folderPerms).toHaveLength(1);
    expect(folderPerms[0]).toMatchObject({ role: "writer", emailAddress: "new@example.com" });

    const realtimePerms = fake.state.permissions.get(layout.realtimeFolderId!);
    expect(realtimePerms).toHaveLength(1);
    expect(realtimePerms![0]).toMatchObject({ role: "writer", emailAddress: "new@example.com" });
  });

  it("rejects an invalid invite email without creating any permission", async () => {
    const { service, fake, store } = makeService();
    await expect(service.invite("proj1", "not-an-email", "viewer")).rejects.toThrow(/valid email/i);
    expect(fake.state.permissions.size).toBe(0);
    expect(store.records.has("proj1")).toBe(false);
  });

  it("does not duplicate a collaborator's realtime access on a second invite", async () => {
    const { service, fake, store } = makeService();
    await service.invite("proj1", "x@example.com", "viewer");
    await service.invite("proj1", "x@example.com", "editor");

    const layout = store.records.get("proj1")!;
    const realtimePerms = fake.state.permissions.get(layout.realtimeFolderId!);
    expect(realtimePerms).toHaveLength(1);
  });

  it("updates a collaborator's role", async () => {
    const { service, fake, store } = makeService();
    await service.invite("proj1", "x@example.com", "viewer");
    const layout = store.records.get("proj1")!;
    const permission = fake.state.permissions.get(layout.folderId!)![0];

    await service.updateRole("proj1", "x@example.com", "editor");
    expect(fake.state.permissions.get(layout.folderId!)!.find((p) => p.id === permission.id)!.role).toBe("writer");
  });

  it("rejects updating the owner's role and an unknown collaborator", async () => {
    const { service, fake } = makeService();
    const folderId = await service.ensureSharedProject("proj1");
    fake.state.permissions.set(folderId, [{ id: "own", type: "user", role: "owner", emailAddress: "owner@example.com" }]);
    await expect(service.updateRole("proj1", "owner@example.com", "viewer")).rejects.toThrow(/owner/i);
    await expect(service.updateRole("proj1", "ghost@example.com", "viewer")).rejects.toThrow(/not found/i);
  });

  it("removes a collaborator, revoking both the project and realtime access", async () => {
    const { service, fake, store } = makeService();
    await service.invite("proj1", "x@example.com", "editor");
    const layout = store.records.get("proj1")!;
    expect(fake.state.permissions.get(layout.folderId!)!.length).toBe(1);
    expect(fake.state.permissions.get(layout.realtimeFolderId!)!.length).toBe(1);

    await service.removeCollaborator("proj1", "x@example.com");
    expect(fake.state.permissions.get(layout.folderId!)!.length).toBe(0);
    expect(fake.state.permissions.get(layout.realtimeFolderId!)!.length).toBe(0);
  });

  it("rejects removing the owner or an unknown collaborator", async () => {
    const { service, fake } = makeService();
    const folderId = await service.ensureSharedProject("proj1");
    fake.state.permissions.set(folderId, [{ id: "own", type: "user", role: "owner", emailAddress: "owner@example.com" }]);
    await expect(service.removeCollaborator("proj1", "owner@example.com")).rejects.toThrow(/owner/i);
    await expect(service.removeCollaborator("proj1", "ghost@example.com")).rejects.toThrow(/not found/i);
  });

  it("discovers shared projects this account can reach, keyed by the parent folder name", async () => {
    const { service, fake } = makeService();
    await service.ensureSharedProject("projA");
    await service.ensureSharedProject("projB");
    const strayId = "stray";
    fake.state.files.set(strayId, { id: strayId, name: "project.json", mimeType: "application/json", parents: [], body: "{}" });

    const discovered = await service.discoverSharedProjects();
    expect(discovered.map((d) => d.projectId).sort()).toEqual(["projA", "projB"]);
    for (const entry of discovered) {
      expect(entry.fileId).toBe((await service.projectFileId(entry.projectId))!);
    }
  });

  it("re-listes shared projects immediately after the discovery cache is invalidated", async () => {
    const { service } = makeService();
    await service.discoverSharedProjects();
    await service.ensureSharedProject("fresh");
    expect((await service.discoverSharedProjects()).map((d) => d.projectId)).toEqual([]); // TTL cache
    service.invalidateSharedDiscovery();
    expect((await service.discoverSharedProjects()).map((d) => d.projectId)).toEqual(["fresh"]);
  });

  it("resolves a collaborator's layout by discovery when the local cache is empty", async () => {
    const { service, fake, store } = makeService({ identity: "owner@example.com" });
    const folderId = await service.ensureSharedProject("proj1");
    fake.state.permissions.set(folderId, [{ id: "c", type: "user", role: "writer", emailAddress: "collab@example.com" }]);

    // A collaborator's browser has no local shared-layout cache.
    await store.delete("proj1");
    fake.setIdentity("collab@example.com");
    expect(await service.myRole("proj1")).toBe("editor");
    expect(await service.readSharedSnapshot("proj1")).toBe(JSON.stringify({ projectId: "proj1" }));
    // Discovery result is cached for subsequent calls.
    expect(store.records.get("proj1")!.projectFileId).toBe(await service.projectFileId("proj1"));
  });

  it("reuses the realtime folder across repeated calls without creating a second one", async () => {
    const { service, fake, store } = makeService();
    await service.ensureSharedProject("proj1");
    const realtime1 = await service.realtimeFolderId("proj1");
    const realtime2 = await service.realtimeFolderId("proj1");
    expect(realtime2).toBe(realtime1);
    expect(store.records.get("proj1")!.realtimeFolderId).toBe(realtime1);
    const projFolderId = [...fake.state.folders.values()].find((f) => f.name === "proj1")!.id;
    const realtimeFolders = [...fake.state.folders.values()].filter((f) => f.name === "realtime" && f.parents.includes(projFolderId));
    expect(realtimeFolders).toHaveLength(1);
  });

  it("revokes the caller's own collaborator and realtime permission on self-removal", async () => {
    const { service, fake, store } = makeService();
    await service.ensureSharedProject("proj1");
    await service.invite("proj1", "edit@example.com", "editor");
    const folderId = store.records.get("proj1")!.folderId!;
    fake.state.permissions.get(folderId)!.push({ id: "perm-owner", type: "user", role: "owner", emailAddress: "me@example.com" });
    const realtimeId = store.records.get("proj1")!.realtimeFolderId!;
    expect(fake.state.permissions.get(realtimeId)!.some((p) => p.emailAddress === "edit@example.com")).toBe(true);
    fake.setIdentity("edit@example.com");
    await service.removeSelfFromProject("proj1");
    const folderPermissions = fake.state.permissions.get(folderId)!;
    expect(folderPermissions.some((p) => p.emailAddress === "edit@example.com")).toBe(false);
    expect(folderPermissions.some((p) => p.role === "owner")).toBe(true);
    expect(fake.state.permissions.get(realtimeId)!.some((p) => p.emailAddress === "edit@example.com")).toBe(false);
  });

  it("never revokes the owner's permission via self-removal", async () => {
    const { service, fake, store } = makeService();
    await service.ensureSharedProject("proj1");
    await service.invite("proj1", "edit@example.com", "editor");
    const folderId = store.records.get("proj1")!.folderId!;
    fake.state.permissions.get(folderId)!.push({ id: "perm-owner", type: "user", role: "owner", emailAddress: "me@example.com" });
    await service.removeSelfFromProject("proj1");
    const folderPermissions = fake.state.permissions.get(folderId)!;
    expect(folderPermissions.filter((p) => p.role === "owner")).toHaveLength(1);
    expect(folderPermissions.some((p) => p.emailAddress === "edit@example.com")).toBe(true);
  });

  it("resolves quietly when the board was never Drive-shared", async () => {
    const { service } = makeService();
    await expect(service.removeSelfFromProject("private-board")).resolves.toBeUndefined();
  });

  it("resolves quietly when the caller's permission was already revoked", async () => {
    const { service, fake } = makeService();
    await service.ensureSharedProject("proj1");
    fake.setIdentity("stranger@example.com");
    await expect(service.removeSelfFromProject("proj1")).resolves.toBeUndefined();
  });

  it("re-discovers boards from the shared-with-me shelf while name search lags, including directly shared markers", async () => {
    const fake = makeFakeTransport();
    const store = makeFakeStore();
    const service = createDrivePermissionService({ transport: fake.transport, sharedProjects: store,
      readSnapshot: async (projectId) => JSON.stringify({ projectId }) });
    const folderA = await service.ensureSharedProject("laggy");
    const folderB = await service.ensureSharedProject("legacy");
    const markerA = [...fake.state.files.values()].find((f) => f.name === "project.json" && f.parents.includes(folderA))!;
    const markerB = [...fake.state.files.values()].find((f) => f.name === "project.json" && f.parents.includes(folderB))!;
    store.records.delete("laggy");
    store.records.delete("legacy");
    // The grant happened but Drive's name-search index has not caught up.
    fake.transport.listFilesByName = async () => [];
    fake.sharedWithMe.push({ id: folderA, name: "laggy", mimeType: "application/vnd.google-apps.folder" });
    fake.sharedWithMe.push({ id: markerB.id, name: "project.json", mimeType: "application/json" });

    const discovered = await service.discoverSharedProjects();

    expect(discovered.map((d) => d.projectId).sort()).toEqual(["laggy", "legacy"]);
    expect(discovered.find((d) => d.projectId === "laggy")!.fileId).toBe(markerA.id);
    expect(discovered.find((d) => d.projectId === "legacy")!.fileId).toBe(markerB.id);
    expect(store.records.get("laggy")).toMatchObject({ folderId: folderA, projectFileId: markerA.id });
  });

  it("keeps name-search results when the shared-with-me shelf request fails", async () => {
    const fake = makeFakeTransport();
    const store = makeFakeStore();
    const service = createDrivePermissionService({ transport: fake.transport, sharedProjects: store,
      readSnapshot: async (projectId) => JSON.stringify({ projectId }) });
    await service.ensureSharedProject("indexed");
    fake.transport.listSharedWithMe = async () => { throw new Error("shelf unavailable"); };
    expect((await service.discoverSharedProjects()).map((d) => d.projectId)).toEqual(["indexed"]);
  });

  it("restores a left board only when the caller's own grant id changed after a recorded removal", async () => {
    const { service, fake, store } = makeService({ identity: "collab@example.com" });
    const folderId = await service.ensureSharedProject("proj1");
    const grant = (id: string) => fake.state.permissions.set(folderId, [
      { id: "perm-owner", type: "user", role: "owner", emailAddress: "owner@example.com" },
      { id, type: "user", role: "reader", emailAddress: "collab@example.com" }
    ]);
    // The first observation of a grant has nothing to order it against, so it
    // only records the baseline: a grant that predates the leave cannot be
    // mistaken for a re-invitation.
    grant("perm-1");
    expect(await service.wasReinvitedSince("proj1")).toBe(false);
    expect(await service.wasReinvitedSince("proj1")).toBe(false); // same grant, never revoked
    // A different id for the same grantee means the old grant was revoked and
    // re-issued, which is the only ordering signal Drive exposes.
    grant("perm-2");
    expect(await service.wasReinvitedSince("proj1")).toBe(true);
    expect(await service.wasReinvitedSince("proj1")).toBe(false); // baseline advanced
    // The leave itself is the baseline, so the owner's next grant is a new one.
    await service.removeSelfFromProject("proj1");
    grant("perm-3");
    expect(await service.wasReinvitedSince("proj1")).toBe(true);
    expect(await service.wasReinvitedSince("proj1")).toBe(false);
    expect(store.records.get("proj1")!.folderId).toBe(folderId);
    expect(await service.wasReinvitedSince("never-shared")).toBe(false);
  });
});

describe("writersCanShare restriction transport (D2)", () => {
  const auth = (): GoogleAuthProvider => ({
    connect: async () => {}, disconnect: async () => {},
    getConnectionState: async () => "connected",
    isConfigured: () => true,
    getAccessToken: vi.fn(async () => "drive-token")
  });

  it("issues a metadata PATCH setting writersCanShare false", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "f 1", writersCanShare: false })));
    const transport = createDrivePermissionTransport(auth(), fetcher);
    await transport.restrictWriterSharing("f 1");
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://www.googleapis.com/drive/v3/files/f%201?fields=id%2CwritersCanShare");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe('{"writersCanShare":false}');
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("rejects when Drive refuses the restriction so callers can degrade", async () => {
    const transport = createDrivePermissionTransport(auth(), async () => new Response(JSON.stringify({ error: { message: "sharedDrive" } }), { status: 400 }));
    await expect(transport.restrictWriterSharing("f")).rejects.toThrow("400");
  });
});
