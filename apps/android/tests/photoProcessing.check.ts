import { describe, expect, it, vi } from 'vitest';
import { fitImageWithin } from '../../../src/images/processing';
import { processPhotoFileAsync, supportsOffThreadProcessing } from '../src/images/processPhotoAsync';

function stubBitmap(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })));
  return { close };
}

describe('off-thread Android photo processing', () => {
  it('reports support only when both off-thread APIs exist', () => {
    vi.unstubAllGlobals();
    const original = globalThis.OffscreenCanvas;
    // @ts-expect-error deliberately removing the API
    delete globalThis.OffscreenCanvas;
    expect(supportsOffThreadProcessing()).toBe(false);
    globalThis.OffscreenCanvas = original;
  });
  it('rejects unsupported types and oversized files before decoding', async () => {
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    await expect(processPhotoFileAsync(new File(['x'], 'a', { type: 'text/plain' }))).rejects.toThrow('Only image files');
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'a', { type: 'image/png' });
    await expect(processPhotoFileAsync(big)).rejects.toThrow('larger than 20 MB');
    expect(bitmap).not.toHaveBeenCalled();
  });
  it('stores the shared fit dimensions and closes the decoded bitmap', async () => {
    const { close } = stubBitmap(2800, 1400);
    const drawImage = vi.fn();
    const convertToBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }));
    vi.stubGlobal('OffscreenCanvas', class { width; height; constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { drawImage }; }
      convertToBlob = convertToBlob; });
    const image = await processPhotoFileAsync(new File([new Uint8Array([1])], 'a', { type: 'image/png' }));
    expect(image).toMatchObject({ ...fitImageWithin(2800, 1400), mimeType: 'image/webp' });
    expect(image.dataUrl).toBe('data:image/webp;base64,AQID');
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2800, 1400, 0, 0, 1400, 700);
    expect(close).toHaveBeenCalledOnce();
  });
});
