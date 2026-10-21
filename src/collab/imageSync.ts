import { blobToDataUrl } from "../storage/blobStore";
import type { RxRepository } from "../storage/rxdbRepository";
import type { BoardImage } from "../types";
import { verifyImageAsset, SUPPORTED_IMAGE_MIME } from "./security/imageAsset";

/** Allowlist for shared image assets; anything else is rejected before decode. */
const SUPPORTED_SHARED_IMAGE_MIME = SUPPORTED_IMAGE_MIME;

export interface SharedImageTransport {
  readImage(projectId: string, imageId: string): Promise<BoardImage | null>;
  writeImage(projectId: string, imageId: string, image: BoardImage): Promise<void>;
}

/** A running image transfer for one board. */
export interface ProjectImageSync {
  /** Run one transfer pass now. */
  tick(): Promise<void>;
  /** Begin the periodic transfer and the card/image subscriptions. */
  start(): void;
  /** Stop the transfer and release its subscriptions. */
  stop(): Promise<void>;
}

/** Transfer immutable image bytes through Drive without replacing live card documents. */
export function createProjectImageSync(options: {
  projectId: string;
  repository: RxRepository;
  transport: SharedImageTransport;
  canWrite: boolean;
  /** Asks authorized peers for missing attachment bytes over the authenticated DataChannel; failures keep them pending. */
  requestFromPeers?: (imageIds: string[]) => Promise<void>;
  onError: (error: unknown) => void;
  pollMs?: number;
}) {
  const { projectId, repository, transport } = options;
  const published = new Set<string>();
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let stopCards: (() => void) | undefined;
  let stopImages: (() => void) | undefined;

  async function transfer() {
    const cards = await repository.listCards(projectId, false); const ids = new Set(cards.map((card) => card.imageId).filter((id): id is string => !!id));
    const missingLocally: string[] = [];
    for (const imageId of ids) {
      if (!active) return;
      let stored = await repository.getImage(imageId);
      if (!stored) {
        let image: BoardImage | null = null;
        try { image = await transport.readImage(projectId, imageId); }
        catch (error) { options.onError(error); }
        if (!active || !image) { missingLocally.push(imageId); continue; } // Its originating browser may still be uploading.
        // Shared assets are untrusted input: strict MIME allowlist, size and
        // dimension limits, and the card's hash-derived id must match the decoded
        // bytes. This binds every image to its authenticated digest (the SHA-256
        // imageId signed into the card mutation/asset record), so a hash supplied
        // alongside modified bytes fails here before storage or display.
        const blob = await verifyImageAsset(imageId, image);
        if (!active) return;
        await repository.blobs.putBlob(blob, image);
        stored = await repository.getImage(imageId);
        published.add(imageId); // Already durable in Drive; do not re-upload a download.
      }
      if (!active) return;
      if (options.canWrite && stored && !published.has(imageId)) {
        const image: BoardImage = { dataUrl: await blobToDataUrl(stored.blob), mimeType: stored.mimeType, width: stored.width, height: stored.height };
        try {
          await transport.writeImage(projectId, imageId, image);
          published.add(imageId);
        } catch (error) { options.onError(error); }
      }
    }
    if (missingLocally.length && options.requestFromPeers) {
      // Authorized peers may hold the bytes; each receiver verifies the hash
      // itself, so a served asset cannot forge anything. A failed request keeps
      // the attachment pending; the next poll retries.
      if (!active) return;
      for (let index = 0; active && index < missingLocally.length; index += 16) {
        try { await options.requestFromPeers(missingLocally.slice(index, index + 16)); }
        catch (error) { options.onError(error); }
      }
    }
  }

  function schedule() {
    if (!active || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void tick(); }, options.pollMs ?? 2000);
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
      clearTimeout(timer);
      timer = undefined;
      stopCards?.(); stopImages?.();
      await running;
    }
  } satisfies ProjectImageSync;
}
