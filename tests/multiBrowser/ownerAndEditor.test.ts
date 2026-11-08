/**
 * Two (plus a viewer) browser contexts, two Google accounts: A owns the board
 * in Drive, B is an invited editor (Drive ACL + identity-directory grant), C
 * is an invited viewer. Same five scenarios as the same-account suite, with
 * the role differences the collaboration contract promises asserted
 * explicitly:
 *  - the editor receives its grant through admission and never becomes an
 *    authority; exactly one board authority (one relay room) may exist,
 *  - the log attributes B's writes to B's authenticated device id, and A sees
 *    them,
 *  - a viewer device never ends up holding a board content key,
 *  - one owner-only operation from B is refused, not silently applied,
 *  - the durable snapshot stays inside the ACLs (editor reads it, viewer does
 *    not even see the folder).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, logStatusOf, roomFor } from './fixtures/browser';
import type { BrowserHandle, Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';
const EDITOR = 'editor@example.com';
const VIEWER = 'viewer@example.com';

async function backgroundReconcile(browser: BrowserHandle) {
  // A viewer-role board raises the read-only posture error inside the round;
  // the round still delivers everything else, exactly as in the product.
  await browser.runtime.googleDrive.reconcileAll({ force: true }).catch(() => undefined);
}

async function openBoard(browser: BrowserHandle, boardId: string) {
  await browser.runtime.collaborationManager.start(boardId);
}

async function reattach(browser: BrowserHandle) {
  await browser.runtime.collaborationManager.setEnabled(false);
  await browser.runtime.collaborationManager.setEnabled(true);
}

async function grantRound(browsers: BrowserHandle[], boardId: string) {
  for (const browser of browsers) await browser.runtime.boardCollaboration.identitySharing.sync(boardId, true);
}

/** Run the grantee's identity-directory round directly. Returns the error text
 * (the product path swallows it inside the authority auto-bootstrap), or null
 * when the round completes. */
async function identitySyncIssue(browser: BrowserHandle, boardId: string): Promise<string | null> {
  try {
    await browser.runtime.boardCollaboration.identitySharing.sync(boardId, true);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function gapMessage(browser: BrowserHandle, boardId: string, issue: string | null): string {
  return `PRODUCT GAP — browser ${browser.label} (${browser.email}) never filed a device request for board ${boardId}. `
    + (issue === null
      ? 'The identity-directory round completed with nothing the flow can use: no policy advertised for the board and no device request filed, though syncWork() must do one of the two on every owned/listed board.'
      : `The identity-directory round itself failed: "${issue}". `)
    + 'Mechanism: every authority decision runs through the single decision point `adoptAuthority` (src/collab/boardGrants.ts). For an '
    + 'exported board it must ADOPT the advertised authority — the project.json export marker is a durability record the product writes '
    + 'itself, never rival trust — and googleIdentitySharing.syncWork() must then file the grantee device request. If this message '
    + 'appears, either the decision point wrongly refuses adoption (a pin, a live advertisement it should join, or a signed data block), '
    + 'or the auto-bootstrap swallowed the round — exactly the path an invited editor depends on.';
}

async function untilQuiet(predicate: () => boolean): Promise<boolean> {
  for (let turn = 0; turn < 4000; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

async function untilText(probe: () => string | null): Promise<string | null> {
  for (let turn = 0; turn < 4000; turn++) {
    const value = probe();
    if (value !== null) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return probe();
}

function relayNeverSynced(browser: BrowserHandle, boardId: string, expectation: string): Error {
  const room = roomFor(browser, boardId);
  return new Error(`PRODUCT GAP — browser ${browser.label} (${browser.email}) never synchronized board ${boardId} over the durable operation log (${expectation}). `
    + `Room record: ${JSON.stringify({ error: room?.error ?? null, log: room?.log ?? null, starts: room?.starts ?? 0 })}. `
    + 'For an editor, admission needs: the directory policy listing its email (owner invite), the owner approving its device request into the manifest, '
    + 'and src/sync/runtime.ts actually selecting the relay in operation-sync mode (its `signalingSettings` cache is only assigned in '
    + 'legacyCollaborationManager.myRole, which never runs while the operation protocol owns the board).');
}

async function expectRelaySynced(browser: BrowserHandle, boardId: string, expectation: string) {
  if (!await untilQuiet(() => logStatusOf(browser, boardId)?.phase === 'synced')) throw relayNeverSynced(browser, boardId, expectation);
}

/** Model the share the owner performs from the UI: Drive ACL + identity invite. */
async function shareBoard(cloud: Cloud, owner: BrowserHandle, boardId: string, grantee: BrowserHandle, driveRole: string, policyRole: 'editor' | 'viewer') {
  cloud.drive.grant(boardId, grantee.email, driveRole);
  try {
    await owner.runtime.boardCollaboration.identitySharing.invite(boardId, grantee.email, policyRole);
  } catch (error) {
    // An invite needs the owner's advertised directory policy. When the round
    // that should have advertised it failed (or silently did nothing), report
    // THAT, with the product error as the cause.
    const issue = await identitySyncIssue(owner, boardId);
    const advertised = Boolean(cloud.signaling.directory.get(boardId));
    throw new Error(gapMessage(owner, boardId, issue ?? (advertised
      ? 'the policy exists only because THIS test just force-ran identitySharing.sync; nothing in the automatic flow advertised it before the invite'
      : 'no policy entry exists even after a forced identity round; the invite cannot exist at all')), { cause: error });
  }
}

/** Drive through the first-attach admission dance for a new grantee. */
async function admitBrowser(cloud: Cloud, a: BrowserHandle, browser: BrowserHandle, boardId: string) {
  // The owner must have advertised the policy the grantee is listed in before
  // anything the grantee does can succeed; prove it separately from its failure.
  const ownerIssue = await identitySyncIssue(a, boardId);
  if (ownerIssue !== null || !cloud.signaling.directory.get(boardId)) {
    throw new Error(gapMessage(a, boardId, ownerIssue ?? 'the owner\'s round completed without advertising a policy entry; the grantee has nothing to be admitted against'));
  }
  await backgroundReconcile(browser);
  await openBoard(browser, boardId);
  const issue = await identitySyncIssue(browser, boardId);
  const requested = await untilQuiet(() => (cloud.signaling.directory.get(boardId)?.pending.length ?? 0) >= 1);
  if (!requested) throw new Error(gapMessage(browser, boardId, issue));
  await grantRound([a, browser], boardId);
  await reattach(browser);
}

describe('owner and editor (plus viewer), two Google accounts', { timeout: 120_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let c: BrowserHandle;
  let sharedBoard = '';
  let liveBoard = '';

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    b = await createBrowser({ label: 'B', email: EDITOR, cloud });
    c = await createBrowser({ label: 'C', email: VIEWER, cloud });
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await c?.close();
  });

  it('scenario 1: the editor attaches through admission, one authority exists, and the viewer never holds a content key', async () => {
    const board = await a.rx.createProject('Shared with editor', 'project');
    sharedBoard = board.id;
    await a.rx.addItem({ projectId: board.id, content: 'Owned content' });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await openBoard(a, board.id);
    await expectRelaySynced(a, board.id, 'the owner must run the board on the log');

    // A Drive-only viewer (no identity grant yet): reads through its ACL, and
    // every write attempt is refused without touching the board — the role-gate
    // evidence requested for the repository refactor.
    cloud.drive.grant(board.id, c.email, 'reader');
    await backgroundReconcile(c);
    const seenCards = await c.rx.listCards(board.id);
    expect(seenCards.map(card => card.content), 'the viewer reads the board through its Drive ACL').toEqual(['Owned content']);
    const viewerAttempts = await Promise.all([
      c.rx.addItem({ projectId: board.id, content: 'Viewer write attempt' }).then(() => null, (error: unknown) => String(error)),
      c.rx.updateItem(seenCards[0].id, { content: 'Viewer overwrite' }).then(() => null, (error: unknown) => String(error)),
      c.rx.deleteItem(seenCards[0].id).then(() => null, (error: unknown) => String(error)),
    ]);
    for (const [index, refusal] of viewerAttempts.entries()) {
      expect(refusal, `viewer write attempt ${index} (add/update/delete) was NOT refused by the role gate`)
        .toMatch(/view-only|editing access|read-only|viewer/i);
    }
    expect((await a.rx.listCards(board.id)).map(card => card.content), 'the viewer\'s refused attempts must not touch the board')
      .toEqual(['Owned content']);
    expect(c.holdsContentKey(board.id), 'a viewer device must never hold the board content key').toBe(false);

    await shareBoard(cloud, a, board.id, b, 'writer', 'editor');
    await shareBoard(cloud, a, board.id, c, 'reader', 'viewer');

    await admitBrowser(cloud, a, b, board.id);
    await expectRelaySynced(b, board.id, 'the invited editor must reach the log through its admitted device grant');

    // Authority is a property of exactly one browser: the editor gets a
    // device grant, never the board authority, and no second authority (a
    // second relay room) may appear for the board.
    expect(await a.runtime.boardCollaboration.ownsAuthority(board.id), 'the owner holds the authority').toBe(true);
    expect(await b.runtime.boardCollaboration.ownsAuthority(board.id), 'the editor must not hold the authority').toBe(false);
    const roomsForBoard = [...cloud.signaling.rooms.values()].filter(room => room.board === board.id);
    expect(roomsForBoard.length, 'one board authority means one relay room; a second room names a second authority')
      .toBe(1);
    const editorGrant = (await b.runtime.boardCollaboration.security(board.id))!;
    const editorDevice = editorGrant.signer.deviceKeyId;
    expect(editorGrant.manifest.devices.find(device => device.deviceKeyId === editorDevice)?.role).toBe('editor');

    // The viewer device never reaches *this board's* room: no admitted log
    // connection under its account for this board, no content key in its store.
    //
    // Resolved through the relay's own room table rather than by matching the
    // account, because the account room is now one more room on the same socket
    // (`logSession.ts`): a viewer of this board is legitimately enrolled in its
    // own `account:<hash>` room — that admission is the account authority's
    // decision, not the board ACL's — and an account-wide match would report that
    // as a board admission. The question this scenario is about is the board.
    const roomsOfViewer = cloud.signaling.admitted
      .filter(entry => entry.email === VIEWER)
      .map(entry => cloud.signaling.rooms.get(entry.room)?.board)
      .filter((boardId): boardId is string => boardId !== undefined && !boardId.startsWith('account:'));
    expect(roomsOfViewer, 'a viewer account must never be admitted to a board log room').toEqual([]);
    expect(c.rooms().filter(room => room.topic.includes(board.id) && room.log), 'no log room for the viewer\'s board')
      .toEqual([]);
    expect(c.holdsContentKey(board.id), 'a viewer device must never hold the board content key').toBe(false);
  });

  it('scenario 2: the editor sees a new board the owner creates, created and empty, without a manual refresh', async () => {
    const board = await a.rx.createProject('Second shared board', 'project');
    liveBoard = board.id;
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    cloud.drive.grant(board.id, b.email, 'writer');

    const lists: string[][] = [];
    const stop = b.rx.subscribeProjects(projects => lists.push(projects.map(project => project.id)));
    try {
      await backgroundReconcile(b);
      const seen = await untilQuiet(() => lists.some(ids => ids.includes(board.id)));
      if (!seen) throw new Error(`PRODUCT GAP — board ${board.id} never reached browser B's reactive list after a background reconcile; `
        + 'account-level board advertisement (reconcileOperations via boardStore.listBoards) must cover ACL-shared folders for the editor account.');
      expect(await b.rx.listCards(board.id), 'the board must arrive as the owner left it — empty').toEqual([]);
    } finally { stop(); }
    // The viewer was not granted this board and must not see it at all.
    expect(cloud.drive.visibleTo(board.id, VIEWER), 'an uninvited viewer must not see the board folder').toBe(false);
  });

  it('scenario 3: a card typed by the editor appears on the owner with its content intact and attributed to the editor device', async () => {
    await openBoard(a, liveBoard);
    await backgroundReconcile(a); // the owner's round publishes the directory policy the invite edits
    await shareBoard(cloud, a, liveBoard, b, 'writer', 'editor');
    await admitBrowser(cloud, a, b, liveBoard);
    await expectRelaySynced(a, liveBoard, 'the owner must be live before the editor writes');
    await expectRelaySynced(b, liveBoard, 'the editor must be live to write');

    const contents: string[][] = [];
    const stop = a.rx.subscribeCards(liveBoard, cards => contents.push(cards.map(card => card.content)));
    try {
      await b.rx.addItem({ projectId: liveBoard, content: 'Authored by the editor' });
      const landed = await untilQuiet(() => contents.some(list => list.includes('Authored by the editor')));
      if (!landed) {
        throw new Error(`PRODUCT GAP — the editor's card never reached the owner intact. Room A: ${JSON.stringify(roomFor(a, liveBoard)?.log ?? null)}; room B: ${JSON.stringify(roomFor(b, liveBoard)?.log ?? null)}. `
          + 'If both devices sealed with different content keys, the missing mechanism is the courier hand-off: runKeyCourier '
          + '(src/sync/operations/keyCourierTransport.ts) lets a writer generate a fresh key when no grant exists for its wrap key yet, '
          + 'and nothing re-wraps the board key when a peer publishes its wrap key after the writer last attached.');
      }
    } finally { stop(); }
    // The log attributed the write to the editor's authenticated device — the
    // payload never names its own author to the service.
    const room = [...cloud.signaling.rooms.values()].find(entry => entry.board === liveBoard)!;
    const editorDevice = cloud.signaling.admitted.find(entry => entry.email === EDITOR && entry.room === room.room)!.deviceKeyId;
    expect(room.submissions.some(entry => entry.deviceKeyId === editorDevice), 'the editor authored log entries under its own device id').toBe(true);
    expect(room.rows.every(row => row.actorId === editorDevice || row.actorId === cloud.signaling.admitted.find(entry => entry.email === OWNER && entry.room === room.room)!.deviceKeyId)).toBe(true);
  });

  it('scenario 4: the owner adds a second card, both converge on exactly two cards, and an owner-only operation from the editor is refused', async () => {
    const seenBy = new Map<string, string[][]>([['A', []], ['B', []]]);
    const stops = [
      a.rx.subscribeCards(liveBoard, cards => seenBy.get('A')!.push(cards.map(card => card.content))),
      b.rx.subscribeCards(liveBoard, cards => seenBy.get('B')!.push(cards.map(card => card.content))),
    ];
    try {
      await a.rx.addItem({ projectId: liveBoard, content: 'Owner follow-up' });
      const settled = await untilQuiet(
        () => seenBy.get('A')!.some(list => list.includes('Owner follow-up') && list.includes('Authored by the editor'))
          && seenBy.get('B')!.some(list => list.includes('Owner follow-up') && list.includes('Authored by the editor')));
      if (!settled) throw new Error('PRODUCT GAP — the two accounts never converged on the two cards; see scenario 3 for the transport diagnosis.');
      const cardsA = await a.rx.listCards(liveBoard);
      const cardsB = await b.rx.listCards(liveBoard);
      expect(cardsA.map(card => card.id).sort()).toEqual([...new Set(cardsA.map(card => card.id))].sort());
      expect(cardsB.map(card => card.content).sort()).toEqual(['Authored by the editor', 'Owner follow-up']);
    } finally { for (const stop of stops) stop(); }

    // Role refusal: history gardening is owner-only in the operation service;
    // the editor must be refused, not silently allowed.
    await expect(b.runtime.operationService.previewGardening(liveBoard)).rejects.toThrow(/owner/i);
  });

  it('scenario 5: switching the owner away flushes a durable snapshot with every card; the editor reads it, the viewer does not see the folder', async () => {
    const other = await a.rx.createProject('Owner switch target', 'project');
    await a.runtime.googleDrive.syncProject(other.id, { force: true });
    await a.runtime.collaborationManager.start(other.id);

    const snapshotText = await untilText(() => cloud.drive.contentsUnder(liveBoard).find(entry => entry.name.startsWith('snapshot-'))?.text ?? null);
    if (snapshotText === null) throw new Error(`PRODUCT GAP — no snapshot for ${liveBoard} was flushed to Drive on room close; `
      + 'runLogConsolidation (src/sync/logConsolidationRuntime.ts) must publish the owner snapshot when the owner leaves the board.');
    const snapshot = JSON.parse(snapshotText) as { checkpoint: { entities: { collection: string; deleted: boolean; fields: Record<string, { value?: unknown }> }[] } };
    const cardContents = snapshot.checkpoint.entities
      .filter(entity => entity.collection === 'cards' && !entity.deleted)
      .map(entity => entity.fields.content?.value);
    expect(cardContents).toContain('Authored by the editor');
    expect(cardContents).toContain('Owner follow-up');
    const snapshotName = cloud.drive.contentsUnder(liveBoard).find(entry => entry.name.startsWith('snapshot-'))!.name;
    expect(cloud.drive.visibleTo(snapshotName, OWNER), 'the owner account reads the durable file').toBe(true);
    expect(cloud.drive.visibleTo(snapshotName, EDITOR), 'the editor account reads the same durable file through its ACL').toBe(true);
    expect(cloud.drive.visibleTo(snapshotName, VIEWER), 'the uninvited viewer account must not see it').toBe(false);
  });
});
