/**
 * The WebRTC peer stack, as one module.
 *
 * Two platforms build against this checkout, and only one of them can reach
 * this code at runtime:
 *
 *  - The extension calls `setWebRtcDisabled(true)` in `src/sync/browser.ts`, so
 *    `createCollaborationManager`'s `doStart()` returns before a pool exists and
 *    the runtime's operation room returns before a DataChannel exists. It must
 *    not pay for this code.
 *  - `apps/android/src/sync/service.ts` builds the same runtime without that
 *    call, so its collaboration manager opens peer pools and its operation rooms
 *    open DataChannels. It executes exactly the modules below.
 *
 * That is why this is the single module every peer import goes through: the
 * extension's build aliases this one path to `peerRuntime.stub.ts`, so the stack
 * is absent from the extension bundle, while Android has no alias and gets the
 * real modules. Nothing here has its own logic — every export is a re-export, so
 * the two platforms cannot drift apart.
 */

export { replicateWebRTC } from "rxdb/plugins/replication-webrtc";
export { createPboardWebRTCConnectionHandler } from "./webrtcHandler";
export { scopeMasterChanges } from "./scopedPull";
export { createProjectImageSync } from "./imageSync";
export { createDriveSignaling } from "./signaling";
export { createOperationRealtime } from "../sync/operations/realtime";
