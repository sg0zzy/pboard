/**
 * The diagnostics gauges themselves: the counted-timer registry, the socket
 * registry and the live-subscription gauges. These are the instruments the
 * single-socket and idle-cost invariants are asserted with, so they are tested
 * before anything is asserted through them — a gauge that double-releases, or
 * that survives `clear()`, would make every later invariant test meaningless.
 *
 * The build flag is read when `src/collab/counters` loads, so each build is
 * loaded after the global is stubbed (the same boundary `counters.test.ts`
 * pins), and the production half of every case goes through that load too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationCountersApi } from "../../src/collab/counters";

// `src/collab/counters` reads `__PBOARD_DIAGNOSTICS__` when it *loads*, so a
// static import would capture one build for the whole file and the production
// half of these cases could not run at all. Loading it per case, after the
// stub, is the boundary under test.
async function load(a: { diagnostics: boolean }): Promise<CollaborationCountersApi> {
  vi.stubGlobal("__PBOARD_DIAGNOSTICS__", a.diagnostics);
  vi.resetModules();
  return (await import("../../src/collab/counters")).collaborationCounters;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The armed set, which is what an idle-cost invariant compares. */
const armed = (counters: CollaborationCountersApi): string[] =>
  Object.keys(counters.snapshot().active).filter(name => name.startsWith("timer.")).sort();

describe("counted timers", () => {
  it("counts an armed interval until it is cleared, and fires exactly once per period", async () => {
    const counters = await load({ diagnostics: true });
    vi.useFakeTimers();
    let runs = 0;
    const handle = counters.countedInterval("probe", () => { runs += 1; }, 1_000);
    expect(counters.snapshot().active["timer.probe"]).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runs).toBe(3);
    // Still armed: firing does not disarm an interval.
    expect(counters.snapshot().active["timer.probe"]).toBe(1);

    counters.clearCountedTimer(handle);
    expect(armed(counters)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(3);
  });

  it("drops a timeout's gauge when it fires, without a clear", async () => {
    const counters = await load({ diagnostics: true });
    vi.useFakeTimers();
    let runs = 0;
    counters.countedTimeout("probe", () => { runs += 1; }, 500);
    expect(counters.snapshot().active["timer.probe"]).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(1);
    // A fired timeout is no longer scheduled work, which is the whole point of
    // distinguishing "armed" from "exists".
    expect(armed(counters)).toEqual([]);
  });

  it("releases once, so a clear before the interval fires is not double-counted", async () => {
    const counters = await load({ diagnostics: true });
    vi.useFakeTimers();
    const first = counters.countedInterval("probe", () => undefined, 1_000);
    const second = counters.countedInterval("probe", () => undefined, 1_000);
    expect(counters.snapshot().active["timer.probe"]).toBe(2);
    counters.clearCountedTimer(first);
    counters.clearCountedTimer(first);          // idempotent
    expect(counters.snapshot().active["timer.probe"]).toBe(1);
    // Clearing the second leaves no key at all rather than a zero the reader
    // would have to interpret.
    counters.clearCountedTimer(second);
    expect(counters.snapshot().active).toEqual({});
  });

  it("clears a plain handle and an absent one without touching any gauge", async () => {
    const counters = await load({ diagnostics: true });
    vi.useFakeTimers();
    let plainRuns = 0;
    const plain = setInterval(() => { plainRuns += 1; }, 1_000);
    counters.clearCountedTimer(undefined);
    expect(counters.snapshot().active).toEqual({});
    counters.clearCountedTimer(plain);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plainRuns).toBe(0);
    expect(counters.snapshot().active).toEqual({});
  });

  it("keeps the armed set a function of the timers, not of the call sites", async () => {
    // The invariant these gauges exist for: the same set at one board and at
    // many. One name armed N times reads N, and every release removes it.
    const counters = await load({ diagnostics: true });
    vi.useFakeTimers();
    const handles = Array.from({ length: 100 }, () => counters.countedInterval("probe", () => undefined, 1_000));
    expect(armed(counters)).toEqual(["timer.probe"]);
    expect(counters.snapshot().active["timer.probe"]).toBe(100);
    for (const handle of handles) counters.clearCountedTimer(handle);
    expect(armed(counters)).toEqual([]);
  });

  it("republishes still-armed timers after clear(), so an idle report cannot lie", async () => {
    const counters = await load({ diagnostics: true });
    vi.useFakeTimers();
    const handle = counters.countedInterval("probe", () => undefined, 1_000);
    counters.noteSocketOpen("topic");
    counters.clear();
    // `clear()` zeroes counters; it must not hide work the registry can see.
    expect(counters.snapshot().active).toEqual({ "timer.probe": 1, "transport.open": 1, "transport.topic.topic": 1 });
    counters.clearCountedTimer(handle);
    counters.noteSocketClose("topic");
    expect(counters.snapshot().active).toEqual({});
  });
});

describe("the socket registry", () => {
  it("counts dials, splits them by topic, and returns to nothing when they close", async () => {
    const counters = await load({ diagnostics: true });
    counters.noteSocketOpen("board-a");
    counters.noteSocketOpen("board-a");
    counters.noteSocketOpen("account");
    expect(counters.snapshot().active).toEqual({
      "transport.open": 3, "transport.topic.board-a": 2, "transport.topic.account": 1
    });
    counters.noteSocketClose("board-a");
    counters.noteSocketClose("account");
    counters.noteSocketClose("board-a");
    // Keys disappear at zero: the socket population is the key set, and an
    // extra topic key would read as an extra socket.
    expect(counters.snapshot().active).toEqual({});
  });

  it("survives an unmatched close without a negative socket count", async () => {
    const counters = await load({ diagnostics: true });
    counters.noteSocketClose("board-a");
    expect(counters.snapshot().active).toEqual({});
  });

  it("is inert in a production build: the call sites stay, nothing is recorded", async () => {
    const counters = await load({ diagnostics: false });
    vi.useFakeTimers();
    let runs = 0;
    const handle = counters.countedInterval("probe", () => { runs += 1; }, 1_000);
    const once = counters.countedTimeout("probe", () => { runs += 1; }, 500);
    counters.noteSocketOpen("board-a");
    counters.adjustActive("rx.subscriptions", 1);
    // The timers themselves are the platform's own, so behaviour is unchanged.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toBeGreaterThan(0);
    expect(counters.snapshot().active).toEqual({});
    expect(counters.enabled).toBe(false);
    counters.clearCountedTimer(handle);
    counters.clearCountedTimer(once);
    expect(counters.snapshot().active).toEqual({});
  });
});

describe("the diagnostics console", () => {
  it("carries the counters next to the rooms, without reshaping the payload", async () => {
    const counters = await load({ diagnostics: true });
    // Loading boundary, not a runtime-selected module: `realtimeDiagnostics`
    // holds a static reference to the counters instance it was evaluated with,
    // so it has to be evaluated *after* the build below is loaded or it reads
    // the disabled instance and the assertion would test the harness.
    const { exposeCollaborationDiagnostics } = await import("../../src/sync/realtimeDiagnostics");
    counters.noteSocketOpen("board-a");
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      exposeCollaborationDiagnostics("probe", () => ({ rooms: [] }));
      const read = globalThis.pboardCollaboration;
      expect(read).toBeTypeOf("function");
      const payload = await read!() as Record<string, unknown>;
      expect(payload.context).toBe("probe");
      expect(payload.counters).toMatchObject({ active: { "transport.open": 1, "transport.topic.board-a": 1 } });
      // The existing shape is unchanged: the room keys stay where they were.
      expect(payload.rooms).toEqual([]);
      expect(payload.authBudget).toBeTypeOf("object");
    } finally { consoleInfo.mockRestore(); counters.noteSocketClose("board-a"); }
  });
});
