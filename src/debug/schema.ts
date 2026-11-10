/**
 * Live Debug Bridge — shared diagnostic event schema (version 1).
 *
 * This module is the single source of truth for the diagnostic contract.
 * It is imported by the browser extension instrumentation (`src/debug`), the
 * local bridge and MCP server (`tools/pboard-debug`, executed by Node's type
 * stripping) and the Vitest suites. It therefore MUST stay free of runtime
 * imports and of non-erasable TypeScript syntax (no enums, no parameter
 * properties, no namespaces) so `node file.ts` can load it unmodified.
 *
 * Producers emit `DebugEvent`; the bridge validates with
 * `validateDebugEvent`, assigns a receive timestamp, and never rewrites the
 * producer's fields. Cross-process ordering is only ever approximate: use
 * `sequenceNumber` (per producer, monotonic) and `monotonicTime` (per clock
 * domain) for durations, never wall-clock comparisons across machines.
 */

export const DEBUG_SCHEMA_VERSION = 1 as const;

/** Components that can produce diagnostic events. Adding a component here is
 * the contract step for new instrumentation; MCP tools and bridge filters
 * accept these exact strings. */
export const DEBUG_COMPONENTS = [
  "debug",
  "websocket",
  "auth",
  "sync",
  "persistence",
  "drive",
  "lifecycle",
  "relay",
  "harness",
] as const;
export type DebugComponent = (typeof DEBUG_COMPONENTS)[number];

export const DEBUG_SEVERITIES = ["debug", "info", "warn", "error"] as const;
export type DebugSeverity = (typeof DEBUG_SEVERITIES)[number];

/**
 * Event-name registry by component. Names are stable `domain.action` strings.
 * Instrumentation and tests reference `DEBUG_EVENTS.<component>.<name>`; the
 * docs are generated from this table, so a new event must be added here first.
 */
export const DEBUG_EVENTS = {
  debug: {
    "bridge.status": "Bridge or SDK self-status (drops, backpressure, connect/disconnect)",
  },
  websocket: {
    "connection.requested": "A relay WebSocket dial is about to be constructed",
    "connection.opened": "The socket reached OPEN",
    "connection.closing": "This client asked the socket to close",
    "connection.closed": "The socket ended, with close code and cause",
    "message.sent": "An application frame was written to the socket",
    "message.received": "An application frame arrived from the socket",
    "reconnect.scheduled": "A reconnect attempt was scheduled with a delay",
    "reconnect.attempted": "A reconnect dial started",
    "reconnect.completed": "A reconnect produced a usable session",
    "reconnect.failed": "A reconnect attempt failed",
    "subscription.requested": "A board/room subscription frame was sent",
    "subscription.accepted": "The subscription was confirmed by the server",
  },
  auth: {
    "authentication.started": "Relay admission/authentication flow began",
    "authentication.completed": "Admission accepted; identity established",
    "authentication.failed": "Admission/authentication was rejected or errored",
    "identity.established": "The session's user identity is known",
    "token.refresh.started": "An OAuth token refresh started",
    "token.refresh.completed": "A refreshed credential was accepted",
    "token.refresh.failed": "The refresh failed",
    "authorization.rejected": "Server-side authorization denied an operation",
  },
  sync: {
    "operation.created": "A local operation was created",
    "operation.queued": "A local operation entered the durable outbox",
    "operation.transmitted": "The operation was written to the wire",
    "operation.acknowledged": "The server/log acknowledged the operation",
    "operation.received": "An inbound operation arrived",
    "operation.validated": "An inbound operation passed validation",
    "operation.applied": "An inbound operation changed local state",
    "operation.duplicate": "An inbound operation was a known duplicate",
    "operation.rejected": "An inbound operation was rejected",
    "conflict.detected": "A write conflict was detected",
    "conflict.resolved": "A conflict resolution committed",
    "sync.completed": "A synchronization round finished",
    "sync.failed": "A synchronization round failed",
    "sync.state": "Synchronization state changed for a board",
  },
  persistence: {
    "rxdb.write.requested": "An RxDB document write started",
    "rxdb.write.completed": "An RxDB document write committed",
    "rxdb.write.failed": "An RxDB document write failed",
    "snapshot.loading": "A snapshot load started",
    "snapshot.loaded": "A snapshot was loaded",
    "snapshot.creating": "A snapshot build started",
    "snapshot.saved": "A snapshot was saved",
    "oplog.processed": "An operation-log processing round finished",
    "oplog.recovered": "Pending operations were recovered",
    "persistence.recovery.failed": "Persistence recovery failed",
  },
  drive: {
    "upload.requested": "A Drive upload started",
    "upload.completed": "A Drive upload succeeded",
    "upload.failed": "A Drive upload failed",
    "download.requested": "A Drive download started",
    "download.completed": "A Drive download succeeded",
    "download.failed": "A Drive download failed",
    "ratelimit.detected": "Drive reported a rate limit",
    "retry.scheduled": "A Drive retry was scheduled",
    "authorization.failed": "Drive rejected the credential/permission",
    "revision.conflict": "A file revision conflict was detected",
  },
  lifecycle: {
    "background.boot": "This background context executed its top-level init",
    "runtime.initialized": "A sync runtime was constructed",
    "runtime.disposed": "A sync runtime was disposed",
    "listeners.registered": "Extension event listeners were registered",
    "listeners.removed": "Extension event listeners were removed",
    "socket.ownership.assigned": "A runtime instance took ownership of a connection",
    "socket.ownership.released": "Ownership of a connection was released",
  },
  relay: {
    "connection.accepted": "The relay accepted a WebSocket connection",
    "connection.closed": "The relay closed a connection",
    "authentication.result": "The relay recorded an authentication result",
    "subscription.changed": "A client subscribed or unsubscribed",
    "operation.received": "The relay received a client operation",
    "operation.forwarded": "The relay forwarded an operation to peers",
    "operation.buffered": "The relay buffered an operation",
    "authorization.denied": "The relay denied an authorization attempt",
    "error": "The relay logged an error",
  },
  harness: {
    "scenario.started": "A test scenario started",
    "scenario.completed": "A test scenario completed",
    "scenario.failed": "A test scenario failed",
    "fault.injected": "A fault was injected (mock/local mode only)",
    "fault.cleared": "An injected fault was removed",
    "capture.started": "A trace capture started",
    "capture.stopped": "A trace capture stopped",
  },
} as const satisfies Record<DebugComponent, Record<string, string>>;

export type DebugEventName<C extends DebugComponent = DebugComponent> =
  keyof (typeof DEBUG_EVENTS)[C] & string;

/** One diagnostic event. Optional identity fields are omitted, never null. */
export interface DebugEvent {
  schemaVersion: typeof DEBUG_SCHEMA_VERSION;
  /** Producer wall clock, ISO-8601. Not comparable across machines. */
  timestamp: string;
  /** Producer monotonic clock (ms since an arbitrary origin), for durations. */
  monotonicTime?: number;
  /** Per-producer strictly increasing order; gaps mean dropped telemetry. */
  sequenceNumber: number;

  traceId?: string;
  spanId?: string;
  parentSpanId?: string;

  /** Stable identifier of the extension instance / harness process. */
  clientId?: string;
  /** One run/boot of that instance (distinct from a user identity). */
  sessionId?: string;
  userId?: string;
  boardId?: string;
  connectionId?: string;
  operationId?: string;

  component: DebugComponent;
  event: string;
  severity: DebugSeverity;

  /** Which execution context emitted the event (background, sidebar, node…). */
  context?: string;
  details?: Record<string, unknown>;
}

/** What `emit` accepts: everything except the fields the bus fills in. */
export type DebugEventInput = Omit<DebugEvent, "schemaVersion" | "timestamp" | "sequenceNumber">;

/** Limits shared by every producer, transport and consumer. */
export const DEBUG_LIMITS = {
  /** Serialized upper bound for one event; larger events are rejected. */
  maxEventBytes: 16 * 1024,
  /** Details nesting depth kept during sanitisation. */
  maxDetailDepth: 4,
  /** Array entries kept per details array. */
  maxDetailArray: 24,
  /** Strings are truncated to this many characters during sanitisation. */
  maxDetailString: 480,
} as const;

/**
 * Substrings that mark a key as sensitive. Values under such keys are replaced
 * by a length marker before an event can leave the producer. This is a
 * defence-in-depth backstop: instrumentation must still project fields
 * explicitly (see `collab/diagnostics.ts` for the same convention).
 */
export const REDACTED_KEY_PATTERN = /(token|secret|privatekey|wrapkey|credential|authorization|receipt|apikey|password|cookie|sdp|keymaterial)/i;
export const REDACTION_MARKER = "[redacted]";

export type ValidationResult = { ok: true; event: DebugEvent } | { ok: false; error: string };

/** Structural validation of one event. Used by the bridge on ingest and by
 * unit tests on the producer side. Deliberately strict about the identity
 * surface (component/event/severity/sequence) and deliberately lenient about
 * `details` contents, which are component-owned. */
export function validateDebugEvent(value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, error: "event must be an object" };
  const event = value as Record<string, unknown>;
  if (event.schemaVersion !== DEBUG_SCHEMA_VERSION)
    return { ok: false, error: `schemaVersion must be ${DEBUG_SCHEMA_VERSION}` };
  if (typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp)))
    return { ok: false, error: "timestamp must be an ISO-8601 string" };
  if (typeof event.sequenceNumber !== "number" || !Number.isFinite(event.sequenceNumber) || event.sequenceNumber < 0)
    return { ok: false, error: "sequenceNumber must be a non-negative finite number" };
  if (typeof event.component !== "string" || !(DEBUG_COMPONENTS as readonly string[]).includes(event.component))
    return { ok: false, error: "component must be one of the registered components" };
  if (typeof event.event !== "string" || !isValidEventName(event.component as DebugComponent, event.event))
    return { ok: false, error: `event "${String(event.event)}" is not registered for component "${String(event.component)}"` };
  if (typeof event.severity !== "string" || !(DEBUG_SEVERITIES as readonly string[]).includes(event.severity))
    return { ok: false, error: "severity must be debug|info|warn|error" };
  for (const field of ["traceId", "spanId", "parentSpanId", "clientId", "sessionId", "userId", "boardId", "connectionId", "operationId", "context"] as const) {
    const id = event[field];
    if (id !== undefined && (typeof id !== "string" || id.length === 0 || id.length > 128))
      return { ok: false, error: `${field} must be a 1–128 character string when present` };
  }
  if (event.monotonicTime !== undefined && (typeof event.monotonicTime !== "number" || !Number.isFinite(event.monotonicTime)))
    return { ok: false, error: "monotonicTime must be a finite number when present" };
  if (event.details !== undefined && (typeof event.details !== "object" || event.details === null || Array.isArray(event.details)))
    return { ok: false, error: "details must be a plain object when present" };
  return { ok: true, event: event as unknown as DebugEvent };
}

export function isValidEventName(component: DebugComponent, name: string): boolean {
  const names = DEBUG_EVENTS[component] as Record<string, string> | undefined;
  return names !== undefined && Object.prototype.hasOwnProperty.call(names, name);
}

/** Approximate serialized size used for size caps (UTF-16 length × 2 is a
 * conservative cheap bound; the bridge recomputes exactly when needed). */
export function approxEventBytes(event: DebugEvent): number {
  try {
    return JSON.stringify(event).length * 2;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Filters accepted by `pboard_debug_get_events`, the dashboard and live
 * subscriptions. All fields are optional AND-ed predicates. */
export interface DebugEventFilter {
  clientId?: string;
  context?: string;
  component?: DebugComponent | DebugComponent[];
  event?: string | string[];
  severity?: DebugSeverity[];
  traceId?: string;
  operationId?: string;
  connectionId?: string;
  boardId?: string;
  sessionId?: string;
  /** Only events at or after this ISO timestamp (this machine's clock). */
  since?: string;
  /** Full-text match against event name + string detail values (slow path). */
  text?: string;
}

export function eventMatchesFilter(event: DebugEvent, filter: DebugEventFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.clientId !== undefined && event.clientId !== filter.clientId) return false;
  if (filter.context !== undefined && event.context !== filter.context) return false;
  if (filter.component !== undefined) {
    const components = Array.isArray(filter.component) ? filter.component : [filter.component];
    if (!components.includes(event.component)) return false;
  }
  if (filter.event !== undefined) {
    const names = Array.isArray(filter.event) ? filter.event : [filter.event];
    if (!names.includes(event.event)) return false;
  }
  if (filter.severity !== undefined && !filter.severity.includes(event.severity)) return false;
  if (filter.traceId !== undefined && event.traceId !== filter.traceId) return false;
  if (filter.operationId !== undefined && event.operationId !== filter.operationId) return false;
  if (filter.connectionId !== undefined && event.connectionId !== filter.connectionId) return false;
  if (filter.boardId !== undefined && event.boardId !== filter.boardId) return false;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.since !== undefined && event.timestamp < filter.since) return false;
  if (filter.text !== undefined) {
    const needle = filter.text.toLowerCase();
    const hay = (event.event + " " + safeStringify(event.details)).toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** A correlated trace: all events sharing one trace/operation id. */
export interface TraceView {
  traceId: string;
  operationId?: string;
  startedAt: string;
  endedAt: string;
  complete: boolean;
  stages: TraceStage[];
  missingStages: string[];
  duplicateStages: string[];
  errors: DebugEvent[];
}

export interface TraceStage {
  timestamp: string;
  monotonicTime?: number;
  clientId?: string;
  context?: string;
  event: string;
  severity: DebugSeverity;
  /** ms since the previous stage in this trace (same producer only). */
  sincePreviousMs?: number;
  details?: Record<string, unknown>;
}

/** Stages a full card operation should produce, in order. The bridge reports
 * a trace `complete` when every stage was observed; missing stages are
 * reported, never invented. Absence of an event never proves absence of the
 * application-level action — observers can be disconnected. */
export const CARD_OPERATION_TRACE_STAGES: { component: DebugComponent; event: string }[] = [
  { component: "sync", event: "operation.created" },
  { component: "sync", event: "operation.queued" },
  { component: "websocket", event: "message.sent" },
  { component: "relay", event: "operation.received" },
  { component: "relay", event: "operation.forwarded" },
  { component: "websocket", event: "message.received" },
  { component: "sync", event: "operation.applied" },
];
