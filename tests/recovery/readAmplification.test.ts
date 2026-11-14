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
  //
  // `prepare` additionally resolves a write's parent with two *keyed* reads on the
  // `version` index (the exact version, then the versions sharing its timestamp)
  // instead of reading this document's whole history. The budget counts calls, not
  // rows, so it allows those two while still failing any change that scans the
  // history again — that scan grows one entry per card operation, and was 2,421
  // rows / 1.4 MB per insert on a board with 2,420 of them.
  expect(counts.get('entries') ?? 0).toBeLessThanOrEqual(8);
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

it('resolves an edit against a board with history without reading that history', async () => {
  // The parent lookup used to read the document's whole version history, and for a
  // project row that history grows one entry per card operation: measured at 2,421
  // rows and 1.4 MB for a single insert on a board with 2,420 of them, 46.7 ms
  // against 7.4 ms on a fresh board — insert, edit and delete all paid it.
  //
  // An edit always has a previous value, so its parent is resolvable by the keyed
  // `version` index. A first insert still reads the history by design (there is no
  // previous value to key on), which is why this exercises an edit.
  const { repo, board } = await setup();
  for (let index = 0; index < 40; index++) {
    const card = await repo.addItem({ projectId: board.id, content: `Card ${index}` });
    await repo.updateItem(card.id, { content: `Card ${index} edited` });
  }
  const target = await repo.addItem({ projectId: board.id, content: 'Before' });
  const journal = repo.journal as unknown as { read: <T>(name: string, op: (s: IDBObjectStore) => IDBRequest<T>) => Promise<T> };
  const keys: string[] = [];
  const original = journal.read.bind(journal);
  journal.read = async (name, op) => {
    // Name the index the read uses, without running it twice.
    const described = String((op as unknown as { toString(): string }).toString());
    keys.push(`${name}:${/version/.test(described) ? "version" : "other"}`);
    return original(name, op);
  };
  await repo.updateItem(target.id, { content: 'After' });
  const entryReads = keys.filter(key => key.startsWith("entries:"));
  // Every entry read for the edit is keyed on `version`; a wholesale scan of the
  // store would show up as `entries:other`.
  expect(entryReads.length).toBeGreaterThan(0);
  expect(entryReads.every(key => key === "entries:version")).toBe(true);
});
