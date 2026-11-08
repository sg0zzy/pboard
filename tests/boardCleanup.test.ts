/**
 * The Drive half of the deletion state machine: move a deleted board's folder
 * to Trash, confirm it, and never lose the intent.
 *
 * Everything here runs against the product's own `createDriveBoardStore` over
 * the multi-browser fake Drive (`tests/multiBrowser/fixtures/fakeDrive.ts`),
 * and the product's own `ChangeJournal` over `fake-indexeddb` — so the folder
 * addressing, the role oracle, the write faults and the durable record are the
 * real ones, not a stand-in for them.
 *
 * The assertions are deliberately about *mutations* and *records*, never about
 * durations: "refuses" means the fake Drive saw no delete at all, and "resumes"
 * means a second journal over the same database finds the work still owed.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeJournal } from "../src/storage/changeJournal";
import { boardCleanupRetryDelay, confirmedBoardCleanup, failedBoardCleanup,
  pendingBoardCleanup, boardCleanupDue, type BoardCleanupState } from "../src/storage/boardCleanup";
import { createDriveBoardStore, boardFolderName, BOARD_ROOT_NAME } from "../src/sync/driveBoardStore";
import { runBoardCleanup, runPendingBoardCleanups } from "../src/sync/boardCleanup";
import { FakeDrive } from "./multiBrowser/fixtures/fakeDrive";

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const ACCOUNT = "account-hash-owner";

const unique = () => `cleanup${crypto.randomUUID().replaceAll("-", "")}`;
const openJournals: ChangeJournal[] = [];
afterEach(async () => { for (const journal of openJournals.splice(0)) journal.close(); });

async function journal(): Promise<ChangeJournal> {
  const opened = new ChangeJournal(unique());
  await opened.open();
  openJournals.push(opened);
  return opened;
}

/** A Drive account plus the product's board store pointed at it. */
function drive(email = OWNER) {
  const fake = new FakeDrive();
  const token = fake.addAccount(email);
  const store = createDriveBoardStore({
    auth: { getAccessToken: async () => token, getConnectionState: async () => "connected" as const,
      isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
    fetcher: fake.fetch as unknown as typeof fetch
  });
  return { fake, store };
}

/** A board folder the way the product lays one out: `/pboard/<boardId>`. */
async function boardOnDrive(store: ReturnType<typeof drive>["store"], boardId: string) {
  return await store.boardFolder(boardId);
}

/**
 * The state a real deletion leaves behind: the durable tombstone first, then
 * the cleanup record — in that order, which is exactly what `deleteProject`
 * does and the only order the executor will act on.
 */
async function tombstonedRow(journal: ChangeJournal, boardId: string, options: { name?: string; accountId?: string | null } = {}) {
  await journal.recordBoardDeletion({ boardId, accountId: options.accountId === undefined ? ACCOUNT : options.accountId,
    context: {}, role: "owner", at: "2026-01-01T00:00:00.000Z", evidence: "test" });
  await journal.beginBoardCleanup(boardId, options.accountId === undefined ? ACCOUNT : options.accountId,
    "2026-01-01T00:00:00.000Z", 0, options.name);
}

const trashMutations = (fake: FakeDrive, folderId: string) =>
  fake.mutations.filter(mutation => mutation.url.includes(folderId));

describe("the deletion cleanup state machine", () => {
  it("schedules retries with a bounded ladder and never repeats a confirmed Trash", () => {
    expect(boardCleanupRetryDelay(1)).toBe(30_000);
    expect(boardCleanupRetryDelay(2)).toBe(60_000);
    expect(boardCleanupRetryDelay(3)).toBe(120_000);
    // The ceiling is an hour, and the exponent cannot overflow into `Infinity`.
    expect(boardCleanupRetryDelay(20)).toBe(60 * 60_000);
    expect(Number.isFinite(boardCleanupRetryDelay(1_000))).toBe(true);

    const pending = pendingBoardCleanup(ACCOUNT, "2026-01-01T00:00:00.000Z", 1_000);
    expect(boardCleanupDue(pending, false, 1_000)).toBe(true);
    const failed = failedBoardCleanup(pending, "Drive refused", "2026-01-01T00:00:01.000Z", 1_000_000);
    expect(failed.stage).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt).toBe(1_000_000 + 30_000);
    // The wait is the default; a forced round ignores it but still counts.
    expect(boardCleanupDue(failed, false, 1_000_000)).toBe(false);
    expect(boardCleanupDue(failed, true, 1_000_000)).toBe(true);
    const confirmed = confirmedBoardCleanup(failed, ["folder-1"], "2026-01-01T00:00:02.000Z");
    expect(confirmed.stage).toBe("trashed");
    expect(boardCleanupDue(confirmed, true, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe("moving a deleted board's folder to Trash", () => {
  it("trashes the folder, confirms it, and leaves the board tombstoned", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    await tombstonedRow(records, board, { name: "Old board" });

    const outcome = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT });
    expect(outcome).toMatchObject({ status: "trashed", alreadyTrashed: false, folderIds: [folderId] });
    const root = fake.files.find(file => file.name === BOARD_ROOT_NAME && !file.appDataOwner)!;
    expect(root.trashed, "the /pboard root is never trashed").toBe(false);
    expect(await store.boardFolderCandidates(board), "the folder is no longer listed under the root").toEqual([]);
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(true);

    const cleanup = await records.boardCleanup(board);
    expect(cleanup).toMatchObject({ stage: "trashed", folderIds: [folderId], name: "Old board" });
    // The deletion decision is untouched by its Drive half.
    expect((await records.boardTombstone(board, ACCOUNT)).deleted).toBe(true);
    expect(await records.deletedBoards(ACCOUNT)).toEqual(new Set([board]));
  });

  it("keeps a failed Trash pending with a reason and succeeds on retry", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    await tombstonedRow(records, board);

    fake.writeOutage = 503;
    const failed = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT, now: 1_000 });
    expect(failed.status).toBe("failed");
    let cleanup = await records.boardCleanup(board);
    expect(cleanup).toMatchObject({ stage: "failed", attempts: 1 });
    expect(cleanup?.reason).toMatch(/trashing/);
    expect(cleanup!.nextAttemptAt).toBe(1_000 + 30_000);
    // The logical deletion is exactly where it was: the board is still deleted
    // and still hidden, and Drive still has the folder.
    expect((await records.boardTombstone(board, ACCOUNT)).deleted).toBe(true);
    expect(await records.deletedBoards(ACCOUNT)).toEqual(new Set([board]));
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(false);

    // Before the window opens there is no attempt and no Drive request.
    const spent = fake.mutations.length;
    expect(await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT, now: 1_000 }))
      .toMatchObject({ status: "skipped" });
    expect(fake.mutations.length).toBe(spent);

    fake.writeOutage = null;
    const retried = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT, now: 1_000 + 30_000 });
    expect(retried).toMatchObject({ status: "trashed", alreadyTrashed: false });
    cleanup = await records.boardCleanup(board);
    expect(cleanup).toMatchObject({ stage: "trashed" });
    expect(cleanup?.reason).toBeUndefined();
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(true);
  });

  it("resumes a cleanup that a closed browser left pending", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const name = unique();
    const first = new ChangeJournal(name);
    await first.open();
    await tombstonedRow(first, board, { name: "Interrupted" });
    // The browser dies here: the tombstone and the intent are durable, nothing
    // has been sent to Drive.
    first.close();
    expect(fake.files.find(file => file.id === folderId)?.trashed, "premise: no Trash happened").toBe(false);

    // The next session opens the same database and runs the round's pass.
    const resumed = new ChangeJournal(name);
    await resumed.open();
    openJournals.push(resumed);
    const pending = await resumed.pendingBoardCleanups();
    expect(pending.map(row => row.boardId)).toEqual([board]);

    const outcomes = await runPendingBoardCleanups({ journal: resumed, store, account: async () => ACCOUNT });
    expect(outcomes).toEqual([{ status: "trashed", folderIds: [folderId], alreadyTrashed: false }]);
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(true);
    expect(await resumed.pendingBoardCleanups(), "the resumed pass leaves nothing owed").toEqual([]);
    expect((await resumed.boardTombstone(board, ACCOUNT)).deleted).toBe(true);
  });

  it("reports an already-trashed folder as confirmed without a second Trash", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    await tombstonedRow(records, board);
    // Someone (Drive's own UI, another device) already moved it.
    await store.trashFile(folderId);
    const before = fake.mutations.length;

    const outcome = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT });
    expect(outcome).toMatchObject({ status: "trashed", alreadyTrashed: true });
    expect(fake.mutations.length, "confirming an existing Trash writes nothing to Drive").toBe(before);
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "trashed" });
  });

  it("does not re-trash a board whose cleanup is already confirmed", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    await tombstonedRow(records, board);

    expect(await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT })).toMatchObject({ status: "trashed" });
    const afterFirst = fake.mutations.length;
    const again = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT, force: true });
    expect(again).toMatchObject({ status: "skipped" });
    expect(fake.mutations.length, "a duplicate cleanup performs no Drive request at all").toBe(afterFirst);

    // A second deletion of the same board keeps the terminal record instead of
    // minting a fresh pending one.
    await tombstonedRow(records, board);
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "trashed" });
  });

  it("never touches another board's folder", async () => {
    const { fake, store } = drive();
    const doomed = crypto.randomUUID(), kept = crypto.randomUUID();
    const doomedFolder = await boardOnDrive(store, doomed);
    const keptFolder = await boardOnDrive(store, kept);
    const records = await journal();
    await tombstonedRow(records, doomed);

    expect(await runBoardCleanup({ boardId: doomed, journal: records, store, account: ACCOUNT })).toMatchObject({ status: "trashed" });
    expect(fake.files.find(file => file.id === doomedFolder)?.trashed).toBe(true);
    expect(fake.files.find(file => file.id === keptFolder)?.trashed, "the unrelated board's folder is untouched").toBe(false);
    expect(trashMutations(fake, keptFolder), "no mutation addressed the unrelated folder").toEqual([]);
    expect(await records.boardCleanup(kept), "the unrelated board owes nothing").toBeNull();
  });
});

describe("the cleanup refuses anything it cannot prove", () => {
  it("refuses the /pboard root as the target folder", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    await boardOnDrive(store, board);
    const rootId = (await store.existingRootFolder())!;
    const records = await journal();
    await tombstonedRow(records, board);
    // A corrupted or hostile record claiming the root is the board's folder.
    const row = await records.tombstones.get(board);
    await records.tombstones.put({ ...row!, cleanup: { ...row!.cleanup!, folderId: rootId } });
    const before = fake.mutations.length;

    const outcome = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT });
    expect(outcome).toMatchObject({ status: "refused", refusal: "root-folder" });
    expect(fake.mutations.length, "a refusal writes nothing to Drive").toBe(before);
    expect(fake.files.find(file => file.id === rootId)?.trashed).toBe(false);
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "pending" });
  });

  it("refuses a folder that belongs to another board", async () => {
    const { fake, store } = drive();
    const doomed = crypto.randomUUID(), other = crypto.randomUUID();
    await boardOnDrive(store, doomed);
    const otherFolder = await boardOnDrive(store, other);
    const records = await journal();
    await tombstonedRow(records, doomed);
    const row = await records.tombstones.get(doomed);
    await records.tombstones.put({ ...row!, cleanup: { ...row!.cleanup!, folderId: otherFolder } });
    const before = fake.mutations.length;

    const outcome = await runBoardCleanup({ boardId: doomed, journal: records, store, account: ACCOUNT });
    expect(outcome).toMatchObject({ status: "refused", refusal: "foreign-folder" });
    expect(fake.mutations.length, "a refusal writes nothing to Drive").toBe(before);
    expect(fake.files.find(file => file.id === otherFolder)?.trashed).toBe(false);
    expect(await records.boardCleanup(doomed)).toMatchObject({ stage: "pending" });
  });

  it("refuses a folder this account does not own", async () => {
    const fake = new FakeDrive();
    const ownerToken = fake.addAccount(OTHER), callerToken = fake.addAccount(OWNER);
    const board = crypto.randomUUID();
    // The folder is created and owned by another account, shared to this one as
    // a writer: Drive reports `canAddChildren` but not `ownedByMe`.
    const otherStore = createDriveBoardStore({
      auth: { getAccessToken: async () => ownerToken, getConnectionState: async () => "connected" as const,
        isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
      fetcher: fake.fetch as unknown as typeof fetch
    });
    const folderId = await otherStore.boardFolder(board);
    fake.grant(BOARD_ROOT_NAME, OWNER, "writer");
    fake.grant(boardFolderName(board), OWNER, "writer");
    const store = createDriveBoardStore({
      auth: { getAccessToken: async () => callerToken, getConnectionState: async () => "connected" as const,
        isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
      fetcher: fake.fetch as unknown as typeof fetch
    });
    const records = await journal();
    await tombstonedRow(records, board);
    const before = fake.mutations.length;

    const outcome = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT });
    expect(outcome).toMatchObject({ status: "refused", refusal: "not-owner" });
    expect(fake.mutations.length, "a refusal writes nothing to Drive").toBe(before);
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(false);
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "pending" });
  });

  it("refuses a board that is not tombstoned", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    // A cleanup record with no deletion behind it — what a stale record left
    // behind by a restore would look like if the restore failed to clear it.
    await records.tombstones.put({ boardId: board, facts: [],
      cleanup: pendingBoardCleanup(ACCOUNT, "2026-01-01T00:00:00.000Z", 0) });
    const before = fake.mutations.length;

    const outcome = await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT });
    expect(outcome).toMatchObject({ status: "refused", refusal: "not-tombstoned" });
    expect(fake.mutations.length, "a refusal writes nothing to Drive").toBe(before);
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(false);
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "pending" });
  });

  it("drops the cleanup record when the board is restored", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    await tombstonedRow(records, board);
    await records.recordBoardDeletion({ boardId: board, accountId: ACCOUNT, context: {}, role: "owner",
      at: "2026-01-01T00:00:01.000Z", evidence: "explicit-restore", kind: "restored" });

    expect(await records.boardCleanup(board), "a live board owes no folder move").toBeNull();
    expect(await records.pendingBoardCleanups()).toEqual([]);
    expect(await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT }))
      .toMatchObject({ status: "skipped" });
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(false);
  });
});

describe("the cleanup waits for a usable Drive account", () => {
  it("skips without spending the retry ladder while Drive is disconnected", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    await tombstonedRow(records, board);
    const before = fake.mutations.length;

    expect(await runBoardCleanup({ boardId: board, journal: records, store, account: null }))
      .toMatchObject({ status: "skipped" });
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "pending", attempts: 0 });
    expect(fake.mutations.length, "an offline browser sends nothing").toBe(before);
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(false);
  });

  it("skips a record that belongs to a different Google account", async () => {
    const { fake, store } = drive();
    const board = crypto.randomUUID();
    const folderId = await boardOnDrive(store, board);
    const records = await journal();
    await tombstonedRow(records, board, { accountId: "another-account" });
    const before = fake.mutations.length;

    expect(await runBoardCleanup({ boardId: board, journal: records, store, account: ACCOUNT }))
      .toMatchObject({ status: "skipped" });
    expect(fake.mutations.length, "the wrong account's Drive is never written").toBe(before);
    expect(fake.files.find(file => file.id === folderId)?.trashed).toBe(false);
    // And it is not silently settled either: the right account still owes it.
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "pending" });
  });
});

/** The record shape is durable data: a reader must not have to guess. */
describe("the cleanup record", () => {
  it("round-trips through the journal row without becoming a tombstone fact", async () => {
    const records = await journal();
    const board = crypto.randomUUID();
    await tombstonedRow(records, board, { name: "Named board" });
    const facts = await records.boardTombstoneFacts(board);
    expect(facts).toHaveLength(1);
    expect(facts[0]).not.toHaveProperty("cleanup");
    const cleanup = await records.boardCleanup(board) as BoardCleanupState;
    expect(cleanup).toMatchObject({ stage: "pending", accountId: ACCOUNT, name: "Named board", attempts: 0 });
    // Writing another fact must not disturb the Drive half.
    await records.recordBoardDeletion({ boardId: board, accountId: ACCOUNT, context: {}, role: "owner",
      at: "2026-01-01T00:00:03.000Z", evidence: "test", kind: "deleted" });
    expect(await records.boardCleanup(board)).toMatchObject({ stage: "pending", name: "Named board" });
  });
});
