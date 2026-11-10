/**
 * Live Debug Bridge — core state, no HTTP.
 *
 * Holds the bounded event buffer, client/connection/trace registries, live
 * subscriptions, queued inspections, and trace captures. `server.ts` wraps it
 * in the loopback HTTP/WS surface; `tests/debugBridge.test.ts` exercises it
 * directly. Every collection here is bounded by construction; overflow is
 * counted and reported, never silently swallowed.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEBUG_SCHEMA_VERSION,
  validateDebugEvent,
  eventMatchesFilter,
  type DebugEventFilter,
} from "../../src/debug/schema.ts";
import { ConnectionRegistry, type ConnectionFinding } from "../../src/debug/connectionRegistry.ts";
import { TraceIndex, buildTraceView, correlateTraces } from "../../src/debug/trace.ts";
import type {
  BridgeClientInfo,
  BridgeMode,
  BridgeStatus,
  ClientStateSnapshot,
  EventQuery,
  EventQueryResult,
  IngestEnvelope,
  IngestResponse,
  StoredDebugEvent,
  TraceCaptureFile,
} from "../../src/debug/protocol.ts";
import type { TraceView } from "../../src/debug/schema.ts";

export const BRIDGE_VERSION = "1.0.0";

export interface BridgeOptions {
  /** Maximum events retained in the ring (default 20 000). */
  maxEvents?: number;
  /** Maximum accepted serialized size of one ingest batch (default 1 MiB). */
  maxIngestBytes?: number;
  /** Maximum live subscriptions (default 16). */
  maxSubscriptions?: number;
  /** Maximum events one capture records (default 100 000). */
  maxCaptureEvents?: number;
  /** Directory captures are written to. */
  captureDir?: string;
  /** Shared token; when set, every request must present it. */
  token?: string;
  mode?: BridgeMode;
  /** Label recorded into captures (dev/diagnostic build, CI, …). */
  environment?: string;
  /** Test seam. */
  now?: () => number;
}

export interface Subscription {
  id: string;
  filter?: DebugEventFilter;
  /** Returns false when the consumer is too slow and must be dropped. */
  deliver: (frame: string) => boolean;
}

export interface ActiveCapture {
  id: string;
  startedAt: string;
  label?: string;
  filter?: DebugEventFilter;
  seed?: string;
  events: StoredDebugEvent[];
  dropped: number;
  stoppedAt?: string;
  failureSummary?: string;
}

type PendingInspection = { requestId: string; scope?: string; createdAt: number };
type InspectionWaiter = { resolve: (snapshot: ClientStateSnapshot | undefined) => void; timer: ReturnType<typeof setTimeout> };
type InspectionEntry = { queue: PendingInspection[]; waiters: Map<string, InspectionWaiter> };

export class DebugBridgeCore {
  readonly events: StoredDebugEvent[] = [];
  private head = 0;
  private bridgeSeq = 0;
  private overflowCount = 0;
  /** Highest `bridgeSeq` at the moment of the last overflow: consumers whose
   * cursor is below it learn their view skipped history. */
  private overflowedThrough = 0;
  private rejectedEvents = 0;
  private oversizedBatches = 0;
  private readonly startedAt = Date.now();
  private readonly now: () => number;
  readonly registry = new ConnectionRegistry();
  readonly traces = new TraceIndex();
  readonly clients = new Map<string, BridgeClientInfo>();
  readonly subscriptions = new Map<string, Subscription>();
  private readonly inspections = new Map<string, InspectionEntry>();
  private readonly faultQueue: { id: string; clientId: string; action: string; args?: Record<string, unknown>; queuedAt: string }[] = [];
  private activeCapture: ActiveCapture | undefined;
  private readonly stoppedCaptures = new Map<string, TraceCaptureFile>();
  readonly mode: BridgeMode;
  /** Set by the HTTP server once listening; reported by /status. */
  boundPort = 0;

  private readonly maxEvents: number;
  readonly maxIngestBytes: number;
  readonly maxSubscriptions: number;
  private readonly maxCaptureEvents: number;
  private readonly captureDir: string;
  private readonly token: string | undefined;
  readonly environment: string;

  constructor(options: BridgeOptions = {}) {
    this.maxEvents = options.maxEvents ?? 20_000;
    this.maxIngestBytes = options.maxIngestBytes ?? 1024 * 1024;
    this.maxSubscriptions = options.maxSubscriptions ?? 16;
    this.maxCaptureEvents = options.maxCaptureEvents ?? 100_000;
    this.captureDir = resolve(options.captureDir ?? "test-results/debug-traces");
    this.token = options.token?.trim() || undefined;
    this.mode = options.mode ?? "local";
    this.environment = options.environment ?? "local";
    this.now = options.now ?? Date.now;
  }

  get tokenRequired(): boolean {
    return this.token !== undefined;
  }

  /** Constant-time check of a presented token against the configured one. */
  checkToken(presented: string | null): boolean {
    if (!this.token) return true;
    if (!presented) return false;
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(presented);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Ingest one client batch. Events are validated individually; a bad event
   * never rejects its neighbours (counted, never logged with contents). */
  ingest(envelope: IngestEnvelope, serializedBytes = 0): IngestResponse {
    if (serializedBytes > this.maxIngestBytes) {
      this.oversizedBatches += 1;
      return { ok: false, accepted: 0, rejected: Array.isArray(envelope?.events) ? envelope.events.length : 0, error: "batch exceeds bridge size limit" };
    }
    if (envelope.protocol !== 1 || typeof envelope.clientId !== "string" || !envelope.clientId)
      return { ok: false, accepted: 0, rejected: 0, error: "unsupported ingest envelope" };
    let accepted = 0;
    let rejected = 0;
    const stored: StoredDebugEvent[] = [];
    for (const raw of Array.isArray(envelope.events) ? envelope.events : []) {
      const result = validateDebugEvent(raw);
      if (!result.ok) {
        rejected += 1;
        this.rejectedEvents += 1;
        continue;
      }
      const event = result.event;
      if (envelope.clientId && event.clientId && event.clientId !== envelope.clientId) {
        // A client may not speak for another client identity.
        rejected += 1;
        this.rejectedEvents += 1;
        continue;
      }
      const stamped: StoredDebugEvent = {
        // Identity falls back to the envelope — the authenticated boundary.
        // The browser bus stamps every event; harness senders may stamp the
        // envelope only, and the registry/traces need per-event attribution
        // either way.
        ...event,
        clientId: event.clientId ?? envelope.clientId,
        sessionId: event.sessionId ?? envelope.sessionId,
        context: event.context ?? envelope.context,
        receivedAt: new Date(this.now()).toISOString(),
        bridgeSeq: ++this.bridgeSeq,
      };
      stored.push(stamped);
      accepted += 1;
    }
    for (const event of stored) {
      this.pushEvent(event);
      this.observe(event, envelope);
    }
    this.noteClient(envelope, accepted, rejected);
    return { ok: rejected === 0, accepted, rejected };
  }

  private pushEvent(event: StoredDebugEvent): void {
    if (this.events.length < this.maxEvents) {
      this.events.push(event);
    } else {
      this.events[this.head] = event;
      this.head = (this.head + 1) % this.maxEvents;
      this.overflowCount += 1;
      this.overflowedThrough = event.bridgeSeq;
    }
    if (this.activeCapture && (!this.activeCapture.filter || eventMatchesFilter(event, this.activeCapture.filter))) {
      if (this.activeCapture.events.length < this.maxCaptureEvents) this.activeCapture.events.push(event);
      else this.activeCapture.dropped += 1;
    }
    if (this.subscriptions.size > 0) {
      const frame = JSON.stringify({ type: "events", events: [event] });
      for (const subscription of [...this.subscriptions.values()]) {
        if (subscription.filter && !eventMatchesFilter(event, subscription.filter)) continue;
        if (!subscription.deliver(frame)) this.subscriptions.delete(subscription.id);
      }
    }
  }

  private observe(event: StoredDebugEvent, envelope: IngestEnvelope): void {
    this.registry.observe(event);
    this.traces.observe(event);
    void envelope;
  }

  private noteClient(envelope: IngestEnvelope, accepted: number, rejected: number): void {
    const at = new Date(this.now()).toISOString();
    const existing = this.clients.get(envelope.clientId);
    if (existing) {
      existing.lastSeen = at;
      existing.eventCount += accepted;
      existing.rejectedCount += rejected;
      if (!existing.contexts.includes(envelope.context)) existing.contexts.push(envelope.context);
      if (!existing.sessionIds.includes(envelope.sessionId)) existing.sessionIds.push(envelope.sessionId);
      if (envelope.label) existing.label = envelope.label;
      return;
    }
    this.clients.set(envelope.clientId, {
      clientId: envelope.clientId,
      contexts: [envelope.context],
      sessionIds: [envelope.sessionId],
      ...(envelope.label ? { label: envelope.label } : {}),
      firstSeen: at,
      lastSeen: at,
      eventCount: accepted,
      rejectedCount: rejected,
    });
  }

  /** The buffer contents, oldest first, as `bridgeSeq` ordered history. */
  allEvents(): StoredDebugEvent[] {
    if (this.events.length < this.maxEvents) return this.events.slice();
    return [...this.events.slice(this.head), ...this.events.slice(0, this.head)];
  }

  queryEvents(query: EventQuery = {}): EventQueryResult {
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 5_000);
    const afterSeq = parseAfter(query.after);
    const matched: StoredDebugEvent[] = [];
    for (const event of this.allEvents()) {
      if (afterSeq !== undefined && event.bridgeSeq <= afterSeq) continue;
      if (!eventMatchesFilter(event, query)) continue;
      matched.push(event);
    }
    const truncated = matched.length > limit;
    const page = truncated ? matched.slice(matched.length - limit) : matched;
    const lastSeq = page.length > 0 ? page[page.length - 1].bridgeSeq : (afterSeq ?? 0);
    return {
      events: page,
      nextCursor: String(lastSeq),
      truncated,
      bufferOverflown: afterSeq !== undefined ? this.overflowedThrough > afterSeq : this.overflowCount > 0,
    };
  }

  latestCursor(): string {
    return String(this.bridgeSeq);
  }

  connectionFindings(clientId?: string): ConnectionFinding[] {
    if (!clientId) return this.registry.checks();
    return this.registry.checks().filter((finding) =>
      this.registry.get(finding.connectionIds[0])?.clientId === clientId || finding.key === clientId);
  }

  traceFor(traceId: string): TraceView | undefined {
    const events = this.traces.byTraceId(traceId) ?? this.traces.byOperationId(traceId.startsWith("op:") ? traceId.slice(3) : traceId);
    return buildTraceView(events, traceId);
  }

  recentTraces(limit = 10): TraceView[] {
    return correlateTraces(this.allEvents(), limit);
  }

  status(): BridgeStatus {
    return {
      ok: true,
      uptimeMs: this.now() - this.startedAt,
      host: "127.0.0.1",
      port: this.boundPort,
      mode: this.mode,
      eventBufferCapacity: this.maxEvents,
      eventBufferLength: Math.min(this.events.length, this.maxEvents),
      droppedByOverflow: this.overflowCount,
      rejectedEvents: this.rejectedEvents,
      subscriptions: this.subscriptions.size,
      captures: { active: this.activeCapture && !this.activeCapture.stoppedAt ? 1 : 0, stored: this.stoppedCaptures.size },
      clients: this.clients.size,
      schemaVersion: DEBUG_SCHEMA_VERSION,
      serverVersion: BRIDGE_VERSION,
      latestCursor: this.bridgeSeq,
    };
  }

  // --- subscriptions --------------------------------------------------------

  addSubscription(subscription: Subscription): boolean {
    if (this.subscriptions.size >= this.maxSubscriptions) return false;
    this.subscriptions.set(subscription.id, subscription);
    return true;
  }

  removeSubscription(id: string): void {
    this.subscriptions.delete(id);
  }

  // --- pull inspections ------------------------------------------------------

  /** Queue a state inspection for `clientId`; resolves when the client's poll
   * picks it up and answers, or undefined on timeout (client not running —
   * which is itself the honest answer). */
  requestInspection(clientId: string, scope?: string, timeoutMs = 12_000): Promise<ClientStateSnapshot | undefined> {
    const entry: InspectionEntry = this.inspections.get(clientId) ?? { queue: [], waiters: new Map() };
    this.inspections.set(clientId, entry);
    const request: PendingInspection = { requestId: randomUUID(), createdAt: this.now(), ...(scope ? { scope } : {}) };
    entry.queue.push(request);
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        entry.waiters.delete(request.requestId);
        entry.queue = entry.queue.filter((queued) => queued.requestId !== request.requestId);
        resolvePromise(undefined);
      }, timeoutMs);
      entry.waiters.set(request.requestId, { resolve: resolvePromise, timer });
    });
  }

  /** A client poll: hand out the oldest outstanding inspection, if any. */
  pollInspection(clientId: string): { requestId: string; scope?: string } | undefined {
    const entry = this.inspections.get(clientId);
    const request = entry?.queue.shift();
    if (!request) return undefined;
    return { requestId: request.requestId, ...(request.scope ? { scope: request.scope } : {}) };
  }

  respondInspection(clientId: string, requestId: string, snapshot: unknown): boolean {
    const entry = this.inspections.get(clientId);
    const waiter = entry?.waiters.get(requestId);
    if (!entry || !waiter) return false;
    clearTimeout(waiter.timer);
    entry.waiters.delete(requestId);
    entry.queue = entry.queue.filter((queued) => queued.requestId !== requestId);
    waiter.resolve(snapshot && typeof snapshot === "object" ? snapshot as ClientStateSnapshot : undefined);
    return true;
  }

  // --- fault commands (mock mode) --------------------------------------------

  /** Queue a fault-injection command for the harness client to pick up.
   * Rejected outside mock mode: production observation must stay read-only. */
  queueFault(clientId: string, action: string, args?: Record<string, unknown>): { id: string } | { error: string } {
    if (this.mode !== "mock") return { error: `fault injection is not available in mode "${this.mode}"` };
    const command = { id: randomUUID(), clientId, action, ...(args ? { args } : {}), queuedAt: new Date(this.now()).toISOString() };
    this.faultQueue.push(command);
    return { id: command.id };
  }

  pollFaults(clientId: string): { id: string; action: string; args?: Record<string, unknown> }[] {
    const mine = this.faultQueue.filter((command) => command.clientId === clientId);
    this.faultQueue.splice(0, this.faultQueue.length, ...this.faultQueue.filter((command) => command.clientId !== clientId));
    return mine.map(({ id, action, args }) => ({ id, action, ...(args ? { args } : {}) }));
  }

  // --- captures ---------------------------------------------------------------

  startCapture(options: { label?: string; filter?: DebugEventFilter; seed?: string } = {}): { captureId: string } {
    if (this.activeCapture && !this.activeCapture.stoppedAt)
      return { captureId: this.activeCapture.id };
    this.activeCapture = {
      id: randomUUID().slice(0, 8),
      startedAt: new Date(this.now()).toISOString(),
      ...(options.label ? { label: options.label } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.seed ? { seed: options.seed } : {}),
      events: [],
      dropped: 0,
    };
    return { captureId: this.activeCapture.id };
  }

  stopCapture(failureSummary?: string): TraceCaptureFile | undefined {
    const capture = this.activeCapture;
    if (!capture) return undefined;
    capture.stoppedAt = new Date(this.now()).toISOString();
    if (failureSummary) capture.failureSummary = failureSummary;
    const file = this.captureFile(capture);
    this.stoppedCaptures.set(capture.id, file);
    this.activeCapture = undefined;
    return file;
  }

  private captureFile(capture: ActiveCapture): TraceCaptureFile {
    const clientIds = [...new Set(capture.events.map((event) => event.clientId).filter((id): id is string => !!id))];
    return {
      kind: "pboard-debug-capture",
      captureVersion: 1,
      schemaVersion: DEBUG_SCHEMA_VERSION,
      metadata: {
        captureId: capture.id,
        startedAt: capture.startedAt,
        ...(capture.stoppedAt ? { stoppedAt: capture.stoppedAt } : {}),
        ...(capture.label ? { label: capture.label } : {}),
        mode: this.mode,
        environment: this.environment,
        ...(capture.seed ? { seed: capture.seed } : {}),
        clientIds,
        ...(capture.filter ? { filter: capture.filter } : {}),
        ...(capture.failureSummary ? { failureSummary: capture.failureSummary } : {}),
      },
      connections: this.registry.list().map((entry) => ({
        connectionId: entry.connectionId,
        ...(entry.clientId ? { clientId: entry.clientId } : {}),
        ...(entry.trigger ? { trigger: entry.trigger } : {}),
        ...(entry.room ? { room: entry.room } : {}),
        state: entry.state,
        ...(entry.requestedAt ? { requestedAt: entry.requestedAt } : {}),
        ...(entry.openedAt ? { openedAt: entry.openedAt } : {}),
        ...(entry.closedAt ? { closedAt: entry.closedAt } : {}),
        ...(entry.closeCode !== undefined ? { closeCode: entry.closeCode } : {}),
        ...(entry.closeCause ? { closeCause: entry.closeCause } : {}),
        reconnectScheduled: entry.reconnectScheduled,
      })),
      events: capture.events,
      ...(capture.dropped > 0 ? { truncatedEvents: capture.dropped } : {}),
    };
  }

  writeCapture(id: string): { path: string; bytes: number } | undefined {
    const capture = this.stoppedCaptures.get(id);
    if (!capture) return undefined;
    const serialized = JSON.stringify(capture, null, 1);
    const file = resolve(this.captureDir, `capture-${id}-${capture.metadata.startedAt.slice(0, 19).replaceAll(":", "-").replaceAll(":", "")}.json`);
    mkdirSync(this.captureDir, { recursive: true });
    writeFileSync(file, serialized, "utf8");
    return { path: file, bytes: Buffer.byteLength(serialized) };
  }

  captureSummary(capture: TraceCaptureFile) {
    return {
      captureId: capture.metadata.captureId,
      startedAt: capture.metadata.startedAt,
      ...(capture.metadata.stoppedAt ? { stoppedAt: capture.metadata.stoppedAt } : {}),
      ...(capture.metadata.label ? { label: capture.metadata.label } : {}),
      events: capture.events.length,
      connections: capture.connections.length,
      clientIds: capture.metadata.clientIds,
      mode: capture.metadata.mode,
      ...(capture.metadata.failureSummary ? { failureSummary: capture.metadata.failureSummary } : {}),
    };
  }

  listCaptures(): ReturnType<DebugBridgeCore["captureSummary"]>[] {
    return [...this.stoppedCaptures.values()].map((capture) => this.captureSummary(capture));
  }

  getCapture(id: string): TraceCaptureFile | undefined {
    return this.stoppedCaptures.get(id);
  }
}

/** Cursors are bridge sequences (`bridgeSeq`), dense over the bridge's
 * lifetime. ISO timestamps filter via `since`, not the cursor. */
function parseAfter(after: string | undefined): number | undefined {
  if (after === undefined) return undefined;
  const asNumber = Number(after);
  return Number.isFinite(asNumber) ? asNumber : undefined;
}
