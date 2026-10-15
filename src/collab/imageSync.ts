import { blobToDataUrl, hashBlob, imageToBlob } from "../storage/blobStore";
import type { RxRepository } from "../storage/rxdbRepository";
import type { BoardImage } from "../types";
import { MAX_IMAGE_FILE_BYTES, MAX_STORED_IMAGE_EDGE } from "../images/processing";

/** Allowlist for shared image assets; anything else is rejected before decode. */
const SUPPORTED_SHARED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface SharedImageTransport {
  readImage(projectId: string, imageId: string): Promise<BoardImage | null>;
  writeImage(projectId: string, imageId: string, image: BoardImage): Promise<void>;
}

/** Transfer immutable image bytes through Drive without replacing live card documents. */
export function createProjectImageSync(options: {
  projectId: string;
  repository: RxRepository;
  transport: SharedImageTransport;
  canWrite: boolean;
  onError: (error: unknown) => void;
  pollMs?: number;
}) {
  const { projectId, repository, transport } = options;
  const published = new Set<string>();
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopCards: (() => void) | undefined;
  let stopImages: (() => void) | undefined;

  async function transfer() {
    const cards = await repository.listCards(projectId);
    const ids = new Set(cards.map((card) => card.imageId).filter((id): id is string => !!id));
    for (const imageId of ids) {
      if (!active) return;
      let stored = await repository.getImage(imageId);
      if (!stored) {
        const image = await transport.readImage(projectId, imageId);
        if (!active || !image) continue; // Its originating browser may still be uploading.
        // Shared assets are untrusted input: strict MIME allowlist, size and
        // dimension limits, and the card's hash-derived id must match the decoded
        // bytes. This binds every image to its authenticated digest (the SHA-256
        // imageId signed into the card mutation/asset record), so a hash supplied
        // alongside modified bytes fails here before storage or display.
        if (typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/") ||
            image.dataUrl.length > MAX_IMAGE_FILE_BYTES * 1.5 || !image.mimeType?.startsWith("image/") ||
            !SUPPORTED_SHARED_IMAGE_MIME.has(image.mimeType) ||
            !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
            image.width < 1 || image.height < 1 || image.width > MAX_STORED_IMAGE_EDGE || image.height > MAX_STORED_IMAGE_EDGE) {
          throw new Error("Invalid shared image data");
        }
        const blob = await imageToBlob(image.dataUrl);
        if (blob.size > MAX_IMAGE_FILE_BYTES || blob.type !== image.mimeType || await hashBlob(blob) !== imageId) {
          throw new Error("Shared image failed integrity verification");
        }
        if (!active) return;
        await repository.blobs.putBlob(blob, image);
        stored = await repository.getImage(imageId);
        published.add(imageId); // Already durable in Drive; do not re-upload a download.
      }
      if (!active) return;
      if (options.canWrite && stored && !published.has(imageId)) {
        const image: BoardImage = { dataUrl: await blobToDataUrl(stored.blob), mimeType: stored.mimeType, width: stored.width, height: stored.height };
        await transport.writeImage(projectId, imageId, image);
        published.add(imageId);
      }
    }
  }

  function schedule() {
    if (!active || timer !== null) return;
    timer = setTimeout(() => { timer = null; void tick(); }, options.pollMs ?? 2000);
  }

  function tick(): Promise<void> {
    if (!active) return Promise.resolve();
    if (running) return running;
    running = transfer().catch(options.onError).finally(() => {
      running = null;
      schedule();
    });
    return running;
  }

  return {
    tick,
    start() {
      active = true;
      stopCards = repository.subscribeCards(projectId, () => { void tick(); });
      stopImages = repository.subscribeImages(() => { void tick(); });
      void tick();
    },
    async stop() {
      active = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stopCards?.(); stopImages?.();
      await running;
    }
  };
}
