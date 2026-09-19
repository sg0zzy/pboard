import type { BoardImage } from "../types";

export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_STORED_IMAGE_EDGE = 1400;

export type CaptureRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  href?: string;
};

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function computeCropRect(imageWidth: number, imageHeight: number, region: CaptureRegion): CropRect {
  const scaleX = imageWidth / region.viewportWidth;
  const scaleY = imageHeight / region.viewportHeight;
  const x = Math.min(Math.max(0, Math.round(region.x * scaleX)), Math.max(0, imageWidth - 1));
  const y = Math.min(Math.max(0, Math.round(region.y * scaleY)), Math.max(0, imageHeight - 1));
  const width = Math.max(1, Math.min(imageWidth - x, Math.round(region.width * scaleX)));
  const height = Math.max(1, Math.min(imageHeight - y, Math.round(region.height * scaleY)));
  return { x, y, width, height };
}

export function fitImageWithin(width: number, height: number, maxEdge = MAX_STORED_IMAGE_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

export async function processImageFile(file: File): Promise<BoardImage> {
  if (!file.type.startsWith("image/")) throw new Error("Only image files can be added.");
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error("The image is larger than 20 MB.");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    return drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function cropCapturedImage(dataUrl: string, region: CaptureRegion): Promise<BoardImage> {
  const image = await loadImage(dataUrl);
  const rect = computeCropRect(image.naturalWidth, image.naturalHeight, region);
  return drawImage(image, rect.x, rect.y, rect.width, rect.height);
}

function drawImage(
  image: HTMLImageElement,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number
): BoardImage {
  const size = fitImageWithin(sourceWidth, sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable.");
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, size.width, size.height);
  const dataUrl = canvas.toDataURL("image/webp", 0.82);
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png";
  return { dataUrl, mimeType, width: size.width, height: size.height };
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be decoded."));
    image.src = source;
  });
}
