// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createRxRepository } from '../../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../../src/storage/blobStore';
import { updateCardPhoto } from '../src/storage/cardPhotos';
import { readSnapshot } from '../src/storage/repository';
const unique = () => `photo${crypto.randomUUID().replaceAll('-', '')}`;
const image = (color: string) => ({ dataUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="${color}"/></svg>`)}`, mimeType: 'image/svg+xml', width: 20, height: 10 });

describe('Android photo storage', () => {
  it('attaches/replaces images with one card update, preserves order and survives restart', async () => {
    const name = unique(); const blobs = createIndexedDbBlobStore(unique());
    let repository = await createRxRepository({ name, blobs });
    try {
      const board = await repository.createProject('Photos');
      const card = await repository.addItem({ projectId: board.id, content: '' });
      const before = (await repository.db.cards.findOne(card.id).exec())!;
      const rank = before.orderKey;
      const fields = { title: '', content: '', type: card.type, status: card.status };
      const revision = (await repository.getProject(board.id))!.revision;
      await updateCardPhoto(repository, card.id, fields, image('red'));
      const first = (await readSnapshot(repository)).cards[0];
      expect(first.imageId).toBeTruthy(); expect(first.imageWidth).toBe(20); expect(first.imageHeight).toBe(10);
      expect(await repository.imageAvailability(first.imageId!)).toBe('available');
      expect((await repository.getProject(board.id))!.revision).toBe(revision + 1);
      const edited = (await repository.getCard(card.id))!.updatedAt;
      await updateCardPhoto(repository, card.id, fields, undefined);
      expect((await repository.getCard(card.id))!.updatedAt).toBe(edited);
      await updateCardPhoto(repository, card.id, fields, image('blue'));
      const second = (await repository.getCard(card.id))!;
      expect(second.imageId).not.toBe(first.imageId);
      expect((await repository.db.cards.findOne(card.id).exec())!.orderKey).toBe(rank);
      await repository.db.close(); repository = await createRxRepository({ name, blobs });
      expect((await readSnapshot(repository)).cards[0].imageId).toBe(second.imageId);
      expect(await repository.imageAvailability(second.imageId!)).toBe('available');
    } finally { await repository.db.close(); }
  });
  it('removes image references without breaking another card sharing the blob', async () => {
    const repository = await createRxRepository({ name: unique(), blobs: createIndexedDbBlobStore(unique()) });
    try {
      const board = await repository.createProject('Shared photos');
      const card = await repository.addItem({ projectId: board.id, content: 'Caption', image: image('red') });
      const duplicate = await repository.duplicateItem(card.id);
      await updateCardPhoto(repository, card.id, { content: 'Keep caption', title: '', type: card.type, status: card.status }, null);
      const updated = (await repository.getCard(card.id))!;
      expect(updated.imageId).toBeUndefined(); expect(updated.imageWidth).toBeUndefined(); expect(updated.content).toBe('Keep caption');
      expect((await repository.getCard(duplicate.id))!.imageId).toBe(card.imageId);
      expect(await repository.imageAvailability(card.imageId!)).toBe('available');
    } finally { await repository.db.close(); }
  });
  it('keeps the original card reference if writing the replacement blob fails', async () => {
    const blobs = createIndexedDbBlobStore(unique());
    const repository = await createRxRepository({ name: unique(), blobs });
    try {
      const board = await repository.createProject('Write failure');
      const card = await repository.addItem({ projectId: board.id, content: 'Original', image: image('red') });
      const original = await repository.getCard(card.id);
      blobs.putBlob = async () => { throw new Error('Storage full'); };
      await expect(updateCardPhoto(repository, card.id, { title: '', content: 'New', type: card.type, status: card.status }, image('blue'))).rejects.toThrow('Storage full');
      expect(await repository.getCard(card.id)).toEqual(original);
    } finally { await repository.db.close(); }
  });
});
