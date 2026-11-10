/**
 * Trace correlation: fold events that share a trace/operation id into an
 * ordered stage list, report missing/duplicate stages honestly.
 *
 * Correlation ids: `traceId` is introduced only where instrumentation can
 * attach one cheaply (e.g. a scenario runner stamping its client-side
 * events); otherwise events correlate by the production `operationId`, which
 * is preserved unchanged. Trace ids never alter synchronization semantics —
 * they are observability-only.
 */

import { CARD_OPERATION_TRACE_STAGES, type DebugEvent, type TraceStage, type TraceView } from "./schema.ts";

/** Index of events by traceId and operationId. The bridge keeps one;
 * captures are analysed with a fresh instance. */
export class TraceIndex {
  private readonly byTrace = new Map<string, DebugEvent[]>();
  private readonly operationTraces = new Map<string, Set<string>>();

  observe(event: DebugEvent): void {
    const key = event.traceId ?? (event.operationId ? `op:${event.operationId}` : undefined);
    if (!key) return;
    const list = this.byTrace.get(key) ?? [];
    list.push(event);
    // Keep the trace small on purpose: a long-running operation (a board's
    // steady traffic) must not grow an unbounded trace.
    if (list.length > 2_000) list.shift();
    this.byTrace.set(key, list);
    if (event.operationId) {
      const traces = this.operationTraces.get(event.operationId) ?? new Set<string>();
      traces.add(key);
      this.operationTraces.set(event.operationId, traces);
    }
  }

  byTraceId(traceId: string): DebugEvent[] | undefined {
    return this.byTrace.get(traceId);
  }

  byOperationId(operationId: string): DebugEvent[] {
    const traces = this.operationTraces.get(operationId);
    if (!traces) return [];
    const merged: DebugEvent[] = [];
    for (const trace of traces) merged.push(...(this.byTrace.get(trace) ?? []));
    merged.sort((a, b) => a.sequenceNumber - b.sequenceNumber || a.timestamp.localeCompare(b.timestamp));
    return merged;
  }

  /** Trace ids with at least one error, or with a missing expected stage. */
  suspicious(limit = 20): string[] {
    const result: string[] = [];
    for (const [key, events] of this.byTrace) {
      if (events.some((event) => event.severity === "error")) result.push(key);
      else if (key.startsWith("op:") && !cardOperationComplete(events).complete) result.push(key);
      if (result.length >= limit) break;
    }
    return result;
  }

  clear(): void {
    this.byTrace.clear();
    this.operationTraces.clear();
  }
}

export function buildTraceView(events: DebugEvent[], id: string): TraceView | undefined {
  if (events.length === 0) return undefined;
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequenceNumber - b.sequenceNumber);
  const stages: TraceStage[] = [];
  let previous: DebugEvent | undefined;
  for (const event of ordered) {
    stages.push({
      timestamp: event.timestamp,
      ...(event.monotonicTime !== undefined ? { monotonicTime: event.monotonicTime } : {}),
      ...(event.clientId ? { clientId: event.clientId } : {}),
      ...(event.context ? { context: event.context } : {}),
      event: event.event,
      severity: event.severity,
      ...(previous && previous.clientId === event.clientId && previous.monotonicTime !== undefined && event.monotonicTime !== undefined
        ? { sincePreviousMs: Math.round((event.monotonicTime - previous.monotonicTime) * 10) / 10 }
        : {}),
      ...(event.details ? { details: event.details } : {}),
    });
    previous = event;
  }
  const { missing, duplicates, complete } = cardOperationComplete(ordered);
  const operationId = ordered.find((event) => event.operationId)?.operationId;
  return {
    traceId: id,
    ...(operationId ? { operationId } : {}),
    startedAt: ordered[0].timestamp,
    endedAt: ordered[ordered.length - 1].timestamp,
    complete,
    stages,
    missingStages: missing,
    duplicateStages: duplicates,
    errors: ordered.filter((event) => event.severity === "error"),
  };
}

/** Which of the expected card-operation stages were observed. `complete`
 * means every stage has an event; it does NOT prove correctness, and a
 * missing stage does NOT prove the application step never ran — observers
 * can be disconnected and telemetry can be dropped. */
export function cardOperationComplete(events: DebugEvent[]): { complete: boolean; missing: string[]; duplicates: string[] } {
  // No severity filter: per-frame `message.sent`/`message.received` carry an
  // operationId only when they concern an operation, so within one trace each
  // expected stage should appear exactly once regardless of severity, and a
  // second occurrence is a genuine duplicate/retry worth reporting.
  const seen = new Map<string, number>();
  for (const event of events) {
    const key = `${event.component}:${event.event}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const missing: string[] = [];
  const duplicates: string[] = [];
  for (const stage of CARD_OPERATION_TRACE_STAGES) {
    const key = `${stage.component}:${stage.event}`;
    const count = seen.get(key) ?? 0;
    if (count === 0) missing.push(key);
    else if (count > 1) duplicates.push(key);
  }
  return { complete: missing.length === 0, missing, duplicates };
}

/** All traces in a batch of events, newest first. */
export function correlateTraces(events: DebugEvent[], limit = 20): TraceView[] {
  const index = new TraceIndex();
  for (const event of events) index.observe(event);
  const seenKeys = new Set<string>();
  const views: TraceView[] = [];
  const groups = [...events]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((event) => event.traceId ?? (event.operationId ? `op:${event.operationId}` : undefined));
  for (const key of groups) {
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const group = index.byTraceId(key) ?? index.byOperationId(key.slice(3));
    const view = buildTraceView(group, key);
    if (view) views.push(view);
    if (views.length >= limit) break;
  }
  return views;
}
