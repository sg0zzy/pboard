// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import { App } from "../src/sidebar/App";
import type { BoardItem, Project } from "../src/types";

// Same fake-singleton harness as tests/projectDeletionUi.test.tsx: App reaches
// the repository, extension APIs and collaboration manager through modules.
const fake = vi.hoisted(() => {
  const project: Project = {
    id: "p1",
    name: "My Board",
    template: "brainstorming",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const card: BoardItem = {
    id: "shot", projectId: "p1", type: "reference", status: "candidate", order: 0,
    content: "Screenshot", imageId: "img-1", createdAt: "2026-01-01", updatedAt: "2026-01-01"
  };
  const subscribe = (value: unknown) => async (listener: (next: unknown) => void) => {
    listener(value);
    return () => {};
  };
  return {
    project,
    card,
    subscribeProjects: vi.fn(subscribe([project])),
    subscribeCurrentProject: vi.fn(subscribe(project)),
    subscribeCards: vi.fn(async (_projectId: string, listener: (next: unknown) => void) => {
      listener([card]);
      return () => {};
    }),
    getImage: vi.fn(async (imageId: string) => imageId === "img-1"
      ? { imageId, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), mimeType: "image/png", width: 4, height: 4, size: 3 }
      : null),
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
  operationService: { subscribeRole: async () => () => {}, role: async () => "viewer" },
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

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await act(async () => undefined);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("board download button", () => {
  let container: HTMLDivElement;
  let root: Root;
  let capturedBlob: Blob | undefined;
  let createObjectURL: Mock<(blob: Blob) => string>;
  let clickAnchor: MockInstance;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    capturedBlob = undefined;
    createObjectURL = vi.fn((blob: Blob) => { capturedBlob = blob; return "blob:board-zip"; });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    clickAnchor.mockRestore();
  });

  it("renders copy board on the left and download board on the right", async () => {
    await act(async () => { root.render(<App />); });
    const buttons = [...container.querySelectorAll(".board-control-buttons button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Copy board", "Download board"]);
  });

  it("downloads a zip with the prompt txt and the card image once it is ready", async () => {
    await act(async () => { root.render(<App />); });
    await until(() => container.querySelectorAll(".board-control-buttons button").length === 2, "board controls");
    expect(container.querySelector<HTMLButtonElement>(".download-button")?.disabled).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>(".download-button")!.click(); });
    await until(() => clickAnchor.mock.calls.length === 1, "the download click");
    const anchor = clickAnchor.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe("My Board.zip");
    const files = unzipSync(new Uint8Array(await capturedBlob!.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["board.json", "board.txt", "images/shot-1.png"]);
    expect(new TextDecoder().decode(files["board.txt"])).toContain("[reference] [candidate] Screenshot");
    expect(Array.from(files["images/shot-1.png"]!)).toEqual([1, 2, 3]);
    await until(() => container.querySelector(".notice")?.textContent === "Board downloaded", "the download notice");
  });
});
