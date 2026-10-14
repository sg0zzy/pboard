/** Fit the entire photo; never crop it or upscale small pictures. */
export function thumbnailSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid photo dimensions.');
  const scale = Math.min(1, 480 / width, 240 / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function thumbnailBlob(blob: Blob): Promise<Blob> {
  const source = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('The photo could not be decoded.')); image.src = source;
    });
    const size = thumbnailSize(image.naturalWidth, image.naturalHeight);
    if (size.width === image.naturalWidth && size.height === image.naturalHeight) return blob;
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo preview is unavailable.');
    context.drawImage(image, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Photo preview could not be generated.')), 'image/webp', .82));
  } finally { URL.revokeObjectURL(source); }
}
