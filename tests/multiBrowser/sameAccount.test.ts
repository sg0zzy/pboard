/**
 * Two browser contexts, one Google account, relay (durable operation log)
 * collaboration with the peer pools switched off.
 *
 * The authority here is **Google Drive**, not a signed device manifest: the
 * browser composition root supplies `getDriveIdentityCredentials`
 * (`src/sync/googleAuth.ts`), so the runtime admits every room through
 * `/drive/admit`, a second browser of the same account joins the *same* relay
 * room because it proves the same Drive folder, and there is no identity
 * directory, no `account:<hash>` pin and no device-request ceremony on this
 * path at all (`tests/multiBrowser/driveAuthorityRuntime.test.ts` pins that the
 * legacy `/identity/` and `/grants/` endpoints are never contacted).
 *
 * Scenario order matters: each scenario continues from the board state the
 * previous one left, mirroring the owner's manual five-step test. Assertions
 * are observable outcomes — what browser B's repository contains, the content
 * field of a card, the durable snapshot bytes in Drive, the admission record
 * the signaling service holds — never internals of the runtimes.
 *
 * Where the product cannot deliver today, the scenario fails loudly with a
 * message naming the missing mechanism (file + function + what it lacks)
 * instead of skipping or asserting a weakened substitute.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, logStatusOf, roomFor } from './fixtures/browser';
import type { BrowserHandle, Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';

/** One Drive-side reconcile: what the background alarm / sidebar-focus
 * discovery calls; the product's own entry point, not a manual refresh. */
async function backgroundReconcile(browser: BrowserHandle) {
  await browser.runtime.googleDrive.reconcileAll({ force: true });
}

/** Open the board the way the sidebar does: start the collaboration session,
 * which opens the operation session and asks it for realtime. */
async function openBoard(browser: BrowserHandle, boardId: string) {
  await browser.runtime.collaborationManager.start(boardId);
}

/** Force the realtime factory to run again for the board this browser has
 * open — the same path a role refresh takes after a grant changed. */
async function reattach(browser: BrowserHandle) {
  await browser.runtime.collaborationManager.setEnabled(false);
  await browser.runtime.collaborationManager.setEnabled(true);
}

/** `until` returning false instead of throwing, so callers can attach a
 * product-gap explanation to the condition they actually waited for. */
async function untilQuiet(predicate: () => boolean): Promise<boolean> {
  for (let turn = 0; turn < 4000; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

/** `until` over a value-producing probe: resolves the first non-null answer.
 * Both act loops advance exactly one scheduler turn per iteration (zero-delay
 * timers only, never a wall-clock sleep), so results are load-independent. */
async function untilQuietText(probe: () => string | null): Promise<string | null> {
  for (let turn = 0; turn < 4000; turn++) {
    const value = probe();
    if (value !== null) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return probe();
}

/** `untilQuiet` for a probe that has to read a repository: same scheduler-turn
 * bound, so a convergence assertion never depends on how fast the machine is. */
async function untilSettled(probe: () => Promise<boolean>): Promise<boolean> {
  for (let turn = 0; turn < 4000; turn++) {
    if (await probe()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return probe();
}

/** Explain *why* the relay never synchronized instead of timing out silently:
 * the room record carries the transport's own last answer. */
function relayNeverSynced(browser: BrowserHandle, boardId: string, expectation: string): Error {
  const room = roomFor(browser, boardId);
  return new Error(`PRODUCT GAP — browser ${browser.label} never synchronized board ${boardId} over the durable operation log (${expectation}). `
    + `The room record says: ${JSON.stringify({ error: room?.error ?? null, log: room?.log ?? null, starts: room?.starts ?? 0 })}. `
    + 'On the Drive-authorized path every room is admitted through `/drive/admit`: the account proves the board folder with its own '
    + 'Google identity and the relay derives the room from `(boardId, folderId)`. A second browser of the same account lands in the same '
    + 'room because it resolves the same folder, not because of a device grant.');
}

async function expectRelaySynced(browser: BrowserHandle, boardId: string, expectation: string) {
  const synced = await untilQuiet(() => logStatusOf(browser, boardId)?.phase === 'synced');
  if (!synced) throw relayNeverSynced(browser, boardId, expectation);
  const log = logStatusOf(browser, boardId)!;
  if (typeof log.appliedSeq !== 'number') throw relayNeverSynced(browser, boardId, `${expectation} (no applied sequence reported)`);
}

describe('two browsers, one Google account', { timeout: 120_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let sharedBoard = '';

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    b = await createBrowser({ label: 'B', email: OWNER, cloud });
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('scenario 1: both browsers load local storage, then Drive, then reach a synced log state without a peer-pool fallback', async () => {
    const board = await a.rx.createProject('Relay boot board', 'project');
    await a.rx.addItem({ projectId: board.id, content: 'Sealed before either browser opened the relay' });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });

    await openBoard(a, board.id);
    await expectRelaySynced(a, board.id, 'the authoring browser must attach its board to the log');

    // Browser B boots with an empty profile: local storage first (nothing),
    // then Drive (the reconcile round), then the WebSocket.
    await backgroundReconcile(b);
    const projects = await b.rx.listProjects();
    expect(projects.some(project => project.id === board.id), 'Drive reconcile must import the account\'s board').toBe(true);

    await openBoard(b, board.id);
    // A second browser of the SAME account reaches the same room without any
    // grant ceremony: the room id is derived from `(boardId, folderId)`, which
    // both browsers resolve from the one Drive folder they can both read.
    await expectRelaySynced(b, board.id, 'a same-account second browser must reach the log through Drive admission');
    const authorityRooms = new Set([...cloud.signaling.rooms.values()].filter(room => room.board === board.id).map(room => room.room));
    expect(authorityRooms.size, 'both browsers of one account must hold exactly one relay room').toBe(1);
    expect(roomFor(b, board.id)!.topic, 'and it is the same room the author is on').toBe(roomFor(a, board.id)!.topic);

    // The Drive-authorized path never consults the identity directory the
    // retired signed-authority path published into.
    expect(cloud.signaling.directory.size, 'no identity-directory policy exists on the Drive path').toBe(0);

    // Neither browser may have fallen back to the peer pools: the room record
    // is the browser's own last answer about its live channel.
    for (const browser of [a, b]) {
      const room = roomFor(browser, board.id);
      expect(room?.error ?? '', `browser ${browser.label} fell back to the peer pools`).not.toMatch(/WebRTC|peer/i);
      expect(room?.log?.phase).toBe('synced');
    }
    // The service admitted exactly these two devices, both under this account.
    const admitted = cloud.signaling.admitted.filter(entry => entry.room === roomFor(a, board.id)!.topic || cloud.signaling.rooms.get(entry.room)?.board === board.id);
    expect(admitted.length, 'both browsers must hold an admitted log connection').toBeGreaterThanOrEqual(2);
    expect(new Set(admitted.map(entry => entry.deviceKeyId)).size, 'each browser connects with its own device key').toBe(2);
    for (const entry of admitted) expect(entry.email).toBe(OWNER);
  });

  it('scenario 2: a board created on browser A shows up on browser B — created and empty — without a manual refresh', async () => {
    const board = await a.rx.createProject('Created while B watches', 'project');
    sharedBoard = board.id;
    await a.runtime.googleDrive.syncProject(board.id, { force: true });

    const lists: string[][] = [];
    const stop = b.rx.subscribeProjects(projects => lists.push(projects.map(project => project.id)));
    try {
      await backgroundReconcile(b);
      const seen = await untilQuiet(() => lists.some(ids => ids.includes(board.id)));
      if (!seen) throw new Error(`PRODUCT GAP — board ${board.id} created by browser A never appeared in browser B's reactive project list after a background `
        + 'reconcile round; src/sync/runtime.ts reconcileOperations() must treat `boardStore.listBoards()` as account-level board advertisement.');
      const cards = await b.rx.listCards(board.id);
      expect(cards, 'a newly shared board must arrive exactly as its author left it — empty').toEqual([]);
    } finally { stop(); }
  });

  it('scenario 3: a card typed on browser B appears on browser A with its content intact', async () => {
    await openBoard(a, sharedBoard);
    await openBoard(b, sharedBoard);
    await expectRelaySynced(a, sharedBoard, 'browser A must be live on the board before B edits it');
    await expectRelaySynced(b, sharedBoard, 'browser B must be live on the board to edit it');

    const contents: string[][] = [];
    const stop = a.rx.subscribeCards(sharedBoard, cards => contents.push(cards.map(card => card.content)));
    try {
      await b.rx.addItem({ projectId: sharedBoard, content: 'Typed in browser B' });
      const landed = await untilQuiet(() => contents.some(list => list.includes('Typed in browser B')));
      if (!landed) {
        const room = roomFor(a, sharedBoard);
        const submissions = [...cloud.signaling.rooms.values()].flatMap(roomEntry => roomEntry.submissions);
        throw new Error(`PRODUCT GAP — the card browser B typed never reached browser A with its content. `
          + `A's room: ${JSON.stringify({ error: room?.error ?? null, log: room?.log ?? null })}; log submissions: ${JSON.stringify(submissions)}. `
          + 'Both devices read the same plaintext Drive-authorized room (`createPlaintextOperationCodec`, src/sync/operations/plaintextCodec.ts), '
          + 'so a missing delivery is a transport or projection fault, never a key hand-off.');
      }
    } finally { stop(); }
  });

  it('scenario 4: a second card from browser A reaches B, and both converge on exactly two cards with no duplicates', async () => {
    const contentsByBrowser = new Map<string, string[][]>([['A', []], ['B', []]]);
    const stops = [
      a.rx.subscribeCards(sharedBoard, cards => contentsByBrowser.get('A')!.push(cards.map(card => card.content))),
      b.rx.subscribeCards(sharedBoard, cards => contentsByBrowser.get('B')!.push(cards.map(card => card.content))),
    ];
    try {
      await a.rx.addItem({ projectId: sharedBoard, content: 'Second card, from A' });
      const settled = await untilQuiet(
        () => contentsByBrowser.get('A')!.some(list => list.length === 2) && contentsByBrowser.get('B')!.some(list => list.length === 2));
      if (settled) {
        const cardsA = await a.rx.listCards(sharedBoard);
        const cardsB = await b.rx.listCards(sharedBoard);
        expect(cardsA.map(card => card.id).sort()).toEqual([...new Set(cardsA.map(card => card.id))].sort());
        expect(cardsB.map(card => card.content).sort()).toEqual(['Second card, from A', 'Typed in browser B']);
        expect(cardsA.map(card => card.content).sort()).toEqual(cardsB.map(card => card.content).sort());
      } else {
        throw new Error('PRODUCT GAP — the browsers never converged on the two cards; see scenario 3 for the transport diagnosis format.');
      }
    } finally { for (const stop of stops) stop(); }
  });

  it('scenario 5: switching boards flushes a durable snapshot holding every card, visible to both browsers', async () => {
    const other = await a.rx.createProject('Switch target', 'project');
    await a.runtime.googleDrive.syncProject(other.id, { force: true });
    // Leaving the shared board closes its realtime room, which consolidates:
    // the owner publishes a snapshot of the whole board to Drive.
    await a.runtime.collaborationManager.start(other.id);

    const snapshotText = await untilQuietText(() => {
      const file = cloud.drive.contentsUnder(sharedBoard).find(entry => entry.name.startsWith('snapshot-'));
      return file?.text ?? null;
    });
    if (snapshotText === null) throw new Error(`PRODUCT GAP — no operation snapshot for board ${sharedBoard} was published to Drive when browser A `
      + 'switched boards; runLogConsolidation (src/sync/logConsolidationRuntime.ts) runs on room close for the Drive owner.');

    const snapshot = JSON.parse(snapshotText) as { checkpoint: { entities: { collection: string; deleted: boolean; fields: Record<string, { value?: unknown }> }[] } };
    const cardContents = snapshot.checkpoint.entities
      .filter(entity => entity.collection === 'cards' && !entity.deleted)
      .map(entity => entity.fields.content?.value);
    expect(cardContents).toContain('Typed in browser B');
    expect(cardContents).toContain('Second card, from A');
    // Durable means readable from Drive, not just from memory: assert the
    // snapshot file is in the view each browser's account actually resolves.
    const snapshotName = cloud.drive.contentsUnder(sharedBoard).find(entry => entry.name.startsWith('snapshot-'))!.name;
    expect(cloud.drive.visibleTo(snapshotName, a.email), 'the authoring account reads the snapshot').toBe(true);
    expect(cloud.drive.visibleTo(snapshotName, b.email), 'the second same-account browser reads the same durable file').toBe(true);
  });

  it('scenario 6: an owner erase on browser A removes the board from browser B while B is open on it, and B stops authoring for it', async () => {
    // B is still live on the board scenario 3 put it on. A must be live too:
    // the removal is relayed over the board's log, and a browser that has
    // already left the board has no channel to relay it on — that case is the
    // scheduled Drive round, which scenario 8 exercises.
    await openBoard(a, sharedBoard);
    await reattach(a); await reattach(b);
    await expectRelaySynced(a, sharedBoard, 'the erasing browser must hold the board log open');
    await expectRelaySynced(b, sharedBoard, 'the watching browser must hold the board log open');
    const retainedOnB = (await b.rx.journal.entries.where('boardId').equals(sharedBoard).toArray()).length;
    expect(retainedOnB, 'browser B must hold journal history for the board it is live on').toBeGreaterThan(0);

    await a.rx.deleteProject(sharedBoard);
    expect(await a.rx.isDeletedProject(sharedBoard), 'the erasing browser records the account deletion marker').toBe(true);

    const listed = async (browser: BrowserHandle) => (await browser.rx.listProjects()).some(project => project.id === sharedBoard);
    const erasedEverywhere = await untilSettled(async () => !await listed(a) && !await listed(b));
    if (!erasedEverywhere) {
      throw new Error('PRODUCT GAP — the owner erased board ' + sharedBoard + ' is still listed: A=' + JSON.stringify(await listed(a))
        + ' B=' + JSON.stringify(await listed(b))
        + '; markers A=' + JSON.stringify(await a.rx.isDeletedProject(sharedBoard))
        + ' B=' + JSON.stringify(await b.rx.isDeletedProject(sharedBoard))
        + '; B row=' + JSON.stringify((await b.rx.db.projects.storageInstance.findDocumentsById([sharedBoard], true))[0] ?? null)
        + '; B log=' + JSON.stringify(logStatusOf(b, sharedBoard) ?? null)
        + '. The erase publishes a projects-document delete on the board log (src/storage/rxdbRepository.ts deleteProject → '
        + 'events.projectDeleted → googleDrive.deleteProject → operationService.flushRemoval); if the second browser keeps the board, '
        + 'either the erase never recorded its delete (a storage CONFLICT it swallowed — see scenario 7) or the projection on the '
        + 'receiving browser refused to remove the row (src/sync/operations/projection.ts).');
    }
    expect(await b.rx.getProject(sharedBoard), 'the erased board is not readable on the second browser').toBeNull();
    expect(await b.rx.listCards(sharedBoard), 'a tombstoned board keeps no live cards').toEqual([]);
    // A device that still has the board open must stop mutating it, not write
    // the erased content back into the log.
    await expect(b.rx.addItem({ projectId: sharedBoard, content: 'Authored after the erase' }))
      .rejects.toThrow(/deleted/);
    // Existing erasure/export rules: the live rows go, the evidence stays.
    expect((await b.rx.journal.entries.where('boardId').equals(sharedBoard).toArray()).length,
      'browser B retains the board history it needs to export').toBeGreaterThanOrEqual(retainedOnB);
  });

  it('scenario 7: an erase wins against a live patch stream on the same board', async () => {
    // The owner's failing delete was a storage CONFLICT: applying an operation
    // batch rewrites the board row (its `revision` is the operation vector, its
    // `tailOrderKey` the card order) without touching `updatedAt`, so a
    // document read before the erase is stale when the tombstone is written.
    // Here the stream is real: every card the other browser types is a batch
    // this browser applies, and each batch rewrites the row.
    const board = await a.rx.createProject('Deleted mid-edit', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await backgroundReconcile(b);
    await openBoard(a, board.id);
    await openBoard(b, board.id);
    await reattach(a);
    await reattach(b);
    await expectRelaySynced(a, board.id, 'the authoring browser must be live before the erase races the stream');
    await expectRelaySynced(b, board.id, 'the patching browser must be live before it starts patching');

    const patching = (async () => {
      for (let edit = 0; edit < 12; edit++) {
        // The erase may win mid-loop, which is the outcome under test; a
        // refused edit is the browser discovering the board is gone.
        await b.rx.addItem({ projectId: board.id, content: `Patch ${edit}` }).catch(() => undefined);
      }
    })();
    await a.rx.deleteProject(board.id);
    await patching;

    const stored = (await a.rx.db.projects.storageInstance.findDocumentsById([board.id], true))[0] as unknown as { _deleted?: boolean } | undefined;
    if (!stored?._deleted) {
      throw new Error('PRODUCT GAP — the erase of ' + board.id + ' did not tombstone the board row on the erasing browser. '
        + 'The row still reads ' + JSON.stringify(stored) + '. The erase must re-read the row and retry '
        + '(src/storage/rxdbRepository.ts eraseProjectDocument) because the projection of applied operations '
        + '(src/sync/operations/projection.ts) rewrites that row on every batch.');
    }
    expect(await a.rx.isDeletedProject(board.id), 'the erase left no half-deleted state behind').toBe(true);
    const goneOnB = await untilSettled(async () => !(await b.rx.listProjects()).some(project => project.id === board.id));
    expect(goneOnB, 'the second browser stops listing a board its owner erased mid-edit').toBe(true);
  });

  it('scenario 8: an erased board stays erased over another account round, and erasing it again is not an error', async () => {
    // A reconcile round is the resurrection risk: the board's Drive files can
    // outlive the erase, and discovery must respect the account marker rather
    // than the folder listing.
    await backgroundReconcile(a);
    await backgroundReconcile(b);
    expect((await a.rx.listProjects()).some(project => project.id === sharedBoard), 'the erased board must not come back on A').toBe(false);
    expect((await b.rx.listProjects()).some(project => project.id === sharedBoard), 'the erased board must not come back on B').toBe(false);
    await expect(a.rx.deleteProject(sharedBoard)).resolves.toBeUndefined();
    expect(await a.rx.isDeletedProject(sharedBoard), 'the deletion marker survives the round').toBe(true);
  });
});
