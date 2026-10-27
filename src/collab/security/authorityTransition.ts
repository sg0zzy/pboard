/**
 * Auditable authority re-key ("transition") records for the Drive-first model.
 *
 * A board authority record can be lost (cleared browser, reinstalled device)
 * while its signed history remains in the grant service. The Google Drive ACL
 * is the only evidence that survives, so it is the re-key oracle: a live,
 * authenticated read that reports the current account as folder `owner`.
 *
 * Properties this module enforces:
 *  - an issued transition names the previous authority key (when this device
 *    retained it), the new authority key, and the exact Drive ACL observation
 *    that justified it — auditable later, never inferred from cache;
 *  - the new root self-signs the record; verifiers check the signature and
 *    the key fingerprint, so a stored record cannot be hand-edited;
 *  - acceptance against a *fresh* ownership proof is a separate check
 *    (verifyTransitionOwnership): a transition is only trusted while the live
 *    ACL still proves the same owner, and only for the recorded folder.
 *
 * A client-issued record is deliberately NOT sufficient to make remote peers
 * trust the new authority — that needs the fresh ownership read on the
 * accepting side (and for viewers, which cannot read Drive ACLs, a server
 * relay later). See the Phase 1 ADR trust model.
 */
import { canonicalBytes, signedBytes, type Json } from "./canonical";
import { importSigningKey, publicKeyFingerprint, signBytes, verifyBytes, type DevicePublicKey } from "./keys";

export const AUTHORITY_TRANSITION_FORMAT = "pboard-authority-transition-v1";
/** D6 marker: clients older than this must not treat migrated state as writable. */
export const TRANSITION_MIN_CLIENT_VERSION = 2;
/** Ownership proof older than this is stale; re-read the ACL instead. */
export const OWNERSHIP_PROOF_FRESHNESS_MS = 60_000;

/** Live, authenticated Drive ACL observation proving current ownership. */
export type DriveOwnershipProof = {
  /** Shared board folder whose ACL was read. */
  folderFileId: string;
  /** SHA-256 (hex) of the verified account's normalized email — auditable without storing the address. */
  ownerEmailHash: string;
  /** Digest of the canonical ACL projection that was read; binds the exact permission set. */
  aclDigest: string;
  /** Clock reading when the read completed. Remote acceptance must re-read, never trust this field. */
  verifiedAt: number;
};

/** Self-signed claim that the Drive ACL justified replacing a board authority. */
export type AuthorityTransitionRecord = {
  format: typeof AUTHORITY_TRANSITION_FORMAT;
  boardId: string;
  /** Previous authority fingerprint when this device still had the key; null on fresh installs. */
  previousAuthorityKeyId: string | null;
  previousAuthorityPublicKey: DevicePublicKey | null;
  newAuthorityKeyId: string;
  newAuthorityPublicKey: DevicePublicKey;
  driveFolderFileId: string;
  driveOwnerEmailHash: string;
  aclDigest: string;
  minClientVersion: number;
  issuedAt: number;
  /** Signed by `newAuthorityPublicKey` over every field above. */
  signature: string;
};

/** Canonical signing input: the record without its signature. */
export function transitionBytes(record: Omit<AuthorityTransitionRecord, "signature">): Uint8Array {
  return signedBytes(AUTHORITY_TRANSITION_FORMAT, record as unknown as Json);
}

export async function signTransition(record: Omit<AuthorityTransitionRecord, "signature">, privateJwk: JsonWebKey): Promise<AuthorityTransitionRecord> {
  return { ...record, signature: await signBytes(await importSigningKey(privateJwk), transitionBytes(record)) };
}

/** Structural + cryptographic validation of a stored/received record. */
export async function verifyTransition(record: AuthorityTransitionRecord): Promise<boolean> {
  if (!record || record.format !== AUTHORITY_TRANSITION_FORMAT || !record.boardId || !record.driveFolderFileId) return false;
  if (typeof record.minClientVersion !== "number" || !Number.isSafeInteger(record.minClientVersion) || record.minClientVersion < 1) return false;
  if (!Number.isSafeInteger(record.issuedAt) || !record.driveOwnerEmailHash || !record.aclDigest || !record.signature) return false;
  const { signature: _signature, ...unsigned } = record;
  try {
    if (await publicKeyFingerprint(record.newAuthorityPublicKey) !== record.newAuthorityKeyId) return false;
    if (record.previousAuthorityPublicKey && await publicKeyFingerprint(record.previousAuthorityPublicKey) !== record.previousAuthorityKeyId) return false;
    if (record.previousAuthorityKeyId === null && record.previousAuthorityPublicKey !== null) return false;
    return await verifyBytes(record.newAuthorityPublicKey, record.signature, transitionBytes(unsigned));
  } catch { return false; }
}

/**
 * Acceptance rule: a transition is only honored when a *fresh* ownership read
 * still proves the same owner for the recorded folder. The transition itself
 * is not self-justifying; the live ACL is.
 */
export function verifyTransitionOwnership(record: AuthorityTransitionRecord, fresh: DriveOwnershipProof, now = Date.now()): boolean {
  if (now - fresh.verifiedAt > OWNERSHIP_PROOF_FRESHNESS_MS || fresh.verifiedAt - now > OWNERSHIP_PROOF_FRESHNESS_MS) return false;
  return record.driveFolderFileId === fresh.folderFileId && record.driveOwnerEmailHash === fresh.ownerEmailHash && record.minClientVersion <= TRANSITION_MIN_CLIENT_VERSION;
}

/** sha256 hex for ACL/email digests; exported so producer and record agree exactly. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical digest over the ACL projection ownership was judged from: every
 * permission's id/type/role plus a truncated email hash (binds the exact set
 * without storing addresses). Sort-stable across listing order.
 */
export async function aclDigest(permissions: { id?: string; type?: string; role?: string; emailAddress?: string }[]): Promise<string> {
  const projection = await Promise.all(permissions.map(async permission => ({
    id: permission.id ?? "", type: permission.type ?? "", role: permission.role ?? "",
    emailHash: permission.emailAddress ? (await sha256Hex(permission.emailAddress.trim().toLowerCase())).slice(0, 16) : "",
  })));
  projection.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return await sha256Hex(JSON.stringify(projection));
}
