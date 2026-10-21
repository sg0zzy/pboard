import { canonicalBytes, toBase64Url, type Json } from "./canonical";
import { verifyManifest, type SignedManifest } from "./manifest";
import { publicKeyFingerprint, type DevicePublicKey } from "./keys";

/** Obtained only from the runtime's independently pinned and verified authority. */
export type RelayAuthorization = { authority: DevicePublicKey; manifest: SignedManifest };
const hash = async (bytes: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
const exact = (value: object, keys: string) => Object.keys(value).sort().join(",") === keys;
const validId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);

export async function prepareRelayAdmission(topic: string, proof: RelayAuthorization, deviceKeyId: string) {
  if (!exact(proof.authority, "crv,kty,x,y")) throw new Error("Relay authority must contain only a public key");
  const authorityId = await publicKeyFingerprint(proof.authority);
  const manifest = await verifyManifest(proof.manifest, proof.authority, authorityId);
  if (!exact(manifest, "authorityKeyId,boardId,devices,driveFolderId,driveProjectFileId,epoch,expiresAt,issuedAt,protocol") ||
      manifest.devices.some(d => !exact(d, "deviceKeyId,publicKey,role") || !exact(d.publicKey, "crv,kty,x,y"))) {
    throw new Error("Relay manifest contains unexpected fields");
  }
  if (manifest.expiresAt <= Date.now() || manifest.issuedAt > Date.now() + 30_000 || !manifest.devices.some(d => d.deviceKeyId === deviceKeyId)) {
    throw new Error("Relay manifest expired or device not enrolled");
  }
  const account = manifest.boardId.startsWith("account:") ? manifest.boardId.slice(8) : null;
  const validTopic = account !== null
    ? validId(account) && manifest.driveProjectFileId === "" && manifest.driveFolderId === "" && topic === `pboard-account-${account}-order`
    : validId(manifest.boardId) && ((manifest.driveProjectFileId === "" && manifest.driveFolderId === "") || (validId(manifest.driveProjectFileId) && validId(manifest.driveFolderId))) &&
      ["cards", "projects"].some(c => topic === `pboard-collab-${manifest.boardId}-${c}`);
  if (!validTopic || topic.length > 240) throw new Error("Relay manifest does not authorize this topic");
  const bytes = canonicalBytes(manifest as unknown as Json);
  const roomHash = await hash(new TextEncoder().encode(JSON.stringify(["pboard-ws-room-v2", topic, manifest.driveProjectFileId, manifest.driveFolderId])));
  return {
    room: `pboard-v2-${authorityId}-${roomHash}`,
    digest: await hash(bytes),
    authorization: { topic, authority: proof.authority, manifestPayload: toBase64Url(bytes), manifestSignature: proof.manifest.signature }
  };
}
