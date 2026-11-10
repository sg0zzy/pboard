import { describe, expect, it } from 'vitest';
import {
  ASSET_MIME_ALLOWLIST, ASSET_STATES, allocateDriveFile, blocksSyncedClaim, buildAssetFileName,
  canTransitionAsset, DEFAULT_ASSET_GRACE_MS, MAX_ASSET_BYTES, parseAssetFileName, patchAssetName,
  planAssetReclamation, sha256HexOf, transitionAsset, verifyAssetBytes,
  type AssetRecord, type BoardAsset,
} from '../../src/sync/operations/assets';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-02T00:00:00.000Z'); // every plan test passes its own clock
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const bytesOf = (text: string) => new TextEncoder().encode(text);
async function assetFor(text: string, overrides: Partial<BoardAsset> = {}): Promise<BoardAsset> {
  const bytes = bytesOf(text);
  const base: BoardAsset = { id: crypto.randomUUID(), driveFileId: 'file-1', name: 'pasted.png',
    mimeType: 'image/png', size: bytes.byteLength, sha256: await sha256HexOf(bytes) };
  return { ...base, ...overrides };
}

describe('verification', () => {
  it('verifies a hash mismatch before the blob store sees the bytes', async () => {
    const asset = await assetFor('original bytes');
    expect(await verifyAssetBytes(bytesOf('original bytes'), asset)).toEqual({ ok: true });
    // Same length, different bytes: only the hash can catch this. A failure here is
    // a `failed` asset; the bytes never reach the blob store and are never saved partially.
    expect(await verifyAssetBytes(bytesOf('tampered bytes'), asset)).toEqual(
      { ok: false, failure: 'sha256-mismatch', expectedSize: asset.size, observedSize: 14 });
    const truncated = bytesOf('origina');
    expect(await verifyAssetBytes(truncated, asset)).toEqual(
      { ok: false, failure: 'size-mismatch', expectedSize: asset.size, observedSize: truncated.byteLength });
    // A metadata hash that is not lowercase hex cannot match by definition.
    expect((await verifyAssetBytes(bytesOf('original bytes'), { ...asset, sha256: 'deadbeef' })).ok).toBe(false);
    expect((await verifyAssetBytes(bytesOf('original bytes'), { ...asset, sha256: asset.sha256.toUpperCase() })).ok).toBe(false);
  });
  it('checks length before the hash, and the hash before the allowlist', async () => {
    const asset = await assetFor('payload', { mimeType: 'text/html' });
    // Wrong size AND off-allowlist type: the first reported failure is the length.
    expect(await verifyAssetBytes(bytesOf('payl'), asset)).toMatchObject({ failure: 'size-mismatch' });
    // Wrong hash AND off-allowlist type: the hash speaks first.
    expect(await verifyAssetBytes(bytesOf('other'), { ...asset, size: 5 })).toMatchObject({ failure: 'sha256-mismatch' });
  });
  it('refuses an off-allowlist type before uploading, and stores bytes for an allowed one', async () => {
    const allowed = await assetFor('a real png');
    expect(await verifyAssetBytes(bytesOf('a real png'), allowed)).toEqual({ ok: true });
    const executable = await assetFor('a real png', { mimeType: 'text/html' });
    expect(await verifyAssetBytes(bytesOf('a real png'), executable)).toMatchObject({ ok: false, failure: 'mime-not-allowed' });
    // The allowlist is the rendering decision: nothing the UI would execute or sniff.
    expect(ASSET_MIME_ALLOWLIST).toContain('image/png');
    expect(ASSET_MIME_ALLOWLIST).not.toContain('image/svg+xml');
    expect(ASSET_MIME_ALLOWLIST).not.toContain('application/x-msdownload');
  });
  it('enforces the size ceiling on the verification path too', async () => {
    const bytes = bytesOf('x'.repeat(9)), asset = await assetFor('x'.repeat(9));
    // Hash and length pass; only the ceiling can refuse.
    expect(await verifyAssetBytes(bytes, asset, { maxBytes: 8 })).toMatchObject({ ok: false, failure: 'size-ceiling-exceeded', observedSize: 9 });
    expect(await verifyAssetBytes(bytes, asset)).toEqual({ ok: true }); // far below the shipped ceiling
    expect(MAX_ASSET_BYTES).toBeGreaterThan(0);
  });
});

describe('naming', () => {
  it('names bytes content-addressed and parses only its own pattern', () => {
    expect(buildAssetFileName(HASH_A, 'Photo.PNG')).toBe(`asset-${HASH_A}.png`);
    expect(buildAssetFileName(HASH_A)).toBe(`asset-${HASH_A}`);
    expect(buildAssetFileName('not-a-hash', 'x.png')).toBeNull();
    expect(parseAssetFileName(`asset-${HASH_A}.png`)).toEqual({ sha256: HASH_A, extension: 'png' });
    expect(parseAssetFileName(`asset-${HASH_A}`)).toEqual({ sha256: HASH_A });
    // None of these is an asset, and a GC pass must leave every one untouched.
    for (const junk of ['', 'holiday-photo.png', 'asset-.png', `asset-${HASH_A.slice(0, 63)}.png`,
      `asset-${HASH_A.toUpperCase()}.png`, `asset-${HASH_A}.png.txt`, `asset-${HASH_A}.${'x'.repeat(17)}`,
      `operations-${HASH_A}.json`, `image-${HASH_A}.json`, ` asset-${HASH_A}.png`, `asset-${HASH_A}.png `,
      `asset-${HASH_A}.`, `asset_x.png`]) expect(parseAssetFileName(junk)).toBeUndefined();
    // Round trip: build emits only what parse accepts.
    expect(parseAssetFileName(buildAssetFileName(HASH_B, 'report.pdf')!)).toEqual({ sha256: HASH_B, extension: 'pdf' });
  });
  it('identical bytes from two devices yield one Drive file name and two asset rows', async () => {
    const one = await assetFor('the same paste', { name: 'from-device-one.png' });
    const two = await assetFor('the same paste', { name: 'Camera Shot.PNG' });
    expect(two.sha256).toBe(one.sha256);   // the hash reveals they are the same bytes
    expect(two.id).not.toBe(one.id);       // …as two independently created rows
    expect(buildAssetFileName(two.sha256, two.name)).toBe(buildAssetFileName(one.sha256, one.name));
  });
});

describe('states', () => {
  const asset: BoardAsset = { id: 'asset-1', driveFileId: 'file-1', name: 'paste.png', mimeType: 'image/png', size: 3, sha256: HASH_A };
  it('walks the spec table and refuses every other move', () => {
    let record: AssetRecord = { asset, state: 'local-ready' };
    for (const next of ['uploading', 'remote'] as const) { record = transitionAsset(record, next)!; expect(record.state).toBe(next); }
    expect(transitionAsset(record, 'uploading')).toBeNull();                          // remote is terminal
    expect(transitionAsset({ asset, state: 'local-ready' }, 'remote')).toBeNull();    // bytes land before the op
    expect(transitionAsset({ asset, state: 'reference-only' }, 'uploading')).toBeNull();
    expect(transitionAsset({ asset, state: 'failed' }, 'local-ready')).toBeNull();
    expect(canTransitionAsset('uploading', 'uploading')).toBe(true);                  // retry, same file
    expect(canTransitionAsset('local-ready', 'failed')).toBe(true);                   // pre-upload verification failed
    expect(transitionAsset({ asset, state: 'reference-only' }, 'failed')!.state).toBe('failed'); // download verify failed
  });
  it('keeps the same id and hash across an upload retry after a failure', () => {
    const retry = transitionAsset({ asset, state: 'failed' }, 'uploading');
    expect(retry?.asset.id).toBe(asset.id);
    expect(retry?.asset.sha256).toBe(asset.sha256);
    expect(retry?.asset).toBe(asset); // and no new Drive file: the retry carries the old allocation
  });
  it('does not allocate a second Drive file when a queued upload is replayed', () => {
    const queued = { id: 'asset-1', name: 'paste.png', mimeType: 'image/png', size: 3, sha256: HASH_A };
    const allocated = allocateDriveFile(queued, 'file-1');
    expect(allocated?.driveFileId).toBe('file-1');
    expect(allocateDriveFile(allocated!, 'file-1')?.driveFileId).toBe('file-1'); // replay reuses
    expect(allocateDriveFile(allocated!, 'file-2')).toBeNull();                  // never a second file per id
  });
  it('patches only the display name', () => {
    const renamed = patchAssetName(asset, 'renamed.png');
    expect(renamed.name).toBe('renamed.png');
    expect({ ...renamed, name: asset.name }).toEqual(asset);
  });
  it('metadata without bytes shows pending and blocks a Synced claim', () => {
    const arrived: AssetRecord = { asset, state: 'reference-only' };
    expect(transitionAsset(arrived, 'remote')!.state).toBe('remote'); // download verified → remote
    for (const state of ASSET_STATES) expect(blocksSyncedClaim(state)).toBe(state !== 'remote');
  });
});

describe('reclamation', () => {
  const name = (hash: string) => `asset-${hash}.png`;
  const created = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  const files = [
    { driveFileId: 'stale', name: name(HASH_A), createdTime: created(8) },          // clears every test
    { driveFileId: 'referenced', name: name(HASH_B), createdTime: created(8) },     // live state still points at it
    { driveFileId: 'covered', name: name('c'.repeat(64)), createdTime: created(8) },// live state moved on; a snapshot covers it
    { driveFileId: 'recent', name: name('d'.repeat(64)), createdTime: created(6) }, // inside the default grace window
    { driveFileId: 'junk', name: 'holiday-photo.png', createdTime: created(30) },   // not an asset; untouchable
  ];
  function plan(over: { complete?: boolean; coverage?: Record<string, string[]>; graceMs?: number } = {}) {
    return planAssetReclamation({ listing: { complete: over.complete ?? true, files }, referenced: ['referenced'],
      retainedSnapshotCoverage: over.coverage ?? { snapshot1: ['covered'] }, now: NOW, graceMs: over.graceMs });
  }
  it('reclaims only what clears every test, and states its policy', () => {
    const result = plan();
    expect(result.eligibleDriveFileIds).toEqual(['stale']);
    expect(result.policy).toContain('grace window');
    expect(result.blocked).toBeUndefined();
  });
  it('a partial Drive listing reclaims nothing', () => {
    // Every other candidate would clear the tests; a throttled listing still stops the pass.
    const result = plan({ complete: false });
    expect(result.eligibleDriveFileIds).toEqual([]);
    expect(result.blocked).toContain('listing');
  });
  it('reclaims only after the grace window, measured from creation', () => {
    const single = (createdTime: string) => planAssetReclamation({ listing: { complete: true,
      files: [{ driveFileId: 'f', name: name(HASH_A), createdTime }] }, referenced: [], retainedSnapshotCoverage: {}, now: NOW });
    expect(single(created(0)).eligibleDriveFileIds).toEqual([]);                                            // brand new
    expect(single(new Date(NOW - DEFAULT_ASSET_GRACE_MS).toISOString()).eligibleDriveFileIds).toEqual([]);  // exactly the window: not yet older
    expect(single(new Date(NOW - DEFAULT_ASSET_GRACE_MS - 1).toISOString()).eligibleDriveFileIds).toEqual(['f']);
    expect(single('not-a-date').eligibleDriveFileIds).toEqual([]);                                           // unknown age is not old age
    expect(plan({ graceMs: 9 * DAY }).eligibleDriveFileIds).toEqual([]);                                     // a longer window reclaims less
  });
  it('a retained snapshot receipt blocks reclamation the live state no longer references', () => {
    expect(plan({ coverage: { snapshot1: [] } }).eligibleDriveFileIds).toContain('covered');
    expect(plan({ coverage: { snapshot1: ['covered'], snapshot2: ['stale'] } }).eligibleDriveFileIds).toEqual([]);
  });
});
