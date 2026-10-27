// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/sidebar/App";
import type { Project } from "../src/types";

// App reaches the repository, the extension APIs and the collaboration manager
// through module singletons, so each is replaced by a fake. Only the deletion
// path is exercised: the gate keeps propagation in flight while the panel is
// expected to close.
const fake = vi.hoisted(() => {
  const project: Project = {
    id: "p1",
    name: "Shared",
    template: "brainstorming",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const subscribe = (value: unknown) => async (listener: (next: unknown) => void) => {
    listener(value);
    return () => {};
  };
  return {
    project,
    deleteProject: vi.fn<() => Promise<void>>(),
    subscribeProjects: vi.fn(subscribe([project])),
    subscribeCurrentProject: vi.fn(subscribe(project)),
    subscribeCards: vi.fn(async (_projectId: string, listener: (next: unknown) => void) => {
      listener([]);
      return () => {};
    }),
    getImage: vi.fn(async () => null),
    subscribeImage: vi.fn(async (_imageId: string, listener: (next: unknown) => void) => {
      listener(null);
      return () => {};
    })
  };
});

vi.mock("../src/storage/browser", () => ({
  repository: fake,
  RXDB_MIGRATION_ERROR_KEY: "rxdbMigrationError"
}));

vi.mock("../src/platform/browser", () => ({
  browser: {
    runtime: { sendMessage: vi.fn(async () => ({ page: false, selection: false, link: false, accessible: false })) },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  }
}));

vi.mock("../src/sync/client", () => ({
  requestDriveReconciliation: vi.fn(async () => undefined),
  requestProjectSync: vi.fn(async () => undefined)
}));

vi.mock("../src/sync/browser", () => ({
  boardCollaboration: { settings: async () => ({ provider: "drive", url: "wss://pboard.cecosl.ovh/ws" }) },
  collaborationManager: {
    state: () => ({ ready: false, role: "private", connectedPeers: [], error: null }),
    setEnabled: async () => {},
    start: vi.fn(async () => undefined),
    refreshRole: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  },
  drivePermissions: {},
  sharePermissions: {},
  discoverSharedBoards: vi.fn(async () => []),
  SHARED_PROJECTS_KEY: "sharedProjects",
  renewBoardAuthorization: vi.fn(async () => ({ role: "owner" })),
  googleAuth: { connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), isConfigured: () => false },
  googleDrive: { getConnectionState: vi.fn(async () => "disconnected") },
  driveSyncState: { get: vi.fn(async () => null), markDirty: vi.fn(async () => undefined) },
}));

// Gate for tests that must observe an intermediate state: the awaited promise
// stays pending until the test releases it, so no wall-clock timer is involved.
type Gate<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Microtask-flush until a condition holds (same reasoning as
// tests/shareControls.test.tsx): a fixed number of flushes is racy and no
// wall-clock timer is allowed.
async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await act(async () => undefined);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("project deletion confirmation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fake.deleteProject.mockReset();
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  async function openConfirmation(): Promise<void> {
    await act(async () => { root.render(<App />); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Delete project"]')!.click(); });
    expect(document.querySelector(".delete-confirmation")).not.toBeNull();
  }

  it("closes the confirmation panel while the background propagation is still running", async () => {
    const propagation = gate<void>();
    fake.deleteProject.mockImplementation(() => propagation.promise);
    await openConfirmation();
    await act(async () => { document.querySelector<HTMLButtonElement>(".delete-confirm-button")!.click(); });
    expect(fake.deleteProject).toHaveBeenCalledWith(fake.project.id);
    expect(document.querySelector(".delete-confirmation")).toBeNull();
    propagation.resolve(undefined);
    await act(async () => { await propagation.promise; });
    expect(document.querySelector(".notice")).toBeNull();
  });

  it("reports a background failure after the panel has already closed", async () => {
    const propagation = gate<void>();
    fake.deleteProject.mockImplementation(() => propagation.promise);
    await openConfirmation();
    await act(async () => { document.querySelector<HTMLButtonElement>(".delete-confirm-button")!.click(); });
    expect(document.querySelector(".delete-confirmation")).toBeNull();
    propagation.reject(new Error("Drive role check failed"));
    await until(() => document.querySelector(".notice")?.textContent?.includes("Drive role check failed") === true, "the deletion failure notice");
  });
});
