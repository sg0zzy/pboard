import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { openDevice, DriveFixture, sampleImage, type RecoveryDevice } from './harness';
import { installLiveBoardMutations } from '../../src/collab/security/liveMutations';
import { verifyJournalChange } from '../../src/collab/security/journalProof';
const devices: RecoveryDevice[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const d of devices.splice(0)) await d.destroy(); });
async function setup() {
  const cloud = new DriveFixture(), d = await openDevice(cloud); devices.push(d);
  const board = await d.repo.createProject('Offline commands', 'project');
  const card = await d.repo.addItem({ projectId: board.id, content: 'Source text' });
  await d.grants.configure({ provider: 'websocket', url: 'wss://fixture.example.test/ws' }); await d.grants.initialize(board.id);
  const security = (await d.grants.security(board.id))!;
  const guard = await installLiveBoardMutations({ projectId: board.id, cards: d.repo.db.cards, projects: d.repo.db.projects, security, attestExisting: true });
  return { cloud, d, board, card, security, guard,
    expire() { vi.spyOn(Date, 'now').mockReturnValue(security.manifest.expiresAt + 1); },
    async renew() { await guard.uninstall(); await d.grants.initialize(board.id); const next = (await d.grants.security(board.id))!;
      await installLiveBoardMutations({ projectId: board.id, cards: d.repo.db.cards, projects: d.repo.db.projects, security: next }); return next; } };
}
it('buffers create/image/duplicate/merge/delete/move/template/name commands and admits their final proposals under renewed grants', async () => {
  const f = await setup(); f.expire();
  const first = await f.d.repo.addItem({ projectId: f.board.id, content: 'Offline image', image: sampleImage });
  const second = await f.d.repo.addItem({ projectId: f.board.id, content: 'Offline note' });
  const copy = await f.d.repo.duplicateItem(second.id);
  await f.d.repo.mergeItems(copy.id, second.id); await f.d.repo.deleteItem(f.card.id);
  await f.d.repo.reorderItems(f.board.id, [second.id, first.id]);
  await f.d.repo.renameProject(f.board.id, 'Renamed offline'); await f.d.repo.changeProjectTemplate(f.board.id, 'idea');
  expect((await f.d.repo.getProject(f.board.id))?.name).toBe('Renamed offline');
  expect((await f.d.repo.listCards(f.board.id)).map(c => c.id)).toEqual([second.id, first.id]);
  expect(await f.d.repo.db.cards.findOne(first.id).exec()).toBeNull(); expect((await f.d.repo.db.projects.findOne(f.board.id).exec())?.name).toBe('Offline commands');
  const pending = await f.d.repo.exportPendingWork(f.board.id); expect(pending.images[0].dataUrl).toBe(sampleImage.dataUrl);
  await f.d.repo.deleteImage(first.imageId!); expect(await f.d.repo.hasImage(first.imageId!)).toBe(true);
  const current = await f.renew(); await f.d.repo.admitPendingWork(f.board.id);
  expect((await f.d.repo.db.projects.findOne(f.board.id).exec())?.name).toBe('Renamed offline');
  expect((await f.d.repo.db.cards.findOne(first.id).exec())?.content).toBe('Offline image');
  for (const entry of (await f.d.repo.journal.entries.toArray()).filter(e => e.origin === 'local' && (e.value._sec as any)?.provenance.operationId.startsWith('pending:'))) {
    await expect(verifyJournalChange(entry, entry.proof, current, entry.admission)).resolves.toBeUndefined();
  }
});
it('restores unadmitted creations, structural work and image bytes from private Drive after permanent device loss, without restoring editing authority', async () => {
  const f = await setup(); f.expire();
  const added = await f.d.repo.addItem({ projectId: f.board.id, content: 'Recover pending image', image: sampleImage });
  await f.d.repo.renameProject(f.board.id, 'Recover pending name');
  await f.d.provider.syncProject(f.board.id);
  expect(f.cloud.histories('account-a').some(b => b.pending?.length)).toBe(true);
  await f.guard.uninstall(); await f.d.destroy();
  const fresh = await openDevice(f.cloud); devices.push(fresh); await fresh.provider.reconcileAll();
  expect((await fresh.repo.getProject(f.board.id))?.name).toBe('Recover pending name');
  expect((await fresh.repo.exportProject(f.board.id)).items.find(c => c.id === added.id)?.image).toEqual(sampleImage);
  expect((await fresh.repo.listPendingWork()).some(e => e.base.documentId === added.id)).toBe(true);
  await expect(fresh.repo.updateItem(added.id, { content: 'No ownership from Google' })).rejects.toThrow('authorization');
  expect(await fresh.grants.ownsAuthority(f.board.id)).toBe(false);
});
it('retries lost pending-backup acknowledgement without duplicates and retains edits made during upload', async () => {
  const f = await setup(); f.expire(); await f.d.repo.updateItem(f.card.id, { content: 'First pending' });
  f.cloud.failNext('upload', true); await expect(f.d.provider.syncProject(f.board.id)).rejects.toThrow('lost');
  const held = f.cloud.pauseNext('upload'); const sync = f.d.provider.syncProject(f.board.id);
  // There may be only a compatibility snapshot left after the immutable retry.
  await held.started; await f.d.repo.updateItem(f.card.id, { content: 'Later pending' }); held.release(); await sync;
  await f.d.provider.syncProject(f.board.id); await f.d.restart();
  expect((await f.d.repo.getCard(f.card.id))?.content).toBe('Later pending');
});
