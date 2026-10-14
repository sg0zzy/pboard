// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createRxRepository } from '../../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../../src/storage/blobStore';
import { buildBoardArchive } from '../../../src/sidebar/download';
import { serializeBoard } from '../../../src/sidebar/serialize';
import { updateCardPhoto } from '../src/storage/cardPhotos';
import { readSnapshot, setUiScale } from '../src/storage/repository';
const unique = () => `parity${crypto.randomUUID().replaceAll('-', '')}`;

describe('shared local feature semantics after the main rebase', () => {
  it('duplicates an image card after its source and resets status while preserving metadata', async () => {
    const repository = await createRxRepository({ name: unique(), blobs: createIndexedDbBlobStore(unique()) });
    try {
      const board = await repository.createProject('Parity');
      const first = await repository.addItem({ projectId: board.id, content: 'A', status: 'done', displayMode: 'expanded', image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF6sAAAAASUVORK5CYII=', mimeType: 'image/png', width: 1, height: 1 }, source: { provider: 'chat', conversationUrl: 'https://example.com' } });
      const last = await repository.addItem({ projectId: board.id, content: 'B' });
      const duplicate = await repository.duplicateItem(first.id);
      expect(duplicate).toMatchObject({ imageId: first.imageId, status: 'candidate', displayMode: 'expanded', source: first.source });
      expect((await repository.listCards(board.id)).map(card => card.id)).toEqual([first.id, duplicate.id, last.id]);
      const inserted = await repository.addItem({ projectId: board.id, content: 'Inserted', afterItemId: first.id });
      expect((await repository.listCards(board.id)).map(card => card.id)).toEqual([first.id, inserted.id, duplicate.id, last.id]);
    } finally { await repository.db.close(); }
  });
  it('merges title/text and preserves the target category, status, image and manual rank', async () => {
    const repository = await createRxRepository({ name: unique() });
    try {
      const board = await repository.createProject('Merge', 'project');
      const source = await repository.addItem({ projectId: board.id, title: 'Source title', content: 'Source text', type: 'task' });
      const target = await repository.addItem({ projectId: board.id, content: 'Target', type: 'goal', status: 'started', displayMode: 'compact' });
      const rank = (await repository.db.cards.findOne(target.id).exec())!.orderKey;
      await repository.mergeItems(source.id, target.id);
      expect(await repository.getCard(source.id)).toBeNull();
      expect(await repository.getCard(target.id)).toMatchObject({ content: 'Target\n\nSource title\nSource text', type: 'goal', status: 'started', displayMode: 'compact' });
      expect((await repository.db.cards.findOne(target.id).exec())!.orderKey).toBe(rank);
      const image = await repository.addItem({ projectId: board.id, content: '', image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF6sAAAAASUVORK5CYII=', mimeType: 'image/png', width: 1, height: 1 } });
      await expect(repository.mergeItems(image.id, target.id)).rejects.toThrow('Image cards');
      expect(await repository.getCard(image.id)).not.toBeNull();
    } finally { await repository.db.close(); }
  });
  it('exports the exact browser archive, deduplicates images, excludes trash, and never edits timestamps', async () => {
    const repository = await createRxRepository({ name: unique(), blobs: createIndexedDbBlobStore(unique()) });
    try {
      const board = await repository.createProject('Download');
      const first = await repository.addItem({ projectId: board.id, content: 'Image caption', image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF6sAAAAASUVORK5CYII=', mimeType: 'image/png', width: 1, height: 1 } });
      await repository.duplicateItem(first.id);
      await repository.addItem({ projectId: board.id, content: 'Trashed', status: 'trash' });
      const cards = await repository.listCards(board.id); const before = await repository.getProject(board.id);
      const archive = await buildBoardArchive(board, cards, repository.getImage);
      const contents = unzipSync(archive.data);
      expect(archive.filename).toBe('Download.zip'); expect(strFromU8(contents['board.txt'])).toBe(serializeBoard(board, cards));
      expect(Object.keys(contents).filter(name => name.startsWith('images/'))).toHaveLength(1);
      expect(strFromU8(contents['board.txt'])).not.toContain('Trashed');
      expect(await repository.getProject(board.id)).toEqual(before);
    } finally { await repository.db.close(); }
  });
  it('saving an unchanged untitled card does not invent an edit or an empty persistent title', async () => {
    const repository = await createRxRepository({ name: unique() });
    try {
      const board = await repository.createProject('Unchanged'); const card = await repository.addItem({ projectId: board.id, content: 'Text' });
      const before = await repository.getProject(board.id);
      await updateCardPhoto(repository, card.id, { title: '', content: 'Text', type: card.type, status: card.status }, undefined);
      expect(await repository.getProject(board.id)).toEqual(before);
      expect((await repository.getCard(card.id))!.title).toBeUndefined();
    } finally { await repository.db.close(); }
  });
  it('persists font size and display mode after restart and keeps preference-only changes out of edit timestamps', async () => {
    const name = unique(); let repository = await createRxRepository({ name });
    try {
      const board = await repository.createProject('Scale'); const card = await repository.addItem({ projectId: board.id, content: 'Text' });
      const before = await repository.getProject(board.id);
      await setUiScale(repository, 1.2); expect(await repository.getProject(board.id)).toEqual(before);
      await repository.updateItem(card.id, { displayMode: 'compact' });
      await repository.db.close(); repository = await createRxRepository({ name });
      const snapshot = await readSnapshot(repository); expect(snapshot.uiScale).toBe(1.2); expect(snapshot.cards[0].displayMode).toBe('compact');
    } finally { await repository.db.close(); }
  });
});
