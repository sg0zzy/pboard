#!/usr/bin/env node
/**
 * Pboard Debug Bridge — MCP server (stdio).
 *
 * Speaks the Model Context Protocol over stdio and proxies the read-only
 * (plus explicitly-flagged test-control) surface of the local Debug Bridge.
 * Designed to be spawned by an MCP client (OMP, Codex, Qwen agents) with:
 *
 *   { "mcpServers": { "pboard-debug": { "command": "npm",
 *       "args": ["run", "--silent", "debug:mcp"] } } }
 *
 * Environment:
 *   PBOARD_DEBUG_URL    bridge base URL (default http://127.0.0.1:8790)
 *   PBOARD_DEBUG_TOKEN  shared token when the bridge requires one
 *   PBOARD_DEBUG_AUTO_START=1  spawn the bridge locally if none is answering
 *
 * Design rules (docs/debugging/mcp-tools.md mirrors this):
 *  - Every read tool is bounded (limit defaults, response caps, truncation
 *    flags). Nothing here sends raw board content: only presence/counts/
 *    identity fields, by construction of the client snapshots.
 *  - Mutating tools exist only for test control (`pboard_debug_run_scenario`,
 *    `pboard_debug_start_capture` …) and are refused by the bridge outside
 *    mock/local mode for fault commands; production-observer sessions cannot
 *    inject faults (the bridge enforces this, not just the tool list).
 *  - No streaming assumption: `pboard_debug_watch_events` blocks for a bounded
 *    window and returns a cursor; the cursor makes polling reliable for any
 *    MCP client.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  DEBUG_SCHEMA_VERSION,
  DEBUG_COMPONENTS,
  DEBUG_SEVERITIES,
  DEBUG_EVENTS,
  CARD_OPERATION_TRACE_STAGES,
} from "../../src/debug/schema.ts";
import { listScenarios, runScenario } from "./harness.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = (process.env.PBOARD_DEBUG_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
const TOKEN = process.env.PBOARD_DEBUG_TOKEN?.trim() ?? "";
const AUTO_START = process.env.PBOARD_DEBUG_AUTO_START === "1";
const REQUEST_TIMEOUT_MS = 25_000;
/** Hard response cap: the MCP client contract says bounded output. */
const MAX_EVENTS_PER_RESPONSE = 400;

let bridgeProcess: ChildProcess | undefined;

function bridgeUrl(path: string, query: Record<string, string | number | undefined> = {}): string {
  const url = new URL(path, BRIDGE_URL);
  if (TOKEN) url.searchParams.set("token", TOKEN);
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}

async function bridgeFetch(path: string, init: RequestInit = {}, query: Record<string, string | number | undefined> = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(bridgeUrl(path, query), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bridgeJson(path: string, init: RequestInit = {}, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
  const response = await bridgeFetch(path, init, query);
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      /* keep raw */
    }
    throw new Error(`bridge ${response.status}: ${detail}`);
  }
  return JSON.parse(text);
}

async function ensureBridge(): Promise<string | undefined> {
  try {
    await bridgeFetch("/status");
    return undefined;
  } catch (error) {
    if (!AUTO_START)
      return `No Debug Bridge answering on ${BRIDGE_URL} (${error instanceof Error ? error.message : String(error)}). Start it with \`npm run debug:bridge\`, or set PBOARD_DEBUG_AUTO_START=1 to spawn it automatically.`;
    bridgeProcess = spawn(process.execPath, [resolve("tools/pboard-debug/server.ts")], {
      stdio: ["ignore", "ignore", "inherit"],
      env: process.env,
    });
    bridgeProcess.on("exit", () => {
      bridgeProcess = undefined;
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      try {
        await bridgeFetch("/status");
        return undefined;
      } catch {
        /* keep waiting */
      }
    }
    return `Started a bridge but it never answered on ${BRIDGE_URL}`;
  }
}

function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 1).slice(0, 200_000) }] };
}

function errorText(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const filterSchema = z.object({
  clientId: z.string().optional().describe("exact client id (see pboard_debug_list_clients)"),
  context: z.string().optional().describe("execution context: background | sidebar | node"),
  component: z.union([z.string(), z.array(z.string())]).optional()
    .describe("debug | websocket | auth | sync | persistence | drive | lifecycle | relay | harness"),
  event: z.union([z.string(), z.array(z.string())]).optional().describe("exact event name(s), e.g. operation.applied"),
  severity: z.array(z.enum(["debug", "info", "warn", "error"])).optional(),
  traceId: z.string().optional(),
  operationId: z.string().optional(),
  connectionId: z.string().optional(),
  boardId: z.string().optional(),
  sessionId: z.string().optional(),
  text: z.string().optional().describe("substring match against event name and string detail values"),
}).strict();

const server = new McpServer({ name: "pboard-debug", version: "1.0.0" });

/** `registerTool` in the shape every registration here uses (name,
 * description, zod input shape, handler). Inferred generics keep each
 * handler's `args` typed from its own shape. */
function defineTool<S extends Record<string, z.ZodTypeAny>>(name: string, description: string, inputSchema: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown> | ReturnType<typeof text>) {
  server.registerTool(name, { description, inputSchema: inputSchema as never }, handler as never);
}

async function guarded<T>(work: () => Promise<T>): Promise<ReturnType<typeof text> | { content: { type: "text"; text: string }[]; isError: true }> {
  const note = await ensureBridge();
  if (note) return errorText(note);
  try {
    return text(await work());
  } catch (error) {
    return errorText(error instanceof Error ? error.message : String(error));
  }
}

// --- Discovery --------------------------------------------------------------

defineTool("pboard_debug_get_status", "Debug Bridge self-status: buffer occupancy, drop counters, mode, connected client count, schema version. Call this first to confirm the bridge is healthy.", {},
  () => guarded(() => bridgeJson("/status")));

defineTool("pboard_debug_list_clients", "Every diagnostic client (Firefox profile, harness process, relay observer) that has sent events, with contexts, sessions, event counts and last-seen time.", {},
  () => guarded(() => bridgeJson("/clients")));

defineTool("pboard_debug_list_sessions", "Sessions (one per client boot/reload) across all clients, with first/last-seen times. Several live sessions of one client with open connections is the reload-leak signal.", {},
  () => guarded(() => bridgeJson("/sessions")));

defineTool("pboard_debug_list_connections", "Connection registry: every WebSocket the instrumented runtimes dialled, with owning client, trigger (session:attach, courier:pass, …), room, state, close code/cause, message counts. Optionally filtered.",
  { filter: filterSchema.optional() },
  (args) => guarded(() => bridgeJson("/connections", {}, args.filter ? { filter: JSON.stringify(args.filter) } : {})));

// --- Live observation ---------------------------------------------------------

defineTool("pboard_debug_get_events", "Query the bounded event history. Filters AND together. Results are oldest-first, capped at 400; `nextCursor` + `after` pages forward, `bufferOverflown` says if the window lost history the caller never saw.",
  {
    filter: filterSchema.optional(),
    after: z.string().optional().describe("cursor from a previous call (forward-only)"),
    limit: z.number().int().min(1).max(MAX_EVENTS_PER_RESPONSE).optional(),
  },
  (args) => guarded(() => bridgeJson("/events", {}, {
    ...(args.filter ? { filter: JSON.stringify(args.filter) } : {}),
    ...(args.after ? { after: args.after } : {}),
    limit: Math.min(args.limit ?? MAX_EVENTS_PER_RESPONSE, MAX_EVENTS_PER_RESPONSE),
  })));

defineTool("pboard_debug_watch_events", "Wait up to `waitMs` (default 5000, max 30000) for events after `after` (a cursor; omit for 'now'), then return them with a fresh cursor. Works with any MCP client: no streaming notifications required; re-call with the returned cursor to keep watching.",
  {
    after: z.string().optional(),
    waitMs: z.number().int().min(0).max(30_000).optional(),
    pollMs: z.number().int().min(200).max(5_000).optional(),
    filter: filterSchema.optional(),
  },
  async (args) => guarded(async () => {
    const waitMs = args.waitMs ?? 5_000;
    const pollMs = args.pollMs ?? 750;
    // Start from "now" when the caller gave no cursor: the status response
    // carries the buffer's current end cursor.
    const status = await bridgeJson("/status") as { latestCursor: number };
    let cursor = args.after ?? String(status.latestCursor);
    const started = Date.now();
    for (;;) {
      const result = await bridgeJson("/events", {}, {
        ...(args.filter ? { filter: JSON.stringify(args.filter) } : {}),
        after: cursor,
        limit: MAX_EVENTS_PER_RESPONSE,
      }) as { events: unknown[] };
      if (result.events.length > 0 || Date.now() - started >= waitMs) return result;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }));

defineTool("pboard_debug_get_errors", "Warnings and errors from the recent window, grouped by event name with one example each. The fast 'what is going wrong' question.",
  { clientId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  (args) => guarded(async () => {
    const result = await bridgeJson("/events", {}, {
      filter: JSON.stringify({ severity: ["warn", "error"], ...(args.clientId ? { clientId: args.clientId } : {}) }),
      limit: MAX_EVENTS_PER_RESPONSE,
    }) as { events: Record<string, unknown>[] };
    const grouped = new Map<string, { count: number; example: unknown; lastSeen: string }>();
    for (const event of result.events) {
      const key = `${event.component}:${event.event}`;
      const existing = grouped.get(key);
      grouped.set(key, {
        count: (existing?.count ?? 0) + 1,
        example: event,
        lastSeen: String(event.receivedAt ?? ""),
      });
    }
    return {
      total: result.events.length,
      groups: [...grouped.entries()]
        .map(([event, info]) => ({ event, ...info }))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .slice(0, args.limit ?? 50),
    };
  }));

defineTool("pboard_debug_get_connection_history", "One connection's whole life: lifecycle events in order, ownership transitions, and what the registry concluded about it.",
  { connectionId: z.string() },
  (args) => guarded(async () => {
    const events = await bridgeJson("/events", {}, { filter: JSON.stringify({ connectionId: args.connectionId }), limit: MAX_EVENTS_PER_RESPONSE }) as { events: unknown[] };
    const connections = await bridgeJson("/connections", {}, { filter: JSON.stringify({ connectionId: args.connectionId }) }) as { connections: unknown[] };
    return { connection: connections.connections[0] ?? null, events: events.events };
  }));

// --- Synchronization ------------------------------------------------------------

defineTool("pboard_debug_get_sync_state", "Current synchronization state as observed from events: per board, the latest sync.state / sync.completed / sync.failed, cursor phase, pending count. Live RxDB truth comes from pboard_debug_get_board_state instead.",
  { boardId: z.string().optional() },
  (args) => guarded(async () => {
    const events = await bridgeJson("/events", {}, {
      filter: JSON.stringify({ component: "sync", event: ["sync.state", "sync.completed", "sync.failed"], ...(args.boardId ? { boardId: args.boardId } : {}) }),
      limit: MAX_EVENTS_PER_RESPONSE,
    }) as { events: Record<string, unknown>[] };
    const latest = new Map<string, Record<string, unknown>>();
    for (const event of events.events) {
      const key = `${event.clientId}/${event.boardId}`;
      if (!latest.has(key)) latest.set(key, event);
    }
    return { boards: [...latest.values()] };
  }));

defineTool("pboard_debug_get_pending_operations", "Operations created/queued but not yet acknowledged, per board: the diff of created/queued/acknowledged observed in the buffer. Honest about gaps: `note` explains when counters may be incomplete.",
  { clientId: z.string().optional(), boardId: z.string().optional() },
  (args) => guarded(async () => {
    const events = await bridgeJson("/events", {}, {
      filter: JSON.stringify({ component: "sync", event: ["operation.created", "operation.acknowledged", "operation.duplicate"], ...(args.clientId ? { clientId: args.clientId } : {}), ...(args.boardId ? { boardId: args.boardId } : {}) }),
      limit: 5_000,
    }) as { events: Record<string, unknown>[]; bufferOverflown?: boolean };
    const outstanding = new Map<string, Record<string, unknown>>();
    for (const event of [...events.events].reverse()) {
      const id = `${event.clientId}|${event.operationId}`;
      if (event.event === "operation.acknowledged") outstanding.delete(id);
      else if (!outstanding.has(id)) outstanding.set(id, event);
    }
    return {
      pending: [...outstanding.values()],
      note: events.bufferOverflown
        ? "the event buffer overflowed: acknowledgements older than the window are not counted — the live outbox length is available via pboard_debug_get_board_state"
        : undefined,
    };
  }));

defineTool("pboard_debug_trace_operation", "Full correlation for one operation (or trace id): ordered stages across clients, per-stage durations, missing/duplicate stages, errors. Includes the honest 'missing ≠ never happened' caveat.",
  { operationId: z.string().optional(), traceId: z.string().optional() },
  (args) => guarded(() => bridgeJson("/trace", {}, args.traceId ? { traceId: args.traceId } : { operationId: args.operationId })));

defineTool("pboard_debug_list_traces", "Recent correlated traces (by traceId or operation id), most recent first, with completeness flags. Find operation ids to trace here.",
  { limit: z.number().int().min(1).max(50).optional() },
  (args) => guarded(() => bridgeJson("/traces", {}, { limit: args.limit ?? 10 })));

// --- Client state -----------------------------------------------------------

defineTool("pboard_debug_get_client_state", "Ask a running client (pull model) for its controlled read-only state snapshot: open boards, counts, sync state, live connections — no raw documents, no user content, no credentials. Times out honestly when no such client is connected.",
  { clientId: z.string(), timeoutMs: z.number().int().min(1000).max(60_000).optional() },
  (args) => guarded(() => bridgeJson(`/inspect/${encodeURIComponent(args.clientId)}`, {}, args.timeoutMs ? { timeoutMs: String(args.timeoutMs) } : {})));

defineTool("pboard_debug_compare_clients", "Compare two clients' board-state snapshots side by side (counts, sync state, pending). Fetches both snapshots then diffs; explains refusals instead of hiding them.",
  { clientIdA: z.string(), clientIdB: z.string() },
  (args) => guarded(async () => {
    type SnapshotLike = { boards?: { boardId: string; cardCount?: number; syncState?: string; pendingOperations?: number; lastSyncedAt?: string; snapshot?: unknown; oplog?: unknown }[]; connections?: unknown[]; error?: string };
    const [a, b] = await Promise.all([
      bridgeJson(`/inspect/${encodeURIComponent(args.clientIdA)}`).then((value) => value as SnapshotLike, (error: unknown) => ({ error: String(error) }) as SnapshotLike),
      bridgeJson(`/inspect/${encodeURIComponent(args.clientIdB)}`).then((value) => value as SnapshotLike, (error: unknown) => ({ error: String(error) }) as SnapshotLike),
    ]);
    const ids = [...new Set([...(a.boards ?? []), ...(b.boards ?? [])].map((board) => board.boardId))];
    const rowFor = (snapshot: SnapshotLike, boardId: string) => {
      const board = (snapshot.boards ?? []).find((entry) => entry.boardId === boardId);
      if (!board) return null;
      return { cardCount: board.cardCount, syncState: board.syncState, pendingOperations: board.pendingOperations, lastSyncedAt: board.lastSyncedAt, snapshot: board.snapshot, oplog: board.oplog };
    };
    return {
      clientA: a.error ? { error: a.error } : { clientId: args.clientIdA, connections: a.connections?.length ?? 0 },
      clientB: b.error ? { error: b.error } : { clientId: args.clientIdB, connections: b.connections?.length ?? 0 },
      boards: ids.map((boardId) => ({ boardId, a: rowFor(a, boardId), b: rowFor(b, boardId) })),
    };
  }));

// --- Captures -----------------------------------------------------------------

defineTool("pboard_debug_start_capture", "Start a trace capture recording matching events (plus their connections) into a bounded, exportable file. Only one capture is active at a time.",
  { label: z.string().optional(), seed: z.string().optional(), filter: filterSchema.optional() },
  (args) => guarded(() => bridgeJson("/capture/start", { method: "POST", body: JSON.stringify(args), headers: { "content-type": "application/json" } })));

defineTool("pboard_debug_stop_capture", "Stop the active capture; pass failureSummary when stopping after a failed test so the capture file records why.",
  { failureSummary: z.string().optional() },
  (args) => guarded(() => bridgeJson("/capture/stop", { method: "POST", body: JSON.stringify(args ?? {}), headers: { "content-type": "application/json" } })));

defineTool("pboard_debug_export_capture", "Write a stopped capture as JSON to test-results/debug-traces/ for offline analysis; returns the path.",
  { captureId: z.string() },
  (args) => guarded(() => bridgeJson("/capture/export", { method: "POST", body: JSON.stringify(args), headers: { "content-type": "application/json" } })));

defineTool("pboard_debug_list_captures", "Stopped captures held by the bridge with event/connection counts and failure summaries.", {},
  () => guarded(() => bridgeJson("/captures")));

defineTool("pboard_debug_replay_trace", "Replay = re-display of a recorded capture, in order, optionally filtered — a reading aid, NOT a re-execution. Deterministic re-execution belongs to the test harness (pboard_debug_run_scenario).",
  { captureId: z.string(), maxEvents: z.number().int().min(1).max(500).optional() },
  (args) => guarded(async () => {
    const capture = await bridgeJson(`/captures/${encodeURIComponent(args.captureId)}`) as { events?: Record<string, unknown>[] };
    const events = (capture.events ?? []).slice(0, args.maxEvents ?? 200);
    return { replay: events.map((event) => ({ t: event.receivedAt, client: event.clientId, component: event.component, event: event.event, severity: event.severity, operationId: event.operationId, connectionId: event.connectionId, details: event.details })) };
  }));

// --- Connection diagnostics ------------------------------------------------------

defineTool("pboard_debug_check_connections", "The duplicate-connection questions, answered: duplicate live dials per trigger+room, orphaned sockets, multi-session owners, stalled courier sockets. Each finding carries its connection ids as evidence.",
  { clientId: z.string().optional() },
  (args) => guarded(() => bridgeJson("/connections/checks", {}, args.clientId ? { clientId: args.clientId } : {})));

// --- Harness control ---------------------------------------------------------

defineTool("pboard_debug_run_scenario", "Run a harness scenario (mock mode) against the bridge: the runner registers itself as a client, drives mock clients through the real sync runtime, and records a capture. Actions: list | <scenario-name>.",
  { action: z.string(), args: z.record(z.string(), z.string()).optional() },
  (args) => guarded(async () => {
    // The harness runner is a local Node process; spawning is intentionally
    // restricted to the repository's own runner and mock mode.
    if (args.action === "list") {
      return { scenarios: listScenarios() };
    }
    return await runScenario(args.action, args.args ?? {});
  }));

defineTool("pboard_debug_send_command", "Fault injection / test control against mock clients ONLY (bridge mode 'mock'): disconnect, reconnect, drop-message, duplicate-operation, latency, reset-storage, reload. Refused (403) in local and production-observer modes — this tool cannot touch the real relay.",
  { clientId: z.string(), action: z.enum(["disconnect", "reconnect", "drop-message", "duplicate-operation", "latency", "reset-storage", "reload", "clear-faults"]), args: z.record(z.string(), z.string()).optional() },
  (args) => guarded(() => bridgeJson("/command", { method: "POST", body: JSON.stringify(args), headers: { "content-type": "application/json" } })));

// --- Protocol documentation ------------------------------------------------------

defineTool("pboard_debug_describe_protocol", "The diagnostic event contract: schema version, components, every registered event name with its meaning, filter semantics, and trace stage expectations. Read this before writing filters.", {},
  async () => guarded(async () => {
    return { schemaVersion: DEBUG_SCHEMA_VERSION, components: DEBUG_COMPONENTS, severities: DEBUG_SEVERITIES, events: DEBUG_EVENTS, cardOperationStages: CARD_OPERATION_TRACE_STAGES };
  }));

const invokedAsMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedAsMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol; logs go to stderr.
  console.error(`pboard-debug MCP server connected (bridge ${BRIDGE_URL}${AUTO_START ? ", auto-start enabled" : ""})`);
  const shutdown = () => {
    bridgeProcess?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { server };
