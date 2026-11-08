/** Board assets: identity and metadata converge through the operation log; bytes
 * travel only through Drive. This module is pure — no Drive, no blob store, no
 * editor — so every rule is testable offline. Rules: docs/architecture/board-assets.md.
 */

/** Metadata only. Never the bytes: an asset row must be safe to replicate. */
export type BoardAsset = {
  id: string;          // board-global, client-generated (crypto.randomUUID)
  driveFileId: string; // Drive file holding the bytes, allocated before the op is written
  name: string;        // display name; not trusted for type or safety
  mimeType: string;    // allowlisted, see verifyAssetBytes
  size: number;        // bytes, exact
  sha256: string;      // lowercase hex over exactly those bytes
};

/** What the interface can render without executing or sniffing anything: the
 * existing image path's rendering set, kept so this path cannot quietly loosen
 * it. Widening the set is an owner rendering decision made here, not a storage one. */
export const ASSET_MIME_ALLOWLIST: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
/** Per-asset ceiling, enforced before upload and again by verifyAssetBytes on
 * download. Spec open decision 2: Drive capacity is the budget and the number is
 * the owner's; this is an explicit starting value, and callers may pass a smaller
 * `maxBytes` but a shipped path must never pass a larger one. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/** Reclamation grace window (spec open decision 1): the window must survive a
 * worst-case offline-then-resync upload, so it matches the seven-day recovery
 * expectations rather than a plausible single upload. */
export const DEFAULT_ASSET_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const sha256Hex = /^[a-f0-9]{64}$/;
/** Exactly what buildAssetFileName can emit: `asset-<sha256>`, optionally with its
 * dot-separated extension. Nothing else parses as an asset. */
const assetFileName = /^asset-([a-f0-9]{64})(?:\.([a-z0-9]{1,16}))?$/;

/** Lowercase-hex SHA-256 over raw bytes. The operations `digest()` helper
 * canonicalizes JSON and cannot serve bytes, but this is the same crypto.subtle
 * path and hex encoding, so the log and the bytes share one digest convention. */
export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/** Drive listing is the only index, so the file name carries the classification:
 * `asset-<sha256>.<extension>`. The extension is the display name's, lowercased,
 * and a display name without a usable one yields the extensionless content-addressed
 * form (the spec names only the dotted form; parse accepts exactly what build emits,
 * never more). A malformed hash returns null rather than a guessed name. */
export function buildAssetFileName(fileSha256: string, displayName = ''): string | null {
  if (!sha256Hex.test(fileSha256)) return null;
  const extension = /\.([A-Za-z0-9]{1,16})$/.exec(displayName)?.[1]?.toLowerCase();
  return extension ? `asset-${fileSha256}.${extension}` : `asset-${fileSha256}`;
}
export type AssetFileName = { sha256: string; extension?: string };
/** Parse only, never repair. Anything that does not match is not an asset: a GC
 * pass treats an unparseable name as untouchable, not as junk. */
export function parseAssetFileName(name: string): AssetFileName | undefined {
  const match = assetFileName.exec(name);
  if (!match) return undefined;
  return match[2] ? { sha256: match[1], extension: match[2] } : { sha256: match[1] };
}

export type AssetVerificationFailure = 'size-mismatch' | 'sha256-mismatch' | 'mime-not-allowed' | 'size-ceiling-exceeded';
/** Discriminated so the UI can be specific: "the bytes arrived truncated" and
 * "that type is not displayable here" are different conversations with the user. */
export type AssetVerification =
  | { ok: true }
  | { ok: false; failure: AssetVerificationFailure; expectedSize: number; observedSize: number };
/** Runs on every byte ingestion path, before bytes reach the blob store, with no
 * exceptions: the hash is also the deduplication key, so skipping verification
 * would corrupt identity, not just integrity. A failure is a `failed` asset —
 * never a silent discard and never a partial save. */
export async function verifyAssetBytes(bytes: Uint8Array, metadata: BoardAsset,
  options: { maxBytes?: number; allowlist?: readonly string[] } = {}): Promise<AssetVerification> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES, allowlist = options.allowlist ?? ASSET_MIME_ALLOWLIST;
  const report = (failure: AssetVerificationFailure): AssetVerification =>
    ({ ok: false, failure, expectedSize: metadata.size, observedSize: bytes.byteLength });
  // The spec's order: exact length, then the hash, then the rendering allowlist,
  // then the per-asset ceiling (enforced again on every download path).
  if (bytes.byteLength !== metadata.size) return report('size-mismatch');
  // A metadata hash that is not lowercase hex cannot match by definition; the
  // compare itself is exact because sha256HexOf only ever produces lowercase.
  if (!sha256Hex.test(metadata.sha256) || await sha256HexOf(bytes) !== metadata.sha256) return report('sha256-mismatch');
  if (!allowlist.includes(metadata.mimeType)) return report('mime-not-allowed');
  if (bytes.byteLength > maxBytes) return report('size-ceiling-exceeded');
  return { ok: true };
}

export const ASSET_STATES = ['local-ready', 'uploading', 'remote', 'reference-only', 'failed'] as const;
export type AssetState = typeof ASSET_STATES[number];
/** An asset held by a device is in exactly one state; the pending badge and the
 * "Synced" claim read this one field. */
export type AssetRecord = { asset: BoardAsset; state: AssetState };
/** The spec table's edges only. `remote` is terminal because replacing bytes means
 * a new asset plus an operation that moves the reference — never an in-place
 * overwrite. `failed` re-enters through `uploading` and nowhere else. */
const assetTransitions: Record<AssetState, readonly AssetState[]> = {
  'local-ready': ['uploading', 'failed'],
  'uploading': ['uploading', 'remote', 'failed'],
  'remote': [],
  'reference-only': ['remote', 'failed'],
  'failed': ['uploading'],
};
export function canTransitionAsset(from: AssetState, to: AssetState): boolean {
  return assetTransitions[from]?.includes(to) ?? false;
}
/** Move an asset. The BoardAsset travels unchanged, so a `failed` retry
 * structurally cannot carry a different id or hash: re-attaching different bytes
 * is a new asset, and this function offers no way to express it as a transition. */
export function transitionAsset(record: AssetRecord, to: AssetState): AssetRecord | null {
  if (!canTransitionAsset(record.state, to)) return null;
  return { asset: record.asset, state: to };
}
/** A metadata `patch` moves the display name only; id, driveFileId, hash, size and
 * mimeType are immutable per attachment. */
export function patchAssetName(asset: BoardAsset, name: string): BoardAsset {
  return { ...asset, name };
}
/** An upload-queue entry before or after Drive allocation. The entry keys on `id`,
 * which is what makes a replayed entry identifiable. */
export type PendingAssetUpload = Omit<BoardAsset, 'driveFileId'> & { driveFileId?: string };
/** Idempotent allocation: a replayed queue entry reuses the `driveFileId` it
 * already holds, and a second, different Drive file for the same attachment is
 * refused with null — never a second upload of the same id. */
export function allocateDriveFile(entry: PendingAssetUpload, driveFileId: string): BoardAsset | null {
  if (entry.driveFileId !== undefined && entry.driveFileId !== driveFileId) return null;
  return { ...entry, driveFileId };
}
/** Metadata arriving before bytes keeps the reference and shows a pending
 * attachment, and a missing or failed asset prevents a "Synced" claim for the
 * board. A failed upload is never silently downgraded to "attachment removed". */
export function blocksSyncedClaim(state: AssetState): boolean { return state !== 'remote'; }

export type AssetReclamationPlan = { eligibleDriveFileIds: string[]; policy: string; blocked?: string };
/** Deleting an asset is the one irreversible action in this subsystem, so a
 * candidate must clear every test: unreferenced by live state, not covered by any
 * retained snapshot's receipts, older than the grace window measured from creation
 * (last-access is a lie during a sync storm and a fiction for an offline device),
 * and seen in a listing known complete. "Not in flight" is covered by the window,
 * which is why the window must be longer than a plausible upload, not shorter. */
export function planAssetReclamation(options: {
  listing: { complete: boolean; files: { driveFileId: string; name: string; createdTime: string }[] };
  referenced: string[];
  /** snapshotId → the driveFileIds its receipts still reference. Any retained
   * snapshot naming a file protects it; a temporarily hidden card is not junk. */
  retainedSnapshotCoverage: Record<string, string[]>;
  now: number; graceMs?: number;
}): AssetReclamationPlan {
  const graceMs = options.graceMs ?? DEFAULT_ASSET_GRACE_MS;
  const policy = `Retain every asset file unless it is unreferenced by live state and by every retained snapshot's receipts, older than the ${graceMs / (24 * 60 * 60 * 1000)}-day grace window measured from creation, and seen in a complete listing; unparseable names are untouchable. A partial or failed listing makes the whole pass a no-op. Reclamation is owner-only and runs under the consolidation lease.`;
  if (!options.listing.complete) return { eligibleDriveFileIds: [], policy,
    blocked: 'Drive listing is incomplete or failed; reclaiming against a partial index deletes a board\'s images because one request was throttled.' };
  const referenced = new Set(options.referenced);
  const covered = new Set(Object.values(options.retainedSnapshotCoverage).flat());
  const cutoff = options.now - graceMs;
  const eligible: string[] = [];
  for (const file of options.listing.files) {
    // An unparseable name is not an asset and stays untouched, never junk.
    if (!parseAssetFileName(file.name)) continue;
    if (referenced.has(file.driveFileId) || covered.has(file.driveFileId)) continue;
    // Unknown creation age is not evidence of age; the candidate survives.
    const created = Date.parse(file.createdTime);
    if (!Number.isFinite(created) || created >= cutoff) continue;
    eligible.push(file.driveFileId);
  }
  return { eligibleDriveFileIds: eligible.sort(), policy };
}
