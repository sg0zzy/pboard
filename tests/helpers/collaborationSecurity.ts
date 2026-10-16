import { generateDeviceKey } from "../../src/collab/security/keys";
import { signManifest, verifyManifest } from "../../src/collab/security/manifest";
import type { CollaborationManagerOptions, CollaborationSecurityOptions } from "../../src/collab/manager";

// Transport fixtures simulate sessions of one enrolled device. Production obtains
// these contexts from pinned authorities; fixtures sign and verify ephemeral manifests.
const key = generateDeviceKey();
const manifests = new Map<string, Promise<CollaborationSecurityOptions["manifest"]>>();

export function collaborationSecurityFixture() {
  const ownSessionId = crypto.randomUUID();
  async function context(boardId: string): Promise<CollaborationSecurityOptions> {
    const device = await key;
    if (!manifests.has(boardId)) {
      manifests.set(boardId, (async () => {
        const account = boardId.startsWith("account:");
        const signed = await signManifest({
          protocol: 2, boardId, driveProjectFileId: account ? "" : "test-file",
          driveFolderId: account ? "" : "test-folder", authorityKeyId: device.keyId,
          epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
          devices: [{ deviceKeyId: device.keyId, publicKey: device.publicJwk, role: "owner" }]
        }, device);
        return verifyManifest(signed, device.publicJwk, device.keyId);
      })());
    }
    return {
      signer: { privateJwk: device.privateJwk, deviceKeyId: device.keyId },
      manifest: await manifests.get(boardId)!, boardId, ownSessionId
    };
  }
  return {
    boardSecurity: context,
    accountSecurity: (account: string) => context(`account:${account}`),
    // These tests cover transport/lifecycle. Storage signature enforcement has its
    // own real collection coverage in securityAdversarial.test.ts.
    installMutationGuard: async (projectId: string) => ({ projectId, uninstall: async () => {} })
  } satisfies Pick<CollaborationManagerOptions, "boardSecurity" | "accountSecurity" | "installMutationGuard">;
}
