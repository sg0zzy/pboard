/**
 * Grant-bound authorizer for the signaling server's buffer/leader HTTP API.
 *
 * Produces, per call, the fresh challenge and the device signature the server
 * verifies (`["pboard-ws-auth-v2", challenge, session, room, deviceKeyId,
 * digest]` over the authority-signed manifest — identical bytes to the WebRTC
 * admission path, so one key and one manifest cover every transport).
 */
import { prepareRelayAdmission } from "../collab/security/relayAdmission";
import { importSigningKey, signBytes } from "../collab/security/keys";
import type { CollaborationSecurityOptions } from "../collab/manager";
import type { AuthMaterial, Authorizer } from "./bufferClient";

export function createGrantAuthorizer(
  getSecurity: (boardId: string) => Promise<CollaborationSecurityOptions | null>,
  httpOrigin: string,
  fetcher: (input: string, init?: Record<string, unknown>) => Promise<Response> = (input, init) => fetch(input, init as RequestInit)
): Authorizer {
  return {
    async authorize(boardId): Promise<AuthMaterial> {
      const security = await getSecurity(boardId);
      if (!security?.relayAuthorization) throw new Error("Buffer access requires an independent board grant");
      const role = security.manifest.devices.find(device => device.deviceKeyId === security.signer.deviceKeyId)?.role;
      if (role !== "owner" && role !== "editor") throw new Error("Buffer writes require an editor grant");
      const admission = await prepareRelayAdmission(`pboard-collab-${boardId}-cards`, security.relayAuthorization, security.signer.deviceKeyId);
      const hello = await fetcher(`${httpOrigin}/buffer/challenge`);
      if (!hello.ok) throw new Error(`Buffer challenge unavailable (${hello.status})`);
      const { challenge } = await hello.json() as { challenge?: unknown };
      if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error("Buffer challenge malformed");
      const session = crypto.randomUUID();
      const signature = await signBytes(
        await importSigningKey(security.signer.privateJwk),
        new TextEncoder().encode(JSON.stringify(["pboard-ws-auth-v2", challenge, session, admission.room, security.signer.deviceKeyId, admission.digest]))
      );
      return {
        deviceKeyId: security.signer.deviceKeyId,
        session,
        signature,
        authority: security.relayAuthorization.authority as unknown as AuthMaterial["authority"],
        manifestPayload: admission.authorization.manifestPayload,
        manifestSignature: admission.authorization.manifestSignature
      };
    }
  };
}
