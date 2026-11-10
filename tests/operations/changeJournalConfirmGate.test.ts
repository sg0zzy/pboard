import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { DriveFixture, openDevice, type RecoveryDevice } from '../recovery/harness';

const STALE = 'Retained work changed. Review it again before deleting.';
const devices: RecoveryDevice[] = [];
afterEach(async () => { for (const device of devices.splice(0)) try { await device.destroy() } catch { /* already gone */ } });

/** One device with retained local work on a board that is still in its list. The permission row
 * names another device and no live role is installed, so commands land as pending drafts. Every
 * command also carries its board-metadata entry, so a card draft is two heads: the card and the
 * board. The confirm set is the whole head set at the moment of the confirm, in no meaningful
 * order; a reviewed head only drops out of it when the board has an operation binding. */
async function setup(boardName: string) {
  const cloud = new DriveFixture(), device = await openDevice(cloud); devices.push(device);
  const repo = device.repo, journal = repo.journal;
  const board = await repo.createProject(boardName, 'project');
  const key = await generateDeviceKey();
  await journal.permissions.put({ id: board.id, role: 'owner', deviceKeyId: key.keyId, authorityKeyId: key.keyId });
  const card = await repo.addItem({ projectId: board.id, content: 'Original content' });
  const bind = async () => { await repo.bindOperationBoard({ id: `binding:${board.id}`, kind: 'operation-binding', boardId: board.id, folderId: 'fixture-folder', role: 'owner', legacyFileIds: [], baseRevision: 0 }, []); };
  const head = async (collection: string, documentId: string) => {
    const row = (await repo.listPendingWork()).find(edit => edit.base.collection === collection && edit.base.documentId === documentId);
    if (!row) throw new Error(`No confirmable head for ${collection}/${documentId}`);
    return row;
  };
  const draft = async (itemId: string, content: string) => { await repo.updateItem(itemId, { content }); return head('cards', itemId); };
  const boardHead = async () => head('projects', board.id);
  const confirmable = async () => (await repo.listPendingWork()).map(edit => edit.id).sort();
  const discarded = async () => (await journal.receipts.where('destination').equals(`local-pending-discard:${board.id}`).toArray()).map(receipt => receipt.changeId).sort();
  return { cloud, device, repo, journal, board, card, bind, draft, head, boardHead, confirmable, discarded };
}

describe('confirm gate for retained work on a removed board', () => {
  it('settles and deletes the retained rows when the confirm matches the current review', async () => {
    const f = await setup('Confirm gate current review');
    const reviewed = await f.draft(f.card.id, 'Draft reviewed as a new operation');
    await f.bind();
    const secondCard = await f.repo.addItem({ projectId: f.board.id, content: 'Original content' });
    const unreviewed = await f.draft(secondCard.id, 'Draft left for later review');
    await f.repo.reviewPendingWork(reviewed.id, [reviewed.id]);
    await f.repo.deleteProject(f.board.id);
    const confirmSet = [await f.boardHead(), unreviewed].map(row => row.id).sort();
    expect(await f.confirmable()).toEqual(confirmSet);
    await f.repo.discardRemovedBoardWork(f.board.id, confirmSet, 'account-a');
    expect(await f.journal.pendingEdits.get(reviewed.id)).toBeUndefined();
    expect(await f.journal.pendingEdits.get(unreviewed.id)).toBeUndefined();
    expect(await f.confirmable()).toEqual([]);
    const marker = await f.journal.boardErasure(f.board.id);
    expect(marker).toMatchObject({ boardId: f.board.id, accountId: 'account-a', cloudPending: true, localPurged: true });
    expect([...(marker?.cardIds ?? [])].sort()).toEqual([f.card.id, secondCard.id].sort());
  });

  it('refuses work recorded after the review, deleting nothing', async () => {
    const f = await setup('Confirm gate stale review');
    const reviewed = await f.draft(f.card.id, 'Draft reviewed as a new operation');
    await f.bind();
    await f.repo.reviewPendingWork(reviewed.id, [reviewed.id]);
    // Work recorded after the review lands on a card the board already holds, so it is a new head.
    const secondCard = await f.repo.addItem({ projectId: f.board.id, content: 'Original content' });
    const later = await f.draft(secondCard.id, 'Work recorded after the review');
    await f.repo.deleteProject(f.board.id);
    const current = [await f.boardHead(), later].map(row => row.id).sort();
    expect(await f.confirmable()).toEqual(current);
    // Card work alone is not a full confirm: the board-metadata head is retained work as well.
    await expect(f.repo.discardRemovedBoardWork(f.board.id, [later.id], 'account-a')).rejects.toThrow(STALE);
    // A reviewed head's checkpoint cannot excuse it while newer work changes the expectation.
    await expect(f.repo.discardRemovedBoardWork(f.board.id, [...current, reviewed.id].sort(), 'account-a')).rejects.toThrow(STALE);
    await expect(f.repo.discardRemovedBoardWork(f.board.id, [later.id, later.id], 'account-a')).rejects.toThrow(STALE);
    expect((await f.journal.pendingEdits.get(reviewed.id))?.id).toBe(reviewed.id);
    expect((await f.journal.pendingEdits.get(later.id))?.id).toBe(later.id);
    expect(await f.discarded()).toEqual([]);
    expect(await f.journal.boardErasure(f.board.id)).toBeUndefined();
    expect(await f.confirmable()).toEqual(current);
  });

  it('refuses a review superseded by newer work on the same board and only accepts the current expectation', async () => {
    const f = await setup('Confirm gate superseded review');
    const older = await f.draft(f.card.id, 'Draft under the older review');
    await f.bind();
    await f.repo.reviewPendingWork(older.id, [older.id]);
    const secondCard = await f.repo.addItem({ projectId: f.board.id, content: 'Original content' });
    const current = await f.draft(secondCard.id, 'Draft under the newer review');
    await f.repo.reviewPendingWork(current.id, [current.id]);
    const replaced = await f.draft(secondCard.id, 'Work recorded after the newer review');
    await f.repo.deleteProject(f.board.id);
    const expected = [await f.boardHead(), replaced].map(row => row.id).sort();
    expect(await f.confirmable()).toEqual(expected);
    await expect(f.repo.discardRemovedBoardWork(f.board.id, [older.id], 'account-a')).rejects.toThrow(STALE);
    await expect(f.repo.discardRemovedBoardWork(f.board.id, [current.id, replaced.id], 'account-a')).rejects.toThrow(STALE);
    expect((await f.journal.pendingEdits.get(older.id))?.id).toBe(older.id);
    expect(await f.discarded()).toEqual([]);
    await f.repo.discardRemovedBoardWork(f.board.id, expected, 'account-a');
    expect(await f.journal.pendingEdits.get(older.id)).toBeUndefined();
    expect(await f.journal.pendingEdits.get(current.id)).toBeUndefined();
    expect(await f.journal.pendingEdits.get(replaced.id)).toBeUndefined();
    expect(await f.confirmable()).toEqual([]);
    expect(await f.journal.boardErasure(f.board.id)).toMatchObject({ boardId: f.board.id, cloudPending: true });
  });

  it('never treats a board without an operation binding as bound, so its checkpoint cannot excuse a head', async () => {
    const f = await setup('Confirm gate unbound board');
    const head = await f.draft(f.card.id, 'Retained draft on an unbound board');
    const boardHead = await f.boardHead();
    const listed = (await f.repo.listPendingWork()).find(edit => edit.id === head.id)!;
    expect(listed.canReview).toBe(false);
    await expect(f.repo.reviewPendingWork(head.id, [head.id])).rejects.toThrow();
    expect(await f.confirmable()).toEqual([boardHead.id, head.id].sort());
    await f.journal.write('operationCheckpoints', store => store.put({ id: `pending-review:${head.id}`, kind: 'operation-pending-review', boardId: f.board.id, reviewedIds: [head.id], operationId: 'op-legacy' }));
    await f.journal.write('operations', store => store.put({ id: 'op-legacy', boardId: f.board.id, sourceId: 'pending:' + head.id }));
    expect(await f.confirmable()).toEqual([boardHead.id, head.id].sort());
    await f.repo.deleteProject(f.board.id);
    // Removing an unbound board is itself retained work, so both heads are the removal rows.
    const removedCard = await f.head('cards', f.card.id), removedBoard = await f.boardHead();
    expect(removedCard.id).not.toBe(head.id);
    expect(removedBoard.id).not.toBe(boardHead.id);
    const expected = [removedCard.id, removedBoard.id].sort();
    expect(await f.confirmable()).toEqual(expected);
    await expect(f.repo.discardRemovedBoardWork(f.board.id, [removedCard.id], 'account-a')).rejects.toThrow(STALE);
    await f.repo.discardRemovedBoardWork(f.board.id, expected, 'account-a');
    expect(await f.journal.pendingEdits.get(head.id)).toBeUndefined();
    expect(await f.journal.pendingEdits.get(boardHead.id)).toBeUndefined();
    expect(await f.confirmable()).toEqual([]);
    expect(await f.journal.boardErasure(f.board.id)).toMatchObject({ boardId: f.board.id, cloudPending: true });
  });

  it('re-reads the changed work as confirmable again after refusing the stale confirm set', async () => {
    const f = await setup('Confirm gate re-review');
    const reviewed = await f.draft(f.card.id, 'Draft reviewed as a new operation');
    await f.bind();
    await f.repo.reviewPendingWork(reviewed.id, [reviewed.id]);
    const secondCard = await f.repo.addItem({ projectId: f.board.id, content: 'Original content' });
    const changed = await f.draft(secondCard.id, 'Work recorded after the review');
    await f.repo.deleteProject(f.board.id);
    const expected = [await f.boardHead(), changed].map(row => row.id).sort();
    await expect(f.repo.discardRemovedBoardWork(f.board.id, [reviewed.id], 'account-a')).rejects.toThrow(STALE);
    expect((await f.journal.pendingEdits.get(reviewed.id))?.id).toBe(reviewed.id);
    expect((await f.journal.pendingEdits.get(changed.id))?.id).toBe(changed.id);
    expect(await f.discarded()).toEqual([]);
    expect(await f.confirmable()).toEqual(expected);
    await f.repo.discardRemovedBoardWork(f.board.id, expected, 'account-a');
    expect(await f.journal.pendingEdits.get(changed.id)).toBeUndefined();
    expect(await f.confirmable()).toEqual([]);
    expect(await f.journal.boardErasure(f.board.id)).toMatchObject({ boardId: f.board.id, cloudPending: true });
  });
});
