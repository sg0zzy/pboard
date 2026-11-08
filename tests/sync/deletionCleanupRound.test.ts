/**
 * The resumption seam, end to end through the product's composition root.
 *
 * A browser that closes between the durable tombstone and the Drive Trash must
 * finish the job in its next session. The seam is the reconcile round
 * (`performReconcileAll` in `src/sync/runtime.ts`), which runs the pending
 * cleanups before any discovery work — never at startup, never on a board open.
 *
 * These scenarios drive the *real* runtime, the *real* repository and the
 * *real* Drive board store over the single-account Drive stub, so "the round
 * did it" is proved by a Drive mutation and a journal record, not by calling
 * the executor directly.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { createDriveRuntime } from "../../src/sync/runtime";
import { createRxRepository, type RxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";
import { BOARD_ROOT_NAME } from "../../src/sync/driveBoardStore";
import { DriveStub } from "./driveStub";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

type Profile = { runtime: ReturnType<typeof createDriveRuntime>; repository: RxRepository; stub: DriveStub; name: string;
  /** Mutable fault switch: return a response to refuse a request, `null` to pass it through. */
  faults: { refuse: ((url: string, method: string) => Response | null) | null };
  /** Every request that asked Drive to mark something trashed, by target id.
   *  The claim "a confirmed cleanup is not repeated" is a claim about this
   *  list, not about reads — the round reads plenty for other reasons. */
  trashWrites: { id: string }[] };

/** One browser profile on one Drive stub: the repository is created first and
 * the runtime resolves it lazily, exactly as the composition root does.
 *
 * The fetcher is a stable wrapper, never the stub's own arrow, because the
 * Drive stores capture it once at construction — a test that swapped
 * `stub.fetch` afterwards would be changing a property nothing reads. */
async function profile(stub: DriveStub, name: string): Promise<Profile> {
  const repository = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const data: Record<string, unknown> = {};
  const faults: Profile["faults"] = { refuse: null };
  const trashWrites: Profile["trashWrites"] = [];
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if ((init.method ?? "GET").toUpperCase() === "PATCH" && typeof init.body === "string" && init.body.includes('"trashed":true')) {
      trashWrites.push({ id: decodeURIComponent((/\/files\/([^/?]+)/.exec(url)?.[1] ?? "")) });
    }
    return faults.refuse?.(url, (init.method ?? "GET").toUpperCase()) ?? await stub.fetch(input, init);
  }) as typeof fetch;
  const runtime = createDriveRuntime({
    auth: { getAccessToken: async () => "token", getConnectionState: async () => "connected" as const,
      isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
    storage: { get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
      set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); } },
    getRepository: async () => repository, fetcher
  });
  await runtime.collaborationManager.setEnabled(false);
  closes.push(async () => {
    await runtime.collaborationManager.stop();
    for (const id of repository.operationSource.bindings.keys()) await runtime.operationService.close(id);
    await repository.db.close();
  });
  return { runtime, repository, stub, name, faults, trashWrites };
}

const boardFolder = (stub: DriveStub, boardId: string) =>
  stub.files.find(file => file.name === boardId && !file.trashed && file.mimeType === "application/vnd.google-apps.folder");

describe("a deletion's Drive cleanup is resumed by the reconcile round", () => {
  it("moves the folder on the first round after the delete, and leaves the board tombstoned", async () => {
    const stub = new DriveStub();
    stub.defaultPermissions = [{ id: "owner", type: "user", role: "owner", emailAddress: "owner@example.com" }];
    const browser = await profile(stub, `cleanupr${crypto.randomUUID().replaceAll("-", "")}`);
    const board = await browser.repository.createProject("Doomed", "project");
    await browser.runtime.googleDrive.syncProject(board.id, { force: true });
    expect(boardFolder(stub, board.id), "premise: the board has a Drive folder").toBeDefined();

    await browser.repository.deleteProject(board.id);
    // The intent is durable as soon as the delete returns, before any Drive
    // work: that is what a browser closing here must be able to resume.
    expect(await browser.repository.boardDriveCleanup(board.id)).toMatchObject({ stage: "pending", name: "Doomed" });
    expect(boardFolder(stub, board.id)?.trashed, "the delete itself does not touch Drive").toBe(false);

    await browser.runtime.googleDrive.reconcileAll({ force: true });
    expect(boardFolder(stub, board.id), "the round moved the folder out of the listing").toBeUndefined();
    expect(stub.files.find(file => file.name === board.id)?.trashed).toBe(true);
    expect(stub.files.find(file => file.name === BOARD_ROOT_NAME)?.trashed).toBe(false);
    expect(await browser.repository.boardDriveCleanup(board.id)).toMatchObject({ stage: "trashed" });
    expect(await browser.repository.isDeletedProject(board.id), "the board stays tombstoned after its folder is trashed").toBe(true);
    expect(await browser.repository.pendingBoardCleanups()).toEqual([]);
  });

  it("resumes after a restart, from the journal alone and without enumerating Drive", async () => {
    const stub = new DriveStub();
    stub.defaultPermissions = [{ id: "owner", type: "user", role: "owner", emailAddress: "owner@example.com" }];
    const name = `cleanupresume${crypto.randomUUID().replaceAll("-", "")}`;
    const first = await profile(stub, name);
    const board = await first.repository.createProject("Interrupted", "project");
    await first.runtime.googleDrive.syncProject(board.id, { force: true });
    const folderId = boardFolder(stub, board.id)!.id;
    await first.repository.deleteProject(board.id);
    // The session ends here: tombstone and intent are durable, Drive is clean.
    await first.repository.db.close();
    closes.pop();
    expect(stub.files.find(file => file.id === folderId)?.trashed).toBe(false);

    // A new session over the same journal database.
    const second = await profile(stub, name);
    expect((await second.repository.pendingBoardCleanups()).map(row => row.boardId)).toEqual([board.id]);
    // What the resume costs is counted. No id was verified before the session
    // ended, so the folder is resolved the only way that is allowed to create
    // nothing: the create-free name probe (root listing, then the board's own
    // name), never a whole-account enumeration and never a find-or-create.
    const before = stub.files.filter(file => file.trashed).length;
    const mutationsBefore = stub.requests.filter(url => !/files\/[^/?]+\?fields=id$/.test(url)).length;
    await second.runtime.googleDrive.reconcileAll({ force: true });
    expect(stub.files.find(file => file.id === folderId)?.trashed).toBe(true);
    expect(stub.files.filter(file => file.trashed).length, "exactly one folder moved to Trash").toBe(before + 1);
    expect(stub.requests.length).toBeGreaterThan(mutationsBefore);
    expect(await second.repository.boardDriveCleanup(board.id)).toMatchObject({ stage: "trashed" });
    expect(await second.repository.isDeletedProject(board.id)).toBe(true);
    // And the resume is idempotent: a second round asks Drive to trash nothing.
    // Reads from other legs (discovery, preferences) are not the claim.
    const writes = second.trashWrites.filter(write => write.id === folderId).length;
    expect(writes, "the resume performed exactly one Trash").toBe(1);
    await second.runtime.googleDrive.reconcileAll({ force: true });
    expect(second.trashWrites.filter(write => write.id === folderId).length,
      "a confirmed cleanup is not re-attempted by the next round").toBe(writes);
    expect(stub.files.filter(file => file.trashed).length, "still exactly one trashed folder").toBe(before + 1);
  });

  it("keeps the deletion and reports the reason when Drive refuses the Trash", async () => {
    const stub = new DriveStub();
    stub.defaultPermissions = [{ id: "owner", type: "user", role: "owner", emailAddress: "owner@example.com" }];
    const browser = await profile(stub, `cleanupfail${crypto.randomUUID().replaceAll("-", "")}`);
    const board = await browser.repository.createProject("Stubborn", "project");
    await browser.runtime.googleDrive.syncProject(board.id, { force: true });
    const folderId = boardFolder(stub, board.id)!.id;
    await browser.repository.deleteProject(board.id);

    // A refusal on the write itself — Drive naming the operation as forbidden —
    // is the failure the retry ladder exists for.
    browser.faults.refuse = (url, method) => method === "PATCH" && url.includes(folderId)
      ? Response.json({ error: { status: "INSUFFICIENT_FILE_PERMISSIONS", message: "refused" } }, { status: 403 })
      : null;
    await browser.runtime.googleDrive.reconcileAll({ force: true });
    const failed = await browser.repository.boardDriveCleanup(board.id);
    expect(failed).toMatchObject({ stage: "failed", attempts: 1 });
    expect(failed?.reason).toMatch(/trashing|403|permission/i);
    expect(failed!.nextAttemptAt).toBeGreaterThan(0);
    // The deletion is exactly where it was, and Drive still has the folder.
    expect(await browser.repository.isDeletedProject(board.id), "a failed Trash never resurrects the board").toBe(true);
    expect(await browser.repository.listProjects()).toEqual([]);
    expect((await browser.repository.pendingBoardCleanups()).map(row => row.boardId)).toEqual([board.id]);
    expect(stub.files.find(file => file.id === folderId)?.trashed).toBe(false);

    // Drive relents: the next scheduled attempt is a retry of this one folder
    // and it lands. Forced rounds ignore the backoff window, so the scenario
    // does not have to wait out the ladder.
    browser.faults.refuse = null;
    await browser.runtime.googleDrive.reconcileAll({ force: true });
    expect(stub.files.find(file => file.id === folderId)?.trashed).toBe(true);
    const confirmed = await browser.repository.boardDriveCleanup(board.id);
    expect(confirmed).toMatchObject({ stage: "trashed" });
    expect(confirmed?.reason).toBeUndefined();
    expect(await browser.repository.isDeletedProject(board.id)).toBe(true);
    expect(await browser.repository.pendingBoardCleanups()).toEqual([]);
  });
});
