/**
 * Stress/overhead integration test: sustained emission through the real bus
 * into the real bridge. Deliberately uses real timers and real sockets — the
 * point is bounded behaviour under load, which fake time cannot show:
 * queue bounds under burst, no unbounded memory growth, honest drop
 * accounting, and an application loop that survives the bridge dying.
 * Kept to ~5s; run via `npm run debug:test`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBridge } from "../tools/pboard-debug/server";
import { configureDebugBus, emit, flushDebugBus, resetDebugBus, debugDropReport, pendingEventCount } from "../src/debug/bus";
import { HttpBridgeTransport } from "../src/debug/bridgeTransport";

let bridge: { close: () => Promise<void>; url: string } | undefined;

beforeAll(async () => {
  const handle = startBridge({ host: "127.0.0.1", port: 0, mode: "mock", quiet: true, maxEvents: 5_000 });
  const bound = await handle.listening;
  bridge = { close: handle.close, url: `http://127.0.0.1:${bound.port}` };
});

afterAll(async () => {
  resetDebugBus();
  await bridge?.close();
});

async function bridgeStatus(): Promise<{ eventBufferLength: number; droppedByOverflow: number; rejectedEvents: number }> {
  const response = await fetch(`${bridge!.url}/status`);
  return (await response.json()) as { eventBufferLength: number; droppedByOverflow: number; rejectedEvents: number };
}

/** Wait until the bridge has ingested everything the bus can deliver (or
 * the condition-poll deadline passes): condition-polling instead of a fixed
 * sleep so the assertion below is about behaviour, not timer luck. */
async function waitForBuffer(minimum: number, deadlineMs = 8_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let length = 0;
  do {
    flushDebugBus();
    length = (await bridgeStatus()).eventBufferLength;
    if (length >= minimum) return length;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return length;
}

describe("debug bridge stress", () => {
  it("delivers a 5k-event burst without loss, keeping queue and memory bounded", async () => {
    configureDebugBus({
      enabled: true,
      identity: () => ({ clientId: "stress-client", sessionId: "stress-session", context: "node-test" }),
      transport: () => new HttpBridgeTransport({ url: bridge!.url, clientId: "stress-client", sessionId: "stress-session", context: "node-test" }),
      maxQueue: 4_000,
    });
    const before = process.memoryUsage().rss;
    for (let index = 0; index < 5_000; index += 1)
      emit({ component: "sync", event: "operation.created", severity: index % 400 === 0 ? "warn" : "debug", boardId: "stress-board", details: { index, pad: "x".repeat(48) } });
    // The synchronous burst must never grow the queue beyond its bound.
    expect(pendingEventCount()).toBeLessThanOrEqual(4_000);
    const droppedDuringBurst = debugDropReport().queue;
    const after = process.memoryUsage().rss;
    // Loose ceiling: this is a smoke bound on runaway growth, not a profile.
    expect(after - before).toBeLessThan(128 * 1024 * 1024);

    const delivered = await waitForBuffer(5_000 - droppedDuringBurst);
    expect(delivered + droppedDuringBurst).toBeGreaterThanOrEqual(5_000);
    const status = await bridgeStatus();
    expect(status.rejectedEvents).toBe(0);
    expect(status.droppedByOverflow).toBe(0);
    resetDebugBus();
  });

  it("records transport drops and stays functional when the bridge disappears", async () => {
    const deadUrl = bridge!.url;
    configureDebugBus({
      enabled: true,
      identity: () => ({ clientId: "dead-bridge-client", sessionId: "s", context: "node-test" }),
      transport: () => new HttpBridgeTransport({ url: deadUrl, clientId: "dead-bridge-client", sessionId: "s", context: "node-test" }),
      maxQueue: 200,
    });
    await bridge!.close();
    bridge = undefined;
    // Application loop continues against a dead bridge: emit never throws,
    // the queue stays bounded, drops are counted rather than hidden.
    for (let index = 0; index < 2_000; index += 1) {
      expect(() => emit({ component: "sync", event: "operation.created", severity: "debug", boardId: "x", details: { index } })).not.toThrow();
      if (index % 250 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(pendingEventCount()).toBeLessThanOrEqual(200);
    const report = debugDropReport();
    expect(report.queue + report.transport).toBeGreaterThan(0);
  });
});
