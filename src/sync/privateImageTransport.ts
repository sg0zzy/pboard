import { createDriveTransport, type DriveTransport } from "./driveTransport";
import type { SharedImageTransport } from "../collab/imageSync";
import type { BoardImage } from "../types";
import type { GoogleAuthProvider } from "./googleAuth";
import { verifyImageAsset } from "../collab/security/imageAsset";

/**
 * Account-private attachment assets for the independent collaboration path.
 * Immutable, content-addressed `image-<hash>.json` records in this account's own
 * `appDataFolder`. Authorized peers receive bytes through the authenticated
 * WebRTC DataChannel; peers on the same account also reuse these records;
 * signaling carries no image contents. Reuses the existing blob hashing and the
 * Drive transport's bounded retry behavior.
 */
export function createPrivateImageTransport(auth: GoogleAuthProvider, fetcher: typeof fetch = fetch,
  authorize?: (boardId: string, token: string) => Promise<() => Promise<boolean>>): SharedImageTransport {
  async function session(boardId: string): Promise<DriveTransport> {
    // Pin the credential for the WHOLE operation, including retries. A 401 must
    // never refresh into a different account halfway through an upload.
    const token = await auth.getAccessToken();
    const current = authorize ? await authorize(boardId, token) : async () => await auth.getConnectionState() === "connected";
    const boundFetch: typeof fetch = async (input, init) => {
      if (!await current()) throw new Error("Private attachment account changed; transfer remains pending");
      const response = await fetcher(input, init);
      if (!await current()) { await response.body?.cancel(); throw new Error("Private attachment account changed; transfer remains pending"); }
      return response;
    };
    return createDriveTransport({ ...auth, getAccessToken: async () => token }, boundFetch, "image-");
  }
  async function readAsset(transport: DriveTransport, imageId: string): Promise<{ format?: string; imageId?: string; image?: BoardImage } | null> {
    const file = await transport.findProjectFile(imageId);
    if (!file) return null;
    return JSON.parse(await transport.download(file.id)) as { format?: string; imageId?: string; image?: BoardImage };
  }
  return {
    async readImage(projectId, imageId) {
      const saved = await readAsset(await session(projectId), imageId);
      if (!saved) return null;
      if (saved.format !== "pboard-image" || saved.imageId !== imageId || !saved.image) throw new Error("Invalid private image asset");
      await verifyImageAsset(imageId, saved.image);
      return saved.image;
    },
    async writeImage(projectId, imageId, image) {
      await verifyImageAsset(imageId, image);
      const transport = await session(projectId);
      const contents = JSON.stringify({ format: "pboard-image", imageId, image });
      const existing = await transport.findProjectFile(imageId);
      // Immutable assets: identical bytes are a no-op; a hash collision or a
      // partial previous create without the final file is corrected here.
      if (existing) {
        const saved = JSON.parse(await transport.download(existing.id)) as { format?: string; imageId?: string; image?: BoardImage };
        if (saved.format === "pboard-image" && saved.imageId === imageId && saved.image) {
          await verifyImageAsset(imageId, saved.image); return;
        }
        await transport.upload(imageId, contents, existing.id);
      } else await transport.upload(imageId, contents);
    }
  };
}
