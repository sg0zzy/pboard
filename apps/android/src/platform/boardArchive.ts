import type { StoredBlob } from '../../../../src/storage/blobStore';
import type { BoardItem, Project } from '../../../../src/types';
import archiveWorkerUrl from './archiveWorker?worker&url';
import { compressArchive } from './archiveCore';
import { boardArchiveFileName, type BoardArchive } from '../../../../src/sidebar/download';
import { serializeBoard } from '../../../../src/sidebar/serialize';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
};

/**
 * Same archive contents as the shared `buildBoardArchive`, with the blocking
 * work removed from the main thread's critical path.
 *
 * Two measured problems in the shared path: it awaits each image blob in
 * series, and it compresses with `zipSync`. Compression measured ~170 ms of
 * uninterrupted main-thread work for a 60-photo board of already-compressed
 * images (a visible freeze on a phone). Note that fflate's callback `zip` does
 * NOT help here: it only offloads files of 160 KB or more, so a board of normal
 * photos still compresses synchronously on the calling thread; measured parity
 * with `zipSync`. Blob reads therefore overlap here, and compression runs in a
 * dedicated worker, following the repository's existing `?worker&url` pattern.
 */
export async function buildBoardArchiveAsync(
  project: Project,
  items: BoardItem[],
  getImage: (imageId: string) => Promise<StoredBlob | null>,
): Promise<BoardArchive> {
  // Lazy for the same reason as the shared builder: the ZIP codec is only
  // needed by an explicit export and must stay out of the startup chunk.
  const { strToU8 } = await import('fflate');
  const files: Record<string, Uint8Array> = { 'board.txt': strToU8(serializeBoard(project, items)) };

  // One entry per distinct image, first occurrence wins, exactly like the
  // shared builder. Collect first so every blob read overlaps.
  const imageKeys = new Map<string, string>();
  for (const item of items) {
    if (item.status === 'trash') continue;
    const key = item.imageId ?? (item.image ? `data:${item.image.dataUrl}` : null);
    if (key === null || imageKeys.has(key)) continue;
    imageKeys.set(key, item.id);
  }
  const imagePaths = new Map<string, string>();
  const entries = await Promise.all([...imageKeys].map(async ([key, id], index) => {
    const item = items.find(value => value.id === id)!;
    const entry = item.imageId
      ? await getImage(item.imageId)
      : item.image
        ? { blob: await (await fetch(item.image.dataUrl)).blob(), mimeType: item.image.mimeType }
        : null;
    if (!entry) return null;
    const extension = IMAGE_EXTENSIONS[entry.mimeType] ?? entry.mimeType.split('/')[1]?.split('+')[0] ?? 'img';
    // The number follows first-occurrence order, which is what the shared
    // builder produces; it is fixed before any await so concurrent reads cannot
    // claim the same slot.
    const named = `images/${id}-${index + 1}.${extension}`;
    imagePaths.set(key, named);
    return [named, new Uint8Array(await entry.blob.arrayBuffer())] as const;
  }));
  for (const entry of entries) if (entry) files[entry[0]] = entry[1];

  files['board.json'] = strToU8(JSON.stringify({
    format: 'pboard-download', version: 1, name: project.name, template: project.template,
    cards: [...items].filter(item => item.status !== 'trash').sort((a, b) => a.order - b.order).map(item => ({
      type: item.type, status: item.status, title: item.title, content: item.content,
      displayMode: item.displayMode, source: item.source,
      imagePath: imagePaths.get(item.imageId ?? (item.image ? `data:${item.image.dataUrl}` : '')),
      imageWidth: item.image?.width ?? item.imageWidth,
      imageHeight: item.image?.height ?? item.imageHeight,
    })),
  }));
  return { filename: boardArchiveFileName(project), data: await compressOffThread(files) };
}

/** Compress off the UI thread. The worker is created per export and terminated
 * afterwards, so a large archive leaves no resident thread behind. Without
 * `Worker` (Node tests, older WebViews) the same code runs here. */
async function compressOffThread(files: Record<string, Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return compressArchive({ files });
  const worker = new Worker(new URL(archiveWorkerUrl, globalThis.location.href), { type: 'module' });
  try {
    return await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The board archive took too long to build.')), 60_000);
      worker.onmessage = (event: MessageEvent<{ value?: Uint8Array<ArrayBuffer>; error?: string }>) => {
        clearTimeout(timer);
        if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.value!);
      };
      worker.onerror = () => { clearTimeout(timer); reject(new Error('The board archive could not be built.')); };
      worker.postMessage({ id: 1, payload: { files } });
    });
  } finally { worker.terminate(); }
}
