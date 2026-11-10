/**
 * Browser → bridge diagnostic transport: batched HTTP POSTs to the local
 * Debug Bridge, deliberately NOT a `trackTransportSocket` dial — diagnostic
 * traffic must never look like, or ride on, the collaboration protocol.
 *
 * Why HTTP POST instead of a standing WebSocket: the bus already batches and
 * bounds a queue, so ingest is "fire a POST, count the failure" — no
 * handshake, reconnect state machine, or partial-frame handling in an MV3
 * context that Firefox terminates on its own schedule. State inspection is
 * the one pull direction, answered by a short poll of `/inspect/request`.
 *
 * Rules:
 *  - Disabled by default: `configureDebug` only wires this transport when a
 *    dev/diagnostic composition asks for it.
 *  - Fire-and-forget: a failed POST drops the batch; the bus counts it. There
 *    is no queueing beyond the bus's own bounded queue, so a dead bridge can
 *    never grow memory here.
 *  - Loopback endpoints only unless `allowRemote` is set — the diagnostic
 *    channel must never silently point at a remote host.
 */

import type { DebugEvent } from "./schema.ts";
import type { DebugTransport } from "./bus.ts";

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8790";
export const BRIDGE_PROTOCOL_VERSION = 1;

export interface BridgeTransportOptions {
  /** Base URL of the bridge (no trailing slash). Defaults to loopback. */
  url?: string;
  /** Shared dev token, matching the bridge's `PBOARD_DEBUG_TOKEN`; sent as a
   * query parameter so the POST stays a CORS-simple request. */
  token?: string;
  clientId: string;
  sessionId: string;
  /** Which execution context this transport belongs to (`background`,
   * `sidebar`, `node`…). */
  context: string;
  label?: string;
  /** Required to point diagnostics at a non-loopback endpoint; nothing in
   * this repository sets it by default. */
  allowRemote?: boolean;
  onError?: (message: string) => void;
  /** Injectable fetch for tests. */
  fetchImpl?: (input: string, init?: { method?: string; body?: string; headers?: Record<string, string>; keepalive?: boolean }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface PendingInspection {
  requestId: string;
  /** Optional scope narrowing from the bridge (reserved; the inspector may ignore). */
  scope?: string;
}

export class HttpBridgeTransport implements DebugTransport {
  private readonly base: string;
  private readonly options: BridgeTransportOptions;
  private pendingInspections: PendingInspection[] = [];
  private inspectionTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private inspector: ((request: PendingInspection) => Promise<Record<string, unknown>>) | undefined;

  constructor(options: BridgeTransportOptions) {
    this.options = options;
    const url = options.url ?? DEFAULT_BRIDGE_URL;
    if (!isSafeBridgeEndpoint(url) && !options.allowRemote) {
      throw new Error(`Refusing to send diagnostics to a non-loopback endpoint: ${url}`);
    }
    this.base = url.replace(/\/+$/, "");
  }

  /** The bridge answers pull requests (state inspection) on this endpoint;
   * the transport polls while a request is outstanding only. */
  attachInspector(handler: (request: PendingInspection) => Promise<Record<string, unknown>>): void {
    this.inspector = handler;
  }

  private endpoint(path: string, query: Record<string, string | undefined> = {}): string {
    const url = new URL(`${this.base}${path}`);
    const token = this.options.token?.trim();
    if (token) url.searchParams.set("token", token);
    url.searchParams.set("clientId", this.options.clientId);
    url.searchParams.set("sessionId", this.options.sessionId);
    url.searchParams.set("context", this.options.context);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, value);
    return url.href;
  }

  send(events: DebugEvent[]): void {
    if (events.length === 0 || this.closed) return;
    const body = JSON.stringify({
      protocol: BRIDGE_PROTOCOL_VERSION,
      clientId: this.options.clientId,
      sessionId: this.options.sessionId,
      context: this.options.context,
      label: this.options.label,
      events,
    });
    const fetchImpl = this.options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init as RequestInit));
    void fetchImpl(this.endpoint("/ingest"), {
      method: "POST",
      body,
      // keepalive lets a batch finish during teardown; browsers cap it at ~64 KiB,
      // and oversized bodies are simply dropped by the bridge.
      keepalive: true,
      headers: { "content-type": "application/json" },
    }).then((response) => {
      if (!response.ok) this.options.onError?.(`bridge ingest failed: HTTP ${response.status}`);
    }, (error: unknown) => {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
    });
  }

  /** Pull-direction poll: ask the bridge whether a state inspection is
   * outstanding, answer it if so. Runs only while `wantInspections()` says
   * yes, so an unwatched client pays nothing. */
  startInspectionPolling(intervalMs = 3_000): void {
    if (this.inspectionTimer || this.closed) return;
    const tick = () => {
      this.inspectionTimer = undefined;
      if (this.closed || !this.inspector) return;
      const fetchImpl = this.options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init as RequestInit));
      void fetchImpl(this.endpoint("/inspect/request"))
        .then(async (response) => {
          if (!response.ok) return;
          const text = await response.text();
          if (!text || text === "{}") return;
          const parsed = JSON.parse(text) as { requestId?: unknown; scope?: unknown };
          if (typeof parsed.requestId !== "string" || !parsed.requestId) return;
          const request: PendingInspection = {
            requestId: parsed.requestId,
            ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
          };
          if (this.pendingInspections.some((entry) => entry.requestId === request.requestId)) return;
          this.pendingInspections.push(request);
          const snapshot = await this.inspector!(request);
          this.pendingInspections = this.pendingInspections.filter((entry) => entry.requestId !== request.requestId);
          return fetchImpl(this.endpoint("/inspect/respond"), {
            method: "POST",
            body: JSON.stringify({ requestId: request.requestId, snapshot }),
            headers: { "content-type": "application/json" },
          });
        })
        .catch((error: unknown) => this.options.onError?.(error instanceof Error ? String(error) : String(error)))
        .finally(() => {
          if (!this.closed && this.inspector)
            this.inspectionTimer = setTimeout(tick, intervalMs);
        });
    };
    this.inspectionTimer = setTimeout(tick, 0);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.inspectionTimer);
    this.inspectionTimer = undefined;
  }
}

/** True for loopback http(s) endpoints; wss: is allowed for an intentional
 * future relay of diagnostics, but the default and every documented setup is
 * loopback HTTP. */
export function isSafeBridgeEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
    if (parsed.protocol !== "http:" && parsed.protocol !== "ws:") return false;
    return ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}
