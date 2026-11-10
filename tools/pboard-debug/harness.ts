/**
 * Harness runner: mock-mode scenarios that exercise the bridge end to end
 * without a browser.
 *
 * This is NOT a replacement for the browser regression suites — it is the
 * debug-bridge's own acceptance harness: two synthetic Pboard clients emit
 * through the *real* SDK bus (src/debug/bus) into a real bridge over real
 * loopback sockets and a mock relay that speaks the same event vocabulary as
 * `relay.*` production logs. Scenarios model the shapes the sync runtime
 * produces (connect → authenticate → join → submit → forward → apply), can
 * have faults injected through the bridge's own `/command` queue (mock mode
 * only, exactly like the browser harness would consume them), and every run
 * is wrapped in an automatic capture that is exported on both success and
 * failure — a failed scenario must leave the trace behind.
 *
 * Runs in-process when called through MCP (`run_scenario`) or standalone:
 * `node tools/pboard-debug/harness.ts --scenario <name> [--bridge URL]`.
 */

import { emit, configureDebugBus, flushDebugBus, resetDebugBus } from "../../src/debug/bus.ts";
import { newDebugId, resolveClientId, resolveSessionId } from "../../src/debug/ids.ts";
import { HttpBridgeTransport, DEFAULT_BRIDGE_URL } from "../../src/debug/bridgeTransport.ts";
import { observeRelayLogs, toLines } from "./relayObserver.ts";

export interface ScenarioDefinition {
  name: string;
  description: string;
  faults: string[];
  run: (context: ScenarioContext) => Promise<ScenarioOutcome>;
}

/** A decoded JSON object from the bridge, narrowed at the boundary. */
export type JsonObject = Record<string, unknown>;

export interface BridgeResponse {
  status: number;
  json: () => Promise<JsonObject>;
}

export interface ScenarioContext {
  bridgeUrl: string;
  token?: string;
  seed: string;
  /** Faults the caller asked to inject (queued through `/command` by the
   * CLI or handed over directly by MCP). */
  faults: FaultDirective[];
  acknowledgeFault: (id: string) => Promise<void>;
  request: (path: string, init?: { method?: string; body?: unknown }) => Promise<BridgeResponse>;
}

export interface FaultDirective {
  id: string;
  action: string;
  args?: JsonObject;
}

export interface ScenarioOutcome {
  ok: boolean;
  summary: string;
  checks: { name: string; ok: boolean; detail?: string }[];
}

export interface RunOptions {
  bridgeUrl?: string;
  token?: string;
  faults?: FaultDirective[];
  seed?: string;
}

export interface RunResult {
  scenario: string;
  ok: boolean;
  summary: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  captureId?: string;
  capturePath?: string;
  error?: string;
}

/** A bridge event as the harness reads it back over `/events` — a subset,
 * validated by type guard rather than trusted. */
interface BridgeEventView {
  clientId?: string;
  component: string;
  event: string;
  severity: string;
  details?: JsonObject;
}

const DEFAULT_SEED = "pboard-debug-default-seed";

export function listScenarios(): { name: string; description: string; faults: string[] }[] {
  return SCENARIOS.map(({ name, description, faults }) => ({ name, description, faults }));
}

export async function runScenario(name: string, options: RunOptions = {}): Promise<RunResult> {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) return { scenario: name, ok: false, summary: `unknown scenario; available: ${SCENARIOS.map((s) => s.name).join(", ")}`, checks: [] };
  const bridgeUrl = options.bridgeUrl ?? readEnv("PBOARD_DEBUG_URL") ?? DEFAULT_BRIDGE_URL;
  const token = options.token ?? readEnv("PBOARD_DEBUG_TOKEN");
  const seed = options.seed ?? DEFAULT_SEED;
  const base = bridgeUrl.replace(/\/+$/, "");
  const request = async (path: string, init?: { method?: string; body?: unknown }): Promise<BridgeResponse> => {
    const query = token ? `token=${encodeURIComponent(token)}` : "";
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(`${base}${path}${query ? `${separator}${query}` : ""}`, {
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    let parsed: JsonObject = {};
    try {
      parsed = asObject(JSON.parse(text));
    } catch {
      /* non-JSON body reads as an empty object; callers check status */
    }
    return { status: response.status, json: async () => parsed };
  };

  // Automatic capture around the scenario; failures must leave a trace.
  const started = await request("/capture/start", { method: "POST", body: { label: `scenario:${name}`, seed } });
  const captureId = started.status === 200 ? optString((await started.json()).captureId) : undefined;

  const context: ScenarioContext = {
    bridgeUrl,
    ...(token ? { token } : {}),
    seed,
    faults: options.faults ?? [],
    acknowledgeFault: async (id) => {
      await request("/command", { method: "POST", body: { clientId: "harness-runner", action: "fault.acknowledged", args: { id } } }).catch(() => undefined);
    },
    request,
  };

  let outcome: ScenarioOutcome;
  let failure: string | undefined;
  try {
    outcome = await scenario.run(context);
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    outcome = { ok: false, summary: `threw: ${failure}`, checks: [] };
  }

  // Flush the runner's own emitted events before stopping the capture.
  flushDebugBus();
  await sleep(150);
  const stopped = await request("/capture/stop", { method: "POST", body: outcome.ok ? {} : { failureSummary: outcome.summary } });
  let capturePath: string | undefined;
  if (stopped.status === 200 && captureId) {
    const exported = await request("/capture/export", { method: "POST", body: { captureId } });
    if (exported.status === 200) capturePath = optString((await exported.json()).path);
  }
  return {
    scenario: name,
    ok: outcome.ok,
    summary: outcome.summary,
    checks: outcome.checks,
    ...(captureId ? { captureId } : {}),
    ...(capturePath ? { capturePath } : {}),
    ...(failure ? { error: failure } : {}),
  };
}

/** Consume fault directives the bridge queued for this client (poll
 * `/fault/poll`, the same path a browser harness client uses) and emit
 * `harness.fault.injected` for each so the trace shows them. */
export async function drainFaults(clientId: string, context: ScenarioContext): Promise<FaultDirective[]> {
  const response = await context.request(`/fault/poll?clientId=${encodeURIComponent(clientId)}`);
  if (response.status !== 200) return [];
  const commandsValue = (await response.json()).commands;
  const commands: FaultDirective[] = [];
  if (Array.isArray(commandsValue)) {
    for (const entry of commandsValue) {
      const command = asObject(entry);
      const id = optString(command.id);
      const action = optString(command.action);
      if (!id || !action) continue;
      const args = asObject(command.args);
      commands.push({ id, action, ...(Object.keys(args).length ? { args } : {}) });
    }
  }
  for (const command of commands) {
    const target = command.args ? optString(command.args.clientId) : undefined;
    emit({
      component: "harness",
      event: "fault.injected",
      severity: "warn",
      ...(target ? { clientId: target } : {}),
      details: { action: command.action, ...(command.args ?? {}) },
    });
    await context.acknowledgeFault(command.id);
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Synthetic clients
// ---------------------------------------------------------------------------

interface SyntheticClient {
  clientId: string;
  sessionId: string;
  /** Present only on secondary clients, which bypass the shared bus (it
   * carries exactly one identity) and post real ingest envelopes. */
  post?: (event: JsonObject) => Promise<void>;
  close: () => void;
}

async function attachClient(clientId: string, context: string, bridgeUrl: string, token?: string): Promise<SyntheticClient> {
  const session = resolveSessionId();
  const transport = new HttpBridgeTransport({ url: bridgeUrl, ...(token ? { token } : {}), clientId, sessionId: session, context });
  // The module-level bus serves the scenario's primary client; secondary
  // clients (attachSecondaryClient) post through their own transport.
  configureDebugBus({
    enabled: true,
    identity: () => ({ clientId, sessionId: session, context }),
    transport: () => transport,
  });
  return {
    clientId,
    sessionId: session,
    close: () => transport.close?.(),
  };
}

/** A secondary client writes exactly the wire envelope the browser SDK uses;
 * kept honest by reusing the same protocol version and shape. */
async function attachSecondaryClient(clientId: string, context: string, bridgeUrl: string, token?: string): Promise<SyntheticClient> {
  const session = resolveSessionId();
  const transport = new HttpBridgeTransport({ url: bridgeUrl, ...(token ? { token } : {}), clientId, sessionId: session, context });
  const base = bridgeUrl.replace(/\/+$/, "");
  let sequence = 0;
  return {
    clientId,
    sessionId: session,
    post: async (event) => {
      // Exactly what the browser bus stamps per event (identity included —
      // the bridge attributes events, not just envelopes).
      const envelope = {
        protocol: 1,
        clientId,
        sessionId: session,
        context,
        events: [{ schemaVersion: 1, timestamp: new Date().toISOString(), sequenceNumber: ++sequence, clientId, sessionId: session, context, ...event }],
      };
      await fetch(`${base}/ingest${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      }).catch(() => undefined);
    },
    close: () => transport.close?.(),
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS: ScenarioDefinition[] = [
  {
    name: "happy-path-sync",
    description: "One client: connect, authenticate, create→queue→transmit→ack→apply lifecycle for one card operation.",
    faults: ["drop-next-ack"],
    async run(context) {
      const scenarioName = "happy-path-sync";
      const client = await attachClient(await harnessClientId("harness-a"), "node-harness", context.bridgeUrl, context.token);
      const boardId = `scenario-board-${context.seed.slice(0, 8)}`;
      const connectionId = newDebugId("conn");
      const operationId = newDebugId("op");
      const traceId = newDebugId("trace");
      emit({ component: "harness", event: "scenario.started", severity: "info", traceId, clientId: client.clientId, sessionId: client.sessionId, details: { scenario: scenarioName, seed: context.seed } });
      const drained = await drainFaults(client.clientId, context);
      const dropAck = context.faults.some((fault) => fault.action === "drop-next-ack" && faultApplies(fault, client.clientId)) || drained.length > 0;

      emit({ component: "websocket", event: "connection.requested", severity: "info", traceId, connectionId, boardId, context: "node-harness", details: { trigger: "scenario", room: boardId } });
      emit({ component: "websocket", event: "connection.opened", severity: "info", traceId, connectionId, boardId, details: { trigger: "scenario" } });
      emit({ component: "auth", event: "authentication.started", severity: "info", traceId, connectionId, boardId, details: { protocol: 3 } });
      emit({ component: "auth", event: "authentication.completed", severity: "info", traceId, connectionId, boardId, details: { role: "editor" } });
      emit({ component: "websocket", event: "subscription.requested", severity: "debug", traceId, connectionId, boardId, details: {} });
      emit({ component: "websocket", event: "subscription.accepted", severity: "debug", traceId, connectionId, boardId, details: { peers: 1 } });

      emit({ component: "sync", event: "operation.created", severity: "info", traceId, operationId, boardId, details: { kind: "card.updated" } });
      emit({ component: "sync", event: "operation.queued", severity: "info", traceId, operationId, boardId, details: { pending: 1 } });
      emit({ component: "websocket", event: "message.sent", severity: "debug", traceId, operationId, connectionId, boardId, details: { bytes: 96 } });
      emit({ component: "relay", event: "operation.received", severity: "debug", traceId, operationId, boardId, context: "mock-relay", details: { source: "mock" } });
      if (!dropAck) emit({ component: "sync", event: "operation.acknowledged", severity: "info", traceId, operationId, boardId, details: { seq: 1 } });
      emit({ component: "sync", event: "operation.applied", severity: "info", traceId, operationId, boardId, details: { seq: 1, origin: "local" } });
      if (dropAck) emit({ component: "sync", event: "operation.queued", severity: "warn", traceId, operationId, boardId, details: { pending: 1, reason: "ack-dropped" } });

      flushDebugBus();
      await sleep(350);
      const events = await bridgeEvents(context, client.clientId, traceId);
      const required = dropAck
        ? ["sync:operation.created", "sync:operation.queued", "websocket:message.sent", "relay:operation.received", "sync:operation.applied"]
        : ["sync:operation.created", "sync:operation.queued", "websocket:message.sent", "relay:operation.received", "sync:operation.acknowledged", "sync:operation.applied"];
      const seen = new Set(events.map((event) => `${event.component}:${event.event}`));
      const missing = required.filter((stage) => !seen.has(stage));
      const checks = [
        { name: "trace-completes", ok: missing.length === 0, ...(missing.length ? { detail: `missing: ${missing.join(", ")}` } : {}) },
        { name: "events-at-bridge", ok: events.length >= required.length, detail: `${events.length} events for trace` },
      ];
      const ok = checks.every((check) => check.ok);
      emit({ component: "harness", event: ok ? "scenario.completed" : "scenario.failed", severity: ok ? "info" : "error", traceId, details: { scenario: scenarioName } });
      client.close();
      return { ok, summary: ok ? `trace complete over ${events.length} bridge events` : `incomplete: ${checks.filter((c) => !c.ok).map((c) => c.detail ?? c.name).join("; ")}`, checks };
    },
  },
  {
    name: "relay-forward",
    description: "Two clients, one mock relay: client A submits, relay forwards, client B applies; the trace spans both clients.",
    faults: [],
    async run(context) {
      const scenarioName = "relay-forward";
      const a = await attachClient(await harnessClientId("harness-a"), "node-harness-a", context.bridgeUrl, context.token);
      const b = await attachSecondaryClient(await harnessClientId("harness-b"), "node-harness-b", context.bridgeUrl, context.token);
      const boardId = `scenario-board-${context.seed.slice(0, 8)}`;
      const traceId = newDebugId("trace");
      const operationId = newDebugId("op");
      const connectionA = newDebugId("conn");
      const connectionB = newDebugId("conn");
      emit({ component: "harness", event: "scenario.started", severity: "info", traceId, clientId: a.clientId, details: { scenario: scenarioName, peers: 2, seed: context.seed } });

      emit({ component: "websocket", event: "connection.requested", severity: "info", traceId, clientId: a.clientId, connectionId: connectionA, boardId, details: { trigger: "scenario", room: boardId } });
      emit({ component: "websocket", event: "connection.opened", severity: "info", traceId, clientId: a.clientId, connectionId: connectionA, boardId, details: { trigger: "scenario" } });
      emit({ component: "auth", event: "authentication.completed", severity: "info", traceId, clientId: a.clientId, connectionId: connectionA, boardId, details: { role: "editor" } });
      await b.post?.({ component: "websocket", event: "connection.requested", severity: "info", traceId, connectionId: connectionB, boardId, details: { trigger: "scenario", room: boardId } });
      await b.post?.({ component: "websocket", event: "connection.opened", severity: "info", traceId, connectionId: connectionB, boardId, details: { trigger: "scenario" } });
      await b.post?.({ component: "auth", event: "authentication.completed", severity: "info", traceId, connectionId: connectionB, boardId, details: { role: "editor" } });

      emit({ component: "sync", event: "operation.created", severity: "info", traceId, operationId, boardId, clientId: a.clientId, details: { kind: "card.created" } });
      emit({ component: "sync", event: "operation.transmitted", severity: "info", traceId, operationId, boardId, clientId: a.clientId, connectionId: connectionA, details: {} });
      emit({ component: "relay", event: "operation.forwarded", severity: "debug", traceId, operationId, boardId, context: "mock-relay", details: { source: "mock", peers: 1 } });
      await b.post?.({ component: "websocket", event: "message.received", severity: "debug", traceId, operationId, connectionId: connectionB, boardId, details: { bytes: 96 } });
      await b.post?.({ component: "sync", event: "operation.received", severity: "info", traceId, operationId, boardId, details: {} });
      await b.post?.({ component: "sync", event: "operation.validated", severity: "debug", traceId, operationId, boardId, details: {} });
      await b.post?.({ component: "sync", event: "operation.applied", severity: "info", traceId, operationId, boardId, details: { seq: 1 } });
      emit({ component: "sync", event: "operation.acknowledged", severity: "info", traceId, operationId, boardId, clientId: a.clientId, details: { seq: 1 } });

      flushDebugBus();
      await sleep(400);
      const events = await bridgeEvents(context, undefined, traceId);
      const clientA = events.filter((event) => event.clientId === a.clientId).map((event) => `${event.component}:${event.event}`);
      const clientB = events.filter((event) => event.clientId === b.clientId).map((event) => `${event.component}:${event.event}`);
      const relay = events.filter((event) => event.component === "relay").length;
      const checks = [
        { name: "sender-saw-transmit", ok: clientA.includes("sync:operation.transmitted") },
        { name: "receiver-saw-apply", ok: clientB.includes("sync:operation.applied") },
        { name: "server-stage-present", ok: relay >= 1, detail: `${relay} relay events` },
      ];
      const ok = checks.every((check) => check.ok);
      emit({ component: "harness", event: ok ? "scenario.completed" : "scenario.failed", severity: ok ? "info" : "error", traceId, details: { scenario: scenarioName } });
      a.close();
      b.close();
      return { ok, summary: ok ? `cross-client trace complete (${events.length} events)` : `missing stages: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`, checks };
    },
  },
  {
    name: "reconnect-loop",
    description: "Reconnect storm: repeated dials for one trigger+room, exercising the duplicate-connection finding and reconnect events.",
    faults: [],
    async run(context) {
      const scenarioName = "reconnect-loop";
      const client = await attachClient(await harnessClientId("harness-a"), "node-harness", context.bridgeUrl, context.token);
      const boardId = `scenario-board-${context.seed.slice(0, 8)}`;
      const traceId = newDebugId("trace");
      emit({ component: "harness", event: "scenario.started", severity: "info", traceId, clientId: client.clientId, details: { scenario: scenarioName, seed: context.seed } });
      let closedCount = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const connectionId = newDebugId("conn");
        emit({ component: "websocket", event: "connection.requested", severity: "info", traceId, connectionId, boardId, details: { trigger: "log-session", room: boardId } });
        emit({ component: "websocket", event: "connection.opened", severity: "info", traceId, connectionId, boardId, details: { trigger: "log-session" } });
        closedCount += 1;
        emit({ component: "websocket", event: "connection.closed", severity: "warn", traceId, connectionId, boardId, details: { code: 1006, cause: "network" } });
        emit({ component: "websocket", event: "reconnect.scheduled", severity: "info", traceId, boardId, details: { delayMs: 500 * (attempt + 1), attempt: attempt + 1 } });
      }
      // The last socket stays open; the three closed ones must not read as
      // duplicates (only live sockets sharing trigger+room do).
      const openConnection = newDebugId("conn");
      emit({ component: "websocket", event: "connection.requested", severity: "info", traceId, connectionId: openConnection, boardId, details: { trigger: "log-session", room: boardId } });
      emit({ component: "websocket", event: "connection.opened", severity: "info", traceId, connectionId: openConnection, boardId, details: { trigger: "log-session" } });
      flushDebugBus();
      await sleep(350);
      const response = await context.request(`/connections/checks?clientId=${encodeURIComponent(client.clientId)}`);
      const body = await response.json();
      const findings = Array.isArray(body.findings) ? body.findings : [];
      const duplicates = findings.filter((finding) => asObject(finding).kind === "duplicate-connections");
      const ok = response.status === 200 && duplicates.length === 0;
      const checks = [{ name: "no-false-duplicates", ok, detail: `${duplicates.length} duplicate findings for ${closedCount + 1} dials (${closedCount} closed)` }];
      emit({ component: "harness", event: ok ? "scenario.completed" : "scenario.failed", severity: ok ? "info" : "error", traceId, details: { scenario: scenarioName } });
      client.close();
      return { ok, summary: checks[0].detail ?? "", checks };
    },
  },
  {
    name: "server-restart",
    description: "Mock relay closes then rejects connections: dropped socket, failed reconnect, then recovery — errors visible to the MCP layer.",
    faults: ["relay-down"],
    async run(context) {
      const scenarioName = "server-restart";
      const client = await attachClient(await harnessClientId("harness-a"), "node-harness", context.bridgeUrl, context.token);
      const boardId = `scenario-board-${context.seed.slice(0, 8)}`;
      const traceId = newDebugId("trace");
      const connectionId = newDebugId("conn");
      emit({ component: "harness", event: "scenario.started", severity: "info", traceId, clientId: client.clientId, details: { scenario: scenarioName, seed: context.seed } });
      const drained = await drainFaults(client.clientId, context);
      const down = context.faults.some((fault) => fault.action === "relay-down" && faultApplies(fault, client.clientId)) || drained.some((fault) => fault.action === "relay-down");
      emit({ component: "websocket", event: "connection.requested", severity: "info", traceId, connectionId, boardId, details: { trigger: "log-session", room: boardId } });
      emit({ component: "websocket", event: "connection.opened", severity: "info", traceId, connectionId, boardId, details: { trigger: "log-session" } });
      emit({ component: "relay", event: "connection.accepted", severity: "info", traceId, context: "mock-relay", details: { source: "mock", session: newDebugId("relay-session") } });
      emit({ component: "websocket", event: "connection.closed", severity: "warn", traceId, connectionId, boardId, details: { code: 1011, cause: "server-error" } });
      emit({ component: "relay", event: "connection.closed", severity: "warn", traceId, context: "mock-relay", details: { source: "mock", reason: "internal" } });
      if (down) {
        emit({ component: "websocket", event: "reconnect.scheduled", severity: "info", traceId, boardId, details: { delayMs: 500, attempt: 1 } });
        emit({ component: "websocket", event: "reconnect.failed", severity: "error", traceId, boardId, details: { attempt: 1, code: "connection-refused" } });
        emit({ component: "websocket", event: "reconnect.scheduled", severity: "info", traceId, boardId, details: { delayMs: 1000, attempt: 2 } });
      }
      const recovery = newDebugId("conn");
      emit({ component: "websocket", event: "connection.requested", severity: "info", traceId, connectionId: recovery, boardId, details: { trigger: "log-session", room: boardId } });
      emit({ component: "websocket", event: "connection.opened", severity: "info", traceId, connectionId: recovery, boardId, details: { trigger: "log-session" } });
      emit({ component: "auth", event: "authentication.completed", severity: "info", traceId, connectionId: recovery, boardId, details: { role: "editor", resumed: true } });
      flushDebugBus();
      await sleep(350);
      const events = await bridgeEvents(context, client.clientId, traceId);
      const severities = events.filter((event) => event.severity === "error").map((event) => `${event.component}:${event.event}`);
      const recovered = events.some((event) => event.component === "auth" && event.event === "authentication.completed" && event.details?.resumed === true);
      const checks = [
        { name: "recovered", ok: recovered },
        { name: down ? "failure-visible-as-error" : "clean-without-fault", ok: down ? severities.includes("websocket:reconnect.failed") : severities.length === 0, detail: severities.join(", ") || "no errors" },
      ];
      const ok = checks.every((check) => check.ok);
      emit({ component: "harness", event: ok ? "scenario.completed" : "scenario.failed", severity: ok ? "info" : "error", traceId, details: { scenario: scenarioName } });
      client.close();
      return { ok, summary: ok ? "restart recovered; failure visibility matches fault plan" : checks.filter((c) => !c.ok).map((c) => c.detail ?? c.name).join("; "), checks };
    },
  },
  {
    name: "relay-log-observation",
    description: "Feeds real relay tracing lines through the log observer: parsed relay.* events reach the bridge.",
    faults: [],
    async run(context) {
      const scenarioName = "relay-log-observation";
      const client = await attachClient(await harnessClientId("harness-a"), "node-harness", context.bridgeUrl, context.token);
      emit({ component: "harness", event: "scenario.started", severity: "info", clientId: client.clientId, details: { scenario: scenarioName, seed: context.seed } });
      // Exactly the shape lib.rs writes (field names are the contract).
      const lines = [
        '2026-11-10T12:00:00.000000Z  INFO pboard_signaling: event="connect" session=rs-1 remote=127.0.0.1, signaling connection accepted',
        '2026-11-10T12:00:00.100000Z  INFO pboard_signaling: event="authenticated" session=rs-1 room=aabbccddeeff peer=device-1 version=3, device authentication accepted',
        '2026-11-10T12:00:00.200000Z  INFO pboard_signaling: event="room_attached" session=rs-1 role=editor, room attachment accepted',
        '2026-11-10T12:00:00.300000Z  INFO pboard_signaling: event="join" session=rs-1 peers=2, authorized signaling session joined',
        '2026-11-10T12:00:00.400000000Z DEBUG pboard_signaling: event="signal_forwarded" session=rs-1 count=1, signaling envelope forwarded',
        "2026-11-10T12:00:00.500000Z  INFO pboard_signaling: some unrelated log line without an event field",
        '2026-11-10T12:00:01.000000Z  INFO pboard_signaling: event="disconnect" session=rs-1 reason=1000, connection closed',
      ];
      async function* stream(): AsyncIterable<string> {
        for (const line of lines) yield `${line}\n`;
      }
      const observer = observeRelayLogs(toLines(stream()));
      await sleep(100);
      flushDebugBus();
      await sleep(350);
      const counts = observer.consumed();
      const events = await bridgeEvents(context, client.clientId, undefined);
      const relay = events.filter((event) => event.component === "relay");
      const sessions = new Set(relay.map((event) => String(event.details?.session ?? "")));
      const checks = [
        { name: "mapped-known-lines", ok: counts.mapped === 6 && counts.unmapped === 1, detail: `${counts.mapped} mapped / ${counts.unmapped} unmapped` },
        { name: "relay-events-at-bridge", ok: relay.length >= 6 && sessions.has("rs-1"), detail: `${relay.length} relay events, sessions: ${[...sessions].join(",")}` },
      ];
      const ok = checks.every((check) => check.ok);
      emit({ component: "harness", event: ok ? "scenario.completed" : "scenario.failed", severity: ok ? "info" : "error", details: { scenario: scenarioName } });
      client.close();
      return { ok, summary: checks.map((check) => `${check.name}:${check.ok ? "ok" : `FAIL (${check.detail ?? ""})`}`).join(" "), checks };
    },
  },
  {
    name: "stress-events",
    description: "1000 events through the real bus: backpressure, sequence integrity, no loss below the bound.",
    faults: [],
    async run(context) {
      const scenarioName = "stress-events";
      const client = await attachClient(await harnessClientId("harness-a"), "node-harness", context.bridgeUrl, context.token);
      emit({ component: "harness", event: "scenario.started", severity: "info", clientId: client.clientId, details: { scenario: scenarioName, seed: context.seed } });
      const startedAt = Date.now();
      for (let index = 0; index < 1000; index += 1)
        emit({ component: "sync", event: "operation.created", severity: index % 500 === 0 ? "warn" : "debug", boardId: `stress-${context.seed}`, details: { index, pad: "x".repeat(64) } });
      flushDebugBus();
      await sleep(1500);
      const status = await context.request("/status");
      const body = await status.json();
      const elapsed = Date.now() - startedAt;
      const stored = typeof body.eventBufferLength === "number" ? body.eventBufferLength : 0;
      const clientEvents = await bridgeEvents(context, client.clientId, undefined, 2000);
      const created = clientEvents.filter((event) => event.event === "operation.created").length;
      const ok = stored >= 1000 && created >= 1000;
      const checks = [
        { name: "all-stored", ok, detail: `${stored} buffered / ${created} client events of 1000 in ${elapsed}ms (capacity ${String(body.eventBufferCapacity)}, overflow ${String(body.droppedByOverflow)})` },
      ];
      emit({ component: "harness", event: ok ? "scenario.completed" : "scenario.failed", severity: ok ? "info" : "error", details: { scenario: scenarioName, elapsedMs: elapsed } });
      client.close();
      return { ok, summary: checks[0].detail ?? "", checks };
    },
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let cachedClientId: string | undefined;
async function harnessClientId(suffix: string): Promise<string> {
  if (!cachedClientId) cachedClientId = await resolveClientId(undefined, undefined);
  return `${readEnv("PBOARD_DEBUG_CLIENT_ID") ?? cachedClientId}-${suffix}`;
}

async function bridgeEvents(context: ScenarioContext, clientId: string | undefined, traceId: string | undefined, limit = 400): Promise<BridgeEventView[]> {
  const params = new URLSearchParams();
  const filter: JsonObject = {};
  if (clientId) filter.clientId = clientId;
  if (traceId) filter.traceId = traceId;
  if (Object.keys(filter).length) params.set("filter", JSON.stringify(filter));
  params.set("limit", String(limit));
  const response = await context.request(`/events?${params.toString()}`);
  if (response.status !== 200) return [];
  const body = await response.json();
  const events = body.events;
  return Array.isArray(events) ? events.filter(isBridgeEventView) : [];
}

function faultApplies(fault: FaultDirective, clientId: string): boolean {
  const target = fault.args ? optString(fault.args.clientId) : undefined;
  return !target || target === clientId;
}

function isBridgeEventView(value: unknown): value is BridgeEventView {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.component === "string" && typeof candidate.event === "string" && typeof candidate.severity === "string";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// standalone CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const named = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const scenario = named("--scenario");
  if (!scenario) {
    process.stdout.write(`usage: node tools/pboard-debug/harness.ts --scenario <name> [--bridge URL] [--token T] [--fault action [--fault-client id]] [--seed S]\nscenarios:\n${listScenarios().map((entry) => `  ${entry.name} — ${entry.description} [faults: ${entry.faults.join(",") || "none"}]`).join("\n")}\n`);
    return 2;
  }
  const bridgeUrl = named("--bridge") ?? readEnv("PBOARD_DEBUG_URL") ?? DEFAULT_BRIDGE_URL;
  const token = named("--token") ?? readEnv("PBOARD_DEBUG_TOKEN");
  const faults: FaultDirective[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--fault") continue;
    const action = argv[index + 1] ?? "";
    if (!action) continue;
    // Target client either positionally or with an explicit flag:
    //   --fault drop-next-ack harness-a | --fault drop-next-ack --fault-client harness-a
    let faultClient: string | undefined;
    let consumed = 2;
    if (argv[index + 2] === "--fault-client") {
      faultClient = argv[index + 3];
      consumed = 4;
    } else if (argv[index + 2] && !argv[index + 2].startsWith("--")) {
      faultClient = argv[index + 2];
    }
    const fault: FaultDirective = { id: newDebugId("fault"), action, ...(faultClient ? { args: { clientId: faultClient } } : {}) };
    // With an explicit target client, queue through the bridge's real
    // command path (mock mode); the scenario then polls it via /fault/poll.
    if (faultClient) {
      const response = await fetch(`${bridgeUrl}/command${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: faultClient, action, args: { clientId: faultClient } }),
      }).catch(() => undefined);
      if (response && response.status !== 200)
        process.stderr.write(`warning: queuing fault to ${faultClient} returned HTTP ${response.status} (mock mode required)\n`);
    }
    faults.push(fault);
    index += consumed - 1;
  }
  const seedValue = named("--seed");
  const result = await runScenario(scenario, { bridgeUrl, ...(token ? { token } : {}), faults, ...(seedValue ? { seed: seedValue } : {}) });
  resetDebugBus();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("harness.ts")) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
