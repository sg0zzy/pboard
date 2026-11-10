/**
 * The WebRTC peer stack, as one module.
 *
 * **No composition root reaches this code at runtime.** Both call
 * `setWebRtcDisabled(true)` — `src/sync/browser.ts` for the extension and
 * `apps/android/src/sync/service.ts` for Android — so
 * `createCollaborationManager`'s `doStart()` returns before a pool exists and the
 * runtime's operation room returns before a DataChannel exists. The extension
 * additionally has this module aliased to `peerRuntime.stub.ts` at build time, so
 * the stack is absent from its bundles; Android has no alias and would load these
 * modules if a future entry point enabled the pools.
 *
 * The module is therefore retained as source with its unit tests, not as a live
 * path. It stays the single module every peer import goes through so that the two
 * platforms cannot drift apart, and so that re-enabling the posture is one call
 * rather than an import audit. Nothing here has its own logic — every export is a
 * re-export.
 */

export { replicateWebRTC } from "rxdb/plugins/replication-webrtc";
export { createPboardWebRTCConnectionHandler } from "./webrtcHandler";
export { scopeMasterChanges } from "./scopedPull";
export { createProjectImageSync } from "./imageSync";
export { createDriveSignaling } from "./signaling";
export { createOperationRealtime } from "../sync/operations/realtime";
