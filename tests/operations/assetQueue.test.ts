import { describe, expect, it } from 'vitest';
import {
  assetQueueStatus, assetUploadEntry, runAssetUploadCycle,
  type AssetUploadEntry, type AssetUploadQueue,
} from '../../src/sync/operations/assetQueue';
import { sha256HexOf, type BoardAsset, type PendingAssetUpload } from '../../src/sync/operations/assets';

const bytesOf = (text: string) => new TextEncoder().encode(text);
async function entryFor(text: string): Promise<AssetUploadEntry> {
  const bytes = bytesOf(text);
  const upload: PendingAssetUpload = { id: crypto.randomUUID(), name: 'paste.png',
    mimeType: 'image/png', size: bytes.byteLength, sha256: await sha256HexOf(bytes) };
  return assetUploadEntry(upload);
}

/**
 * A fake that records the *order* of port calls: the cycle's whole contract is
 * that nothing reaches Drive before verification and nothing reaches the log
 * before the bytes land, and only the sequence of calls shows that.
 */
function harness(initial: AssetUploadEntry[] = [], options: { allocateRotates?: boolean } = {}) {
  const calls: string[] = [];
  const blobs = new Map<string, Uint8Array | null>(); // id → local copy; null = lost from the blob store
  const uploadedAssets: BoardAsset[] = [];
  const writtenOps: BoardAsset[] = [];
  const files: string[] = [];                          // Drive files actually minted
  const flags = { uploadOk: true, writeOk: true };
  let stored = [...initial];
  const queue: AssetUploadQueue = {
    async load() { calls.push('load'); return stored; },
    async persist(entries) { calls.push('persist'); stored = [...entries]; },
    async readBytes(entry) { calls.push(`read:${entry.upload.id}`); return blobs.get(entry.upload.id) ?? null; },
    async allocateFile(entry) {
      calls.push(`allocate:${entry.upload.id}`);
      // An honest port reuses the allocation it already made for this entry id.
      if (entry.upload.driveFileId !== undefined && !options.allocateRotates) return entry.upload.driveFileId;
      files.push(`file-${files.length + 1}`);
      return files[files.length - 1];
    },
    async uploadBytes(asset) { calls.push(`upload:${asset.driveFileId}`); uploadedAssets.push(asset); return flags.uploadOk; },
    async writeOperation(asset) { calls.push(`op:${asset.id}`); writtenOps.push(asset); return flags.writeOk; },
  };
  return { calls, blobs, uploadedAssets, writtenOps, files, flags, queue, storedOf: () => stored };
}

describe('offline upload cycle', () => {
  it('does nothing when the queue is empty and touches no port', async () => {
    const h = harness();
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'idle' });
    expect(h.calls).toEqual(['load']);
  });

  it('writes the operation only after the bytes land, then the entry leaves the queue', async () => {
    const entry = await entryFor('the pasted bytes');
    const h = harness([entry]);
    h.blobs.set(entry.upload.id, bytesOf('the pasted bytes'));
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'uploaded', id: entry.upload.id });
    // The upload is recorded before the operation, and the intent is persisted
    // before either — that persist is what a restart resumes from.
    expect(h.calls).toEqual([
      'load', `read:${entry.upload.id}`, `allocate:${entry.upload.id}`, 'persist',
      'upload:file-1', `op:${entry.upload.id}`, 'persist',
    ]);
    expect(h.writtenOps).toEqual([h.uploadedAssets[0]]); // the op references exactly the bytes that landed
    expect(h.storedOf()).toEqual([]);                    // `remote` is terminal: nothing left to retry
  });

  it('writes no operation when the upload fails, and retries with the same id, hash and file', async () => {
    const entry = await entryFor('bytes in flight');
    const h = harness([entry]);
    h.blobs.set(entry.upload.id, bytesOf('bytes in flight'));
    h.flags.uploadOk = false;
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'failed', id: entry.upload.id, failure: 'upload-failed' });
    expect(h.writtenOps).toEqual([]);                    // a failed upload cycle writes nothing
    expect(h.storedOf()).toEqual([{                    // surfaced, kept, and holding its allocation
      upload: { ...entry.upload, driveFileId: 'file-1' }, state: 'failed', failure: 'upload-failed' }]);
    h.flags.uploadOk = true;
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'uploaded', id: entry.upload.id });
    expect(h.uploadedAssets[1]).toEqual(h.uploadedAssets[0]); // same id, same hash, same Drive file
    expect(h.files).toEqual(['file-1']);                // and never a second file for the same id
  });

  it('fails a verification mismatch before Drive or the log is asked for anything', async () => {
    const entry = await entryFor('honest bytes');
    const h = harness([entry]);
    h.blobs.set(entry.upload.id, bytesOf('tampered xyz')); // same length; only the hash can catch it
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'failed', id: entry.upload.id, failure: 'sha256-mismatch' });
    expect(h.calls.filter(c => c.startsWith('allocate') || c.startsWith('upload') || c.startsWith('op'))).toEqual([]);
    const [at] = h.storedOf();
    expect({ state: at.state, failure: at.failure }).toEqual({ state: 'failed', failure: 'sha256-mismatch' });
    // A failed asset is never a silent discard: the entry stays in the queue and
    // the local copy is untouched — the driver has no delete port to reach.
    expect(h.storedOf().length).toBe(1);
    expect(h.blobs.get(entry.upload.id)).toEqual(bytesOf('tampered xyz'));
  });

  it('a restart resumes an entry left `uploading` without duplicating or reallocating', async () => {
    const entry = await entryFor('crash mid-upload');
    // What the crashed session persisted: the entry, its id, its allocated file.
    const h = harness([{ upload: { ...entry.upload, driveFileId: 'file-existing' }, state: 'uploading' }]);
    h.blobs.set(entry.upload.id, bytesOf('crash mid-upload'));
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'uploaded', id: entry.upload.id });
    expect(h.calls).toEqual([
      'load', `read:${entry.upload.id}`, `allocate:${entry.upload.id}`, 'persist',
      'upload:file-existing', `op:${entry.upload.id}`, 'persist',
    ]);
    expect(h.files).toEqual([]);        // the persisted allocation was reused, minted: none
    expect(h.storedOf()).toEqual([]);   // one entry went in, zero duplicates came out
  });

  it('reports a second Drive id for the same entry as a failure, never an overwrite', async () => {
    const entry = await entryFor('allocation race');
    const h = harness([{ upload: { ...entry.upload, driveFileId: 'file-original' }, state: 'uploading' }],
      { allocateRotates: true }); // a caller that cannot keep its allocation idempotent
    h.blobs.set(entry.upload.id, bytesOf('allocation race'));
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'failed', id: entry.upload.id, failure: 'drive-allocation-conflict' });
    expect(h.uploadedAssets).toEqual([]); // no upload into the second file, and nothing into the log
    expect(h.writtenOps).toEqual([]);
    const [at] = h.storedOf();
    expect(at.upload.driveFileId).toBe('file-original'); // the allocation it started the cycle with, untouched
    expect(at.failure).toBe('drive-allocation-conflict');
  });

  it('keeps the entry `uploading` when the operation write fails, and the retry completes on the same file', async () => {
    const entry = await entryFor('bytes landed, log did not');
    const h = harness([entry]);
    h.blobs.set(entry.upload.id, bytesOf('bytes landed, log did not'));
    h.flags.writeOk = false;
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'failed', id: entry.upload.id, failure: 'operation-write-failed' });
    const [at] = h.storedOf();
    expect(at.state).toBe('uploading');      // neither verification nor upload failed; not a `failed` asset
    expect(at.upload.driveFileId).toBe('file-1');
    h.flags.writeOk = true;
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'uploaded', id: entry.upload.id });
    expect(h.files).toEqual(['file-1']);     // the retry re-uploads to the same content-addressed file
    expect(h.storedOf()).toEqual([]);
  });

  it('an offline cycle loses nothing: the local copy stays intact and the entry stays retryable', async () => {
    const entry = await entryFor('queued while offline');
    const h = harness([entry]);
    const bytes = bytesOf('queued while offline');
    h.blobs.set(entry.upload.id, bytes);
    h.flags.uploadOk = false; // Drive unreachable: the port reports that the bytes did not land
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'failed', id: entry.upload.id, failure: 'upload-failed' });
    expect(h.writtenOps).toEqual([]);
    expect(h.blobs.get(entry.upload.id)).toEqual(bytes); // losing connectivity must not lose the paste
    h.flags.uploadOk = true;
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'uploaded', id: entry.upload.id });
    expect(h.files).toEqual(['file-1']); // connectivity returned; no second allocation happened meanwhile
  });

  it('never lets a broken head entry starve the ones behind it', async () => {
    const broken = await entryFor('corrupt at rest');
    const healthy = await entryFor('healthy paste');
    const h = harness([broken, healthy]);
    h.blobs.set(broken.upload.id, bytesOf('tampered bytes!')); // same length, wrong hash
    h.blobs.set(healthy.upload.id, bytesOf('healthy paste'));
    expect(await runAssetUploadCycle(h.queue)).toMatchObject({ status: 'failed', id: broken.upload.id, failure: 'sha256-mismatch' });
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'uploaded', id: healthy.upload.id });
    expect(h.storedOf().map(e => [e.upload.id, e.state])).toEqual([[broken.upload.id, 'failed']]);
  });

  it('reports waiting uploads and a blocked Synced claim, and never reports unresolved changes', async () => {
    const waiting = await entryFor('one');
    const stuck = await entryFor('two');
    const failed: AssetUploadEntry = { upload: stuck.upload, state: 'failed', failure: 'upload-failed' };
    // Failed entries stay counted: a failed upload is never "attachment removed".
    expect(assetQueueStatus([waiting, failed])).toEqual({ waiting: 2, blocksSyncedClaim: true, unresolvedChanges: 0 });
    expect(assetQueueStatus([])).toEqual({ waiting: 0, blocksSyncedClaim: false, unresolvedChanges: 0 });
    // A queue of local work is not a source of pending status in the contract's
    // unresolved sense, however long the offline stretch.
    const h = harness([waiting, failed]);
    h.blobs.set(waiting.upload.id, bytesOf('one'));
    expect(await runAssetUploadCycle(h.queue)).toEqual({ status: 'uploaded', id: waiting.upload.id });
    expect(assetQueueStatus(h.storedOf())).toEqual({ waiting: 1, blocksSyncedClaim: true, unresolvedChanges: 0 });
  });
});
