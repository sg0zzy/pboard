/**
 * One cycle of the offline upload queue for board assets: drive the next waiting
 * entry through `local-ready` -> `uploading` -> `remote`, with `failed` reachable
 * from any pre-remote state and retrying through `uploading` with the same id,
 * hash and allocated Drive file. Rules: docs/architecture/board-assets.md; the
 * state machine, byte verification, the idempotent allocation and the Synced-claim
 * predicate are reused whole from `assets.ts` — this module owns only the *order*
 * of port calls and the failure semantics, like `runLogConsolidationCycle`.
 * Scheduling, triggers and retry pacing belong to the caller: loop the cycle
 * until it reports `idle`, and every branch is testable without timers or I/O.
 *
 * The order is the whole safety story:
 *
 * - Verification happens **before** allocation: bytes are read from the local
 *   blob store and must pass `verifyAssetBytes` before Drive is asked for a
 *   file, so a corrupt paste never even leaves a stray Drive file behind. The
 *   entry moves to `failed` and is kept — never a silent discard.
 * - The entry is persisted as `uploading` with its allocated file id **before**
 *   the upload starts. A restart finds its own in-flight entry and resumes it
 *   instead of treating the paste as new, so a replay allocates no second file.
 * - The operation is written **only after** `uploadBytes` reports the bytes
 *   landed: an operation can never reference an unallocated file id, and an
 *   upload-failed cycle writes nothing to the log.
 * - Every id `allocateFile` returns is merged through `allocateDriveFile`, so a
 *   second id for an entry that already carries one is surfaced as a failure —
 *   never taken, never a silent overwrite of the allocation.
 * - A queue failure never touches the local copy: this module has no delete
 *   port and will not invent one, and a `failed` entry stays counted by
 *   `assetQueueStatus` because a failed upload is never "attachment removed".
 *
 * Port obligations beyond the obvious I/O: `allocateFile` MUST be idempotent
 * per entry id (return the entry's existing `driveFileId` when it carries one —
 * the content-addressed name makes that a listing lookup); `uploadBytes` SHOULD
 * be a cheap no-op when the content-addressed file already exists, which is
 * what makes a re-upload after an operation-write failure harmless;
 * `writeOperation` maps the asset onto the `assets` collection's `create`
 * operation with the full `BoardAsset` in `fields`. Verification limits are a
 * caller choice passed straight to `verifyAssetBytes`: a shipped path may pass
 * a *smaller* `maxBytes` than `MAX_ASSET_BYTES`, never a larger one.
 */
import {
  allocateDriveFile, blocksSyncedClaim, transitionAsset, verifyAssetBytes,
  type AssetState, type AssetVerificationFailure, type BoardAsset, type PendingAssetUpload,
} from './assets';

/** The states this driver can hold. `remote` has left the queue for the
 * operation log, and `reference-only` is the download path — a different
 * driver's problem, never an upload queue's. */
export type AssetQueueState = Extract<AssetState, 'local-ready' | 'uploading' | 'failed'>;

/** One persisted queue entry, keyed on `upload.id`. The queue is an ordered
 * list, oldest first: that is what makes the FIFO order visible from
 * persistence and `id` what identifies a replayed entry. `failure` records why
 * the entry last failed so the UI can surface it; a retry replaces it. */
export type AssetUploadEntry = {
  upload: PendingAssetUpload;
  state: AssetQueueState;
  failure?: AssetUploadFailure;
};

/** Why an entry did not move on. The verification arm is `assets.ts`'s own
 * vocabulary; the rest name the port that refused, so "Drive throttled the
 * upload" and "the blob store lost the paste" remain different conversations. */
export type AssetUploadFailure =
  | AssetVerificationFailure
  | 'local-bytes-missing'
  | 'drive-allocation-conflict'
  | 'upload-failed'
  | 'operation-write-failed'
  | 'invalid-entry-state';

/** Everything the cycle cannot do purely. Each port is a fact about the outside
 * world; the cycle supplies only the order. */
export type AssetUploadQueue = {
  /** The queue as this cycle sees it, oldest first. Re-read every cycle, so a
   * queue written by another tab or a previous session needs no driver state. */
  load(): Promise<readonly AssetUploadEntry[]>;
  /** Writes the whole queue back after every state change: the cycle persists
   * intent before I/O and the outcome after, never batching across a port call. */
  persist(entries: readonly AssetUploadEntry[]): Promise<void>;
  /** The local copy of the entry's bytes. Null means the blob store no longer
   * holds them; bytes are never re-downloaded here — this is the upload path. */
  readBytes(entry: AssetUploadEntry): Promise<Uint8Array | null>;
  /** The Drive file id these bytes belong to. MUST be idempotent per entry id:
   * an entry that already carries a `driveFileId` gets that id back, because
   * the cycle refuses a second id with `drive-allocation-conflict` rather than
   * uploading the same attachment into two files. */
  allocateFile(entry: AssetUploadEntry): Promise<string>;
  /** Puts `bytes` at `asset.driveFileId`; true only once Drive has them. SHOULD
   * dedupe by the content-addressed name (`buildAssetFileName` in `assets.ts`). */
  uploadBytes(asset: BoardAsset, bytes: Uint8Array): Promise<boolean>;
  /** Writes the `assets` `create` operation referencing this asset. Called only
   * after `uploadBytes` returned true; false means the log write refused, which
   * leaves the expected bytes-without-operation state for a retry. */
  writeOperation(asset: BoardAsset): Promise<boolean>;
  /** Verification limits handed straight to `verifyAssetBytes`; defaults are
   * `assets.ts`'s, and a shipped path may only tighten `maxBytes`. */
  limits?: { maxBytes?: number; allowlist?: readonly string[] };
};

/** Small enough for the caller to drive a retry loop on without reading queue
 * internals: `idle` ends the loop, `failed` names the entry and the reason. */
export type AssetUploadOutcome =
  | { status: 'idle' }
  | { status: 'uploaded'; id: string }
  | { status: 'failed'; id: string; failure: AssetUploadFailure };

/** The entry for a fresh attachment: keyed on `id`, waiting at `local-ready`,
 * bytes already in the local blob store (queueing does not verify — the cycle
 * does, immediately before any Drive request). */
export function assetUploadEntry(upload: PendingAssetUpload): AssetUploadEntry {
  return { upload, state: 'local-ready' };
}

/** `verifyAssetBytes` and `transitionAsset` take a full `BoardAsset`, and an
 * entry that has not allocated yet has no `driveFileId`. Nothing outside those
 * two pure calls ever sees this view: neither rule reads the Drive id, and the
 * placeholder never reaches a port or the persisted entry. */
const metadataOf = (entry: AssetUploadEntry): BoardAsset =>
  ({ ...entry.upload, driveFileId: entry.upload.driveFileId ?? '' });

/** Drives one queue entry through one attempt. Returns after the first entry
 * the queue offers that is not already `failed`, so a permanently corrupt
 * head cannot starve the healthy entries behind it; once nothing else waits,
 * the oldest failed entry is retried again. */
export async function runAssetUploadCycle(queue: AssetUploadQueue): Promise<AssetUploadOutcome> {
  const entries = [...await queue.load()];
  const healthy = entries.findIndex(e => e.state !== 'failed');
  const index = healthy === -1 ? 0 : healthy;
  const entry = entries[index];
  if (!entry) return { status: 'idle' };

  // 1. Local bytes, verified before any allocation. A verification failure is
  // a `failed` asset, never a silent discard and never a partial save, and no
  // Drive or log port is reached.
  const bytes = await queue.readBytes(entry);
  if (!bytes) return failEntry(queue, entries, index, 'local-bytes-missing');
  const check = await verifyAssetBytes(bytes, metadataOf(entry), queue.limits);
  if (!check.ok) return failEntry(queue, entries, index, check.failure);

  // 2. Allocation, merged through the idempotent predicate: a fresh entry gets
  // exactly one file, and a port that offers a *second* id for an entry that
  // already carries one is refused here, before any upload.
  const allocated = allocateDriveFile(entry.upload, await queue.allocateFile(entry));
  if (!allocated) return failEntry(queue, entries, index, 'drive-allocation-conflict');

  // 3. Record the intent before the upload starts: a restart finds this entry
  // `uploading` on the file it already owns and resumes it without a duplicate
  // and without a second allocation. `failed` and `uploading` re-enter here.
  const uploading = transitionAsset({ asset: allocated, state: entry.state }, 'uploading');
  if (!uploading || uploading.state !== 'uploading') {
    return failEntry(queue, entries, index, 'invalid-entry-state');
  }
  entries[index] = { upload: allocated, state: uploading.state };
  await queue.persist(entries);

  // 4. Bytes. Until they land, nothing else may happen: no operation, and the
  // local copy stays exactly where it is.
  if (!await queue.uploadBytes(allocated, bytes)) {
    return failEntry(queue, entries, index, 'upload-failed');
  }

  // 5. The operation, referencing bytes Drive definitely has.
  if (!await queue.writeOperation(allocated)) {
    // Drive holds the bytes with no operation yet — the crash state the spec
    // expects and the reclamation grace window covers. The entry stays
    // `uploading`, not `failed`: neither verification nor upload failed, and a
    // retry re-uploads to the same content-addressed name (a no-op) and re-writes
    // the operation with the same id and hash.
    entries[index] = { upload: allocated, state: 'uploading', failure: 'operation-write-failed' };
    await queue.persist(entries);
    return { status: 'failed', id: allocated.id, failure: 'operation-write-failed' };
  }

  // 6. `remote` is terminal and leaves the upload queue: the operation carries
  // the asset from here, and a waiting-entry count is for waiting entries only.
  const remote = transitionAsset(uploading, 'remote');
  if (!remote) return failEntry(queue, entries, index, 'invalid-entry-state');
  entries.splice(index, 1);
  await queue.persist(entries);
  return { status: 'uploaded', id: allocated.id };
}

/** Records a failure on the entry this cycle drove: every queue state reaches
 * `failed` except an already-`failed` entry whose retry failed again before
 * re-entering `uploading` (verification is still first), which simply updates
 * its reason. The entry is kept, persisted and reported — surfacing is the
 * point. A queue state the machine refuses (one the types exclude) is left
 * untouched rather than rewritten. */
async function failEntry(queue: AssetUploadQueue, entries: AssetUploadEntry[], index: number,
  failure: AssetUploadFailure): Promise<AssetUploadOutcome> {
  const at = entries[index];
  const moved = transitionAsset({ asset: metadataOf(at), state: at.state }, 'failed');
  entries[index] = { upload: at.upload, state: moved ? 'failed' : at.state, failure };
  await queue.persist(entries);
  return { status: 'failed', id: at.upload.id, failure };
}

export type AssetQueueStatus = {
  /** Attachments still waiting on upload, failed ones included: the pending
   * badge counts them, because a failed upload is never "attachment removed". */
  waiting: number;
  /** Any waiting asset blocks the board's "Synced" claim — the same predicate
   * the contract uses, applied per entry, not a second rule. */
  blocksSyncedClaim: boolean;
  /** Always zero. A queued upload is local work: the contract's pending status
   * for *unresolved* or conflicted changes never includes it, and this constant
   * is that rule stated in code — an offline device keeps accepting pastes. */
  unresolvedChanges: number;
};

/** What the badge and the Synced claim read. `waiting` and `unresolvedChanges`
 * are deliberately different fields: a hundred queued uploads raise the first
 * and leave the second at zero. */
export function assetQueueStatus(entries: readonly AssetUploadEntry[]): AssetQueueStatus {
  return {
    waiting: entries.length,
    blocksSyncedClaim: entries.some(e => blocksSyncedClaim(e.state)),
    unresolvedChanges: 0,
  };
}
