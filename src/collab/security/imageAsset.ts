import { imageToBlob, hashBlob } from "../../storage/blobStore";
import type { BoardImage } from "../../types";
import { MAX_IMAGE_FILE_BYTES, MAX_STORED_IMAGE_EDGE } from "../../images/processing";

/**
 * One integrity gate for every externally supplied image asset (shared Drive
 * asset, private Drive history or peer DataChannel): strict MIME allowlist,
 * size/dimension caps and the card's hash-derived imageId must equal the SHA-256
 * of the decoded bytes. A hash supplied alongside modified bytes fails here
 * before storage or display.
 */
export const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function verifyImageAsset(imageId: string, image: BoardImage): Promise<Blob> {
  if (typeof image?.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/") ||
      image.dataUrl.length > MAX_IMAGE_FILE_BYTES * 1.5 || !image.mimeType?.startsWith("image/") ||
      !SUPPORTED_IMAGE_MIME.has(image.mimeType) ||
      !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width > MAX_STORED_IMAGE_EDGE || image.height > MAX_STORED_IMAGE_EDGE) {
    throw new Error("Invalid shared image data");
  }
  const blob = await imageToBlob(image.dataUrl);
  if (blob.size > MAX_IMAGE_FILE_BYTES || blob.type !== image.mimeType || await hashBlob(blob) !== imageId) {
    throw new Error("Shared image failed integrity verification");
  }
  return blob;
}