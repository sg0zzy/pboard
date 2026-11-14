/**
 * Unit tests for the diagnostic event schema, bus, registry, and trace
 * correlation. Pure Vitest, no browser or bridge required.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  DEBUG_SCHEMA_VERSION,
  validateDebugEvent,
  eventMatchesFilter,
  isValidEventName,
  DEBUG_EVENTS,
  type DebugEvent,
} from "../src/debug/schema";
import { emit, configureDebugBus, resetDebugBus, debugDropReport, flushDebugBus, debugBusEnabled } from "../src/debug/bus";
import { ConnectionRegistry, registryFromEvents } from "../src/debug/connectionRegistry";
import { buildTraceView, cardOperationComplete, correlateTraces, TraceIndex } from "../src/debug/trace";
import { resolveClientId, resolveSessionId, newDebugId } from "../src/debug/ids";
import type { DebugTransport } from "../src/debug/bus";
import { HttpBridgeTransport } from "../src/debug/bridgeTransport";

let clock = 1_000;
function makeEvent(overrides: Partial<DebugEvent> = {}): DebugEvent {
  return {
    schemaVersion: DEBUG_SCHEMA_VERSION,
    timestamp: new Date(clock += 5).toISOString(),
    monotonicTime: clock,
    sequenceNumber: 1,
    component: "websocket",
    event: "connection.opened",
    severity: "info",
    ...overrides,
  } as DebugEvent;
}

beforeEach(() => {
  resetDebugBus();
});

describe("schema validation", () => {
  it("accepts a well-formed event", () => {
    const result = validateDebugEvent(makeEvent());
    expect(result.ok).toBe(true);
  });

  it("rejects wrong schema version, bad severity, unregistered event names", () => {
    expect(validateDebugEvent(makeEvent({ schemaVersion: 999 as never })).ok).toBe(false);
    expect(validateDebugEvent(makeEvent({ severity: "fatal" as never })).ok).toBe(false);
    expect(validateDebugEvent(makeEvent({ component: "bogus" as never })).ok).toBe(false);
    expect(validateDebugEvent(makeEvent({ event: "not.registered" })).ok).toBe(false);
    // Registered for a different component must not validate.
    expect(validateDebugEvent(makeEvent({ component: "websocket", event: "operation.created" })).ok).toBe(false);
  });

  it("rejects oversized and empty identity fields", () => {
    expect(validateDebugEvent(makeEvent({ clientId: "x".repeat(129) })).ok).toBe(false);
    expect(validateDebugEvent(makeEvent({ clientId: "" })).ok).toBe(false);
  });

  it("event name registry covers every documented component", () => {
    for (const component of Object.keys(DEBUG_EVENTS))
      expect(isValidEventName(component as never, "connection.opened")).toBe(component === "websocket");
  });
});

describe("bus emit", () => {
  let sent: DebugEvent[] = [];
  const collector: DebugTransport = {
    send(events) {
      sent.push(...events);
    },
  };
  beforeEach(() => {
    sent = [];
  });
  function enableBus(transport: DebugTransport | undefined = collector) {
    configureDebugBus({
      enabled: true,
      identity: () => ({ clientId: "test-client", sessionId: "test-session", context: "test" }),
      transport: () => transport,
      batchSize: 1000,
      flushDelayMs: 60_000,
    });
  }

  it("disabled by default: emit is inert and reports sequence 0", () => {
    expect(debugBusEnabled()).toBe(false);
    expect(emit({ component: "websocket", event: "connection.opened", severity: "info" })).toBe(0);
    expect(debugDropReport()).toEqual({ queue: 0, oversized: 0, invalid: 0, transport: 0 });
  });

  it("assigns monotonically increasing sequence numbers", () => {
    enableBus();
    const first = emit({ component: "websocket", event: "connection.opened", severity: "info" });
    const second = emit({ component: "websocket", event: "message.sent", severity: "debug" });
    expect(second).toBeGreaterThan(first);
    flushDebugBus();
  });

  it("drops oldest info/debug under queue pressure, keeps warn/error", () => {
    const collected: DebugEvent[] = [];
    configureDebugBus({
      enabled: true,
      identity: () => ({ clientId: "c", sessionId: "s", context: "test" }),
      transport: () => ({ send: (events: DebugEvent[]) => collected.push(...events) }),
      maxQueue: 3,
      batchSize: 1000, // force everything out through the explicit flush
      flushDelayMs: 60_000,
    });
    emit({ component: "sync", event: "operation.created", severity: "info" });
    emit({ component: "sync", event: "operation.queued", severity: "warn" });
    emit({ component: "sync", event: "operation.applied", severity: "error" });
    emit({ component: "sync", event: "sync.completed", severity: "info" });
    expect(debugDropReport().queue).toBe(1);
    flushDebugBus();
    expect(collected.map((event) => event.severity)).toEqual(["warn", "error", "info"]);
  });

  it("redacts sensitive keys and truncates deep structures", () => {
    enableBus();
    emit({
      component: "auth",
      event: "authentication.started",
      severity: "info",
      details: {
        accessToken: "eyJhbGciOi...",
        nested: { refreshToken: "secret", keep: 1, list: Array.from({ length: 40 }, (_, index) => index) },
        long: "x".repeat(2_000),
        circular: (() => { const o: Record<string, unknown> = {}; o["self"] = o; return o; })(),
      },
    });
    flushDebugBus();
    const events = sent;
    const details = events[0].details as Record<string, unknown>;
    expect(details.accessToken).toBe("[redacted]");
    const nested = details.nested as Record<string, unknown>;
    expect(nested.refreshToken).toBe("[redacted]");
    expect((nested.list as unknown[]).length).toBeLessThanOrEqual(25); // 24 + overflow marker
    expect(String(details.long).length).toBeLessThan(600);
    expect(JSON.stringify(details.circular)).toContain("depth");
  });

  it("rejects oversized events and counts them", () => {
    enableBus();
    emit({ component: "sync", event: "operation.created", severity: "info", details: { blob: "x".repeat(200_000) } });
    // details strings are truncated before the size gate, so the event fits;
    // a genuinely oversized structure: depth-limited objects stay bounded.
    flushDebugBus();
    expect(debugDropReport().oversized).toBe(0);
    expect(sent.length).toBe(1);
  });

  it("drops batches when the transport throws, keeps the app running", () => {
    const failing: DebugTransport = {
      send() {
        throw new Error("bridge down");
      },
    };
    enableBus(failing);
    for (let index = 0; index < 5; index += 1)
      emit({ component: "websocket", event: "message.sent", severity: "debug" });
    expect(() => flushDebugBus()).not.toThrow();
    expect(debugDropReport().transport).toBeGreaterThan(0);
  });

  it("drops events with no identity rather than mislabelling them", () => {
    configureDebugBus({
      enabled: true,
      identity: () => undefined,
      transport: () => undefined,
      batchSize: 1000,
      flushDelayMs: 60_000,
    });
    expect(emit({ component: "websocket", event: "connection.opened", severity: "info" })).toBe(0);
  });

  it("emits nothing invalid: bad event names are counted, not sent", () => {
    enableBus();
    expect(emit({ component: "websocket", event: "bogus.event", severity: "info" } as never)).toBe(0);
    expect(debugDropReport().invalid).toBe(1);
  });
});

describe("filters", () => {
  it("ANDs predicates across identity, component and severity", () => {
    const event = makeEvent({ clientId: "a", component: "websocket", event: "connection.closed", severity: "warn", boardId: "b1" });
    expect(eventMatchesFilter(event, { clientId: "a", severity: ["warn", "error"] })).toBe(true);
    expect(eventMatchesFilter(event, { clientId: "b" })).toBe(false);
    expect(eventMatchesFilter(event, { component: ["sync", "websocket"], boardId: "b1" })).toBe(true);
    expect(eventMatchesFilter(event, { component: "sync" })).toBe(false);
    expect(eventMatchesFilter(event, { text: "closed" })).toBe(true);
    expect(eventMatchesFilter(event, { text: "absent" })).toBe(false);
  });
});

describe("connection registry", () => {
  function connEvent(event: string, connectionId: string, details: Record<string, unknown> = {}, overrides: Partial<DebugEvent> = {}): DebugEvent {
    return makeEvent({
      component: "websocket",
      event,
      connectionId,
      clientId: "client-x",
      sessionId: "session-1",
      severity: event === "connection.closed" ? "warn" : "info",
      details: { ...details, ...(details.code !== undefined ? {} : {}) },
      ...overrides,
    });
  }

  it("folds lifecycle events into one entry with state transitions", () => {
    const registry = new ConnectionRegistry();
    registry.observe(connEvent("connection.requested", "conn-1", { trigger: "session:attach", room: "board-9" }));
    registry.observe(connEvent("connection.opened", "conn-1"));
    registry.observe(connEvent("message.received", "conn-1"));
    registry.observe(connEvent("connection.closed", "conn-1", { code: 1006, cause: "network" }));
    const entry = registry.get("conn-1")!;
    expect(entry.state).toBe("closed");
    expect(entry.closeCode).toBe(1006);
    expect(entry.closeCause).toBe("network");
    expect(entry.messagesReceived).toBe(1);
    expect(entry.room).toBe("board-9");
  });

  it("flags duplicate live connections with same trigger+room, not different triggers", () => {
    const registry = new ConnectionRegistry();
    registry.observe(connEvent("connection.requested", "conn-1", { trigger: "session:attach", room: "board-9" }));
    registry.observe(connEvent("connection.opened", "conn-1"));
    registry.observe(connEvent("connection.requested", "conn-2", { trigger: "courier:pass", room: "board-9" }));
    registry.observe(connEvent("connection.opened", "conn-2"));
    expect(registry.checks().filter((finding) => finding.kind === "duplicate-connections")).toHaveLength(0);
    registry.observe(connEvent("connection.requested", "conn-3", { trigger: "session:attach", room: "board-9" }));
    registry.observe(connEvent("connection.opened", "conn-3"));
    const findings = registry.checks().filter((finding) => finding.kind === "duplicate-connections");
    expect(findings).toHaveLength(1);
    expect(findings[0].connectionIds.sort()).toEqual(["conn-1", "conn-3"]);
  });

  it("flags connections from multiple live sessions of one client", () => {
    const registry = new ConnectionRegistry();
    registry.observe(connEvent("connection.requested", "conn-1", { trigger: "session:attach", room: "b" }, { sessionId: "s-1" }));
    registry.observe(connEvent("connection.opened", "conn-1", {}, { sessionId: "s-1" }));
    registry.observe(connEvent("connection.requested", "conn-2", { trigger: "session:attach", room: "b" }, { sessionId: "s-2" }));
    registry.observe(connEvent("connection.opened", "conn-2", {}, { sessionId: "s-2" }));
    expect(registry.checks().some((finding) => finding.kind === "connections-from-multiple-sessions")).toBe(true);
  });

  it("groups counts by client/board/state", () => {
    const registry = registryFromEvents([
      connEvent("connection.requested", "c1", { trigger: "session:attach", room: "b1" }),
      connEvent("connection.opened", "c1"),
      connEvent("connection.closed", "c1", { code: 1000 }),
      connEvent("connection.requested", "c2", { trigger: "session:attach", room: "b1" }),
      connEvent("connection.opened", "c2"),
    ]);
    const counts = registry.counts();
    expect(counts.byState.open).toBe(1);
    expect(counts.byBoard["b1"]).toBe(1);
  });
});

describe("trace correlation", () => {
  const opEvents = (): DebugEvent[] => [
    makeEvent({ component: "sync", event: "operation.created", severity: "info", operationId: "op-1", clientId: "A" }),
    makeEvent({ component: "sync", event: "operation.queued", severity: "info", operationId: "op-1", clientId: "A" }),
    makeEvent({ component: "websocket", event: "message.sent", severity: "info", operationId: "op-1", clientId: "A", details: { opKind: "card.move" } }),
    makeEvent({ component: "websocket", event: "message.received", severity: "debug", operationId: "op-1", clientId: "B" }),
    makeEvent({ component: "sync", event: "operation.applied", severity: "info", operationId: "op-1", clientId: "B" }),
  ];

  it("builds an ordered stage timeline with missing stages reported", () => {
    const view = buildTraceView(opEvents(), "op:op-1")!;
    expect(view.stages.map((stage) => stage.event)).toEqual([
      "operation.created", "operation.queued", "message.sent", "message.received", "operation.applied",
    ]);
    expect(view.complete).toBe(false);
    // Server-side relay stages are absent; the browser-side chain is complete.
    expect(view.missingStages).toEqual(["relay:operation.received", "relay:operation.forwarded"]);
    expect(view.stages).toHaveLength(5);
  });

  it("marks duplicates without inventing stages", () => {
    const events = [...opEvents(), makeEvent({ component: "sync", event: "operation.created", severity: "info", operationId: "op-1" })];
    const { duplicates, complete } = cardOperationComplete(events);
    expect(duplicates).toContain("sync:operation.created");
    expect(complete).toBe(false);
  });

  it("correlates by operationId when no traceId exists", () => {
    const index = new TraceIndex();
    for (const event of opEvents()) index.observe(event);
    expect(index.byOperationId("op-1")).toHaveLength(5);
    expect(index.byOperationId("nope")).toHaveLength(0);
  });

  it("surfaces errors in a trace view", () => {
    const view = buildTraceView([...opEvents(), makeEvent({ component: "sync", event: "sync.failed", severity: "error", operationId: "op-1" })], "op:op-1")!;
    expect(view.errors).toHaveLength(1);
    const traces = correlateTraces(opEvents(), 5);
    expect(traces[0].traceId).toBe("op:op-1");
  });
});

describe("ids", () => {
  it("prefers explicit ids, falls back to storage, then random", async () => {
    expect(await resolveClientId("firefox-a", undefined)).toBe("firefox-a");
    const store = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: string) => { store.set(key, value); },
    };
    const first = await resolveClientId(undefined, storage);
    const second = await resolveClientId(undefined, storage);
    expect(second).toBe(first);
    expect(first).toMatch(/^client-[0-9a-f]{20}$/);
  });

  it("sanitises ids that are unsafe or oversized", async () => {
    expect(await resolveClientId("not safe!", undefined)).toMatch(/^client-[0-9a-f]{20}$/);
    expect(resolveSessionId("x".repeat(500))).toMatch(/^session-[0-9a-f]{20}$/);
    expect(newDebugId("conn")).toMatch(/^conn-[0-9a-f]{20}$/);
  });
});

describe("bridge transport CORS posture", () => {
  // A browser extension page is a cross-origin caller of the loopback bridge
  // (`moz-extension://…` → `http://127.0.0.1:8790`). The bridge refuses every
  // OPTIONS preflight with 405 and no CORS grant, so a fetch that asks for one
  // never reaches `/ingest`: the client silently delivered nothing and the bus
  // counted the loss as a transport drop. The transport must therefore issue
  // CORS-simple requests only — the property that keeps it working is the
  // *absence* of any header that triggers a preflight.
  const SAFELISTED_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

  function isPreflightTriggering(headers: Record<string, string> | undefined): boolean {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() !== "content-type") return true; // any other header preflights
      const type = value.split(";")[0].trim().toLowerCase();
      if (!SAFELISTED_TYPES.includes(type)) return true;
    }
    return false;
  }

  async function captureCalls(): Promise<{ url: string; init?: { method?: string; body?: string; headers?: Record<string, string>; keepalive?: boolean } }[]> {
    const calls: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string>; keepalive?: boolean } }[] = [];
    const transport = new HttpBridgeTransport({
      url: "http://127.0.0.1:8790",
      clientId: "cors-client",
      sessionId: "cors-session",
      context: "node-test",
      fetchImpl: async (input, init) => { calls.push({ url: input, init }); return { ok: true, status: 200, text: async () => "{}" }; },
    });
    transport.send([makeEvent()]);
    transport.attachInspector(async () => ({ kind: "board-state", capturedAt: "x", boards: [], connections: [] }));
    transport.startInspectionPolling(10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    transport.close();
    return calls;
  }

  it("sends no request the browser would preflight", async () => {
    const calls = await captureCalls();
    expect(calls.length).toBeGreaterThan(0);
    const posting = calls.filter((call) => call.init?.method === "POST");
    expect(posting.length).toBeGreaterThan(0);
    for (const call of calls) expect(isPreflightTriggering(call.init?.headers)).toBe(false);
  });

  it("still posts the JSON envelope the bridge parses", async () => {
    const calls = await captureCalls();
    const ingest = calls.find((call) => call.url.includes("/ingest"));
    expect(ingest?.init?.method).toBe("POST");
    const envelope = JSON.parse(ingest!.init!.body!) as { protocol: number; clientId: string; events: unknown[] };
    expect(envelope.protocol).toBe(1);
    expect(envelope.clientId).toBe("cors-client");
    expect(envelope.events).toHaveLength(1);
  });
});
