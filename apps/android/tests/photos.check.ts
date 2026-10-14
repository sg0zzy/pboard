import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera, CameraErrorCode, MediaTypeSelection } from '@capacitor/camera';
import { processImageFile } from '../../../src/images/processing';
import { pickPhoto } from '../src/platform/pickPhoto';
import { thumbnailSize } from '../src/images/thumbnail';
vi.mock('@capacitor/camera', () => ({ Camera: { chooseFromGallery: vi.fn() }, CameraErrorCode: { ChooseMediaCancelled: 'OS-PLUG-CAMR-0020' }, MediaTypeSelection: { Photo: 0 } }));
vi.mock('../../../src/images/processing', () => ({ processImageFile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
describe('Android photo selection and thumbnails', () => {
  it('uses a single-photo picker and runs the existing image processing utility', async () => {
    const image = { dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', width: 100, height: 200 };
    vi.mocked(Camera.chooseFromGallery).mockResolvedValue({ results: [{ type: 0, saved: false, webPath: image.dataUrl }] });
    vi.mocked(processImageFile).mockResolvedValue(image);
    expect(await pickPhoto()).toEqual(image);
    expect(Camera.chooseFromGallery).toHaveBeenCalledExactlyOnceWith({ mediaType: MediaTypeSelection.Photo, allowMultipleSelection: false, editable: 'no', includeMetadata: true });
    const file = vi.mocked(processImageFile).mock.calls[0][0];
    expect(file.type).toBe('image/png'); expect(file.size).toBeGreaterThan(0);
  });
  it('treats cancellation and an empty selection as no change, but surfaces real failures', async () => {
    vi.mocked(Camera.chooseFromGallery).mockRejectedValueOnce({ code: CameraErrorCode.ChooseMediaCancelled });
    expect(await pickPhoto()).toBeNull();
    vi.mocked(Camera.chooseFromGallery).mockRejectedValueOnce(new Error('User cancelled photos app'));
    expect(await pickPhoto()).toBeNull();
    vi.mocked(Camera.chooseFromGallery).mockResolvedValueOnce({ results: [] }); expect(await pickPhoto()).toBeNull();
    vi.mocked(Camera.chooseFromGallery).mockRejectedValueOnce(new Error('Gallery unavailable'));
    await expect(pickPhoto()).rejects.toThrow('Gallery unavailable');
    expect(processImageFile).not.toHaveBeenCalled();
  });
  it('fits portrait, landscape and small images without cropping or enlarging', () => {
    expect(thumbnailSize(1400, 700)).toEqual({ width: 480, height: 240 });
    expect(thumbnailSize(700, 1400)).toEqual({ width: 120, height: 240 });
    expect(thumbnailSize(1800, 300)).toEqual({ width: 480, height: 80 });
    expect(thumbnailSize(100, 80)).toEqual({ width: 100, height: 80 });
    expect(() => thumbnailSize(0, 20)).toThrow(); expect(() => thumbnailSize(NaN, 20)).toThrow();
  });
});
