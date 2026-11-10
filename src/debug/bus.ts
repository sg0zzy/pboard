/**
 * Diagnostic event bus (browser-agnostic core).
 *
 * `emit` is synchronous and bounded: it sanitises and validates the event,
 * assigns the producer sequence number, and hands the event to an async
 * drain loop that forwards batches to the configured transport. It never
 * awaits, never throws, and never blocks the caller; when the queue is full
 * it drops the oldest debug/info events (warn/error survive) and records the
 * drop count so the bridge can report incomplete traces honestly.
 *
 * Disabled (the default, and the state of every production build): `emit`
 * checks one boolean and returns.
 */

import {
  DEBUG_SCHEMA_VERSION,
  approxEventBytes,
  REDACTED_KEY_PATTERN,
  REDACTION_MARKER,
  validateDebugEvent,
  DEBUG_LIMITS,
  type DebugEvent,
  type DebugEventInput,
} from "./schema.ts";

export interface DebugTransport {
  /** Best-effort batch delivery. May drop; may fail; must never throw to the
   * caller and must never block synchronously on the network. */
  send(events: DebugEvent[]): void;
  close?(): void;
}

export interface DebugIdentity {
  clientId: string;
  sessionId: string;
  context: string;
  userId?: string;
}

export interface DebugBusOptions {
  enabled: boolean;
  /** Read lazily so identity can arrive after boot. */
  identity: () => DebugIdentity | undefined;
  transport: () => DebugTransport | undefined;
  /** Upper bound on queued (not yet forwarded) events. */
  maxQueue?: number;
  /** Forward when this many events have accumulated, without waiting. */
  batchSize?: number;
  /** Even below batchSize, flush within this many ms. */
  flushDelayMs?: number;
  /** Injectable clock for tests. */
  now?: () => { wallClock: string; monotonic: number };
  logger?: (message: string) => void;
}

export interface DebugDropReport {
  queue: number;
  oversized: number;
  invalid: number;
  transport: number;
}

let queue: DebugEvent[] = [];
let sequence = 0;
let drainScheduled = false;
let transportFailureStreak = 0;
const drops: DebugDropReport = { queue: 0, oversized: 0, invalid: 0, transport: 0 };
let options: DebugBusOptions = {
  enabled: false,
  identity: () => undefined,
  transport: () => undefined,
};

const DEFAULT_MAX_QUEUE = 2_000;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_DELAY_MS = 250;
/** After this many consecutive transport failures, stop retrying drains for a
 * while: a dead bridge must not become a periodic timer cost. The next emit
 * that finds the transport alive resumes; the transport itself decides. */
const TRANSPORT_FAILURE_COOLDOWN_MS = 30_000;
let transportCoolingUntil = 0;

export function configureDebugBus(next: DebugBusOptions): void {
  options = next;
  if (!next.enabled) {
    queue = [];
    drainScheduled = false;
  }
}

export function resetDebugBus(): void {
  configureDebugBus({ enabled: false, identity: () => undefined, transport: () => undefined });
  sequence = 0;
  drops.queue = drops.oversized = drops.invalid = drops.transport = 0;
  transportFailureStreak = 0;
  transportCoolingUntil = 0;
}

export function debugBusEnabled(): boolean {
  return options.enabled;
}

export function debugDropReport(): Readonly<DebugDropReport> {
  return { ...drops };
}

/** The default monotonic source: `performance.now` where present. */
function defaultNow(): { wallClock: string; monotonic: number } {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return { wallClock: new Date().toISOString(), monotonic: perf ? perf.now() : Date.now() };
}

/**
 * Emits one diagnostic event. Fire-and-forget: never throws, never awaits.
 * Returns the sequence number assigned, or 0 when the event was disabled or
 * rejected (0 is never a real sequence, which starts at 1).
 */
export function emit(input: DebugEventInput): number {
  if (!options.enabled) return 0;
  try {
    return emitEnabled(input);
  } catch {
    // The diagnostic path must be unthrowable by construction; swallowing is
    // the designed behaviour, and it is counted rather than silent.
    drops.invalid += 1;
    return 0;
  }
}

function emitEnabled(input: DebugEventInput): number {
  const identity = options.identity();
  if (!identity) return 0; // no identity yet: instrumented code runs before boot
  const clock = (options.now ?? defaultNow)();
  const event: DebugEvent = {
    schemaVersion: DEBUG_SCHEMA_VERSION,
    timestamp: clock.wallClock,
    ...(clock.monotonic !== undefined ? { monotonicTime: round1(clock.monotonic) } : {}),
    sequenceNumber: ++sequence,
    ...(identity.userId && input.userId === undefined ? { userId: identity.userId } : {}),
    ...pruneUndefined({
      clientId: identity.clientId,
      sessionId: identity.sessionId,
      context: identity.context,
    }),
    ...pruneUndefined({
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      userId: input.userId,
      clientId: input.clientId,
      sessionId: input.sessionId,
      boardId: input.boardId,
      connectionId: input.connectionId,
      operationId: input.operationId,
    }),
    component: input.component,
    event: input.event,
    severity: input.severity ?? "info",
    ...(input.details !== undefined ? { details: sanitizeDetails(input.details) } : {}),
  };
  const validation = validateDebugEvent(event);
  if (!validation.ok) {
    drops.invalid += 1;
    return 0;
  }
  if (approxEventBytes(event) > DEBUG_LIMITS.maxEventBytes) {
    drops.oversized += 1;
    return 0;
  }
  enqueue(event);
  return event.sequenceNumber;
}

function enqueue(event: DebugEvent): void {
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  if (queue.length >= maxQueue) {
    // Drop the oldest droppable event; warn/error are preserved.
    const victim = queue.findIndex((entry) => entry.severity === "debug" || entry.severity === "info");
    if (victim < 0) {
      drops.queue += 1;
      return; // the queue is entirely warn/error and full: drop the newcomer
    }
    queue.splice(victim, 1);
    drops.queue += 1;
  }
  queue.push(event);
  scheduleDrain();
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (queue.length >= batchSize) {
    drain();
    return;
  }
  drainScheduled = true;
  const delay = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  // queueMicrotask would starve batching under sustained load; the timer is
  // the whole point (bounded send count), and a page teardown loses at most
  // one flush window, which the drop report counts honestly.
  setTimeout(() => {
    drainScheduled = false;
    drain();
  }, delay);
}

function drain(): void {
  if (queue.length === 0) return;
  const transport = options.transport();
  if (!transport) {
    return; // keep queue bounded: transport owns reconnection; drops counted on overflow
  }
  if (Date.now() < transportCoolingUntil) return;
  const batch = queue.splice(0, options.batchSize ?? DEFAULT_BATCH_SIZE);
  try {
    transport.send(batch);
    transportFailureStreak = 0;
  } catch (error) {
    drops.transport += batch.length;
    transportFailureStreak += 1;
    if (transportFailureStreak === 5) {
      transportCoolingUntil = Date.now() + TRANSPORT_FAILURE_COOLDOWN_MS;
      options.logger?.(`debug bridge transport failing; pausing delivery for ${TRANSPORT_FAILURE_COOLDOWN_MS / 1000}s`);
    }
    void error;
  }
  if (queue.length > 0 && Date.now() >= transportCoolingUntil) scheduleDrain();
}

export function pendingEventCount(): number {
  return queue.length;
}

/** Test seam: force a synchronous drain into the current transport. */
export function flushDebugBus(): void {
  drainScheduled = false;
  transportCoolingUntil = 0;
  while (queue.length > 0) drain();
}

// ---------------------------------------------------------------------------
// sanitisation and redaction

/** Depth-bounded copy that drops undefined, truncates strings/arrays, and
 * replaces values under sensitive keys. Returns a fresh object: the bus never
 * retains the caller's `details` graph. */
export function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecord(details, 0);
}

function sanitizeRecord(source: Record<string, unknown>, depth: number, limit = Infinity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (++kept > limit) {
      out["…"] = `${Object.keys(source).length - kept + 1} more keys`;
      break;
    }
    if (REDACTED_KEY_PATTERN.test(key)) {
      out[key] = REDACTION_MARKER;
      continue;
    }
    out[key] = sanitizeValue(value, depth + 1);
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value.length > DEBUG_LIMITS.maxDetailString ? value.slice(0, DEBUG_LIMITS.maxDetailString) + "…" : value;
    case "number":
      return Number.isFinite(value) ? round1(value) : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
      return "[function]";
    case "symbol":
      return String(value);
  }
  if (depth >= DEBUG_LIMITS.maxDetailDepth) return "[depth]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, DEBUG_LIMITS.maxDetailArray).map((entry) => sanitizeValue(entry, depth));
    if (value.length > DEBUG_LIMITS.maxDetailArray) kept.push(`+${value.length - DEBUG_LIMITS.maxDetailArray} more`);
    return kept;
  }
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeDetailsTruncatedString(value.message) };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    try {
      return sanitizeRecord(record, depth, 32);
    } catch {
      return "[unintrospectable]";
    }
  }
  return "[unknown]";
}

function sanitizeDetailsTruncatedString(message: string): string {
  return message.length > DEBUG_LIMITS.maxDetailString ? message.slice(0, DEBUG_LIMITS.maxDetailString) + "…" : message;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pruneUndefined<T extends Record<string, string | undefined>>(record: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(record) as (keyof T)[]) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
