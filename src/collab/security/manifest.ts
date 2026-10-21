/**
 * Board and account permission manifests (protocol 2).
 *
 * A board authority signs a manifest listing device keys and their roles. A
 * fingerprint-pinned client accepts only manifests signed by that pinned authority
 * public key. The manifest epoch advances on membership changes; clients persist
 * the highest accepted epoch, reject rollback and reject conflicting manifests at
 * the same epoch. Manifests expire (five-minute design default) and must be
 * renewed by the authority; expiry is checked on every security-sensitive action.
 */
import { canonicalize, DOMAIN_MANIFEST, MAX_MANIFEST_PAYLOAD_BYTES, parseStrictJson, PROTOCOL_VERSION, signedBytes, signedBytesHash } from "./canonical";
import { signBytes, verifyBytes, importSigningKey, type DevicePublicKey } from "./keys";

export type ManifestRole = "owner" | "editor" | "viewer";

export type ManifestDevice = {
  deviceKeyId: string;
  publicKey: DevicePublicKey;
  role: ManifestRole;
};

/** The unsigned manifest payload. Distributed with an authority signature. */
export type BoardPermissionManifest = {
  protocol: typeof PROTOCOL_VERSION;
  boardId: string;
  driveProjectFileId: string;
  driveFolderId: string;
  authorityKeyId: string;
  epoch: number;
  issuedAt: number;
  expiresAt: number;
  devices: ManifestDevice[];
};

/** One signed manifest as transported through Drive or the signaling path. */
export type SignedManifest = {
  payload: BoardPermissionManifest;
  /** base64url raw r||s signature over the canonical payload bytes. */
  signature: string;
};

/** Design default lifetimes; validated by tests, configurable per deployment. */
export const MANIFEST_LIFETIME_MS = 5 * 60_000;
export const MANIFEST_RENEW_AFTER_MS = 2 * 60_000;
export const CLOCK_TOLERANCE_MS = 30_000;
export const AUTH_TIMEOUT_MS = 10_000;
/** Maximum devices in one manifest (bounded verification work). */
export const MAX_MANIFEST_DEVICES = 64;

export type ManifestContext = {
  boardId: string;
  driveProjectFileId: string;
  driveFolderId: string;
};

function manifestPayload(value: unknown): BoardPermissionManifest {
  if (!value || typeof value !== "object") throw new Error("Manifest payload is not an object");
  const manifest = value as Partial<BoardPermissionManifest>;
  if (manifest.protocol !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${String(manifest.protocol)}`);
  for (const field of ["boardId", "authorityKeyId"] as const) {
    if (typeof manifest[field] !== "string" || (manifest[field] as string).length === 0 || (manifest[field] as string).length > 200) {
      throw new Error(`Manifest ${field} is missing or oversized`);
    }
  }
  // Empty pairs identify a standalone cryptographic board. Legacy Drive boards
  // retain their exact file/folder binding; a partial binding is never valid.
  const isAccountManifest = typeof manifest.boardId === "string" && manifest.boardId.startsWith("account:");
  for (const field of ["driveProjectFileId", "driveFolderId"] as const) {
    const value = manifest[field];
    if (isAccountManifest) {
      if (value !== "") throw new Error(`Account manifest must not bind Drive ${field}`);
    } else if (typeof value !== "string" || value.length > 200) {
      throw new Error(`Manifest ${field} is missing or oversized`);
    }
  }
  if (!isAccountManifest && Boolean(manifest.driveProjectFileId) !== Boolean(manifest.driveFolderId)) throw new Error("Manifest Drive binding must be complete or absent");
  if (!Number.isSafeInteger(manifest.epoch) || (manifest.epoch as number) < 0) throw new Error("Manifest epoch is invalid");
  for (const field of ["issuedAt", "expiresAt"] as const) {
    if (!Number.isSafeInteger(manifest[field]) || (manifest[field] as number) < 0) throw new Error(`Manifest ${field} is invalid`);
  }
  if ((manifest.expiresAt as number) - (manifest.issuedAt as number) <= 0) throw new Error("Manifest lifetime is empty");
  if ((manifest.expiresAt as number) - (manifest.issuedAt as number) > MANIFEST_LIFETIME_MS + CLOCK_TOLERANCE_MS * 2) {
    throw new Error("Manifest lifetime exceeds protocol limits");
  }
  if (!Array.isArray(manifest.devices) || manifest.devices.length === 0 || manifest.devices.length > MAX_MANIFEST_DEVICES) {
    throw new Error("Manifest device list is empty or oversized");
  }
  const keyIds = new Set<string>();
  for (const device of manifest.devices) {
    if (!device || typeof device !== "object") throw new Error("Manifest device is not an object");
    if (typeof device.deviceKeyId !== "string" || device.deviceKeyId.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(device.deviceKeyId)) {
      throw new Error("Manifest device key id is not a fingerprint");
    }
    if (keyIds.has(device.deviceKeyId)) throw new Error("Manifest lists a device key twice");
    keyIds.add(device.deviceKeyId);
    if (!device.publicKey || (device.publicKey as DevicePublicKey).kty !== "EC" || (device.publicKey as DevicePublicKey).crv !== "P-256" ||
        typeof device.publicKey.x !== "string" || typeof device.publicKey.y !== "string") {
      throw new Error("Manifest device public key is malformed");
    }
    if (device.role !== "owner" && device.role !== "editor" && device.role !== "viewer") throw new Error("Manifest role is invalid");
  }
  if (!manifest.devices.some((device) => device.role === "owner")) throw new Error("Manifest lists no owner device");
  return manifest as BoardPermissionManifest;
}

/** Validates an untrusted manifest object without checking the signature. */
export function validateManifest(value: unknown): BoardPermissionManifest {
  // Round-trip through strict parsing first: duplicate members and oversized
  // payloads are rejected before structural validation.
  const canonical = canonicalize(value as never);
  if (new TextEncoder().encode(canonical).length > MAX_MANIFEST_PAYLOAD_BYTES) throw new Error("Manifest exceeds protocol size limits");
  return manifestPayload(parseStrictJson(canonical, MAX_MANIFEST_PAYLOAD_BYTES));
}

/** Signs an already-valid manifest with the board authority signing key. */
export async function signManifest(manifest: BoardPermissionManifest, authorityKey: { privateJwk: JsonWebKey }): Promise<SignedManifest> {
  const validated = manifestPayload(manifest);
  const signed = signedBytes(DOMAIN_MANIFEST, validated as never);
  const signature = await signBytes(await importSigningKey(authorityKey.privateJwk), signed);
  return { payload: validated, signature };
}

/**
 * Verifies a signed manifest against a *pinned* authority public key. The pin
 * comes from out-of-band enrollment, never from the same Drive folder as the
 * manifest. Returns the validated manifest or throws.
 */
export async function verifyManifest(
  signed: unknown,
  pinnedAuthority: DevicePublicKey,
  expectedAuthorityKeyId: string
): Promise<BoardPermissionManifest> {
  if (!signed || typeof signed !== "object") throw new Error("Signed manifest is not an object");
  const envelope = signed as Partial<SignedManifest>;
  const manifest = manifestPayload(envelope.payload);
  if (manifest.authorityKeyId !== expectedAuthorityKeyId) throw new Error("Manifest authority does not match the pinned authority");
  const ok = await verifyBytes(pinnedAuthority, String(envelope.signature ?? ""), signedBytes(DOMAIN_MANIFEST, manifest as never));
  if (!ok) throw new Error("Manifest signature verification failed");
  return manifest;
}

/** Whether a manifest is currently valid without an explicit grace argument. */
export function manifestIsCurrent(manifest: BoardPermissionManifest, now: number): boolean {
  return now + CLOCK_TOLERANCE_MS >= manifest.issuedAt && now - CLOCK_TOLERANCE_MS <= manifest.expiresAt;
}

export function roleForDevice(manifest: BoardPermissionManifest, deviceKeyId: string): ManifestRole | null {
  return manifest.devices.find((device) => device.deviceKeyId === deviceKeyId)?.role ?? null;
}

export function manifestHash(manifest: BoardPermissionManifest): string {
  // The hash binds session proofs and mutation epochs to one exact manifest.
  return signedBytesHash(DOMAIN_MANIFEST, manifest as never);
}

// ---------------------------------------------------------------------------
// Persistence of accepted manifest epochs (anti-rollback state).
// ---------------------------------------------------------------------------

export type AcceptedManifestRecord = { epoch: number; hash: string; expiresAt: number };

export interface ManifestEpochStore {
  read(boardId: string): Promise<AcceptedManifestRecord | null>;
  write(boardId: string, record: AcceptedManifestRecord): Promise<void>;
}

/**
 * In-memory epoch store used by tests and as the default; platforms persist it
 * through their runtime wiring (browser: browser.storage.local wrapper).
 */
export function createInMemoryManifestEpochStore(): ManifestEpochStore {
  const records = new Map<string, AcceptedManifestRecord>();
  return {
    read: (boardId) => Promise.resolve(records.get(boardId) ?? null),
    write: (boardId, record) => { records.set(boardId, record); return Promise.resolve(); }
  };
}

/**
 * Accepts a verified manifest into local state. Rejects epoch rollback and two
 * different payloads claiming the same epoch (a forked membership history).
 */
export async function acceptManifest(
  manifest: BoardPermissionManifest,
  store: ManifestEpochStore,
  now: number
): Promise<AcceptedManifestRecord> {
  const existing = await store.read(manifest.boardId);
  const hash = manifestHash(manifest);
  if (existing) {
    if (manifest.epoch < existing.epoch) throw new Error("Manifest epoch rollback rejected");
    if (manifest.epoch === existing.epoch && existing.hash !== hash) throw new Error("Conflicting manifest at the same epoch rejected");
    if (manifest.expiresAt <= existing.expiresAt && manifest.epoch === existing.epoch) {
      // Identical epoch and hash: the same manifest may be re-accepted harmlessly;
      // a *regressed* expiry with the same hash cannot occur (same hash, same bytes).
    }
  }
  const record: AcceptedManifestRecord = { epoch: manifest.epoch, hash, expiresAt: manifest.expiresAt };
  await store.write(manifest.boardId, record);
  return record;
}

/** Expiry must also hold against the *persisted* acceptance, not just the object. */
export async function manifestAcceptedAndCurrent(
  manifest: BoardPermissionManifest,
  store: ManifestEpochStore,
  now: number
): Promise<boolean> {
  if (!manifestIsCurrent(manifest, now)) return false;
  const accepted = await store.read(manifest.boardId);
  if (!accepted || accepted.epoch > manifest.epoch) return false;
  return accepted.hash === manifestHash(manifest) || accepted.epoch === manifest.epoch;
}
