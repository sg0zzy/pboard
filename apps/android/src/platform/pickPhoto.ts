import { Camera, CameraErrorCode, MediaTypeSelection } from '@capacitor/camera';
import { processImageFile } from '../../../../src/images/processing';
import type { BoardImage } from '../../../../src/types';

/** The system picker grants access to just the selected photo. No gallery permission is requested. */
export async function pickPhoto(): Promise<BoardImage | null> {
  let path: string | undefined;
  try {
    const { results } = await Camera.chooseFromGallery({ mediaType: MediaTypeSelection.Photo, allowMultipleSelection: false, editable: 'no', includeMetadata: true });
    const photo = results[0];
    if (!photo) return null;
    path = photo.webPath;
    if (!path) throw new Error('The selected photo could not be opened.');
    const response = await fetch(path);
    if (!response.ok) throw new Error('The selected photo could not be read.');
    const blob = await response.blob();
    const format = photo.metadata?.format?.toLowerCase().replace('jpg', 'jpeg');
    const mime = blob.type.startsWith('image/') ? blob.type : format ? `image/${format}` : '';
    return await processImageFile(new File([blob], 'photo', { type: mime }));
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (failure?.code === CameraErrorCode.ChooseMediaCancelled || failure?.message === 'User cancelled photos app') return null;
    throw error;
  } finally {
    // The web implementation hands out a temporary object URL; native paths need no release.
    if (path?.startsWith('blob:')) URL.revokeObjectURL(path);
  }
}
