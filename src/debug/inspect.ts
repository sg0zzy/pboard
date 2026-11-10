/**
 * Pull-model state inspection for the bridge.
 *
 * The bridge cannot open a browser's memory; it asks. A running context
 * registers a *collect* function that returns the controlled, read-only
 * snapshot documented in docs/debugging/instrumentation.md; the transport's
 * poll loop picks up queued inspections and answers them with that projection.
 *
 * The contract of `collect` is the security boundary: presence, counts,
 * identities, states — never documents, credentials or key material. The
 * bridge relays whatever it is given, so the projection happens here, next
 * to the data, and the returned object is re-parsed (deep-cloned) before it
 * can cross the network: a caller cannot hand back live application objects.
 */

import type { HttpBridgeTransport, PendingInspection } from "./bridgeTransport.ts";
import type { ClientStateSnapshot } from "./protocol.ts";

type SnapshotProvider = (request: PendingInspection) => Promise<Omit<ClientStateSnapshot, "clientId" | "sessionId"> | undefined>;

let provider: SnapshotProvider | undefined;

export function registerDebugSnapshotProvider(next: SnapshotProvider): void {
  provider = next;
}

export function attachDebugInspector(transport: HttpBridgeTransport, identity: { clientId: string; sessionId: string; context: string }): void {
  transport.attachInspector(async (request) => {
    if (!provider) return { kind: "connection-state", context: identity.context, clientId: identity.clientId, sessionId: identity.sessionId, capturedAt: new Date().toISOString(), boards: [], connections: [], restricted: "no snapshot provider registered in this context" };
    const snapshot = await provider(request);
    if (!snapshot)
      return { kind: "connection-state", context: identity.context, clientId: identity.clientId, sessionId: identity.sessionId, capturedAt: new Date().toISOString(), boards: [], connections: [], restricted: "snapshot unavailable" };
    const complete: ClientStateSnapshot = {
      ...snapshot,
      context: identity.context,
      clientId: identity.clientId,
      sessionId: identity.sessionId,
    };
    // Deep copy through JSON: the bridge response is data, never a live
    // object graph, and anything non-serializable is dropped here rather than
    // erroring mid-response.
    return JSON.parse(JSON.stringify(complete)) as Record<string, unknown>;
  });
  transport.startInspectionPolling();
}
