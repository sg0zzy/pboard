import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { serializeProjectSnapshot } from "../src/sync/snapshot";
import type { BoardItem, Project } from "../src/types";

// Stub the extension `browser` API so the real src/sync/browser can be imported
// without a Chromium/extension context. vi.mock is hoisted above the static
// import of src/sync/browser below, so the stub is in place when that module
// runs. The factory is self-contained (no out-of-scope refs).
vi.mock("../src/platform/browser", () => {
  const data: Record<string, unknown> = {};
  const localStore = {
    get: (key: string) =>
      Promise.resolve(key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values));
      return Promise.resolve();
    },
  };
  return {
    browser: {
      runtime: { getURL: () => "http://localhost/" },
      storage: { local: localStore },
      identity: {},
      contextMenus: {},
      offline: {},
    },
  };
});

// Account-preference persistence is covered by accountPreferences.test.ts;
// this discovery suite must not perform real Drive I/O for it.
vi.mock("../src/sync/accountPreferences", () => ({
  createAccountPreferenceSync: () => (async () => {})
}));
import {
  collaborationManager,
  drivePermissions,
  googleAuth,
  discoverSharedBoards,
  registerRxRepositoryResolver,
} from "../src/sync/browser";

beforeEach(() => {
  vi.spyOn(googleAuth, "getConnectionState").mockResolvedValue("connected");
  vi.spyOn(drivePermissions, "myRole").mockResolvedValue("editor");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverSharedBoards", () => {
  it("imports a missing shared project", async () => {
    const rx = await createRxRepository({
      name: "load-missing",
      blobs: createIndexedDbBlobStore("load-missingimages"),
    });
    registerRxRepositoryResolver(() => Promise.resolve(rx));

    const project: Project = {
      id: "shared-1",
      name: "Shared one",
      template: "project",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const items: BoardItem[] = [{
      id: "card-1",
      projectId: "shared-1",
      type: "task",
      content: "Ship it",
      status: "started",
      order: 0,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }];
    vi.spyOn(drivePermissions, "discoverSharedProjects").mockResolvedValue([
      { projectId: "shared-1", name: "shared-1", fileId: "f1" },
    ]);
    vi.spyOn(drivePermissions, "readSharedSnapshot").mockResolvedValue(
      serializeProjectSnapshot(project, items),
    );

    await discoverSharedBoards();
    expect(await rx.getProject("shared-1")).not.toBeNull();
  });

  it("does not re-import a project that is already present locally", async () => {
    const rx = await createRxRepository({
      name: "load-existing",
      blobs: createIndexedDbBlobStore("load-existingimages"),
    });
    registerRxRepositoryResolver(() => Promise.resolve(rx));

    const project: Project = {
      id: "shared-1",
      name: "Shared one",
      template: "project",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const items: BoardItem[] = [{
      id: "card-1",
      projectId: "shared-1",
      type: "task",
      content: "Ship it",
      status: "started",
      order: 0,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }];
    await rx.importProject(project, items);

    vi.spyOn(drivePermissions, "discoverSharedProjects").mockResolvedValue([
      { projectId: "shared-1", name: "shared-1", fileId: "f1" },
    ]);
    const readSpy = vi.spyOn(drivePermissions, "readSharedSnapshot");

    await discoverSharedBoards();

    expect(readSpy).not.toHaveBeenCalled();
  });

  it("reports an invalid snapshot without importing the project", async () => {
    const rx = await createRxRepository({
      name: "load-broken",
      blobs: createIndexedDbBlobStore("load-brokenimages"),
    });
    registerRxRepositoryResolver(() => Promise.resolve(rx));

    vi.spyOn(drivePermissions, "discoverSharedProjects").mockResolvedValue([
      { projectId: "shared-2", name: "shared-2", fileId: "f2" },
    ]);
    vi.spyOn(drivePermissions, "readSharedSnapshot").mockResolvedValue(
      "not-a-snapshot",
    );

    await expect(discoverSharedBoards()).rejects.toThrow("Could not import some shared boards");
    expect(await rx.getProject("shared-2")).toBeNull();
  });

  it("imports only the missing projects from a mixed batch", async () => {
    const rx = await createRxRepository({
      name: "load-mixed",
      blobs: createIndexedDbBlobStore("load-mixedimages"),
    });
    registerRxRepositoryResolver(() => Promise.resolve(rx));

    const existing: Project = {
      id: "shared-1",
      name: "Existing",
      template: "project",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const existingItems: BoardItem[] = [{
      id: "card-e",
      projectId: "shared-1",
      type: "task",
      content: "Old card",
      status: "done",
      order: 0,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    }];
    await rx.importProject(existing, existingItems);

    const fresh: Project = {
      id: "shared-2",
      name: "Fresh",
      template: "project",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const freshItems: BoardItem[] = [{
      id: "card-f",
      projectId: "shared-2",
      type: "task",
      content: "New card",
      status: "started",
      order: 0,
      createdAt: fresh.createdAt,
      updatedAt: fresh.updatedAt,
    }];

    vi.spyOn(drivePermissions, "discoverSharedProjects").mockResolvedValue([
      { projectId: "shared-1", name: "shared-1", fileId: "f1" },
      { projectId: "shared-2", name: "shared-2", fileId: "f2" },
      { projectId: "shared-3", name: "shared-3", fileId: "f3" },
    ]);
    vi.spyOn(drivePermissions, "readSharedSnapshot").mockImplementation((id) => {
      if (id === "shared-2") {
        return Promise.resolve(serializeProjectSnapshot(fresh, freshItems));
      }
      return Promise.reject(new Error("no snapshot"));
    });

    await expect(discoverSharedBoards()).rejects.toThrow("no snapshot");
    expect(await rx.getProject("shared-2")).not.toBeNull();
    expect(await rx.getProject("shared-3")).toBeNull();
  });

  it("finishes when no repository is registered", async () => {
    registerRxRepositoryResolver(async () => null);
    vi.spyOn(drivePermissions, "discoverSharedProjects").mockResolvedValue([]);

    expect(await discoverSharedBoards()).toBeUndefined();
  });
});

describe("collaborationManager", () => {
  it("exposes the four operations and is unready before start()", () => {
    expect(typeof collaborationManager.start).toBe("function");
    expect(typeof collaborationManager.stop).toBe("function");
    expect(typeof collaborationManager.refreshRole).toBe("function");
    expect(typeof collaborationManager.state).toBe("function");
    const state = collaborationManager.state();
    expect(state.role).toBe("private");
    expect(state.sharedFileId).toBeNull();
    expect(state.ready).toBe(false);
  });
});
