import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore, hashBlob } from '../src/storage/blobStore';
import { createCollaborativeCopy } from '../src/collab/collaborativeCopy';

const repos = { current: [] as Awaited<ReturnType<typeof createRxRepository>>[] };
afterEach(async () => { for (const r of repos.current.splice(0)) await r.db.close(); });

const image = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', mimeType: 'image/png', width: 1, height: 1 };

it('a collaborative copy keeps attachment bytes, new card identities and no migrated signatures', async () => {
  const repo = await createRxRepository({ name: `copy-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`copyblob-${crypto.randomUUID()}`) });
  repos.current.push(repo);
  const board = await repo.createProject('Signed original', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'Original content', image });
  const imageId = (await repo.getCard(card.id))!.imageId!;
  const copyId = await createCollaborativeCopy(repo, board.id);
  expect(copyId).not.toBe(board.id);
  const copyCards = await repo.listCards(copyId);
  expect(copyCards).toHaveLength(1);
  expect(copyCards[0].id).not.toBe(card.id);
  expect(copyCards[0].imageId).toBe(imageId);
  const stored = await repo.getImage(imageId);
  expect(stored && await hashBlob(stored.blob)).toBe(imageId);
  const project = await repo.getProject(copyId);
  expect(project!.name).toContain('collaboration copy');
  expect((project as unknown as Record<string, unknown>)._sec).toBeUndefined();
});