import type { PboardSignaling } from "./signaling";
import { createExperimentalWebSocketSignaling } from "./experimentalWebSocketSignaling";
import { ensureDeviceKey } from "./security/keys";
import type { CollaborationSecurityOptions } from "./manager";
import type { CollaborationSettings } from "./boardGrants";

export function experimentalSignalingEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER === "websocket";
}

/** Production uses persisted, explicit settings; build experiment flags stay DEV-only. */
export function selectRuntimeSignaling(topic: string, drive: () => PboardSignaling, security?: CollaborationSecurityOptions, settings?: CollaborationSettings, getServiceAdmission?: (request: import("./experimentalWebSocketSignaling").ServiceAdmissionRequest) => Promise<string>): PboardSignaling {
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
  return createExperimentalWebSocketSignaling({ topic, url, getServiceAdmission,
    loopbackDevelopment: import.meta.env.DEV, getKey: () => ensureDeviceKey(keyScope), getAuthorization: async () => authorization });
}
