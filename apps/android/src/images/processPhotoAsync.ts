import { MAX_IMAGE_FILE_BYTES, MAX_STORED_IMAGE_EDGE, fitImageWithin } from '../../../../src/images/processing';
import type { BoardImage } from '../../../../src/types';

/**
 * Android photo processing off the UI thread.
 *
 * The shared `processImageFile` decodes through an `<img>` and encodes through
 * `canvas.toDataURL`, both of which run on the main thread; a 20 MB photo stalls
 * the WebView while it decodes and re-encodes. `createImageBitmap` is async and
 * `OffscreenCanvas.convertToBlob` does its work off the render path, so the
 * editor stays responsive. Validation and the 1400 px fit rule are the shared
 * module's constants, so stored dimensions match the browser exactly. The
 * caller falls back to the shared function when either API is unavailable.
 */
export async function processPhotoFileAsync(file: File): Promise<BoardImage> {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be added.');
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error('The image is larger than 20 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitImageWithin(bitmap.width, bitmap.height, MAX_STORED_IMAGE_EDGE);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable.');
    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    return {
      dataUrl: `data:${blob.type || 'image/webp'};base64,${await blobToBase64(blob)}`,
      mimeType: blob.type || 'image/webp',
      width: size.width,
      height: size.height,
    };
  } finally { bitmap.close(); }
}

export function supportsOffThreadProcessing(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
