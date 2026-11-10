// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/sidebar/App";
import type { Project } from "../src/types";

// Same fake-singleton harness as tests/boardDownloadUi.test.tsx. The panel this
// test guards was deleted from App's tree by a refactoring commit while its own
// component tests kept passing, so the assertion is made through App: a control
// nobody can reach is a feature nobody has.
const fake = vi.hoisted(() => {
  const project: Project = {
    id: "p1",
    name: "My Board",
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
    // The panel reads its transport from this setting on mount.
    settings: { provider: "drive", url: "wss://pboard.cecosl.ovh/ws" },
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
    permissions: { request: vi.fn(async () => true) },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  }
}));

vi.mock("../src/sync/client", () => ({
  requestDriveReconciliation: vi.fn(async () => ({ ok: true })),
  requestProjectSync: vi.fn(async () => undefined)
}));

vi.mock("../src/sync/browser", () => ({
  driveFolderGardener: {},
  healRelay: async () => "idle:no-room",
  operationService: { subscribeRole: async () => () => {}, role: async () => "viewer" },
  boardCollaboration: { settings: async () => fake.settings },
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

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await act(async () => undefined);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("transport panel reachability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fake.settings = { provider: "drive", url: "wss://pboard.cecosl.ovh/ws" };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers the relay opt-in inside the board", async () => {
    await act(async () => root.render(<App />));
    await until(() => container.textContent?.includes("Signaling:"), "the collaboration panel to report its signaling source");
    // The summary is the only affordance; if App stops rendering the panel this
    // text disappears and the relay cannot be enabled by anyone.
    expect(container.querySelector(".board-collaboration summary")?.textContent).toBe("WebRTC collaboration");
    expect(container.textContent).toContain("Drive (default)");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toContain("Enable WebSocket collaboration");
  });
});
