import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { DriveFixture, openDevice, sampleImage, type RecoveryDevice } from './harness';
import { makeChange } from '../../src/storage/changeJournal';

const devices: RecoveryDevice[] = [];
async function device(cloud: DriveFixture, account = 'account-a') { const value = await openDevice(cloud, account); devices.push(value); return value; }
afterEach(async () => { for (const value of devices.splice(0)) await value.destroy(); });
it('erases a conflicted board locally and in private Drive, retains other boards and prevents stale devices restoring it', async () => {
  const cloud = new DriveFixture(), a = await device(cloud), stale = await device(cloud);
  const board = await a.repo.createProject('Erase this board', 'project');
  const keep = await a.repo.createProject('Keep this board', 'project');
  const card = await a.repo.addItem({ projectId: board.id, content: 'Private erased content', image: sampleImage });
  const shared = await a.repo.addItem({ projectId: keep.id, content: 'Keep image and content', image: sampleImage });
  const base = (await a.repo.journal.entries.where('[collection+documentId]').equals(['cards', card.id]).toArray()).at(-1)!;
  await a.repo.updateItem(card.id, { content: 'Private local branch' });
  const branch = await makeChange({ ...base, value: { ...base.value, content: 'Private concurrent branch' }, parents: [base.id], ancestry: 'known' });
  await a.repo.reconciliation.receive([branch], async () => true);
  expect((await a.repo.listConflicts()).some(record => record.boardId === board.id)).toBe(true);
  await a.provider.syncProject(board.id); await a.provider.syncProject(keep.id); await stale.provider.reconcileAll();
  const oldSnapshot = cloud.snapshots('account-a').find(value => value.project.id === board.id)!;
  await a.repo.permanentlyDeleteBoard(board.id);
  expect(await a.repo.getProject(board.id)).toBeNull();
  expect(await a.repo.getCard(card.id)).toBeNull();
  expect(await a.repo.listConflicts()).toEqual([]);
  expect(await a.repo.journal.entries.where('boardId').equals(board.id).toArray()).toEqual([]);
  const [scrubbed] = await a.repo.db.cards.storageInstance.findDocumentsById([card.id], true);
  expect(scrubbed._deleted).toBe(true); expect(scrubbed.content).toBe(''); expect(scrubbed.imageId).toBeUndefined();
  expect(await a.repo.hasImage(shared.imageId!)).toBe(true);
  await a.provider.reconcileAll();
  expect(cloud.histories('account-a').every(value => value.boardId !== board.id)).toBe(true);
  expect(cloud.snapshots('account-a').map(value => value.project.id)).toEqual([keep.id]);
  // Simulate an older client recreating a snapshot after deletion. The marker
  // must take precedence over content, even on an otherwise stale device.
  await cloud.transport('account-a').upload(board.id, JSON.stringify(oldSnapshot));
  await stale.provider.reconcileAll();
  expect(await stale.repo.getProject(board.id)).toBeNull();
  expect(await stale.repo.listConflicts()).toEqual([]);
  await a.provider.reconcileAll();
  const fresh = await device(cloud); await fresh.provider.reconcileAll();
  expect(await fresh.repo.getProject(board.id)).toBeNull();
  expect((await fresh.repo.getProject(keep.id))?.name).toBe('Keep this board');
});

it('keeps offline erasure durable, retries failed cloud deletion and never deletes another account’s files', async () => {
  const cloud = new DriveFixture(), a = await device(cloud);
  const board = await a.repo.createProject('Delete after reconnect', 'project');
  await a.repo.addItem({ projectId: board.id, content: 'Erase on reconnect', image: sampleImage });
  await a.provider.syncProject(board.id);
  const saved = cloud.snapshots('account-a')[0];
  await cloud.transport('account-b').upload(board.id, JSON.stringify(saved));
  cloud.available = false;
  await a.repo.permanentlyDeleteBoard(board.id); await a.restart();
  await expect(a.provider.reconcileAll()).rejects.toThrow();
  expect(await a.repo.listProjects()).toEqual([]); expect(await a.repo.listConflicts()).toEqual([]);
  cloud.available = true;
  await a.providerFor('account-b').reconcileAll();
  expect(cloud.snapshots('account-b')).toHaveLength(1);
  expect(cloud.histories('account-a').length).toBeGreaterThan(0);
  cloud.failNext('delete');
  await expect(a.provider.reconcileAll()).rejects.toThrow();
  expect((await a.repo.journal.boardErasure(board.id))?.cloudPending).toBe(true);
  await a.provider.reconcileAll();
  expect(cloud.snapshots('account-a')).toEqual([]); expect(cloud.histories('account-a')).toEqual([]);
  expect(cloud.snapshots('account-b')).toHaveLength(1);
  expect((await a.repo.journal.boardErasure(board.id))?.cloudPending).toBe(false);
  await expect(a.provider.syncProject(board.id, { force: true })).resolves.toBe('not-dirty');
  expect(cloud.snapshots('account-a')).toEqual([]);
  expect(cloud.histories('account-a')).toEqual([]);
});
