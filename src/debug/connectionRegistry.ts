/**
 * Connection registry: one entry per diagnostic event producer *socket*.
 *
 * This is the read-side model of "who owns a WebSocket right now": every
 * `websocket.connection.*` event (and the transport ledger it mirrors) is
 * folded into a live connection entry with owning runtime instance, trigger,
 * room, state, close cause and reconnect bookkeeping. The bridge answers the
 * duplicate/orphan questions from this registry, never from raw log scanning.
 *
 * Expected connection counts are derived from the architecture, not hardcoded
 * here: the shipped browser composition root dials, per background context,
 * at most one standing `RelaySession` socket (which per-room ownership rides
 * on), one account-channel socket when the account channel runs, short-lived
 * key-courier sockets during a courier pass, and — only when the WebSocket
 * signaling experiment is enabled — one room transport per board. `checks()`
 * flags *patterns* (same trigger+room dialled repeatedly while another socket
 * for it is still open, sockets that outlived their courier pass, several
 * live sessions in one context), and reports them as suspects with their
 * lifecycle events, leaving the verdict to the reader.
 */

import type { DebugEvent } from "./schema.ts";
import { eventMatchesFilter, type DebugEventFilter } from "./schema.ts";

export type ConnectionState = "requested" | "open" | "closing" | "closed";

export interface ConnectionEntry {
  connectionId: string;
  clientId?: string;
  sessionId?: string;
  context?: string;
  /** Which subsystem asked for the socket (`session:attach`, `courier:pass`,
   * `v2:room`, …): carried in the event's `details.trigger`. */
  trigger?: string;
  room?: string;
  boardId?: string;
  state: ConnectionState;
  requestedAt?: string;
  openedAt?: string;
  closedAt?: string;
  closeCode?: number;
  closeCause?: string;
  closeReason?: string;
  /** Count of `reconnect.scheduled` events attributed to this connection. */
  reconnectScheduled: number;
  lastReconnectDelayMs?: number;
  messagesSent: number;
  messagesReceived: number;
  /** Monotonic stamp of the most recent event that touched this connection. */
  lastActivitySequence: number;
  /** Ownership events observed for this connection. */
  ownership: "assigned" | "released" | "none";
  /** The raw events folded into this entry (bounded; newest last). */
  events: DebugEvent[];
}

const MAX_EVENTS_PER_CONNECTION = 64;

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionEntry>();

  /** Fold one websocket/lifecycle event. Returns false for events that do
   * not concern a connection (they need not carry a connectionId). */
  observe(event: DebugEvent): boolean {
    const id = event.connectionId;
    if (!id) return false;
    let entry = this.connections.get(id);
    if (!entry) {
      entry = {
        connectionId: id,
        state: "requested",
        reconnectScheduled: 0,
        messagesSent: 0,
        messagesReceived: 0,
        lastActivitySequence: event.sequenceNumber,
        ownership: "none",
        events: [],
      };
      this.connections.set(id, entry);
    }
    entry.clientId ??= event.clientId;
    entry.sessionId ??= event.sessionId;
    entry.context ??= event.context;
    entry.boardId ??= event.boardId;
    entry.lastActivitySequence = Math.max(entry.lastActivitySequence, event.sequenceNumber);
    entry.events.push(event);
    if (entry.events.length > MAX_EVENTS_PER_CONNECTION) entry.events.shift();

    const details = (event.details ?? {}) as Record<string, unknown>;
    switch (event.event) {
      case "connection.requested":
        entry.requestedAt ??= event.timestamp;
        if (typeof details.trigger === "string") entry.trigger = details.trigger;
        if (typeof details.room === "string") entry.room = details.room;
        break;
      case "connection.opened":
        entry.state = "open";
        entry.openedAt ??= event.timestamp;
        break;
      case "connection.closing":
        entry.state = "closing";
        break;
      case "connection.closed":
        entry.state = "closed";
        entry.closedAt ??= event.timestamp;
        if (typeof event.details?.["code"] === "number") entry.closeCode = event.details.code as number;
        if (typeof details.cause === "string") entry.closeCause = details.cause;
        if (typeof details.reason === "string") entry.closeReason = details.reason;
        break;
      case "reconnect.scheduled":
        entry.reconnectScheduled += 1;
        if (typeof details.delayMs === "number") entry.lastReconnectDelayMs = details.delayMs;
        break;
      case "message.sent":
        entry.messagesSent += 1;
        break;
      case "message.received":
        entry.messagesReceived += 1;
        break;
      default:
        if (event.event === "socket.ownership.assigned") entry.ownership = "assigned";
        if (event.event === "socket.ownership.released") entry.ownership = "released";
        break;
    }
    return true;
  }

  get(connectionId: string): ConnectionEntry | undefined {
    return this.connections.get(connectionId);
  }

  /** Live connections; `clientId` limits to one client. */
  live(clientId?: string): ConnectionEntry[] {
    return this.list({ clientId }).filter((entry) => entry.state !== "closed");
  }

  list(filter?: DebugEventFilter): ConnectionEntry[] {
    const all = [...this.connections.values()];
    if (!filter) return all;
    return all.filter((entry) =>
      (filter.clientId === undefined || entry.clientId === filter.clientId)
      && (filter.boardId === undefined || entry.boardId === filter.boardId)
      && (filter.sessionId === undefined || entry.sessionId === filter.sessionId)
      && (filter.connectionId === undefined || entry.connectionId === filter.connectionId));
  }

  /** Counts grouped the way the questions are asked. */
  counts(): Record<string, Record<string, number>> {
    const by = (key: (entry: ConnectionEntry) => string | undefined) => {
      const table: Record<string, number> = {};
      for (const entry of this.connections.values()) {
        if (entry.state === "closed") continue;
        const name = key(entry) ?? "unknown";
        table[name] = (table[name] ?? 0) + 1;
      }
      return table;
    };
    return {
      byClient: by((entry) => entry.clientId),
      bySession: by((entry) => entry.sessionId),
      byBoard: by((entry) => entry.boardId ?? entry.room ?? undefined),
      byState: by((entry) => entry.state),
      byTrigger: by((entry) => entry.trigger),
    };
  }

  /**
   * Heuristic diagnostics. Each finding carries the connection ids and their
   * event evidence; a finding is a question backed by data, never a verdict.
   */
  checks(): ConnectionFinding[] {
    const findings: ConnectionFinding[] = [];
    const live = this.list().filter((entry) => entry.state !== "closed");

    // Duplicate live dials for one (client, trigger, room): the classic
    // "why are there three /ws upgrades" signal. Different triggers for the
    // same room are expected (session + courier); same trigger is not.
    const byKey = new Map<string, ConnectionEntry[]>();
    for (const entry of live) {
      if (!entry.trigger || !entry.room) continue;
      const key = `${entry.clientId ?? "?"}|${entry.trigger}|${entry.room}`;
      const group = byKey.get(key) ?? [];
      group.push(entry);
      byKey.set(key, group);
    }
    for (const [key, group] of byKey)
      if (group.length > 1)
        findings.push({
          kind: "duplicate-connections",
          severity: "warn",
          key,
          connectionIds: group.map((entry) => entry.connectionId),
          summary: `${group.length} live connections share trigger+room "${key}"`,
        });

    // Orphans: opened, but no ownership record and no room — nothing in the
    // architecture should hold a nameless socket.
    for (const entry of live) {
      if (!entry.room && !entry.boardId && entry.state === "open" && entry.ownership === "none")
        findings.push({
          kind: "orphaned-connection",
          severity: "warn",
          key: entry.connectionId,
          connectionIds: [entry.connectionId],
          summary: "open connection with no room/board and no ownership record",
        });
    }

    // Multiple reconnect schedules on one connection id.
    for (const entry of live)
      if (entry.reconnectScheduled > 1)
        findings.push({
          kind: "repeated-reconnect-timers",
          severity: "warn",
          key: entry.connectionId,
          connectionIds: [entry.connectionId],
          summary: `${entry.reconnectScheduled} reconnect schedules on one connection`,
        });

    // Repeated runtime initialisation: several background boots in one
    // session is normal for MV3; several *live* sessions' dials in one client
    // means an older context never released its sockets.
    const sessionsPerClient = new Map<string, Set<string>>();
    for (const entry of live) {
      if (!entry.clientId || !entry.sessionId) continue;
      const set = sessionsPerClient.get(entry.clientId) ?? new Set<string>();
      set.add(entry.sessionId);
      sessionsPerClient.set(entry.clientId, set);
    }
    for (const [clientId, sessions] of sessionsPerClient)
      if (sessions.size > 1)
        findings.push({
          kind: "connections-from-multiple-sessions",
          severity: "warn",
          key: clientId,
          connectionIds: live.filter((entry) => entry.clientId === clientId).map((entry) => entry.connectionId),
          summary: `${sessions.size} sessions of client "${clientId}" hold live connections — a disposed context may not have released its sockets`,
        });

    // Courier sockets that outlived their pass: courier dials are
    // self-closing exchanges.
    for (const entry of live)
      if (entry.trigger?.startsWith("courier:") && entry.state === "open" && entry.openedAt && entry.messagesReceived === 0 && entry.messagesSent === 0 && entry.events.length > 0)
        findings.push({
          kind: "stalled-courier-connection",
          severity: "debug",
          key: entry.connectionId,
          connectionIds: [entry.connectionId],
          summary: "courier connection open with no frames observed",
        });

    return findings;
  }

  clear(): void {
    this.connections.clear();
  }
}

export interface ConnectionFinding {
  kind: string;
  severity: "debug" | "warn" | "error";
  key: string;
  connectionIds: string[];
  summary: string;
}

/** Convenience: fold an event list into a fresh registry (used by queries
 * over historical buffers and captures). */
export function registryFromEvents(events: DebugEvent[], filter?: DebugEventFilter): ConnectionRegistry {
  const registry = new ConnectionRegistry();
  for (const event of events)
    if (!filter || eventMatchesFilter(event, filter)) registry.observe(event);
  return registry;
}
