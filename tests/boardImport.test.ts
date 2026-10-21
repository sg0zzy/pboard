import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { strToU8, zipSync, unzipSync } from 'fflate';
import { buildBoardArchive } from '../src/sidebar/download';
import { importLocalBoard } from '../src/storage/importBoard';
import { readBoardArchive, importBoardCopy } from '../src/sidebar/importBoard';
import { createRxRepository, type RxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../src/storage/blobStore';
import type { Project, BoardItem } from '../src/types';
const project: Project = { id: 'original', name: 'My board', template: 'project', revision: 2, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const card: BoardItem = { id: 'original-card', projectId: project.id, title: 'Separate title', content: 'Text\n\n[task] [done] literal text', type: 'task', status: 'started', order: 0, displayMode: 'expanded', createdAt: project.createdAt, updatedAt: project.updatedAt };
const repos: RxRepository[] = [];
afterEach(async () => { for (const repo of repos.splice(0)) await repo.db.remove(); });

it('round-trips structured cards, exact text, template, order and shared images without importing identity or authorization', async () => {
  const imageId = 'shared';
  const source = { provider: 'Test', conversationUrl: 'https://example.test/conversation' };
  const archive = await buildBoardArchive(project, [{ ...card, imageId, imageWidth: 4, imageHeight: 5, source, _sec: { private: true } } as BoardItem,
    { ...card, id: 'second', order: 1, content: '', imageId, imageWidth: 4, imageHeight: 5 }, { ...card, id: 'trash', status: 'trash' }], async () => ({ imageId, blob: new Blob(['png']), mimeType: 'image/png', width: 4, height: 5, size: 3 }));
  const parsed = await readBoardArchive(archive.data);
  expect(parsed).toMatchObject({ name: project.name, template: 'project', legacy: false });
  expect(parsed.cards).toHaveLength(2);
  expect(parsed.cards[0]).toMatchObject({ title: card.title, content: card.content, displayMode: 'expanded', source, image: { width: 4, height: 5 } });
  expect(parsed.cards[1].image?.dataUrl).toBe(parsed.cards[0].image?.dataUrl);
  expect(parsed.cards[0]).not.toHaveProperty('_sec');
  expect(parsed.cards[0]).not.toHaveProperty('id');
  const target = { importLocalBoard: vi.fn(async () => project) };
  await importBoardCopy(parsed, target);
  expect(target.importLocalBoard).toHaveBeenCalledWith(project.name, 'project', parsed.cards);
});

it('restores older prompt/image ZIPs, keeping multiline text and all images', async () => {
  const parsed = await readBoardArchive(zipSync({ 'board.txt': strToU8('PROJECT: Old board\n\n[goal] [candidate] Title\nBody\n\nParagraph\n\n[task] [to validate] Review'), 'images/old-1.png': strToU8('png') }));
  expect(parsed.legacy).toBe(true); expect(parsed.template).toBe('project');
  expect(parsed.cards.map(c => c.content)).toEqual(['Title\nBody\n\nParagraph', 'Review', '']);
  expect(parsed.cards[1].status).toBe('to validate');
  expect(parsed.cards[2].image?.dataUrl).toBe('data:image/png;base64,cG5n');
});

it('imports repeated copies into real RxDB without changing the original board', async () => {
  const name = `import${crypto.randomUUID().replaceAll('-', '')}`;
  const repo = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) }); repos.push(repo);
  const existing = await repo.createProject(project.name, 'project');
  const previous = await repo.addItem({ projectId: existing.id, content: 'Keep original' });
  const parsed = await readBoardArchive((await buildBoardArchive(project, [card], async () => null)).data);
  const target = { importLocalBoard: (name: string, template: Project['template'], cards: typeof parsed.cards) => importLocalBoard(repo, name, template, cards) };
  const first = await importBoardCopy(parsed, target), second = await importBoardCopy(parsed, target);
  expect(first.id).not.toBe(second.id);
  expect(await repo.listProjects()).toHaveLength(3);
  expect((await repo.getCard(previous.id))?.content).toBe('Keep original');
  expect((await repo.listCards(first.id))[0].content).toBe(card.content);
  expect(await repo.journal.permissions.get(first.id)).toBeUndefined();
});

it('rejects malformed metadata, unsafe image paths, missing images and oversized expanded files before writing', async () => {
  await expect(readBoardArchive(zipSync({ 'unrelated.txt': strToU8('No board') }))).rejects.toThrow('supported Pboard');
  const files = unzipSync((await buildBoardArchive(project, [card], async () => null)).data);
  const metadata = JSON.parse(new TextDecoder().decode(files['board.json']));
  for (const imagePath of ['../secret.png', 'images/missing.png']) {
    metadata.cards[0].imagePath = imagePath;
    await expect(readBoardArchive(zipSync({ ...files, 'board.json': strToU8(JSON.stringify(metadata)) }))).rejects.toThrow('supported Pboard');
  }
  // Forge an excessive central-directory size; reject before decompression.
  const zip = zipSync({ 'board.txt': strToU8('PROJECT: Huge') });
  const view = new DataView(zip.buffer);
  for (let i = 0; i < zip.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 100 * 1024 * 1024, true); break; }
  await expect(readBoardArchive(zip)).rejects.toThrow('64 MB');
});
