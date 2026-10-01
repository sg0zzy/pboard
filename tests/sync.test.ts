import { describe, expect, it, vi } from "vitest";
import type { KeyValueStorage } from "../src/storage/repository";
import { createGoogleAuthProvider, DRIVE_SCOPE } from "../src/sync/googleAuth";
import { createChromiumGoogleAuthProvider } from "../src/sync/googleChromeAuth";
import { createDriveTransport } from "../src/sync/driveTransport";
import { createGoogleDriveProvider } from "../src/sync/googleDriveProvider";
import { createProjectSnapshotStore, deserializeProjectSnapshot, serializeProjectSnapshot } from "../src/sync/snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore, DRIVE_AUTH_STORAGE_KEY } from "../src/sync/state";
import type { AppState, Project } from "../src/types";
import { toFirefoxLoopbackRedirect } from "../src/sync/redirectUri";

class MemoryStorage implements KeyValueStorage {
  data: Record<string, unknown> = {};
  async get(key: string) { return key in this.data ? { [key]: structuredClone(this.data[key]) } : {}; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

const project: Project = {
  id: "project-1",
  name: "Drive test",
  template: "project",
  revision: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z"
};

function stateWithProject(): AppState {
  return {
    version: 3,
    projects: [project],
    currentProjectId: project.id,
    boardItems: [{
      id: "card-1",
      projectId: project.id,
      type: "task",
      status: "started",
      content: "Ship it",
      order: 0,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    }]
  };
}

describe("project snapshots", () => {
  it("round-trips versioned project data", () => {
    const state = stateWithProject();
    state.boardItems[0].status = "to validate";
    state.boardItems[0].displayMode = "expanded";
    const encoded = serializeProjectSnapshot(state.projects[0], state.boardItems, "2026-01-03T00:00:00.000Z");
    const decoded = deserializeProjectSnapshot(encoded);
    expect(decoded).toMatchObject({ format: "pboard-project", version: 1, project: { id: project.id, revision: 4 } });
    expect(decoded.items[0].content).toBe("Ship it");
    expect(decoded.items[0].status).toBe("to validate");
    expect(decoded.items[0].displayMode).toBe("expanded");
  });

  it("defaults legacy snapshot cards to standard display", () => {
    const state = stateWithProject();
    delete state.boardItems[0].displayMode;
    const decoded = deserializeProjectSnapshot(JSON.stringify({
      format: "pboard-project",
      version: 1,
      exportedAt: "2026-01-03T00:00:00.000Z",
      project: state.projects[0],
      items: state.boardItems
    }));

    expect(decoded.items[0].displayMode).toBe("standard");
  });

  it("rejects mismatched project items", () => {
    const encoded = serializeProjectSnapshot(project, [{ ...stateWithProject().boardItems[0], projectId: "other" }]);
    expect(() => deserializeProjectSnapshot(encoded)).toThrow("invalid or unsupported");
  });
});

describe("Google OAuth", () => {
  it("uses PKCE, account selection, and the Drive app-data + drive.file scopes", async () => {
    const storage = new MemoryStorage();
    let authorizationUrl = "";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("code_verifier")).toBeTruthy();
      return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const auth = createGoogleAuthProvider({
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "desktop-secret",
      storage,
      fetch: fetchMock as typeof fetch,
      identity: {
        getRedirectURL: () => "https://extension.example/google-drive",
        launchWebAuthFlow: async ({ url }) => {
          authorizationUrl = url;
          const state = new URL(url).searchParams.get("state");
          return `https://extension.example/google-drive?code=code-1&state=${state}`;
        }
      }
    });

    await auth.connect();

    const params = new URL(authorizationUrl).searchParams;
    expect(params.get("prompt")).toBe("select_account");
    expect(params.get("scope")).toBe(DRIVE_SCOPE);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    expect((fetchMock.mock.calls[0][1]?.body as URLSearchParams).get("client_secret")).toBe("desktop-secret");
    expect(storage.data[DRIVE_AUTH_STORAGE_KEY]).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
  });

  it("uses Chrome's native token flow for a Chrome Extension OAuth client", async () => {
    const getAuthToken = vi.fn(async ({ interactive }: { interactive: boolean }) => ({
      token: interactive ? "interactive-token" : "cached-token"
    }));
    const removeCachedAuthToken = vi.fn(async () => undefined);
    const auth = createChromiumGoogleAuthProvider({
      clientId: "chrome-client.apps.googleusercontent.com",
      identity: { getAuthToken, removeCachedAuthToken }
    });

    await auth.connect();
    expect(getAuthToken).toHaveBeenCalledWith({ interactive: true });
    expect(await auth.getAccessToken()).toBe("interactive-token");

    expect(await auth.getAccessToken(true)).toBe("cached-token");
    expect(removeCachedAuthToken).toHaveBeenCalledWith({ token: "interactive-token" });
  });
});

describe("Drive sync state", () => {
  it("does not clear edits made while a snapshot is uploading", async () => {
    const storage = new MemoryStorage();
    const syncState = createDriveSyncStateStore(storage);
    await syncState.markDirty(project.id);
    const started = await syncState.get(project.id);
    await syncState.markSyncing(project.id);
    await syncState.markDirty(project.id);
    await syncState.markSynced(project.id, 4, "file-1", started.changeToken);

    expect(await syncState.get(project.id)).toMatchObject({ dirty: true, status: "pending", remoteFileId: "file-1" });
  });
});

describe("Google Drive provider", () => {
  it("pushes one app-data snapshot only when the project is dirty", async () => {
    const storage = new MemoryStorage();
    storage.data.projectBoardState = stateWithProject();
    const syncState = createDriveSyncStateStore(storage);
    const tombstones = createDriveTombstoneStore(storage);
    const snapshots = createProjectSnapshotStore(storage);
    const upload = vi.fn(async (_projectId: string, _contents: string, _fileId?: string) => ({ id: "file-1", name: "project-project-1.pboard" }));
    const provider = createGoogleDriveProvider({
      auth: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        getConnectionState: async () => "connected",
        getAccessToken: async () => "token",
        isConfigured: () => true
      },
      transport: {
        listProjectFiles: async () => [],
        findProjectFile: async () => null,
        download: async () => "",
        upload,
        delete: async () => undefined
      },
      snapshots,
      syncState,
      tombstones
    });

    expect(await provider.syncProject(project.id)).toBe("not-dirty");
    expect(upload).not.toHaveBeenCalled();
    await syncState.markDirty(project.id);
    expect(await provider.syncProject(project.id)).toBe("pushed");
    expect(upload).toHaveBeenCalledOnce();
    expect(await syncState.get(project.id)).toMatchObject({ dirty: false, status: "synced", lastSyncedRevision: 4 });
  });

  it("keeps and uploads a newer local timestamp instead of applying older Drive data", async () => {
    const storage = new MemoryStorage();
    storage.data.projectBoardState = stateWithProject();
    const syncState = createDriveSyncStateStore(storage);
    await syncState.markDirty(project.id);
    const upload = vi.fn(async (_projectId: string, _contents: string, _fileId?: string) => ({ id: "file-1", name: "project-project-1.pboard" }));
    const older = serializeProjectSnapshot(
      { ...project, revision: 99, updatedAt: "2026-01-01T12:00:00.000Z" },
      [{ ...stateWithProject().boardItems[0], content: "Old Drive text", updatedAt: "2026-01-01T12:00:00.000Z" }]
    );
    const provider = createGoogleDriveProvider({
      auth: connectedAuth(),
      transport: {
        listProjectFiles: async () => [],
        findProjectFile: async () => ({ id: "file-1", name: "project-project-1.pboard" }),
        download: async () => older,
        upload,
        delete: async () => undefined
      },
      snapshots: createProjectSnapshotStore(storage),
      syncState,
      tombstones: createDriveTombstoneStore(storage)
    });

    expect(await provider.syncProject(project.id)).toBe("pushed");
    expect(JSON.parse(upload.mock.calls[0][1]).project.updatedAt).toBe(project.updatedAt);
    expect((storage.data.projectBoardState as AppState).boardItems[0].content).toBe("Ship it");
  });

  it("pulls a newer Drive timestamp even when the local revision number is higher", async () => {
    const storage = new MemoryStorage();
    storage.data.projectBoardState = stateWithProject();
    const syncState = createDriveSyncStateStore(storage);
    await syncState.markDirty(project.id);
    const newerProject = { ...project, revision: 1, updatedAt: "2026-01-04T00:00:00.000Z" };
    const remote = serializeProjectSnapshot(newerProject, [{
      ...stateWithProject().boardItems[0],
      content: "Newer Drive text",
      updatedAt: newerProject.updatedAt
    }]);
    const upload = vi.fn();
    const provider = createGoogleDriveProvider({
      auth: connectedAuth(),
      transport: {
        listProjectFiles: async () => [],
        findProjectFile: async () => ({ id: "file-1", name: "project-project-1.pboard" }),
        download: async () => remote,
        upload,
        delete: async () => undefined
      },
      snapshots: createProjectSnapshotStore(storage),
      syncState,
      tombstones: createDriveTombstoneStore(storage)
    });

    expect(await provider.syncProject(project.id)).toBe("pulled");
    expect(upload).not.toHaveBeenCalled();
    expect((storage.data.projectBoardState as AppState).boardItems[0].content).toBe("Newer Drive text");
  });

  it("imports remote-only projects during startup reconciliation", async () => {
    const storage = new MemoryStorage();
    const remote = serializeProjectSnapshot(project, stateWithProject().boardItems);
    const provider = createGoogleDriveProvider({
      auth: connectedAuth(),
      transport: {
        listProjectFiles: async () => [{ id: "file-1", name: "project-project-1.pboard" }],
        findProjectFile: async () => null,
        download: async () => remote,
        upload: vi.fn(),
        delete: async () => undefined
      },
      snapshots: createProjectSnapshotStore(storage),
      syncState: createDriveSyncStateStore(storage),
      tombstones: createDriveTombstoneStore(storage)
    });

    expect(await provider.reconcileAll()).toMatchObject({ status: "reconciled", imported: 1 });
    expect((storage.data.projectBoardState as AppState).projects[0].id).toBe(project.id);
  });

  it("gives a durable tombstone precedence over a newer remote snapshot", async () => {
    const storage = new MemoryStorage();
    const tombstones = createDriveTombstoneStore(storage);
    await tombstones.add({
      projectId: project.id,
      remoteFileId: "file-1",
      deletedAt: "2026-01-03T00:00:00.000Z",
      projectUpdatedAt: project.updatedAt,
      revision: project.revision
    });
    const deleteFile = vi.fn(async () => undefined);
    const provider = createGoogleDriveProvider({
      auth: connectedAuth(),
      transport: {
        listProjectFiles: async () => [{ id: "file-1", name: "project-project-1.pboard" }],
        findProjectFile: async () => null,
        download: vi.fn(),
        upload: vi.fn(),
        delete: deleteFile
      },
      snapshots: createProjectSnapshotStore(storage),
      syncState: createDriveSyncStateStore(storage),
      tombstones
    });

    expect(await provider.reconcileAll()).toMatchObject({ deleted: 1, imported: 0 });
    expect(deleteFile).toHaveBeenCalledWith("file-1");
    expect(await tombstones.get(project.id)).toBeNull();
  });
});

describe("Drive app-data transport", () => {
  it("lists and creates project files only in appDataFolder", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/drive/v3/files?")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "file-1", name: "project-project-1.pboard" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const transport = createDriveTransport({
      connect: async () => undefined,
      disconnect: async () => undefined,
      getConnectionState: async () => "connected",
      getAccessToken: async () => "token",
      isConfigured: () => true
    }, fetchMock as typeof fetch);

    expect(await transport.listProjectFiles()).toEqual([]);
    expect(await transport.findProjectFile(project.id)).toBeNull();
    await transport.upload(project.id, "{}");

    const listUrl = new URL(requests[0].url);
    expect(listUrl.searchParams.get("spaces")).toBe("appDataFolder");
    expect(listUrl.searchParams.get("q")).toContain("project-");
    expect(new URL(requests[1].url).searchParams.get("q")).toContain("project-project-1.pboard");
    expect(String(requests[2].init?.body)).toContain('"parents":["appDataFolder"]');
  });
});

function connectedAuth() {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getConnectionState: async () => "connected" as const,
    getAccessToken: async () => "token",
    isConfigured: () => true
  };
}

describe("Firefox loopback redirect", () => {
  it("derives the loopback from the getRedirectURL hash subdomain (no local redirect file needed)", () => {
    const generated =
      "https://3347c8cebdf365b6de12af5ab0927a76cf6421c3.extensions.allizom.org/";
    expect(toFirefoxLoopbackRedirect(generated)).toBe(
      "http://127.0.0.1/mozoauth2/3347c8cebdf365b6de12af5ab0927a76cf6421c3"
    );
  });
});
