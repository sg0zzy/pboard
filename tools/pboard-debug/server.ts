#!/usr/bin/env node
/**
 * Live Debug Bridge — loopback HTTP + WebSocket server.
 *
 * Started by `npm run debug:bridge` (Node 24 type stripping runs this file
 * directly). Endpoints (see src/debug/protocol.ts):
 *
 *   POST /ingest               client telemetry batch
 *   GET  /inspect/request      client poll for a queued state inspection
 *   POST /inspect/respond      client answers an inspection
 *   GET  /fault/poll           mock-mode harness poll for fault commands
 *   GET  /status               bridge status
 *   GET  /events               history query (filter JSON + limit + after)
 *   GET  /events/subscribe     WebSocket live subscription (text frames)
 *   GET  /clients /sessions /connections /connections/checks
 *   GET  /trace?traceId= | ?operationId=
 *   GET  /traces               recent correlated traces
 *   POST /capture/start|stop   capture control; GET /captures, /captures/:id
 *   POST /capture/export       write a stopped capture to test-results/debug-traces
 *   GET  /inspect/:clientId    queue a live state inspection of a running client
 *   POST /command              fault injection (mock mode only)
 *
 * Security posture: binds 127.0.0.1 unless PBOARD_DEBUG_HOST says otherwise
 * (refuses non-loopback unless PBOARD_DEBUG_ALLOW_REMOTE=1, and logs loudly);
 * requires PBOARD_DEBUG_TOKEN on every request when set; rejects cross-origin
 * requests from anything that is not this machine's own origin set; no
 * wildcard CORS anywhere.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { DebugBridgeCore, BRIDGE_VERSION } from "./core.ts";
import { parseEventFilter, BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT, type EventQuery } from "../../src/debug/protocol.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

interface StartOptions {
  host?: string;
  port?: number;
  token?: string;
  mode?: "mock" | "local" | "production-observer";
  environment?: string;
  maxEvents?: number;
  captureDir?: string;
  quiet?: boolean;
}

export function startBridge(options: StartOptions = {}) {
  const host = options.host ?? process.env.PBOARD_DEBUG_HOST ?? BRIDGE_DEFAULT_HOST;
  const port = options.port ?? Number(process.env.PBOARD_DEBUG_PORT ?? BRIDGE_DEFAULT_PORT);
  const allowRemote = process.env.PBOARD_DEBUG_ALLOW_REMOTE === "1";
  if (!isLoopbackHost(host) && !allowRemote) {
    console.error(`pboard-debug: refusing to bind ${host}; set PBOARD_DEBUG_ALLOW_REMOTE=1 to override intentionally`);
    process.exit(1);
  }
  if (!isLoopbackHost(host))
    console.warn(`pboard-debug: EXPOSED on ${host} — diagnostic traffic is unencrypted; only do this on a trusted network`);

  const core = new DebugBridgeCore({
    ...(options.token || process.env.PBOARD_DEBUG_TOKEN ? { token: options.token ?? process.env.PBOARD_DEBUG_TOKEN } : {}),
    ...(options.mode ? { mode: options.mode } : process.env.PBOARD_DEBUG_MODE ? { mode: process.env.PBOARD_DEBUG_MODE as "mock" | "local" | "production-observer" } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.maxEvents ? { maxEvents: options.maxEvents } : {}),
    ...(options.captureDir ? { captureDir: options.captureDir } : {}),
  });

  const server = createServer((request, response) => {
    void handle(core, request, response);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/events/subscribe") {
      socket.destroy();
      return;
    }
    if (!authorized(core, request, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => attachSubscriber(core, client, url));
  });

  const listening = new Promise<{ host: string; port: number }>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? { host: address.address, port: address.port } : { host, port };
      core.boundPort = bound.port;
      if (!options.quiet)
        console.log(`pboard-debug bridge ${BRIDGE_VERSION} on http://${bound.host}:${bound.port} (mode ${core.mode}, schema v1)`);
      resolvePromise(bound);
    });
  });

  return {
    core,
    server,
    listening,
    async close(): Promise<void> {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function authorized(core: DebugBridgeCore, request: IncomingMessage, url: URL): boolean {
  if (!core.tokenRequired) return true;
  const header = request.headers["x-pboard-debug-token"];
  const presented = typeof header === "string" ? header : url.searchParams.get("token");
  return core.checkToken(presented);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectPromise);
  });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const origin = allowedOrigin(response.req);
  if (origin) headers["access-control-allow-origin"] = origin;
  response.writeHead(status, headers);
  response.end(body);
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

/** Same-origin posture: allow no-origin tooling (curl, node fetch, MCP stdio
 * process) and browser clients whose origin host is loopback; everything else
 * is rejected. No wildcard CORS headers are ever emitted.
 *
 * Extension pages (`moz-extension://…`, `chrome-extension://…`) must be
 * allowed explicitly: the MV3 background's fetch to the bridge is a CORS-mode
 * request, and the extension origin is the *developer's own local install*.
 * The origin is echoed back (never `*`), only for the simple requests the SDK
 * makes — preflighted requests are still refused, keeping the channel
 * debug-token-in-query/simple-headers by design. */
function allowedOrigin(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin;
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    if (isLoopbackHost(url.hostname)) return origin;
    if (url.protocol === "moz-extension:" || url.protocol === "chrome-extension:") return origin;
    return undefined;
  } catch {
    return undefined;
  }
}

function originAllowed(request: IncomingMessage): boolean {
  return request.headers.origin === undefined || allowedOrigin(request) !== undefined;
}

async function handle(core: DebugBridgeCore, request: IncomingMessage, response: ServerResponse): Promise<void> {

  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = request.method ?? "GET";
  if (method === "OPTIONS") {
    // Deliberately no CORS grant: the extension POSTs a CORS-simple request
    // without preflight; anything prompting a preflight is not our client.
    response.writeHead(405).end();
    return;
  }
  if (!originAllowed(request)) {
    json(response, 403, { error: "cross-origin requests are not allowed" });
    return;
  }
  if (!authorized(core, request, url)) {
    json(response, 401, { error: "missing or invalid debug token" });
    return;
  }

  try {
    if (method === "POST" && path === "/ingest") {
      const raw = await readBody(request);
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        json(response, 400, { error: "ingest body must be JSON" });
        return;
      }
      json(response, 200, core.ingest(envelope, Buffer.byteLength(raw)));
      return;
    }
    if (method === "GET" && path === "/inspect/request") {
      const clientId = url.searchParams.get("clientId");
      if (!clientId) return json(response, 400, { error: "clientId required" });
      const pending = core.pollInspection(clientId);
      json(response, 200, pending ?? {});
      return;
    }
    if (method === "POST" && path === "/inspect/respond") {
      const clientId = url.searchParams.get("clientId");
      if (!clientId) return json(response, 400, { error: "clientId required" });
      const body = JSON.parse(await readBody(request)) as { requestId?: string; snapshot?: unknown };
      if (typeof body.requestId !== "string") return json(response, 400, { error: "requestId required" });
      json(response, 200, { ok: core.respondInspection(clientId, body.requestId, body.snapshot) });
      return;
    }
    if (method === "GET" && path === "/fault/poll") {
      const clientId = url.searchParams.get("clientId");
      if (!clientId) return json(response, 400, { error: "clientId required" });
      json(response, 200, { commands: core.pollFaults(clientId) });
      return;
    }
    if (method === "GET" && path === "/status") return json(response, 200, core.status());
    if (method === "GET" && path === "/events") {
      const query: EventQuery = {
        ...(parseEventFilter(url.searchParams.get("filter")) ?? {}),
        ...(url.searchParams.get("after") ? { after: url.searchParams.get("after")! } : {}),
        ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
      };
      json(response, 200, core.queryEvents(query));
      return;
    }
    if (method === "GET" && path === "/clients") return json(response, 200, [...core.clients.values()]);
    if (method === "GET" && path === "/sessions") {
      const sessions = new Map<string, { clientId: string; firstSeen: string; lastSeen: string }>();
      for (const client of core.clients.values())
        for (const sessionId of client.sessionIds) {
          const existing = sessions.get(sessionId);
          if (!existing) sessions.set(sessionId, { clientId: client.clientId, firstSeen: client.firstSeen, lastSeen: client.lastSeen });
          else existing.lastSeen = client.lastSeen;
        }
      json(response, 200, [...sessions.entries()].map(([sessionId, info]) => ({ sessionId, ...info })));
      return;
    }
    if (method === "GET" && path === "/connections") {
      const filter = parseEventFilter(url.searchParams.get("filter"));
      json(response, 200, { connections: core.registry.list(filter ?? undefined), counts: core.registry.counts() });
      return;
    }
    if (method === "GET" && path === "/connections/checks") {
      const clientId = url.searchParams.get("clientId") ?? undefined;
      json(response, 200, { findings: core.connectionFindings(clientId), counts: core.registry.counts() });
      return;
    }
    if (method === "GET" && (path === "/trace" || path === "/traces")) {
      if (path === "/traces") return json(response, 200, core.recentTraces(Number(url.searchParams.get("limit") ?? 10)));
      const traceId = url.searchParams.get("traceId");
      const operationId = url.searchParams.get("operationId");
      const view = traceId ? core.traceFor(traceId) : operationId ? core.traceFor(`op:${operationId}`) : undefined;
      return view ? json(response, 200, view) : json(response, 404, { error: "trace not found" });
    }
    if (path === "/captures" && method === "GET") return json(response, 200, core.listCaptures());
    if (path.startsWith("/captures/") && method === "GET") {
      const capture = core.getCapture(path.slice("/captures/".length));
      return capture ? json(response, 200, capture) : json(response, 404, { error: "capture not found" });
    }
    if (method === "POST" && path === "/capture/start") {
      const body = await optionalJson(request);
      json(response, 200, core.startCapture(body));
      return;
    }
    if (method === "POST" && path === "/capture/stop") {
      const body = await optionalJson(request);
      const capture = core.stopCapture(typeof body.failureSummary === "string" ? body.failureSummary : undefined);
      json(response, capture ? 200 : 404, capture ? core.captureSummary(capture) : { error: "no active capture" });
      return;
    }
    if (method === "POST" && path === "/capture/export") {
      const body = await optionalJson(request);
      const id = typeof body.captureId === "string" ? body.captureId : "";
      const written = core.writeCapture(id);
      json(response, written ? 200 : 404, written ?? { error: "capture not found" });
      return;
    }
    if (method === "POST" && path === "/command") {
      const body = await optionalJson(request);
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      const action = typeof body.action === "string" ? body.action : "";
      if (!clientId || !action) return json(response, 400, { error: "clientId and action required" });
      const queued = core.queueFault(clientId, action, body.args as Record<string, unknown> | undefined);
      json(response, "error" in queued ? 403 : 200, queued);
      return;
    }
    if (method === "GET" && path.startsWith("/inspect/")) {
      const clientId = decodeURIComponent(path.slice("/inspect/".length));
      const scope = url.searchParams.get("scope") ?? undefined;
      const snapshot = await core.requestInspection(clientId, scope);
      json(response, snapshot ? 200 : 504, snapshot ?? { error: `no client "${clientId}" answered within the timeout — is Pboard running with the bridge enabled?` });
      return;
    }
    if (method === "GET" && path === "/") {
      text(response, 200, `pboard-debug bridge ${BRIDGE_VERSION}\nGET /status /clients /sessions /connections /connections/checks /events /trace /traces /captures\nPOST /ingest /capture/start /capture/stop /capture/export /command\nws   /events/subscribe\n`);
      return;
    }
    if (path.startsWith("/dashboard") || path === "/ui" || path === "/ui/") {
      // Dashboard is served from /ui when present; static file response below.
      return serveStatic(response);
    }
    if (path.startsWith("/ui/")) return serveStatic(response);
    json(response, 404, { error: "unknown endpoint" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function optionalJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function serveStatic(response: ServerResponse): void {
  // Dashboard: a single static HTML file, read on demand so editing it needs
  // no restart. Falls back to a pointer when the file is absent.
  import("node:fs").then(({ existsSync, readFileSync }) => {
    const file = new URL("./dashboard.html", import.meta.url);
    if (existsSync(file)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(readFileSync(file, "utf8"));
    } else {
      text(response, 404, "dashboard.html not found beside the bridge");
    }
  });
}

function attachSubscriber(core: DebugBridgeCore, client: WebSocket, url: URL): void {
  const filter = parseEventFilter(url.searchParams.get("filter"));
  const id = Math.random().toString(36).slice(2);
  let queue = "";
  let interest = 0;
  const subscription = {
    id,
    ...(filter ? { filter } : {}),
    deliver: (frame: string): boolean => {
      // Bounded per-subscription backlog: a consumer that stops reading is
      // dropped, and dropping is reported honestly via the closing frame.
      if (client.readyState !== WebSocket.OPEN) return false;
      interest += 1;
      if (interest > 4_000) {
        client.send(JSON.stringify({ type: "dropped", reason: "consumer too slow" }));
        client.close(1013, "too slow");
        return false;
      }
      queue += frame;
      if (interest % 32 === 0) {
        client.send(queue);
        queue = "";
      }
      return true;
    },
  };
  if (!core.addSubscription(subscription)) {
    client.close(1013, "subscription limit reached");
    return;
  }
  client.send(JSON.stringify({ type: "welcome", status: core.status(), cursor: core.latestCursor(), filter: filter ?? null }));
  const flush = setInterval(() => {
    if (queue && client.readyState === WebSocket.OPEN) {
      client.send(queue);
      queue = "";
    }
  }, 120);
  client.on("message", (data) => {
    try {
      const message = JSON.parse(String(data)) as { type?: string; filter?: unknown };
      if (message.type === "ping") client.send(JSON.stringify({ type: "pong" }));
      if (message.type === "subscribe" && message.filter && typeof message.filter === "object")
        subscription.filter = message.filter as never;
      if (message.type === "unsubscribe") {
        core.removeSubscription(id);
        client.close(1000, "unsubscribed");
      }
    } catch {
      /* malformed control frames are ignored; the channel stays open */
    }
  });
  client.on("close", () => {
    clearInterval(flush);
    core.removeSubscription(id);
  });
  client.on("error", () => {
    clearInterval(flush);
    core.removeSubscription(id);
  });
}

// CLI entry: `node tools/pboard-debug/server.ts`
const invokedAsMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedAsMain) {
  const handle = startBridge();
  process.on("SIGINT", () => void handle.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void handle.close().then(() => process.exit(0)));
}
