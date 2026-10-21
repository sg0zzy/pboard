import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { DriveFixture, openDevice, sampleImage, type RecoveryDevice } from './harness';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { installLiveBoardMutations } from '../../src/collab/security/liveMutations';

const devices: RecoveryDevice[] = [];
const EXPIRED = 'Current board authorization is required';
afterEach(async () => {
  vi.restoreAllMocks();
  for (const device of devices.splice(0)) try { await device.destroy() } catch { /* already gone */ }
});

type Harness = { cloud: DriveFixture; device: RecoveryDevice; board: { id: string }; card: { id: string }; deviceKeyId: string };

/** Shared setup: an editor whose manifest expires while drafting offline work, then a private-Drive sync. */
async function setup(content: string) {
  const cloud = new DriveFixture(), device = await openDevice(cloud); devices.push(device);
  const board = await device.repo.createProject('Pending offline work', 'project');
  const card = await device.repo.addItem({ projectId: board.id, content: 'Offline base', image: sampleImage });
  const key = await generateDeviceKey();
  const manifest = { protocol: 2 as const, boardId: board.id, authorityKeyId: key.keyId, driveProjectFileId: '', driveFolderId: '',
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'editor' as const }] };
  const guard = await installLiveBoardMutations({ projectId: board.id, cards: device.repo.db.cards, projects: device.repo.db.projects,
    security: { boardId: board.id, manifest, signer: { deviceKeyId: key.keyId, privateJwk: key.privateJwk }, ownSessionId: 'harness', manifestHistory: new Map([[1, manifest]]) } });
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 400000);
  await device.repo.updateItem(card.id, { content });
  spy.mockRestore();
  await guard.uninstall();
  return { cloud, device, board, card, deviceKeyId: key.keyId };
}

it('backs up device-local pending work to private Drive and restores it after permanent source loss without admitting it', async () => {
  const f = await setup('Held offline draft');
  await f.device.provider.syncProject(f.board.id);
  const fresh = await openDevice(f.cloud); devices.push(fresh);
  await f.device.destroy();
  await fresh.provider.reconcileAll();
  // Content overlay shows the sole pending head; a fresh device has no editing entitlement,
  // so this only proves the held work arrived, not that admission succeeded anywhere.
  expect((await fresh.repo.listCards(f.board.id)).find(c => c.id === f.card.id)?.content).toBe('Held offline draft');
  const pending = (await fresh.repo.journal.pendingEdits.toArray()).filter(e => e.base.documentId === f.card.id);
  expect(pending).toHaveLength(1);
  expect(pending[0].admittedChangeId).toBeUndefined(); expect(pending[0].projected).toBeUndefined();
  expect(pending[0].deviceKeyId).toBe(f.deviceKeyId);
  await expect(fresh.repo.admitPendingWork(f.board.id)).rejects.toThrow(EXPIRED);
  expect((await fresh.repo.journal.pendingEdits.toArray()).some(e => e.boardId === f.board.id)).toBe(true);
  // Exact image bytes referenced by the held draft are restored with it.
  const imageId = pending[0].value.imageId as string | undefined;
  if (imageId) expect(await fresh.repo.hasImage(imageId)).toBe(true);
  // Repeated synchronization converges: no duplicate pending entries appear.
  await fresh.provider.syncProject(f.board.id);
  expect((await fresh.repo.journal.pendingEdits.toArray()).filter(e => e.base.documentId === f.card.id)).toHaveLength(1);
});

it('a reinstalled fresh device has no editing entitlement; held work arrives intact, reviewable and exportable', async () => {
  const f = await setup('Offline card edit');
  await expect(f.device.repo.admitPendingWork(f.board.id)).rejects.toThrow(EXPIRED);
  await f.device.provider.syncProject(f.board.id);
  await f.device.destroy();
  const reinstalled = await openDevice(f.cloud); devices.push(reinstalled);
  await reinstalled.provider.reconcileAll();
  const held = (await reinstalled.repo.journal.pendingEdits.toArray()).filter(e => e.base.documentId === f.card.id);
  expect(held).toHaveLength(1); expect(held[0].value.content).toBe('Offline card edit');
  await expect(reinstalled.repo.admitPendingWork(f.board.id)).rejects.toThrow(EXPIRED);
  const exported = await reinstalled.repo.exportPendingWork(f.board.id);
  expect(exported.format).toBe('pboard-pending-work-v1');
  expect(exported.edits.some(e => e.value.content === 'Offline card edit')).toBe(true);
});
it('retains supersession evidence after admission so an old draft cannot become a restored head', async () => {
  const f = await setup('Earlier offline draft');
  const earlier = (await f.device.repo.journal.pendingEdits.toArray()).find(edit => edit.base.documentId === f.card.id)!;
  // Delivery flags cannot be trusted on a new device. Even an admitted successor
  // must be archived as immutable supersession evidence, with those flags stripped.
  const later = { ...earlier, id: crypto.randomUUID(), value: { ...earlier.value, content: 'Later reviewed draft' },
    supersedes: [earlier.id], admittedChangeId: 'a'.repeat(64), projected: true };
  await f.device.repo.journal.pendingEdits.put(later);
  await f.device.provider.syncProject(f.board.id);
  const fresh = await openDevice(f.cloud); devices.push(fresh);
  await f.device.destroy(); await fresh.provider.reconcileAll();
  const drafts = (await fresh.repo.journal.pendingEdits.toArray()).filter(edit => edit.base.documentId === f.card.id);
  expect(drafts.map(edit => edit.id).sort()).toEqual([earlier.id, later.id].sort());
  expect(drafts.every(edit => !edit.admittedChangeId && !edit.projected)).toBe(true);
  const { pendingHeads } = await import('../../src/storage/pendingWork');
  expect(pendingHeads(drafts).map(edit => edit.value.content)).toEqual(['Later reviewed draft']);
  await expect(fresh.repo.admitPendingWork(f.board.id)).rejects.toThrow(EXPIRED);
});

it('permanently erases board data and private backup rather than resurrecting conflicts', async () => {
  const f = await setup('Explicitly discard this archived draft');
  await f.device.provider.syncProject(f.board.id);
  const fresh = await openDevice(f.cloud); devices.push(fresh); await fresh.provider.reconcileAll();
  await fresh.repo.deleteProject(f.board.id);
  const reviewed = await fresh.repo.listPendingWork();
  expect(reviewed.length).toBeGreaterThan(0);
  const cloudFiles = f.cloud.histories('account-a').length;
  await fresh.repo.discardRemovedBoardWork(f.board.id, reviewed.map(edit => edit.id));
  await fresh.restart(); await fresh.provider.reconcileAll(); await fresh.provider.reconcileAll();
  expect(await fresh.repo.journal.pendingEdits.toArray()).toEqual([]);
  expect(await fresh.repo.listPendingWork()).toEqual([]);
  expect(cloudFiles).toBeGreaterThan(0);
  expect(f.cloud.histories('account-a')).toEqual([]);
  expect(f.cloud.snapshots('account-a')).toEqual([]);
  expect(await fresh.repo.listConflicts()).toEqual([]);
  expect(await fresh.repo.listProjects()).toEqual([]);
  expect(f.cloud.calls.some(call => call.operation === 'delete')).toBe(true);
});
