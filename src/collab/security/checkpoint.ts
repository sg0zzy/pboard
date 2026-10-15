/**
 * Signed checkpoint format for Drive snapshots (protocol 2).
 *
 * A checkpoint establishes trusted board history: it carries the board identity,
 * the authority context (epoch and manifest hash), a schema version, a monotonically
 * increasing checkpoint sequence, and a state hash over the full snapshot bytes.
 * Only an *authority*-signed checkpoint can establish history — an ordinary editor
 * signature cannot erase author authorization checks. Ordinary snapshots keep the
 * v1 format but are rejected on import unless they are authority-signed checkpoints
 * on secure boards, or the board is still legacy.
 *
 * Mutable snapshot pointers (Drive file ids) stay separate from the immutable
 * signed content: the pointer can be deleted/corrupted by any Drive writer, but
 * that is an availability failure, never an integrity one.
 */
import { canonicalize, DOMAIN_CHECKPOINT, parseStrictJson, PROTOCOL_VERSION, signedBytes } from "./canonical";
import { signBytes, verifyBytes, importSigningKey, publicKeyFingerprint, type DevicePublicKey } from "./keys";
import type { BoardPermissionManifest } from "./manifest";
import { manifestHash } from "./manifest";

export type SignedCheckpoint = {
  payload: {
    protocol: typeof PROTOCOL_VERSION;
    /** Snapshot format version of `snapshot` below. */
    schemaVersion: number;
    boardId: string;
    driveProjectFileId: string;
    driveFolderId: string;
    authorityKeyId: string;
    manifestEpoch: number;
    manifestHash: string;
    /** Monotonic per-board sequence; receivers reject rollback. */
    checkpointSequence: number;
    /** SHA-256 hex over the exact v1 snapshot bytes this checkpoint attests. */
    stateHash: string;
    issuedAt: number;
    expiresAt: number;
  };
  signature: string;
};

export const CHECKPOINT_LIFETIME_MS = 24 * 60 * 60_000;
export const SNAPSHOT_HASH_ALGORITHM = "SHA-256";

/** SHA-256 hex over arbitrary snapshot bytes. */
export async function stateHashOf(snapshotBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(SNAPSHOT_HASH_ALGORITHM, snapshotBytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Creates an authority-signed checkpoint over a v1 snapshot's exact bytes. */
export async function createCheckpoint(options: {
  snapshotBytes: Uint8Array;
  schemaVersion: number;
  boardId: string;
  driveProjectFileId: string;
  driveFolderId: string;
  manifest: BoardPermissionManifest;
  checkpointSequence: number;
  authorityPrivateJwk: JsonWebKey;
  now?: number;
}): Promise<SignedCheckpoint> {
  const now = options.now ?? Date.now();
  const authorityKeyId = await publicKeyFingerprint(await publicJwkFromPrivate(options.authorityPrivateJwk));
  const payload = {
    protocol: PROTOCOL_VERSION,
    schemaVersion: options.schemaVersion,
    boardId: options.boardId,
    driveProjectFileId: options.driveProjectFileId,
    driveFolderId: options.driveFolderId,
    authorityKeyId,
    manifestEpoch: options.manifest.epoch,
    manifestHash: manifestHash(options.manifest),
    checkpointSequence: options.checkpointSequence,
    stateHash: await stateHashOf(options.snapshotBytes),
    issuedAt: now,
    expiresAt: now + CHECKPOINT_LIFETIME_MS
  };
  const signature = await signBytes(await importSigningKey(options.authorityPrivateJwk), signedBytes(DOMAIN_CHECKPOINT, payload));
  return { payload, signature };
}

async function publicJwkFromPrivate(privateJwk: JsonWebKey): Promise<DevicePublicKey> {
  // Reconstruct the public half from the private JWK's coordinates.
  return { kty: "EC", crv: "P-256", x: String(privateJwk.x), y: String(privateJwk.y) };
}

export type CheckpointVerifierContext = {
  pinnedAuthority: DevicePublicKey;
  expectedAuthorityKeyId: string;
  boardId: string;
  driveProjectFileId: string;
  driveFolderId: string;
  /** The last accepted checkpoint's sequence+hash, or null on first accept. */
  lastAccepted: { checkpointSequence: number; stateHash: string } | null;
  now: number;
};

export type CheckpointAcceptance = {
  /** Exact snapshot bytes the checkpoint attests. */
  stateHash: string;
  checkpointSequence: number;
};

/**
 * Verifies an authority-signed checkpoint. Rejects: untrusted authority, board
 * mismatch, expired checkpoints (with 30s tolerance), and rollback (a sequence
 * not newer than the last accepted one, or a stale hash at the same sequence).
 */
export async function verifyCheckpoint(
  checkpoint: unknown,
  snapshotBytes: Uint8Array,
  context: CheckpointVerifierContext
): Promise<CheckpointAcceptance> {
  const envelope = checkpoint as Partial<SignedCheckpoint> | null;
  const payload = envelope?.payload;
  if (!payload || typeof payload !== "object") throw new Error("Checkpoint payload is missing");
  if (payload.protocol !== PROTOCOL_VERSION) throw new Error("Checkpoint protocol version is unsupported");
  if (payload.boardId !== context.boardId) throw new Error("Checkpoint is bound to another board");
  if (payload.driveProjectFileId !== context.driveProjectFileId || payload.driveFolderId !== context.driveFolderId) {
    throw new Error("Checkpoint is bound to other Drive objects");
  }
  if (payload.authorityKeyId !== context.expectedAuthorityKeyId) throw new Error("Checkpoint authority does not match the pinned authority");
  if (Number(payload.expiresAt) + 30_000 < context.now) throw new Error("Checkpoint has expired");
  const hash = await stateHashOf(snapshotBytes);
  if (hash !== payload.stateHash) throw new Error("Checkpoint state hash does not match the snapshot bytes");
  const ok = await verifyBytes(
    context.pinnedAuthority,
    String(envelope.signature ?? ""),
    signedBytes(DOMAIN_CHECKPOINT, payload)
  );
  if (!ok) throw new Error("Checkpoint signature verification failed");
  if (context.lastAccepted) {
    if (payload.checkpointSequence < context.lastAccepted.checkpointSequence) {
      throw new Error("Checkpoint rollback rejected");
    }
    if (payload.checkpointSequence === context.lastAccepted.checkpointSequence && hash !== context.lastAccepted.stateHash) {
      throw new Error("Conflicting checkpoint at the same sequence rejected");
    }
  }
  return { stateHash: hash, checkpointSequence: payload.checkpointSequence };
}

/**
 * Parses untrusted checkpoint JSON from Drive with strict member/size checking
 * before signature verification.
 */
export function parseCheckpoint(text: string): SignedCheckpoint {
  const parsed = parseStrictJson(text) as unknown as SignedCheckpoint;
  if (!parsed || typeof parsed !== "object" || !parsed.payload || typeof parsed.payload !== "object") {
    throw new Error("Checkpoint envelope is malformed");
  }
  if (typeof parsed.signature !== "string" || parsed.signature.length === 0 || parsed.signature.length > 120) {
    throw new Error("Checkpoint signature is malformed");
  }
  return parsed;
}

/** Canonical form helper for tests and for deduplicating equal payloads. */
export function canonicalCheckpointPayload(checkpoint: SignedCheckpoint): string {
  return canonicalize(checkpoint.payload);
}