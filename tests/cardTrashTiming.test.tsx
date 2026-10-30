// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/sidebar/App";
import type { BoardItem, BoardItemStatus, Project } from "../src/types";

// Same fake-singleton harness as tests/projectDeletionUi.test.tsx. The fake
// repository re-emits its card list after updateItem so section membership
// follows the committed status, like the real RxDB subscription.
const fake = vi.hoisted(() => {
  const project: Project = {
    id: "p1", name: "Board", template: "brainstorming", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const cards: BoardItem[] = [
    { id: "a", projectId: "p1", type: "note", status: "candidate", order: 0, content: "First", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    { id: "b", projectId: "p1", type: "note", status: "candidate", order: 1, content: "Second", createdAt: "2026-01-01", updatedAt: "2026-01-01" }
  ];
  let emitCards: ((value: BoardItem[]) => void) | null = null;
  return {
    project,
    cards,
    emit: (value: BoardItem[]) => emitCards?.(value),
    updateItem: vi.fn(async (itemId: string, patch: Partial<BoardItem>) => {
      const index = cards.findIndex((card) => card.id === itemId);
      if (index >= 0) cards[index] = { ...cards[index], ...patch };
      emitCards?.([...cards]);
    }),
    subscribeProjects: vi.fn(async (listener: (value: unknown) => void) => { listener([project]); return () => {}; }),
    subscribeCurrentProject: vi.fn(async (listener: (value: unknown) => void) => { listener(project); return () => {}; }),
    subscribeCards: vi.fn(async (_projectId: string, listener: (value: BoardItem[]) => void) => {
      emitCards = listener;
      listener([...cards]);
      return () => { if (emitCards === listener) emitCards = null; };
    }),
    getImage: vi.fn(async () => null),
    subscribeImage: vi.fn(async (_imageId: string, listener: (value: unknown) => void) => { listener(null); return () => {}; })
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

function cardElement(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
}

function trashButton(id: string): HTMLButtonElement {
  return cardElement(id).querySelector<HTMLButtonElement>('[aria-label="Delete card"]')!;
}

function committedStatuses(): [string, BoardItemStatus][] {
  return fake.updateItem.mock.calls.map(([id, patch]) => [id, patch.status as BoardItemStatus]);
}

describe("card trash versus staged status changes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fake.cards.forEach((card, index) => {
      fake.cards[index] = { ...card, status: "candidate" };
    });
    fake.updateItem.mockClear();
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
  });

  async function renderBoard(): Promise<void> {
    await act(async () => { root.render(<App />); });
    await until(() => document.querySelector("[data-card-id]") !== null, "the board cards");
  }

  it("moves the card to the Trash section immediately on the trash icon", async () => {
    await renderBoard();
    await act(async () => { trashButton("a").click(); });
    expect(fake.updateItem).toHaveBeenCalledWith("a", { status: "trash" });
    expect(cardElement("a").className).toContain("status-trash");
    expect(document.querySelector(".terminal-section--trash [data-card-id='a']")).not.toBeNull();
  });

  it("keeps the arrow-key status change staged and commits it after the delay", async () => {
    await renderBoard();
    await act(async () => {
      cardElement("b").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(fake.updateItem).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(799); });
    expect(fake.updateItem).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fake.updateItem).toHaveBeenCalledWith("b", { status: "confirmed" });
  });

  it("cancels a staged status change when the trash icon commits first", async () => {
    await renderBoard();
    await act(async () => {
      cardElement("b").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await act(async () => { trashButton("b").click(); });
    expect(fake.updateItem).toHaveBeenCalledWith("b", { status: "trash" });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(committedStatuses()).toEqual([["b", "trash"]]);
  });
});
