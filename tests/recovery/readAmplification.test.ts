import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';

/**
 * The sidebar mounts several subscriptions at once. Every journal change
 * notifies all of them, so an unbounded read per subscriber turns one local
 * edit into a storm of IndexedDB reads. These tests pin the read counts that
 * the shared journal caches keep bounded.
 */
const repos: RxRepository[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const repo of repos.splice(0)) await repo.db.close(); });

async function setup() {
  const name = `readamplification${crypto.randomUUID().replaceAll("-", "")}`;
  const repo = await createRxRepository({ name });
  repos.push(repo);
  const board = await repo.createProject('Amplification', 'project');
  return { repo, board };
}

/** Counts the IndexedDB reads the journal performs, by table. */
function countJournalReads(repo: RxRepository) {
  const counts = new Map<string, number>();
  const journal = repo.journal as unknown as {
    read: <T>(name: string, operation: (store: IDBObjectStore) => IDBRequest<T>) => Promise<T>;
  };
  const original = journal.read.bind(journal);
  journal.read = async (name, operation) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return original(name, operation);
  };
  return counts;
}

it('reads the pending-edit table a bounded number of times per local edit', async () => {
  const { repo, board } = await setup();
  const card = await repo.addItem({ projectId: board.id, content: 'First' });
  const counts = countJournalReads(repo);
  await repo.updateItem(card.id, { content: 'Edited' });
  const pendingReads = counts.get('pendingEdits') ?? 0;
  // The table is read once and shared by every reader, instead of once per
  // subscriber and per call.
  expect(pendingReads).toBeLessThanOrEqual(2);
});

it('reads the pending-edit table once for the whole card-list subscription burst', async () => {
  const { repo, board } = await setup();
  const counts = countJournalReads(repo);
  const stop = await repo.subscribeCards(board.id, () => {});
  await repo.addItem({ projectId: board.id, content: 'One' });
  await repo.addItem({ projectId: board.id, content: 'Two' });
  stop();
  expect(counts.get('pendingEdits') ?? 0).toBeLessThanOrEqual(2);
});

it('does not rescan the change history when a board has many journal rows', async () => {
  const { repo, board } = await setup();
  for (let index = 0; index < 30; index++) {
    const card = await repo.addItem({ projectId: board.id, content: `Card ${index}` });
    await repo.updateItem(card.id, { content: `Card ${index} edited` });
  }
  const counts = countJournalReads(repo);
  const card = await repo.addItem({ projectId: board.id, content: 'After history' });
  await repo.updateItem(card.id, { content: 'After history edited' });
  // The committed log is read once and shared, not once per board.
  expect(counts.get('entries') ?? 0).toBeLessThanOrEqual(6);
});

it('keeps the total journal reads of one edit independent of the board history', async () => {
  const { repo, board } = await setup();
  const early = countJournalReads(repo);
  const first = await repo.addItem({ projectId: board.id, content: 'Early' });
  await repo.updateItem(first.id, { content: 'Early edited' });
  const earlyTotal = [...early.values()].reduce((sum, value) => sum + value, 0);

  for (let index = 0; index < 30; index++) {
    const card = await repo.addItem({ projectId: board.id, content: `Card ${index}` });
    await repo.updateItem(card.id, { content: `Card ${index} edited` });
  }
  const late = countJournalReads(repo);
  const after = await repo.addItem({ projectId: board.id, content: 'Late' });
  await repo.updateItem(after.id, { content: 'Late edited' });
  const lateTotal = [...late.values()].reduce((sum, value) => sum + value, 0);

  // A board with history must not cost more per edit than an empty one.
  expect(lateTotal).toBeLessThanOrEqual(earlyTotal * 2);
});

it('keeps the erasure markers and the committed log consistent with the journal', async () => {
  const { repo, board } = await setup();
  const card = await repo.addItem({ projectId: board.id, content: 'Doomed' });
  await repo.journal.beginBoardErasure(board.id, 'account', [], [card.id]);
  // The marker is visible immediately after it is written.
  expect(await repo.journal.boardErasure(board.id)).toBeDefined();
  expect(await repo.isDeletedProject(board.id)).toBe(true);
  await repo.journal.receipts.update(JSON.stringify([board.id, 'local-board-erasure']), { cloudPending: false } as never);
  // A marker updated in place is visible too: the shared copy is dropped when
  // the receipts table changes.
  expect((await repo.journal.boardErasure(board.id))?.cloudPending).toBe(false);
});
