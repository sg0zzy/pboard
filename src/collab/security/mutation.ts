/**
 * Verifying fork storage layer (protocol 2).
 *
 * Wraps a collection's storage instance so that **every** write path — RxDB
 * document writes, replication `persistFromMaster` (pull + live stream),
 * `masterWrite` conflict resolution, and repository mutations — passes through
 * one security policy before rows reach persistent storage. Received documents
 * must carry valid mutation provenance signed by a device the current manifest
 * authorizes for the document's project; local writes are signed at their origin.
 *
 * Wrapping replaces `collection.storageInstance` before replication is created,
 * so both replication directions and every repository method are covered. The
 * replication state resolves to the underlying persistent storage only for
 * meta/checkpoint instances; the wrapped fork sits in front of all data writes.
 */
import type { RxCollection, RxStorageBulkWriteResponse } from "rxdb";
import { signedBytesHash, signedBytes, DOMAIN_MUTATION, parseStrictJson } from "./canonical";
import { verifyBytes, importSigningKey, signBytes } from "./keys";
import type { BoardPermissionManifest } from "./manifest";
import { CLOCK_TOLERANCE_MS } from "./manifest";

/** Signed application mutation carried in each replicated document. */
export type MutationProvenance = {
  /** Board id (or `account:<hash>` for the account-order room). */
  boardId: string;
  collection: "cards" | "projects" | "accountOrder";
  /** The document's primary key. */
  documentId: string;
  /** Whether this mutation tombstones the document. */
  deleted: boolean;
  /** SHA-256 hex of the application payload (without `_meta`, `_rev`, `_sec`). */
  payloadHash: string;
  authorKeyId: string;
  /** Manifest epoch the author was authorized under. */
  epoch: number;
  /** Unique operation id; repeated identical operations are idempotent. */
  operationId: string;
  /** Author-local increasing sequence. */
  sequence: number;
  /** Causal parent operation ids (bounded). */
  parents: string[];
  issuedAt: number;
  /** Explicit grant expiry the author was operating under. */
  authorizationExpiresAt: number;
};

export type SecuredDocument = { _sec?: { provenance: MutationProvenance; signature: string } };

export const MUTATION_PROVENANCE_FIELD = "_sec";

export type MutationVerifierContext = {
  /** The verified manifest governing this collection's room. */
  manifest: BoardPermissionManifest;
  /** The room identity received mutations must be bound to. */
  boardId: string;
  collection: "cards" | "projects" | "accountOrder";
  /** Monotonic-ish clock; injectable for tests. */
  now?: () => number;
  /** Our own writes (re-emitted by conflict handling) re-verify against history. */
  ownDeviceKeyId?: string;
};

/**
 * Replays prevention state for received mutations, per author device.
 * operationId -> accepted payloadHash.
 */
export type MutationReplayCache = Map<string, Map<string, string>>;

export function createMutationReplayCache(): MutationReplayCache {
  return new Map();
}

const MAX_PARENTS = 8;

/** The application payload we sign: document fields without RxDB internals. */
const RXDB_INTERNAL_FIELDS = ["_meta", "_rev", "_attachments", "_deleted", MUTATION_PROVENANCE_FIELD] as const;

function applicationPayload(document: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if ((RXDB_INTERNAL_FIELDS as readonly string[]).includes(key)) continue;
    payload[key] = value;
  }
  return payload;
}

type CanonicalJson = Parameters<typeof signedBytes>[1];

/** Signs one document mutation at its origin; returns the secured document. */
export async function signMutation<T extends Record<string, unknown>>(
  document: T,
  signer: { privateJwk: JsonWebKey; deviceKeyId: string },
  context: { boardId: string; collection: "cards" | "projects" | "accountOrder"; manifest: BoardPermissionManifest; sequence: number; parents?: string[]; operationId?: string; now?: number }
): Promise<T & SecuredDocument> {
  const payload = applicationPayload(document);
  const provenance: MutationProvenance = {
    boardId: context.boardId,
    collection: context.collection,
    documentId: String(document.id),
    deleted: document.deletedAt !== undefined && document.deletedAt !== null,
    payloadHash: signedBytesHash(DOMAIN_MUTATION, payload as CanonicalJson),
    authorKeyId: signer.deviceKeyId,
    epoch: context.manifest.epoch,
    operationId: context.operationId ?? crypto.randomUUID(),
    sequence: context.sequence,
    parents: (context.parents ?? []).slice(0, MAX_PARENTS),
    issuedAt: context.now ?? Date.now(),
    authorizationExpiresAt: context.manifest.expiresAt
  };
  const signature = await signProvenance(provenance, signer.privateJwk);
  return { ...document, [MUTATION_PROVENANCE_FIELD]: { provenance, signature } } as T & SecuredDocument;
}

async function signProvenance(provenance: MutationProvenance, privateJwk: JsonWebKey): Promise<string> {
  const signingKey = await importSigningKey(privateJwk);
  return signBytes(signingKey, signedBytes(DOMAIN_MUTATION, provenance as CanonicalJson));
}

/**
 * Verifies received provenance against the verified manifest and replay state.
 * Returns the authorization epoch when accepted, else throws with the reason.
 */
export async function verifyMutation(
  document: Record<string, unknown>,
  context: MutationVerifierContext,
  replay: MutationReplayCache
): Promise<MutationProvenance> {
  const securityField = document[MUTATION_PROVENANCE_FIELD];
  if (!securityField || typeof securityField !== "object") throw new Error("Received document has no mutation provenance");
  const envelope = securityField as { provenance?: unknown; signature?: unknown };
  // Round-trip strict parsing rejects duplicate members and non-JSON values.
  const provenance = parseStrictJson(JSON.stringify(envelope.provenance)) as unknown as MutationProvenance;
  if (!provenance || typeof provenance !== "object") throw new Error("Mutation provenance is malformed");
  const device = context.manifest.devices.find((entry) => entry.deviceKeyId === provenance.authorKeyId);
  if (!device) throw new Error("Mutation author is not authorized by the current manifest");
  // Authorization: only owner/editor devices may create or mutate content.
  // A viewer device may relay already-verified mutations unchanged, but a
  // viewer-signed application mutation is rejected at the persistence boundary.
  if (device.role === "viewer") throw new Error("Mutation author has view-only authorization");
  if (provenance.boardId !== context.boardId || provenance.collection !== context.collection) {
    throw new Error("Mutation is bound to another board or collection");
  }
  if (provenance.epoch !== context.manifest.epoch) throw new Error("Mutation epoch does not match the verified manifest");
  const now = typeof context.now === "function" ? context.now() : Date.now();
  const authorizationExpiresAt = Number(provenance.authorizationExpiresAt);
  if (Number.isNaN(authorizationExpiresAt) || authorizationExpiresAt < now - CLOCK_TOLERANCE_MS) {
    throw new Error("Mutation was issued under an expired or invalid authorization");
  }
  if (!Number.isSafeInteger(provenance.sequence) || provenance.sequence < 0) throw new Error("Mutation sequence is invalid");
  if (typeof provenance.operationId !== "string" || provenance.operationId.length === 0 || provenance.operationId.length > 100) throw new Error("Mutation operation id is invalid");
  if (Array.isArray(provenance.parents) === false || provenance.parents.length > MAX_PARENTS) throw new Error("Mutation parents are invalid");
  const payload = applicationPayload(document);
  const expectedPayloadHash = signedBytesHash(DOMAIN_MUTATION, payload as CanonicalJson);
  if (provenance.payloadHash !== expectedPayloadHash) throw new Error("Mutation payload does not match its signed hash");
  const signatureOk = await verifyBytes(device.publicKey, String(envelope.signature ?? ""), signedBytes(DOMAIN_MUTATION, provenance as CanonicalJson));
  if (!signatureOk) throw new Error("Mutation signature verification failed");
  // Replay: repeated identical operations are idempotent; conflicting payloads
  // with the same operation id are rejected.
  const byAuthor = replay.get(provenance.authorKeyId) ?? new Map<string, string>();
  const seenHash = byAuthor.get(provenance.operationId);
  if (seenHash !== undefined) {
    if (seenHash !== provenance.payloadHash) throw new Error("Conflicting duplicate operation rejected");
    // Identical replay: accepted idempotently (no state change; caller may skip).
  } else {
    byAuthor.set(provenance.operationId, provenance.payloadHash);
    if (byAuthor.size > 512) {
      // Eviction is positionally bounded only; entries carry no time here, so
      // drop the first inserted half (Map preserves insertion order).
      let dropped = 0;
      for (const operationId of byAuthor.keys()) {
        if (dropped++ >= 256) break;
        byAuthor.delete(operationId);
      }
    }
    replay.set(provenance.authorKeyId, byAuthor);
  }
  return provenance;
}

// ---------------------------------------------------------------------------
// Verifying storage wrapper
// ---------------------------------------------------------------------------

/** Installed per-project guard: unwraps the storage wrapper on removal. */
export type MutationGuardInstall = {
  projectId: string;
  /** Idempotent unwrap; restores the original storage instance. */
  uninstall(): Promise<void>;
};

/** Verify decision for one write row. */
export type VerifyDecision = "accept" | "reject";

export type ForkGuard = {
  /** Whether this guard is responsible for the document and whether it accepts. */
  verify: (document: Record<string, unknown>) => Promise<VerifyDecision>;
};

/**
 * Wraps the collection's storage instance so a `bulkWrite` row whose document
 * fails mutation verification is answered as a 422 write error and **never**
 * reaches the backing store. The wrapper checks `responsibleFor(document)`;
 * when no active guard claims the document the row flows to the backing store.
 * Returns an uninstall handle.
 */
export function installCollectionMutationGuard<T>(
  collection: RxCollection<T>,
  responsibleFor: (document: Record<string, unknown>) => Promise<ForkGuard | null>
): MutationGuardInstall {
  const underlying = collection.storageInstance;
  const bulkWrite = underlying.bulkWrite.bind(underlying);
  const wrapped = new Proxy(underlying, {
    get(target, property) {
      if (property === "bulkWrite") {
        return async (rows: Array<{ document: Record<string, unknown> }>, context: string): Promise<unknown> => {
          const allowed: Array<{ document: Record<string, unknown> }> = [];
          const blocked: Array<{ document: Record<string, unknown>; reason: string }> = [];
          for (const row of rows) {
            try {
              const guard = await responsibleFor(row.document);
              if (!guard) { allowed.push(row); continue; }
              const decision = await guard.verify(row.document);
              if (decision === "reject") blocked.push({ document: row.document, reason: "mutation verification failed" });
              else allowed.push(row);
            } catch (error) {
              blocked.push({ document: row.document, reason: error instanceof Error ? error.message : String(error) });
            }
          }
          const result = allowed.length
            ? await bulkWrite(allowed as never, context) as unknown as { success: unknown[]; error: unknown[] }
            : { success: [] as unknown[], error: [] as unknown[] };
          const error = [...result.error as Array<Record<string, unknown>>];
          for (const row of blocked) {
            error.push({
              documentId: String(row.document.id),
              writeRow: row,
              status: 422,
              context,
              isError: true,
              error: new Error(`Security policy rejected document: ${row.reason}`)
            } as unknown as Record<string, unknown>);
          }
          return { success: result.success, error };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
  Object.defineProperty(collection, "storageInstance", {
    get() { return wrapped; },
    configurable: true
  });
  let uninstalled = false;
  return {
    projectId: "",
    async uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      Object.defineProperty(collection, "storageInstance", {
        get() { return underlying; },
        configurable: true
      });
    }
  };
}