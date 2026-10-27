import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { ChangeJournal, makeChange, type JournalEntry } from '../../src/storage/changeJournal';

/** Committed entry shape for accept(); proof-free entries stay accepted. */
const entry = async (boardId: string, id: string, value: Record<string, unknown>): Promise<JournalEntry> => ({
  ...(await makeChange({ boardId, collection: "cards", documentId: id, parents: [], ancestry: "known",
    value: { id, projectId: boardId, content: "body", ...value } })),
  state: "committed" as const, origin: "observed" as const
});

it('bootstraps the signed-history bit from committed entries and persists the answer', async () => {
  const name = `signed-${crypto.randomUUID()}`;
  let journal = new ChangeJournal(name); await journal.open();
  await journal.accept([await entry("clean", "c1", { content: "one" }), await entry("other", "o1", { _sec: { signature: "elsewhere" } })]);
  expect(await journal.hasSignedHistory("clean")).toBe(false);
  expect(await journal.hasSignedHistory("missing-board")).toBe(false);
  // The bootstrap answer is durable, so reopening the journal answers without scanning again.
  journal.close();
  journal = new ChangeJournal(name); await journal.open();
  expect(await journal.hasSignedHistory("clean")).toBe(false);
  journal.close();
});

it('only committed signed entries count, matching the authorization predicate exactly', async () => {
  const journal = new ChangeJournal(`signed-${crypto.randomUUID()}`); await journal.open();
  const doc = { id: "card-1", projectId: "board-1", content: "value", _rev: "1-x" };
  const prepared = await journal.prepare("cards", doc, undefined, true);
  // A prepared entry whose document value carries signed provenance must not
  // raise the bit: assertCanMutate consults the committed log, and a rejected
  // or uncertain entry is not signed history.
  await journal.entries.put({ ...prepared, state: "prepared", value: { ...prepared.value, _sec: { signature: "x" } } });
  expect(await journal.hasSignedHistory("board-1")).toBe(false);
  await journal.accept([await entry("board-1", "committed-unsigned", { content: "plain" })]);
  expect(await journal.hasSignedHistory("board-1")).toBe(false);
  await journal.accept([await entry("board-1", "signed-entry", { _sec: { signature: "s" } })]);
  expect(await journal.hasSignedHistory("board-1")).toBe(true);
  // And it agrees with the full scan it replaced.
  const scanned = (await journal.committedEntries()).some(e => e.boardId === "board-1" && !!e.value._sec);
  expect(scanned).toBe(true);
  journal.close();
});

it('raises the bit from the write guard without another scan, and it survives restart', async () => {
  const name = `signed-${crypto.randomUUID()}`;
  let journal = new ChangeJournal(name); await journal.open();
  expect(await journal.hasSignedHistory("board-2")).toBe(false);
  // A signed commit arriving after the negative answer must flip the cached
  // bit immediately: the write guard maintains it in the same transaction.
  await journal.accept([await entry("board-2", "late-1", { _sec: { signature: "late" } })]);
  expect(await journal.hasSignedHistory("board-2")).toBe(true);
  journal.close();
  journal = new ChangeJournal(name); await journal.open();
  expect(await journal.hasSignedHistory("board-2")).toBe(true);
  // A rejected signed entry after the fact never lowers the monotonic bit.
  const doc = { id: "card-9", projectId: "board-2", content: "gone", _rev: "3-x", _sec: { signature: "gone" } };
  const prepared = await journal.prepare("cards", doc, undefined, true);
  await journal.entries.put({ ...prepared, state: "rejected" });
  expect(await journal.hasSignedHistory("board-2")).toBe(true);
  journal.close();
});

it('answers repeated authorization checks from the flag, not the change log', async () => {
  const journal = new ChangeJournal(`signed-${crypto.randomUUID()}`); await journal.open();
  let scans = 0;
  const committedEntries = journal.committedEntries.bind(journal);
  journal.committedEntries = async () => { scans += 1; return committedEntries(); };
  await journal.accept([await entry("busy", "b1", { _sec: { signature: "one" } })]);
  for (let round = 0; round < 20; round++) expect(await journal.hasSignedHistory("busy")).toBe(true);
  expect(scans).toBe(0);
  journal.close();
});

it('the per-write authorization path answers from the flag and still refuses signed boards without authority', async () => {
  const { createRxRepository } = await import('../../src/storage/rxdbRepository');
  const repo = await createRxRepository({ name: `signed-${crypto.randomUUID()}` });
  try {
    const board = await repo.createProject('Signed board', 'project');
    // Signed committed history arriving from elsewhere (no local authority
    // objects): the exact state behind "Current board authorization is
    // required" — the protection must survive the flag switch-over.
    await repo.journal.accept([{ ...(await makeChange({ boardId: board.id, collection: "cards", documentId: "foreign-card",
      parents: [], ancestry: "known", value: { id: "foreign-card", projectId: board.id, content: "signed", _sec: { signature: "s" } } })),
      state: "committed" as const, origin: "observed" as const }]);
    expect(await repo.journal.hasSignedHistory(board.id)).toBe(true);
    const scan = vi.spyOn(repo.journal, "committedEntries");
    await expect(repo.addItem({ projectId: board.id, content: "new card" })).rejects.toThrow("Current board authorization is required");
    // The full committed-log scan is gone from the per-write path.
    expect(scan).not.toHaveBeenCalled();
    // Clean boards keep accepting local creation.
    const other = await repo.createProject('Clean board', 'project');
    expect(await repo.addItem({ projectId: other.id, content: "quick" })).toBeTruthy();
    expect(await repo.journal.hasSignedHistory(other.id)).toBe(false);
  } finally { await repo.db.close(); }
});
