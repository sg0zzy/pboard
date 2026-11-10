import { strToU8, zipSync } from 'fflate';

/** Worker payload: pre-named files, so the worker only compresses and packs. */
export type ArchivePayload = { files: Record<string, Uint8Array> };

/** Runs inside the archive worker. `zipSync` is deliberate: this thread exists
 * precisely so the blocking compression never touches the UI thread. */
export function compressArchive({ files }: ArchivePayload): Uint8Array<ArrayBuffer> {
  return zipSync(files);
}

/** Kept separate from the worker entry so the main thread can fall back to the
 * same code path where `Worker` is unavailable (Node tests, older WebViews). */
export { strToU8 };
