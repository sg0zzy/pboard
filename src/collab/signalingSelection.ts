import type { PboardSignaling } from "./signaling";
import { createExperimentalWebSocketSignaling } from "./experimentalWebSocketSignaling";
import { ensureDeviceKey, type StoredDeviceKey } from "./security/keys";
import type { RelayAuthorization } from "./security/relayAdmission";
import type { ServiceAdmissionRequest } from "./experimentalWebSocketSignaling";
import type { CollaborationSecurityOptions } from "./manager";
import type { CollaborationSettings } from "./boardGrants";
import type { AuthBudget } from "./authBudget";

export function experimentalSignalingEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER === "websocket";
}

/**
 * Credentials for the durable operation log, from the same settings and pinned
 * board grant the peer transport uses: one device key and one manifest per
 * board, so switching transports cannot change who a client is to the server.
 * Returns null when independent collaboration is off, leaving the board on the
 * Drive-signaled path.
 */
export function selectRuntimeOperationLog(boardId: string, security: CollaborationSecurityOptions | null, settings?: CollaborationSettings): {
  url: string; getKey: () => Promise<StoredDeviceKey>; getAuthorization: () => Promise<RelayAuthorization>
} | null {
  if (settings?.provider !== "websocket" && !experimentalSignalingEnabled()) return null;
  const url = settings?.provider === "websocket" ? settings.url : import.meta.env.VITE_PBOARD_SIGNALING_WS_URL;
  const authorization = security?.relayAuthorization;
  if (!url || !authorization) return null;
  const scope = `board-device:${boardId}`;
  return { url, getKey: () => ensureDeviceKey(scope), getAuthorization: async () => authorization };
}

/** Production uses persisted, explicit settings; build experiment flags stay DEV-only. */
export function selectRuntimeSignaling(topic: string, drive: () => PboardSignaling, security?: CollaborationSecurityOptions, settings?: CollaborationSettings, getServiceAdmission?: (request: ServiceAdmissionRequest) => Promise<string>, authBudget?: AuthBudget): PboardSignaling {
  if (settings?.provider === "drive" || (settings?.provider !== "websocket" && !experimentalSignalingEnabled())) return drive();
  const url = settings?.provider === "websocket" ? settings.url : import.meta.env.VITE_PBOARD_SIGNALING_WS_URL;
  if (!url) throw new Error("Experimental WebSocket signaling requires VITE_PBOARD_SIGNALING_WS_URL");
  const authorization = security?.relayAuthorization;
  if (!authorization) throw new Error("Experimental WebSocket signaling requires a pinned signed room authorization");
  let keyScope: string;
  if (topic.startsWith("pboard-account-") && topic.endsWith("-order")) {
    keyScope = `account-device:${topic.slice("pboard-account-".length, -"-order".length)}`;
  } else {
    const match = /^pboard-collab-(.+)-(cards|projects)$/.exec(topic);
    if (!match) throw new Error("Unsupported experimental signaling topic");
    keyScope = `board-device:${match[1]}`;
  }
  return createExperimentalWebSocketSignaling({ topic, url, getServiceAdmission, authBudget,
    loopbackDevelopment: import.meta.env.DEV, getKey: () => ensureDeviceKey(keyScope), getAuthorization: async () => authorization });
}
