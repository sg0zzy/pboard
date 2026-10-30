/**
 * A shared board whose card references an asset nobody holds must not probe
 * Drive on every poll forever. The old fixed 2-second retry burned a Drive
 * round trip (plus a peer image request) per missing asset around the clock:
 * an attachment whose owner closed its browser left the receiver asking every
 * two seconds, keeping the extension's process busy while nothing could ever
 * arrive. The periodic retry now doubles per consecutive unfinished pass up to
 * a 60-second ceiling, while an explicit tick — a card edit, a new blob, a
 * manual sync — always probes immediately, and a clean pass resets the
 * schedule, so a late upload is picked up as soon as any local activity
 * happens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectImageSync, type SharedImageTransport } from "../../src/collab/imageSync";
import type { RxRepository } from "../../src/storage/rxdbRepository";
import type { StoredBlob } from "../../src/storage/blobStore";
import { hashBlob, imageToBlob } from "../../src/storage/blobStore";
import type { BoardImage } from "../../src/types";

const image: BoardImage = { dataUrl: "data:image/png;base64,AAECAwQ=", mimeType: "image/png", width: 1, height: 1 };

/** In-memory stand-in for the storage surface `createProjectImageSync` uses. */
function makeStubRepository(imageIds: string[]) {
  const stored = new Map<string, StoredBlob>();
  let cardListener: (() => void) | null = null;
  const repository = {
    listCards: async () => imageIds.map((imageId, index) => ({ id: `card-${index}`, imageId })),
    getImage: async (imageId: string) => stored.get(imageId) ?? null,
    blobs: {
      putBlob: async (blob: Blob, value: BoardImage): Promise<void> => {
        stored.set(await hashBlob(blob), { imageId: await hashBlob(blob), blob, mimeType: value.mimeType, width: value.width, height: value.height, size: blob.size });
      }
    },
    subscribeCards: (_projectId: string, listener: () => void) => { cardListener = listener; return () => { cardListener = null; }; },
    subscribeImages: () => () => {}
  };
  return {
    repository: repository as unknown as RxRepository,
    stored,
    notifyCards: () => cardListener?.()
  };
}

describe("missing shared image retry backoff", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("probes an absent asset sub-linearly instead of once per poll", async () => {
    const imageId = await hashBlob(await imageToBlob(image.dataUrl));
    const stub = makeStubRepository([imageId]);
    let reads = 0;
    const transport: SharedImageTransport = {
      readImage: async () => { reads += 1; return null; }, // Nobody ever uploaded it.
      writeImage: async () => { throw new Error("Viewer cannot upload"); }
    };
    const sync = createProjectImageSync({ projectId: "p", repository: stub.repository, transport, canWrite: false, onError: () => {}, pollMs: 1000 });
    vi.useFakeTimers();
    try {
      sync.start();
      await vi.advanceTimersByTimeAsync(0); // the start tick
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(29_000); // 29 more seconds
      // Fixed polling would have read 30 times; the doubling schedule keeps to
      // the handful of probes 1+2+4+8+16 seconds allow, and keeps retrying.
      expect(reads).toBeGreaterThanOrEqual(4);
      expect(reads).toBeLessThanOrEqual(6);
      const probesAt30 = reads;
      await vi.advanceTimersByTimeAsync(120_000); // two more minutes
      expect(reads - probesAt30).toBeGreaterThanOrEqual(2); // retries continue
      expect(reads - probesAt30).toBeLessThanOrEqual(4); // never back to per-poll
    } finally {
      await sync.stop();
    }
  });

  it("an explicit tick probes through the backoff and a clean pass restores the base cadence", async () => {
    const imageId = await hashBlob(await imageToBlob(image.dataUrl));
    // Computed while real timers are active: awaiting WebCrypto inside the
    // fake-timer window interleaves nondeterministically under load.
    const second = await hashBlob(await imageToBlob("data:image/png;base64,BQQDAgEA"));
    const imageIds = [imageId];
    const stub = makeStubRepository(imageIds);
    let remote: BoardImage | null = null;
    let reads = 0;
    const transport: SharedImageTransport = {
      readImage: async () => { reads += 1; return remote; },
      writeImage: async () => { throw new Error("Viewer cannot upload"); }
    };
    const sync = createProjectImageSync({ projectId: "p", repository: stub.repository, transport, canWrite: false, onError: () => {}, pollMs: 1000 });
    vi.useFakeTimers();
    try {
      sync.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20_000); // several backed-off misses
      const beforeLate = reads;
      remote = image; // the owner finished uploading while this receiver backed off
      await sync.tick(); // any local activity probes immediately, through the backoff
      expect(stub.stored.size).toBe(1); // the asset is durable now
      expect(reads).toBe(beforeLate + 1);

      // A clean pass resets the schedule: a newly referenced missing asset is
      // probed again on a base cadence, not on the old deep backoff.
      imageIds.push(second);
      stub.notifyCards(); // card change → immediate probe of the new asset
      // The listener pass is fire-and-forget and its next delay is armed when it
      // settles; await that same pass so the cadence is armed before the clock moves.
      await sync.tick();
      expect(reads).toBe(beforeLate + 2);
      await vi.advanceTimersByTimeAsync(2_500); // base(1s)+backoff(2s) probe arrives...
      expect(reads).toBe(beforeLate + 3); // ...while a stale 16s backoff would be silent
    } finally {
      await sync.stop();
    }
  });
});
