import type { PboardWebRTCConnectionOptions } from "../../src/collab/webrtcHandler";
import { manifestHash } from "../../src/collab/security/manifest";

// Explicit authentication double for the existing transport/convergence tests.
// Only test runners import/alias this module; production has no legacy opt-in.
// Admission failures are tested against the real manager in collaborationAdmission.
export function createPboardWebRTCConnectionHandler(options: PboardWebRTCConnectionOptions, handlerFactory: typeof import("../../src/collab/webrtcHandler").createPboardWebRTCConnectionHandler) {
  const { security, ...transportOptions } = options;
  return async () => {
    const handler = await handlerFactory(transportOptions)();
    if (security) handler.connect$.subscribe(peer => {
      security.onSessionVerified?.(String(peer.id), {
        boardId: security.boardId, collection: security.collection,
        ownDeviceKeyId: security.signer.deviceKeyId, remoteDeviceKeyId: "transport-fixture",
        remoteRole: "owner", ownSessionId: security.ownSessionId,
        remoteSessionId: String(peer.id), manifestEpoch: security.manifest.epoch,
        manifestHash: manifestHash(security.manifest), transcriptHash: "transport-fixture",
        manifestExpiresAt: security.manifest.expiresAt
      });
    });
    return handler;
  };
}
