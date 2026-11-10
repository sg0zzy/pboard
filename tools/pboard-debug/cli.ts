/**
 * Small operator CLI for the Debug Bridge: `npm run debug:status` (and a
 * couple of one-call reads). Deliberately tiny — everything else goes
 * through the MCP tools or the dashboard.
 *
 * Usage: node tools/pboard-debug/cli.ts <command> [args]
 *   status                 GET /status, human summary
 *   clients                registered clients + counts
 *   events [filterJson]    newest events (compact one-liners)
 *   traces                 recent trace correlation views
 *   checks                 connection findings
 */

import { DEFAULT_BRIDGE_URL } from "../../src/debug/bridgeTransport.ts";
import type { BridgeClientInfo, BridgeStatus, StoredDebugEvent } from "../../src/debug/protocol.ts";
import type { ConnectionFinding } from "../../src/debug/connectionRegistry.ts";
import type { TraceView } from "../../src/debug/schema.ts";

const base = (process.env.PBOARD_DEBUG_URL ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
const token = process.env.PBOARD_DEBUG_TOKEN;

async function get(path: string): Promise<unknown> {
  const url = new URL(`${base}${path}`);
  if (token) url.searchParams.set("token", token);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const command = process.argv[2] ?? "status";
try {
  if (command === "status") {
    const status = (await get("/status")) as BridgeStatus;
    process.stdout.write(
      `bridge ${status.serverVersion} @ ${status.host}:${status.port} mode=${status.mode} schema v${status.schemaVersion}\n` +
        `events ${status.eventBufferLength}/${status.eventBufferCapacity} (overflow ${status.droppedByOverflow}, rejected ${status.rejectedEvents}) clients ${status.clients} subscriptions ${status.subscriptions}\n` +
        `captures active ${status.captures.active} stored ${status.captures.stored} · latest cursor ${status.latestCursor} · uptime ${Math.round(status.uptimeMs / 1000)}s\n`,
    );
  } else if (command === "clients") {
    const clients = (await get("/clients")) as BridgeClientInfo[];
    for (const client of clients)
      process.stdout.write(`${client.clientId}  contexts=${client.contexts.join(",")} sessions=${client.sessionIds.length} events=${client.eventCount} rejected=${client.rejectedCount} last=${client.lastSeen}${client.label ? ` label=${client.label}` : ""}\n`);
    if (clients.length === 0) process.stdout.write("no clients registered yet — enable the bridge in Pboard storage (pboardDebugBridge)\n");
  } else if (command === "events") {
    const filter = process.argv[3];
    const params = new URLSearchParams({ limit: "25" });
    if (filter) params.set("filter", filter);
    const result = (await get(`/events?${params}`)) as { events: StoredDebugEvent[] };
    for (const event of result.events)
      process.stdout.write(`${event.receivedAt.slice(11, 23)} ${event.severity.padEnd(5)} ${event.component}/${event.event} ${event.clientId ?? "-"} ${event.connectionId ?? event.operationId ?? ""} ${JSON.stringify(event.details ?? {}).slice(0, 110)}\n`);
  } else if (command === "traces") {
    const traces = (await get("/traces?limit=10")) as TraceView[];
    for (const trace of traces)
      process.stdout.write(`${trace.traceId}  stages=${trace.stages.length} complete=${trace.complete} ${trace.stages.map((stage) => stage.event).slice(0, 8).join(">")}${trace.missingStages.length ? ` missing:${trace.missingStages.join(",")}` : ""}${trace.errors.length ? ` errors:${trace.errors.length}` : ""}\n`);
  } else if (command === "checks") {
    const result = (await get("/connections/checks")) as { findings: ConnectionFinding[] };
    const findings = result.findings;
    if (findings.length === 0) process.stdout.write("no connection findings\n");
    for (const finding of findings)
      process.stdout.write(`[${finding.severity}] ${finding.kind}: ${finding.summary} (${finding.connectionIds.join(", ")})\n`);
  } else {
    process.stderr.write(`unknown command "${command}" — expected status|clients|events|traces|checks\n`);
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`pboard-debug ${command} failed: ${error instanceof Error ? error.message : String(error)}\n` + `is the bridge running at ${base}? (npm run debug:bridge)\n`);
  process.exit(1);
}
