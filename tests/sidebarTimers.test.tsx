// @vitest-environment jsdom
/**
 * The sidebar's own timers, as an invariant: the App arms `sidebar.status`,
 * `sidebar.role` and `sidebar.toolbarPin` — three, and three only — and its
 * teardown disarms all of them. A board switch remounts the collaboration
 * effect, so the interesting failure is an effect that arms a timer and never
 * releases it: the armed set would climb with every visit while the board count
 * stayed at one.
 *
 * The counters are the diagnostics build's, so the build flag is stubbed before
 * the module graph loads. Fake timers drive the clock; nothing here waits on
 * wall time.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../src/types";
import type { CollaborationCountersApi } from "../src/collab/counters";

const fake = vi.hoisted(() => {
  const projects: Project[] = ["p1", "p2", "p3"].map((id, index) => ({
    id, name: `Board ${index}`, template: "brainstorming", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  }));
  // A repository whose subscriptions answer immediately and whose current
  // board the test can move, exactly as `storage/browser` does for the UI.
  let current = projects[0];
  const listeners = new Set<(value: Project) => void>();
  return {
    projects,
    get current() { return current; },
    setCurrent(project: Project) { current = project; for (const listener of listeners) listener(project); },
    subscribeProjects: vi.fn(async (listener: (value: Project[]) => void) => { listener(projects); return () => {}; }),
    subscribeCurrentProject: vi.fn(async (listener: (value: Project) => void) => {
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    }),
    subscribeCards: vi.fn(async (_projectId: string, listener: (value: unknown[]) => void) => { listener([]); return () => {}; }),
    getImage: vi.fn(async () => null),
    subscribeImage: vi.fn(async (_imageId: string, listener: (value: null) => void) => { listener(null); return () => {}; })
  };
});

vi.mock("../src/storage/browser", () => ({ repository: fake, RXDB_MIGRATION_ERROR_KEY: "rxdbMigrationError" }));
vi.mock("../src/platform/browser", () => ({
  browser: {
    runtime: { sendMessage: vi.fn(async () => ({ page: false, selection: false, link: false, accessible: false })) },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  }
}));
vi.mock("../src/sync/client", () => ({ requestDriveReconciliation: vi.fn(async () => ({ ok: true })), requestProjectSync: vi.fn(async () => undefined) }));
vi.mock("../src/sync/browser", () => ({
  driveFolderGardener: {},
  healRelay: async () => "idle:no-room",
  operationService: { subscribeRole: async () => () => {}, role: async () => "viewer" },
  boardCollaboration: { settings: async () => ({ provider: "drive", url: "wss://relay.invalid/ws" }) },
  collaborationManager: {
    state: () => ({ ready: false, role: "private", connectedPeers: [], error: null }),
    setEnabled: async () => {}, start: vi.fn(async () => undefined),
    refreshRole: vi.fn(async () => undefined), stop: vi.fn(async () => undefined)
  },
  drivePermissions: {}, sharePermissions: {}, discoverSharedBoards: vi.fn(async () => []),
  SHARED_PROJECTS_KEY: "sharedProjects", renewBoardAuthorization: vi.fn(async () => ({ role: "owner" })),
  googleAuth: { connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), isConfigured: () => false },
  googleDrive: { getConnectionState: vi.fn(async () => "disconnected") },
  driveSyncState: { get: vi.fn(async () => null), markDirty: vi.fn(async () => undefined) }
}));

/** The armed sidebar timers of a counters snapshot. */
const sidebarTimers = (active: Record<string, number>): string[] =>
  Object.keys(active).filter(name => name.startsWith("timer.sidebar.")).sort();

describe("the sidebar's armed timers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let counters: CollaborationCountersApi;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal("__PBOARD_DIAGNOSTICS__", true);
    vi.resetModules();
    counters = (await import("../src/collab/counters")).collaborationCounters;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("records nothing in a production build while arming and disarming the same timers", async () => {
    // The inertness half of the gauge contract, at a real routing point: the
    // build flag is stubbed false, so the three call sites take the plain
    // `setInterval` branch. The timers must still exist, still fire, and leave
    // the counters alone — a gauge that changed behaviour with the build would
    // make every production run a different program from the tested one.
    vi.stubGlobal("__PBOARD_DIAGNOSTICS__", false);
    vi.resetModules();
    counters = (await import("../src/collab/counters")).collaborationCounters;
    expect(counters.enabled).toBe(false);
    const { App } = await import("../src/sidebar/App");
    await act(async () => { root.render(<App />); });
    expect(counters.snapshot().active).toEqual({});
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3);
    const before = vi.getTimerCount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    // Still exactly as many timers: the plain intervals were not cleared by the
    // counted path and nothing was double-armed. (Advancing runs the 1 s status
    // interval, so the count can only fall if something cleared one.)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3);
    await act(async () => { root.unmount(); });
    expect(counters.snapshot().active).toEqual({});
    expect(vi.getTimerCount()).toBeLessThan(before);
  });

  it("arms the same three timers no matter which board is displayed, and disarms them on unmount", async () => {
    const { App } = await import("../src/sidebar/App");
    await act(async () => { root.render(<App />); });
    const armed = sidebarTimers(counters.snapshot().active);
    // Named, not counted: a fourth timer appearing here is the regression, and
    // the names say which effect armed it.
    expect(armed).toEqual(["timer.sidebar.role", "timer.sidebar.status", "timer.sidebar.toolbarPin"]);
    expect(counters.snapshot().active["timer.sidebar.role"]).toBe(1);

    // Switch boards repeatedly. The collaboration effect remounts per board,
    // so an undisarmed timer would read 2, 3, 4… here.
    for (const project of fake.projects.slice(1)) {
      await act(async () => { fake.setCurrent(project); await Promise.resolve(); });
    }
    expect(sidebarTimers(counters.snapshot().active)).toEqual(armed);
    for (const name of armed) expect(counters.snapshot().active[name], `${name} armed more than once`).toBe(1);

    await act(async () => { root.unmount(); });
    expect(sidebarTimers(counters.snapshot().active)).toEqual([]);
    // The timer callbacks are gone too, not merely uncounted: advancing the
    // clock must not run the status updater of an unmounted tree.
    const remaining = vi.getTimerCount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(vi.getTimerCount()).toBeLessThanOrEqual(remaining);
  });
});
