import type { BoardImage } from '../../../../src/types';
import type { RxRepository, BoardItem } from './repository';

type CardFields = Pick<BoardItem, 'title' | 'content' | 'type' | 'status' | 'displayMode'>;
/** Resolve the blob first, then commit image references and editor fields in one existing repository update. */
export async function updateCardPhoto(repository: RxRepository, id: string, fields: CardFields, image: BoardImage | null | undefined) {
  const normalized = { ...fields, title: fields.title?.trim() || undefined };
  if (image === undefined) return repository.updateItem(id, normalized);
  const imageId = image ? await repository.putImage(image) : undefined;
  const patch = { ...normalized, imageId, imageMimeType: image?.mimeType, imageWidth: image?.width, imageHeight: image?.height };
  // The existing updater applies supplied fields together and handles project revision/timestamps.
  // These image-reference fields already exist in its schema; no extension/schema change is needed.
  await repository.updateItem(id, patch);
}
