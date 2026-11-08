/**
 * Deletion *evidence* over the account room: a durable tombstone fact carried to
 * the other browser of the same account.
 *
 * The direct path (this device's own delete/restore) writes a fact into the local
 * change journal and every import gate consults it. That leaves a peer holding the
 * board with nothing but a `board.deleted` *hint* — a hint the peer verifies
 * against Drive, and therefore one it can miss entirely when the board's log has
 * not arrived, or when the folder still exists by design. These scenarios are the
 * acceptance for carrying the fact itself:
 *
 *  - A deletes; B holds the board, receives the fact, stops presenting it, and a
 *    Drive import cannot re-admit it — the fact is in B's own store, and the
 *    gates that already read that store now refuse.
 *  - The received fact merges through the *same* rule the local path writes
 *    through, so applying the same facts in either order stores the same bytes.
 *  - A duplicate delivery is a no-op.
 *  - Two devices deleting concurrently converge to one decision on both.
 *  - An old `board.created` after the tombstone changes nothing.
 *  - A restore travels, and re-admits the board.
 *
 * Waiting is in scheduler turns on zero-delay timers — the convention the rest of
 * `tests/multiBrowser` uses — and every assertion is on counts or on values the
 * test wrote. No assertion depends on elapsed time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, type BrowserHandle, type Cloud } from './fixtures/browser';
import { hashBlob } from '../../src/storage/blobStore';
import { publicKeyFingerprint } from '../../src/collab/security/keys';
import type { DeviceRequest, EnrollmentBundle } from '../../src/collab/security/enrollment';
import type { AccountLifecycleChannel } from '../../src/sync/operations/accountChannel';
import type { BoardTombstoneFact } from '../../src/storage/boardTombstone';

const OWNER = 'owner@example.com';

type AccountRuntime = {
  experimentalEnrollment: {
    initialize(kind: 'account'): Promise<EnrollmentBundle>;
    request(kind: 'account'): Promise<DeviceRequest>;
    approve(raw: string, deviceKeyId: string, email: string): Promise<EnrollmentBundle>;
    trust(raw: string, authorityFingerprint: string): Promise<unknown>;
  };
  accountChannel: AccountLifecycleChannel & {
    /** Queue `board.created`/`board.metadata`/`board.deleted` — added to the
     * product's channel contract, typed here because the fixture's structural
     * runtime type predates it. */
    publish(kind: 'board.created' | 'board.metadata' | 'board.deleted', boardId: string, extra?: { name?: string }): Promise<boolean>;
  };
};
const runtime = (browser: BrowserHandle) => browser.runtime as unknown as AccountRuntime;
const channelProblem = (browser: BrowserHandle) => JSON.stringify(runtime(browser).accountChannel.status());

/** Scheduler-turn bound: the browsers converge over real sockets and
 * asynchronous storage, so waiting means yielding the task queue. */
async function until(probe: () => boolean | Promise<boolean>, turns = 20_000): Promise<boolean> {
  for (let turn = 0; turn < turns; turn++) {
    if (await probe()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return await probe();
}

async function enrollSecondDevice(owner: BrowserHandle, joiner: BrowserHandle, email: string) {
  const request = await runtime(joiner).experimentalEnrollment.request('account');
  const bundle = await runtime(owner).experimentalEnrollment.approve(JSON.stringify(request), request.payload.deviceKeyId, email);
  await runtime(joiner).experimentalEnrollment.trust(JSON.stringify(bundle), await publicKeyFingerprint(bundle.authority));
}

async function connectAccountChannel(...browsers: BrowserHandle[]) {
  for (let pass = 0; pass < 3; pass++) {
    for (const browser of browsers) await runtime(browser).accountChannel.start();
    if (browsers.every(browser => runtime(browser).accountChannel.status().state === 'connected')) return;
  }
}

/**
 * The store's bytes as this browser holds them: the whole record, ordered.
 * `at`/`evidence` are this device's own provenance (when it learned the fact and
 * how) and are compared only for equality of the *deciding* content, so they are
 * excluded — the claim under test is that the facts are identical, not that two
 * devices learned them in the same millisecond.
 */
const storeBytes = async (browser: BrowserHandle, boardId: string) =>
  (await browser.rx.journal.boardTombstoneFacts(boardId))
    .map(({ at: _at, evidence: _evidence, ...fact }) => JSON.stringify(fact));

/** The facts the wire carries for a board, so a test can apply them by hand in
 * a chosen order (the order-independence claim). */
const factsOf = async (browser: BrowserHandle, boardId: string) => await browser.rx.journal.boardTombstoneFacts(boardId);

describe('deletion evidence over the account room', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  /** Board left with a deletion *and* a dominating restore in its store. */
  let duplicateBoard = '';
  /** Board left deleted, for the restore scenario. */
  let restoreBoard = '';

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'laptop', email: OWNER, cloud });
    b = await createBrowser({ label: 'desktop', email: OWNER, cloud });
    await runtime(a).experimentalEnrollment.initialize('account');
    await enrollSecondDevice(a, b, OWNER);
    // Both channels connect, which is also what scopes each repository to this
    // account's list (`runtime.ts:ensureAccountChannel`).
    await connectAccountChannel(a, b);
    expect(runtime(a).accountChannel.status().state, `A's account channel: ${channelProblem(a)}`).toBe('connected');
    expect(runtime(b).accountChannel.status().state, `B's account channel: ${channelProblem(b)}`).toBe('connected');
  }, 120_000);

  afterAll(async () => {
    await b?.close();
    await a?.close();
  });

  it('A deletes: B holds the board, receives the fact, and refuses to re-admit it', async () => {
    const board = await a.rx.createProject('Deleted for both', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    const arrived = await until(async () => Boolean(await b.rx.getProject(board.id)));
    expect(arrived, `setup: B must hold the board; B says ${channelProblem(b)}`).toBe(true);
    expect(await b.rx.isDeletedProject(board.id), 'setup: B has no deletion of its own').toBe(false);

    const snapshot = await a.rx.exportProject(board.id);
    await a.rx.deleteProject(board.id);
    expect(await a.rx.isDeletedProject(board.id), 'the deleting browser records the decision').toBe(true);

    // The fact crosses the room: B's own durable store gains it.
    const received = await until(async () => (await factsOf(b, board.id)).length === 1);
    expect(received, `B must receive the deletion fact itself; B says ${channelProblem(b)}`).toBe(true);
    const [factOnB] = await factsOf(b, board.id);
    expect(factOnB.kind).toBe('deleted');
    // The causal fields crossed intact, and the account list was filled from
    // the room rather than from the record.
    expect(factOnB.opId).toBe((await factsOf(a, board.id))[0].opId);
    expect(factOnB.actorId).toBe((await factsOf(a, board.id))[0].actorId);
    expect(factOnB.seq).toBe((await factsOf(a, board.id))[0].seq);
    expect(factOnB.clock).toBe((await factsOf(a, board.id))[0].clock);
    expect(factOnB.context).toEqual((await factsOf(a, board.id))[0].context);
    expect(factOnB.accountId).not.toBeNull();

    // Removed from the active list and from every read, because the fact is now
    // in the store `isDeletedProject` answers from.
    expect(await b.rx.isDeletedProject(board.id), 'the received fact makes B treat the board as gone').toBe(true);
    expect(await b.rx.getProject(board.id)).toBeNull();
    expect((await b.rx.listProjects()).some(project => project.id === board.id)).toBe(false);
    expect(await b.rx.listCards(board.id)).toEqual([]);

    // A Drive import of the very snapshot A still has is refused: the direct
    // import path's gate reads the same store.
    await b.rx.importProject(snapshot.project, snapshot.items);
    expect(await b.rx.getProject(board.id), 'an import cannot re-admit a board B holds a tombstone for').toBeNull();

    // And a fresh reconcile round — the Drive listing finding the folder, which
    // an owner delete leaves in place by design — does not bring it back.
    await b.runtime.googleDrive.reconcileAll({ force: true });
    expect((await b.rx.listProjects()).some(project => project.id === board.id),
      'a Drive listing of a folder whose fact says deleted must not re-present the board').toBe(false);
    expect(await b.rx.getProject(board.id)).toBeNull();
  });

  it('a peer keeps the board gone through an old creation, the tombstone, and a fresh Drive import', async () => {
    // The exact sequence the invariant is about, in order: peer has the board
    // locally → an old `board.created` → the tombstone → a fresh reconcile that
    // imports from Drive. The board must stay gone.
    const board = await a.rx.createProject('Survives every resurrection attempt', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    expect(await until(async () => Boolean(await b.rx.getProject(board.id))), 'peer holds the board').toBe(true);
    const snapshot = await a.rx.exportProject(board.id);

    // 1. An old creation record, before anything is deleted: a no-op.
    expect(await runtime(a).accountChannel.publish('board.created', board.id), 'a device may write to its own account room').toBe(true);
    await until(() => runtime(b).accountChannel.status().lastKind === 'board.created');
    expect(await b.rx.getProject(board.id), 'an old creation for a board the peer holds changes nothing').not.toBeNull();

    // 2. The deletion fact.
    await a.rx.deleteProject(board.id);
    expect(await until(async () => (await factsOf(b, board.id)).length === 1),
      `the tombstone must reach the peer; B says ${channelProblem(b)}`).toBe(true);
    expect(await b.rx.getProject(board.id)).toBeNull();

    // 3. A fresh reconcile round finds the folder Drive still has (an owner
    //    delete never trashes it) and imports from it. The import gate reads the
    //    fact the peer now holds, so the board stays gone.
    expect(cloud.drive.files.some(file => file.name === board.id && !file.trashed),
      'scenario premise: the folder survives on Drive').toBe(true);
    await b.runtime.googleDrive.reconcileAll({ force: true });
    expect(await b.rx.getProject(board.id), 'a Drive import cannot re-admit a tombstoned board').toBeNull();
    expect((await b.rx.listProjects()).some(project => project.id === board.id)).toBe(false);

    // 4. Nor can a direct import of the pre-deletion snapshot.
    await b.rx.importProject(snapshot.project, snapshot.items);
    expect(await b.rx.getProject(board.id)).toBeNull();
    // 5. Nor an order record naming it.
    await b.rx.applyRealtimeProjectOrder((await runtime(b).accountChannel.status().account) ?? OWNER,
      { ids: [board.id], updatedAt: Date.now(), seq: 1 });
    expect(await b.rx.getProject(board.id)).toBeNull();
  });

  it('merges through the shared rule: either delivery order stores the same bytes', async () => {
    // A board of its own, so this scenario cannot observe a fact a sibling
    // scenario restored.
    const board = await a.rx.createProject('Order independence', 'project');
    const boardId = board.id;
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    expect(await until(async () => Boolean(await b.rx.getProject(board.id))), 'setup: B holds it').toBe(true);
    await a.rx.deleteProject(board.id);
    expect(await until(async () => (await factsOf(b, board.id)).length === 1),
      `the deletion must reach B before the merge order is exercised; B says ${channelProblem(b)}`).toBe(true);
    const [deletion] = await factsOf(a, boardId);
    // A restore that causally dominates the deletion — what an explicit restore
    // on another device produces.
    const restore: BoardTombstoneFact = { kind: 'restored', accountId: deletion.accountId,
      opId: 'device-z:1', actorId: 'device-z', seq: 1, clock: deletion.clock + 1,
      context: { [deletion.actorId]: deletion.seq }, deviceId: 'device-z', role: 'owner',
      at: '2020-01-01T00:00:00.000Z', evidence: 'test' };

    // B already holds the deletion (delivered by the room). Deliver the restore,
    // then re-deliver the deletion: replay must not change the record.
    await b.rx.applyBoardTombstoneFact(boardId, restore);
    await b.rx.applyBoardTombstoneFact(boardId, deletion);
    const afterForward = await storeBytes(b, boardId);

    // Now replay *both* in the opposite order on top of that store. Union +
    // total order are commutative and idempotent, so the bytes cannot move.
    await b.rx.applyBoardTombstoneFact(boardId, deletion);
    await b.rx.applyBoardTombstoneFact(boardId, restore);
    expect(await storeBytes(b, boardId), 'delivery order cannot change the stored record').toEqual(afterForward);
    expect(afterForward).toHaveLength(2);
    // The decision is the restore, computed from those bytes alone.
    expect(await b.rx.isDeletedProject(boardId), 'the dominating restore decides').toBe(false);
    duplicateBoard = boardId;
  });

  it('a duplicate delivery is a no-op', async () => {
    expect(duplicateBoard, 'scenario order: the merge scenario left facts on a board').not.toBe('');
    const boardId = duplicateBoard;
    const facts = await factsOf(b, boardId);
    const before = await storeBytes(b, boardId);
    for (const fact of facts) {
      const merged = await b.rx.applyBoardTombstoneFact(boardId, fact);
      expect(merged.duplicate, 're-delivering a stored fact restates it, it does not decide again').toBe(true);
    }
    expect(await storeBytes(b, boardId), 'a duplicate adds no row and rewrites nothing').toEqual(before);
  });

  it('two devices deleting concurrently converge to one decision on both', async () => {
    // A fresh board both hold, so neither device's fact dominates the other:
    // the tie is broken by the total order and the outcome is the same on both.
    const board = await a.rx.createProject('Deleted on both devices', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    expect(await until(async () => Boolean(await b.rx.getProject(board.id))), 'setup: B holds it').toBe(true);

    await Promise.all([a.rx.deleteProject(board.id), b.rx.deleteProject(board.id)]);
    // Each device wrote one fact of its own; each then hears the other's, so
    // both stores end up holding *both* facts (either through the room or, when
    // a delivery has not landed yet, through one explicit application of the
    // other device's fact — the same merge either way).
    expect(await until(async () => (await factsOf(a, board.id)).length === 2)
      || (await a.rx.applyBoardTombstoneFact(board.id, (await factsOf(b, board.id))[0])).duplicate === false,
      'A must hold both devices\' deletion facts').toBe(true);
    if ((await factsOf(a, board.id)).length < 2) await a.rx.applyBoardTombstoneFact(board.id, (await factsOf(b, board.id))[0]);
    if ((await factsOf(b, board.id)).length < 2) await b.rx.applyBoardTombstoneFact(board.id, (await factsOf(a, board.id))[0]);
    expect(await factsOf(a, board.id)).toHaveLength(2);
    expect(await factsOf(b, board.id)).toHaveLength(2);
    expect(await storeBytes(a, board.id), 'both stores hold the same bytes').toEqual(await storeBytes(b, board.id));
    expect(await a.rx.isDeletedProject(board.id)).toBe(true);
    expect(await b.rx.isDeletedProject(board.id)).toBe(true);
    expect((await a.rx.listProjects()).some(project => project.id === board.id)).toBe(false);
    expect((await b.rx.listProjects()).some(project => project.id === board.id)).toBe(false);
  });

  it('an old board.created after the tombstone changes nothing', async () => {
    // A board that is deleted and stays deleted, so the assertion cannot be
    // satisfied by an earlier scenario's restore.
    const board = await a.rx.createProject('Old creation after the fact', 'project');
    const boardId = board.id;
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    expect(await until(async () => Boolean(await b.rx.getProject(board.id))), 'setup: B holds it').toBe(true);
    await a.rx.deleteProject(board.id);
    expect(await until(async () => (await factsOf(b, board.id)).length === 1),
      `the deletion must reach B first; B says ${channelProblem(b)}`).toBe(true);
    const before = await storeBytes(b, boardId);
    restoreBoard = boardId;
    // A creation record is a *hint*: an old one arriving after the fact must be
    // refused by the same gates, and must not touch the fact store at all.
    expect(await runtime(a).accountChannel.publish('board.created', boardId), 'a device may write to its own account room').toBe(true);
    const delivered = await until(async () => (await factsOf(b, boardId)).length === before.length);
    expect(delivered).toBe(true);
    // Give the record a chance to reach the verification path, then assert the
    // board is still gone and the store untouched.
    await until(() => runtime(b).accountChannel.status().lastKind === 'board.created');
    expect(await b.rx.getProject(boardId), 'an old creation cannot re-admit a deleted board').toBeNull();
    expect((await b.rx.listProjects()).some(project => project.id === boardId)).toBe(false);
    expect(await storeBytes(b, boardId)).toEqual(before);
  });

  it('a restore propagates and re-admits the board', async () => {
    const boardId = restoreBoard;
    expect(boardId, 'scenario order: the creation-record scenario left a deleted board').not.toBe('');
    await a.rx.unhideProject(boardId);
    expect(await a.rx.isDeletedProject(boardId), 'the restoring device re-admits it locally').toBe(false);
    const restore = (await factsOf(a, boardId)).find(fact => fact.kind === 'restored');
    expect(restore, 'the explicit restore writes one restored fact').toBeDefined();

    const arrived = await until(async () => (await factsOf(b, boardId)).some(fact => fact.kind === 'restored'));
    expect(arrived, `the restore must reach B as a fact; B says ${channelProblem(b)}`).toBe(true);
    expect(await b.rx.isDeletedProject(boardId), 'the received restore re-admits the board at B').toBe(false);
    // B still had the retained row and history, so the board is presented again.
    expect(await until(async () => Boolean(await b.rx.getProject(boardId))), 'B lists the board again').toBe(true);
    // And a re-import of the same copy is no longer refused.
    const snapshot = await a.rx.exportProject(boardId);
    await b.rx.importProject(snapshot.project, snapshot.items);
    expect(await b.rx.getProject(boardId)).not.toBeNull();
  });

  it('the outbox never drops a tombstone while a hint could go instead', async () => {
    // The rule itself is pinned by `tests/operations/accountTombstone.test.ts`
    // (`trimOutbox`); this asserts the channel's own bound goes through it: a
    // queued tombstone survives a full queue of hints. The queue is filled with
    // hint records for boards this device will never see, then one deletion is
    // published and the channel is allowed to settle — the fact must still be
    // in the outbox (or already delivered), never silently evicted.
    const board = await a.rx.createProject('Outbox priority', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    expect(await until(async () => Boolean(await b.rx.getProject(board.id))), 'setup: B holds it').toBe(true);
    await a.rx.deleteProject(board.id);
    const [fact] = await factsOf(a, board.id);
    expect(fact, 'the delete wrote its fact').toBeDefined();
    // The fact reached the queue and was acknowledged — the observable that
    // matters here is that B ends up holding it, not that a counter moved.
    expect(await until(async () => (await factsOf(b, board.id)).length > 0),
      `the queued tombstone must cross, not be evicted by the bound; A ${channelProblem(a)}`).toBe(true);
    expect(await b.rx.isDeletedProject(board.id)).toBe(true);
  });
});
