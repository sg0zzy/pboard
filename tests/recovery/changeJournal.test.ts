import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { recoverJournal } from '../../src/storage/journalStorage';
import { installCollectionMutationGuard } from '../../src/collab/security/mutation';

const repositories: RxRepository[] = [];
async function repository(name = `journal-${crypto.randomUUID()}`) {
  const repo = await createRxRepository({ name }); repositories.push(repo); return repo;
}
afterEach(async () => { for (const repo of repositories.splice(0)) await repo.db.close(); });

it('journals real command writes and ancestry; pending delivery and scoped receipts survive restart', async () => {
  let repo = await repository(); const name = repo.db.name;
  const board = await repo.createProject('Journal', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'before' });
  await repo.updateItem(card.id, { content: 'after' });
  const changes = (await repo.journal.pending('drive:account-a')).filter(c => c.documentId === card.id);
  expect(changes).toHaveLength(2);
  const edit = changes.find(c => c.value.content === 'after')!;
  expect(edit.parents).toEqual([changes.find(c => c.value.content === 'before')!.id]);
  await repo.journal.acknowledge(edit.id, 'drive:account-a');
  await repo.db.close(); repo = await repository(name);
  expect((await repo.journal.pending('drive:account-a')).some(c => c.id === edit.id)).toBe(false);
  expect((await repo.journal.pending('peer:device-b')).some(c => c.id === edit.id)).toBe(true);
  expect((await repo.getCard(card.id))?.content).toBe('after');
});

it('recovers a document committed before the journal acknowledgement and retains ambiguous prepared data', async () => {
  const repo = await repository(); const board = await repo.createProject('Crash', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'before' });
  const failure = vi.spyOn(repo.journal, 'finish').mockRejectedValueOnce(new Error('interrupted after document write'));
  await expect(repo.updateItem(card.id, { content: 'committed bytes' })).rejects.toThrow();
  failure.mockRestore();
  expect(await repo.journal.entries.where('state').equals('prepared').count()).toBe(1);
  await recoverJournal(repo.journal, repo.db);
  expect((await repo.journal.pending('drive:a')).some(c => c.value.content === 'committed bytes')).toBe(true);
  const doc = (await repo.db.cards.findOne(card.id).exec())!.toJSON(true);
  const pending = await repo.journal.prepare('cards', { ...doc, content: 'never committed', _rev: 'unwritten' }, doc, true);
  await recoverJournal(repo.journal, repo.db);
  expect((await repo.journal.entries.get(pending.id))?.state).toBe('uncertain');
  expect((await repo.db.cards.storageInstance.findDocumentsById([card.id], true))[0].content).toBe('committed bytes');
  expect((await repo.journal.pending('drive:a')).some(c => c.id === pending.id)).toBe(false);
});

it('retains the exact pre-journal baseline without a schema/data rewrite', async () => {
  const journal = new ChangeJournal(`baseline-${crypto.randomUUID()}`); await journal.open();
  const before = { id: 'card', projectId: 'board', content: 'legacy', _rev: '1-old', _sec: { signature: 'unchanged' } };
  const edit = await journal.prepare('cards', { ...before, content: 'new', _rev: '2-new' }, before, true);
  const base = await journal.entries.get(edit.parents[0]);
  expect(base?.value._sec).toEqual(before._sec); expect(base?.ancestry).toBe('unknown');
  expect(before.content).toBe('legacy'); journal.close();
});

it('does not journal security-rejected remote writes or fabricate ancestry for imported snapshots', async () => {
  const repo = await repository(); const board = await repo.createProject('Import', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'original' });
  const count = await repo.journal.entries.count();
  const guard = installCollectionMutationGuard(repo.db.cards, async () => ({ verify: async () => 'reject' }));
  await expect(repo.updateItem(card.id, { content: 'rejected' })).rejects.toThrow();
  expect(await repo.journal.entries.count()).toBe(count);
  await guard.uninstall();
  const snapshot = await repo.exportProject(board.id);
  await repo.importProject(snapshot!.project, snapshot!.items);
  const observed = (await repo.journal.entries.toArray()).filter(c => c.origin === 'observed');
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(c => c.ancestry === 'unknown' && c.parents.length === 0)).toBe(true);
});

it('fails the save before touching documents when journal preparation fails', async () => {
  const repo = await repository(); const board = await repo.createProject('Disk full', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'Safe original' });
  vi.spyOn(repo.journal, 'prepare').mockRejectedValueOnce(new Error('quota exhausted'));
  await expect(repo.updateItem(card.id, { content: 'Not saved' })).rejects.toThrow();
  expect((await repo.getCard(card.id))?.content).toBe('Safe original');
});

it('does not collect image bytes referenced by an older durable variant', async () => {
  const repo = await repository(); const board = await repo.createProject('Image history', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'Image', image: {
    dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', width: 1, height: 1
  } });
  const doc = (await repo.db.cards.findOne(card.id).exec())!;
  const originalImage = doc.imageId!;
  await doc.incrementalPatch({ imageId: 'replacement' });
  await expect(repo.deleteImage(originalImage)).rejects.toThrow('local change history');
  expect(await repo.hasImage(originalImage)).toBe(true);
});
