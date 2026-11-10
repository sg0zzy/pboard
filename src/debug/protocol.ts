/**
 * Wire protocol between diagnostic clients, the Debug Bridge, and MCP/tools.
 *
 * Kept browser-safe (no Node imports) so the extension, the bridge and the
 * MCP server share one definition. HTTP endpoints (all loopback by default):
 *
 *  POST /ingest            client → bridge: { protocol, clientId, sessionId,
 *                          context, label?, events: DebugEvent[] }
 *  GET  /inspect/request   client poll: bridge answers {} or { requestId, scope? }
 *  POST /inspect/respond   client answers: { requestId, snapshot }
 *  GET  /status            bridge self-status (counts, drops, uptime, modes)
 *  GET  /events?…          historical query (filter JSON + limit + cursor)
 *  GET  /events/subscribe  WebSocket subscription (text frames, protocol below)
 *  GET  /clients /sessions /connections /connections/checks
 *  GET  /trace?traceId= | /trace?operationId=
 *  POST /capture/start|stop|export  trace capture controls
 *  GET  /inspect/<clientId>  queued read-only state inspection (pull model)
 *  POST /command           harness control (mock mode only): { action, args }
 *
 * Subscription frames are JSON: client→bridge {type:"subscribe",filter?}
 * {type:"unsubscribe",id} {type:"ping"}; bridge→client {type:"welcome",…}
 * {type:"events",events,seq} {type:"dropped",count} {type:"pong"}.
 */

import type { DebugEvent, DebugEventFilter } from "./schema.ts";

export const BRIDGE_DEFAULT_PORT = 8790;
export const BRIDGE_DEFAULT_HOST = "127.0.0.1";

/** Ingest envelope sent by `HttpBridgeTransport.send`. */
export interface IngestEnvelope {
  protocol: number;
  clientId: string;
  sessionId: string;
  context: string;
  label?: string;
  events: DebugEvent[];
}

export interface IngestResponse {
  ok: boolean;
  accepted: number;
  rejected: number;
  /** Why the batch (partially) failed; never echoes event contents. */
  error?: string;
}

/** Envelope the bridge stores: producer event + bridge receive stamp. */
export interface StoredDebugEvent extends DebugEvent {
  /** Bridge receive wall clock. Ordering across producers uses this, never
   * the producer timestamp. */
  receivedAt: string;
  /** Bridge-global monotonic sequence, dense within the buffer's lifetime. */
  bridgeSeq: number;
}

/** One client as the bridge's registry sees it. */
export interface BridgeClientInfo {
  clientId: string;
  contexts: string[];
  sessionIds: string[];
  label?: string;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  /** Count of events the *bridge* rejected from this client. */
  rejectedCount: number;
}

export type BridgeMode = "mock" | "local" | "production-observer";

export interface BridgeStatus {
  ok: true;
  uptimeMs: number;
  /** Always 127.0.0.1 unless explicitly exposed (then the reason is logged). */
  host: string;
  port: number;
  mode: BridgeMode;
  eventBufferCapacity: number;
  eventBufferLength: number;
  droppedByOverflow: number;
  rejectedEvents: number;
  subscriptions: number;
  captures: { active: number; stored: number };
  clients: number;
  schemaVersion: number;
  serverVersion: string;
  /** Cursor at the end of the current buffer: start watching from here. */
  latestCursor: number;
}

export interface EventQuery extends DebugEventFilter {
  /** Bridge cursor (`bridgeSeq` exclusive) or ISO timestamp. */
  after?: string;
  limit?: number;
}

export interface EventQueryResult {
  events: StoredDebugEvent[];
  /** Pass as `after` on the next poll; dense per bridge lifetime. */
  nextCursor: string;
  truncated: boolean;
  /** Buffer overflow happened during this client's gap: older events the
   * caller never saw may have been evicted. Honest incompleteness, always. */
  bufferOverflown: boolean;
}

/** A recorded capture file (`test-results/debug-traces/*.json`). */
export interface TraceCaptureFile {
  kind: "pboard-debug-capture";
  captureVersion: 1;
  schemaVersion: number;
  metadata: {
    /** Stable short id assigned at capture start; matches the exported file
     * name and the `/captures/:id` lookup key. */
    captureId: string;
    startedAt: string;
    stoppedAt?: string;
    label?: string;
    mode: BridgeMode;
    environment: string;
    seed?: string;
    clientIds: string[];
    filter?: DebugEventFilter;
    failureSummary?: string;
  };
  connections: {
    connectionId: string;
    clientId?: string;
    trigger?: string;
    room?: string;
    state: string;
    requestedAt?: string;
    openedAt?: string;
    closedAt?: string;
    closeCode?: number;
    closeCause?: string;
    reconnectScheduled: number;
  }[];
  events: StoredDebugEvent[];
  /** Counts when events were dropped to respect the export cap. */
  truncatedEvents?: number;
}

/** Client-side inspector payload: the answer to a queued inspection. The
 * projection is produced by the *client's* own instrumentation — the bridge
 * only relays — and must contain only the controlled, read-only fields
 * documented in docs/debugging (no raw documents, no credentials). */
export interface ClientStateSnapshot {
  kind: "board-state" | "sync-state" | "connection-state";
  /** Which execution context produced this snapshot: two contexts of one
   * client see different rooms, and the reader must know whose truth it is
   * looking at. */
  context?: string;
  clientId: string;
  sessionId: string;
  capturedAt: string;
  /** Presence/count/identity data by default; contents only when the client
   * explicitly authorised board contents. */
  boards: BoardStateEntry[];
  connections: {
    connectionId: string;
    state: string;
    trigger?: string;
    room?: string;
  }[];
  sync?: Record<string, unknown>;
  /** Set when the client refused to include sensitive fields. */
  restricted?: string;
}

export interface BoardStateEntry {
  boardId: string;
  open: boolean;
  cardCount?: number;
  pendingOperations?: number;
  syncState?: string;
  lastSyncedAt?: string;
  snapshot?: { phase?: string; appliedSeq?: number; created?: string };
  oplog?: { pending?: number; appliedSeq?: number };
}

export function parseEventFilter(raw: string | null): DebugEventFilter | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as DebugEventFilter;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
