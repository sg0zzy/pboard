/**
 * Integration tests for the Debug Bridge: core semantics plus the real HTTP
 * surface on loopback. Everything runs in-process (port 0); nothing leaves
 * loopback and no browser is required.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { startBridge } from "../tools/pboard-debug/server";
import { DebugBridgeCore } from "../tools/pboard-debug/core";
import type { IngestEnvelope } from "../src/debug/protocol";

let bridge: { core: DebugBridgeCore; close: () => Promise<void>; url: string; server: Server };
const TOKEN = "test-token-123";

function envelope(clientId: string, events: unknown[]): IngestEnvelope {
  return { protocol: 1, clientId, sessionId: "session-1", context: "test", events } as IngestEnvelope;
}

function eventAt(index: number, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    timestamp: new Date(1_700_000_000_000 + index * 10).toISOString(),
    sequenceNumber: index + 1,
    component: "websocket",
    event: "connection.opened",
    severity: "info",
    ...overrides,
  };
}

async function api(path: string, init?: { method?: string; body?: unknown; token?: string | null; origin?: string }): Promise<{ status: number; body: any; headers: Headers }> {
  const url = new URL(`${bridge.url}${path}`);
  const token = init && "token" in init ? init.token : TOKEN;
  if (token) url.searchParams.set("token", token);
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    ...(init?.origin ? { headers: { origin: init.origin } } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON responses keep their text */
  }
  return { status: response.status, body, headers: response.headers };
}

beforeAll(async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "pboard-debug-test-"));
  const handle = startBridge({ host: "127.0.0.1", port: 0, token: TOKEN, mode: "mock", quiet: true, captureDir });
  const bound = await handle.listening;
  bridge = { core: handle.core, close: handle.close, url: `http://127.0.0.1:${bound.port}`, server: handle.server };
});

afterAll(async () => {
  await bridge?.close();
});

describe("bridge HTTP surface", () => {
  it("requires the token and rejects cross-origin requests, echoing allowed origins", async () => {
    expect((await api("/status", { token: null })).status).toBe(401);
    expect((await api("/status", { token: "wrong-token" })).status).toBe(401);
    expect((await api("/status")).status).toBe(200);

    const forbidden = await api("/status", { origin: "https://evil.example" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("access-control-allow-origin")).toBeNull();

    // Extension origins get their own origin echoed (never `*`).
    const extension = await api("/status", { origin: "moz-extension://test-uuid" });
    expect(extension.status).toBe(200);
    expect(extension.headers.get("access-control-allow-origin")).toBe("moz-extension://test-uuid");

    // No wildcard ever.
    const plain = await api("/status");
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();

    // Preflight is refused outright (the SDK never triggers one).
    const preflight = await fetch(`${bridge.url}/ingest?token=${TOKEN}`, { method: "OPTIONS" });
    expect(preflight.status).toBe(405);
  });

  it("ingests valid events, stamps ordering, and rejects invalid and spoofed ones", async () => {
    const mixed = await api("/ingest", {
      method: "POST",
      body: envelope("client-a", [
        eventAt(0),
        eventAt(1, { event: "not.a.registered.event" }), // unregistered
        eventAt(2, { clientId: "client-victim" }), // spoofing another identity
        eventAt(3, { schemaVersion: 99 }), // wrong protocol
      ]),
    });
    expect(mixed.status).toBe(200);
    expect(mixed.body).toMatchObject({ ok: false, accepted: 1, rejected: 3 });

    const query = await api(`/events?${new URLSearchParams({ filter: JSON.stringify({ clientId: "client-a" }) })}`);
    expect(query.body.events).toHaveLength(1);
    const stored = query.body.events[0];
    expect(typeof stored.bridgeSeq).toBe("number");
    expect(typeof stored.receivedAt).toBe("string");
    expect(stored.clientId ?? "client-a").toBe("client-a");
  });

  it("pages with numeric cursors and honours filters", async () => {
    const many = Array.from({ length: 5 }, (_, index) => eventAt(100 + index, { component: "sync", event: "operation.created", boardId: "board-page" }));
    await api("/ingest", { method: "POST", body: envelope("client-pages", many) });

    const all = await api(`/events?${new URLSearchParams({ filter: JSON.stringify({ boardId: "board-page" }), limit: "10" })}`);
    expect(all.body.events.length).toBeGreaterThanOrEqual(5);
    const seqs = all.body.events.map((event: { bridgeSeq: number }) => event.bridgeSeq);
    // Dense numeric cursors within one ingest run.
    expect(seqs.slice(1).every((seq: number, index: number) => seq === seqs[index] + 1)).toBe(true);
    // `limit` is a tail window (newest N), and `after` continues from a
    // cursor exactly — the contract MCP `watch_events` polls with.
    const tail = await api(`/events?${new URLSearchParams({ filter: JSON.stringify({ boardId: "board-page" }), limit: "2" })}`);
    expect(tail.body.events.map((event: { bridgeSeq: number }) => event.bridgeSeq)).toEqual(seqs.slice(-2));
    const resumed = await api(`/events?${new URLSearchParams({ filter: JSON.stringify({ boardId: "board-page" }), after: String(seqs[1]), limit: "10" })}`);
    expect(resumed.body.events.map((event: { bridgeSeq: number }) => event.bridgeSeq)).toEqual(seqs.slice(2));
    expect(resumed.body.nextCursor).toBe(String(seqs[seqs.length - 1]));
  });

  it("reports connection findings for orphaned sockets via the registry", async () => {
    const connectionId = "conn-orphan-test";
    // Orphan = open, no room/board, no ownership record.
    await api("/ingest", {
      method: "POST",
      body: envelope("client-orphan", [
        eventAt(200, { component: "websocket", event: "connection.requested", connectionId, details: { trigger: "log-session" } }),
        eventAt(201, { component: "websocket", event: "connection.opened", connectionId, details: { trigger: "log-session" } }),
      ]),
    });
    const checks = await api(`/connections/checks?clientId=client-orphan`);
    expect(checks.status).toBe(200);
    const orphaned = checks.body.findings.filter((finding: { kind: string }) => finding.kind === "orphaned-connection");
    expect(orphaned.length).toBe(1);
    expect(orphaned[0].connectionIds).toContain(connectionId);
  });

  it("runs the capture lifecycle and exports a parseable v1 file", async () => {
    const started = await api("/capture/start", { method: "POST", body: { label: "test-capture", seed: "seed-1" } });
    expect(started.status).toBe(200);
    const captureId = started.body.captureId;

    await api("/ingest", { method: "POST", body: envelope("client-capture", [eventAt(300, { component: "sync", event: "operation.applied", traceId: "trace-capture" })]) });
    const stopped = await api("/capture/stop", { method: "POST", body: {} });
    expect(stopped.status).toBe(200);
    expect(stopped.body.events).toBeGreaterThanOrEqual(1);

    const exported = await api("/capture/export", { method: "POST", body: { captureId } });
    expect(exported.status).toBe(200);
    expect(typeof exported.body.path).toBe("string");

    const listed = await api("/captures");
    expect(listed.body.some((entry: { captureId?: string }) => entry.captureId === captureId)).toBe(true);
  });

  it("refuses fault injection outside mock mode", () => {
    const production = new DebugBridgeCore({ mode: "production-observer", token: "t" });
    const refused = production.queueFault("client-x", "drop-ack");
    expect("error" in refused ? refused.error : "").toMatch(/not available in mode|mock/i);
    const mock = new DebugBridgeCore({ mode: "mock" });
    expect(mock.queueFault("client-x", "drop-ack")).toMatchObject({ id: expect.any(String) });
    expect(mock.pollFaults("client-x")).toHaveLength(1);
    expect(mock.pollFaults("client-x")).toHaveLength(0);
  });

  it("bounds the event ring and counts overflow", () => {
    const small = new DebugBridgeCore({ maxEvents: 10 });
    for (let index = 0; index < 25; index += 1)
      small.ingest(envelope("ring-client", [eventAt(400 + index, { component: "sync", event: "operation.created" })]));
    const events = small.queryEvents({ limit: 100 }).events;
    expect(events).toHaveLength(10);
    // Oldest are gone: the retained sequence window is the newest 10.
    const sequences = events.map((event: { sequenceNumber: number }) => event.sequenceNumber);
    // eventAt(400+index) numbers the 25 events 401..425; the ring keeps the
    // newest 10.
    expect(sequences[0]).toBe(401 + 15);
    expect(sequences[9]).toBe(425);
    expect(small.status()).toMatchObject({ droppedByOverflow: 15, eventBufferCapacity: 10 });
  });

  it("serves the pull-based inspection round trip through the core", async () => {
    const core = new DebugBridgeCore();
    core.ingest(envelope("inspected-client", [eventAt(500)]));
    const pending = core.requestInspection("inspected-client", undefined, 5_000);
    const request = core.pollInspection("inspected-client");
    expect(request?.requestId).toBeTruthy();
    expect(core.respondInspection("inspected-client", request!.requestId, { kind: "board-state", boards: [] })).toBe(true);
    await expect(pending).resolves.toMatchObject({ kind: "board-state" });
    // Unknown client times out to undefined (the HTTP layer maps it to 504).
    await expect(core.requestInspection("nobody-here", undefined, 40)).resolves.toBeUndefined();
  });

  it("answers the inspection HTTP round trip for a polling fake client", async () => {
    const roundTrip = api(`/inspect/client-inspect-me`);
    // Drain the queued request the way the browser transport does, then let
    // the waiter answer.
    let poll: { requestId?: string } = {};
    const deadline = Date.now() + 5_000;
    // Real-timer retry: the queued inspection becomes pollable only after
    // the concurrent HTTP request reaches the server — integration against
    // a live socket, so condition-polling is the deterministic option here.
    while (!poll.requestId && Date.now() < deadline) {
      poll = (await api(`/inspect/request?clientId=client-inspect-me`)).body;
      if (!poll.requestId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(poll.requestId).toBeTruthy();
    await api(`/inspect/respond?clientId=client-inspect-me`, { method: "POST", body: { requestId: poll.requestId, snapshot: { kind: "sync-state", boards: [{ boardId: "b1" }] } } });
    const answered = await roundTrip;
    expect(answered.status).toBe(200);
    // The snapshot echoes what the fake client answered with; the bridge
    // keeps the requester's client id in its own bookkeeping, not the body.
    expect(answered.body).toMatchObject({ kind: "sync-state" });
  });
});

describe("keep-alive posture for browser clients", () => {
  // The browser pools a keep-alive socket and reuses it for the 3 s inspector
  // poll and the ingest flush. Whoever closes an idle socket first decides
  // whether a pooled entry can be stale: if the bridge closes it (Node's 5 s
  // default), Firefox reuses the dead entry once, the request dies at the
  // transport with no status and no headers, and the console reports it as
  // "Cross-Origin Request Blocked … CORS request did not succeed" — a
  // CORS-shaped message for a keep-alive race that the bridge never sees,
  // because the request never arrives. The bridge must therefore outlast any
  // browser's own idle timeout so the *client* is always the closer.
  const BROWSER_IDLE_MS = { firefox: 115_000, chromium: 300_000 };

  it("keeps idle connections open longer than any browser does", () => {
    expect(bridge.server.keepAliveTimeout).toBeGreaterThan(BROWSER_IDLE_MS.firefox);
    // Node cuts a request whose headers stall before this; it must not undercut
    // the socket lifetime, or a slow loopback request is truncated instead.
    expect(bridge.server.headersTimeout).toBeGreaterThan(bridge.server.keepAliveTimeout);
    expect(bridge.server.requestTimeout).toBeGreaterThanOrEqual(bridge.server.keepAliveTimeout);
  });

  it("survives a pooled socket idling past Node's default keep-alive window", async () => {
    // A raw socket, because this is about the connection, not the request: an
    // HTTP client library would silently reconnect and hide the regression.
    const net = await import("node:net");
    const port = Number(new URL(bridge.url).port);
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
    const readOne = () => new Promise<string>((resolve, reject) => {
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        if (!buffer.includes("\r\n\r\n")) return;
        socket.off("data", onData);
        resolve(buffer);
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("bridge closed the idle socket")));
    });
    try {
      socket.write(`GET /status?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: moz-extension://keepalive-test\r\nConnection: keep-alive\r\n\r\n`);
      expect((await readOne()).split("\r\n")[0]).toContain("200");
      // The window that used to break it: Node's 5 s default has long expired,
      // while a browser would still consider this socket reusable.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(socket.destroyed).toBe(false);
      socket.write(`GET /status?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: moz-extension://keepalive-test\r\nConnection: keep-alive\r\n\r\n`);
      const second = await readOne();
      expect(second.split("\r\n")[0]).toContain("200");
      expect(second.toLowerCase()).toContain("access-control-allow-origin: moz-extension://keepalive-test");
    } finally {
      socket.destroy();
    }
  }, 20_000);
});
