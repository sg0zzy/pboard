/**
 * Two (plus a viewer) browser contexts, two Google accounts: A owns the board
 * in Drive, B is an invited editor, C is an invited viewer.
 *
 * The authority on this path is the **Drive folder ACL**, proven per attach
 * through `/drive/admit` (`src/sync/operations/googleDriveAdmission.ts`): the
 * relay verifies the account's Google identity and the folder capability, then
 * derives the room from `(boardId, folderId)`. There is no identity directory,
 * no signed device grant and no content key — the room is a plaintext
 * Drive-authorized plane (`createPlaintextOperationCodec`), so what separates
 * an editor from a viewer is the ACL role the relay was told and enforces in
 * `sync_api.rs`, plus the local `assertCanMutate` gate.
 *
 * What the scenarios pin:
 *  - all three accounts of one board land in exactly one relay room,
 *  - the log attributes B's writes to B's authenticated device id, and A sees
 *    them,
 *  - a viewer reads the board through its ACL and is refused every write,
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
    + 'Every room here is admitted through `/drive/admit`: the relay verifies the account identity and the folder capability, then derives '
    + 'the room from `(boardId, folderId)`. Three accounts landing in one room is the expected answer — one Drive folder, one room — and '
    + 'the role each attach presents is the ACL role the relay enforces per frame.');
}

async function expectRelaySynced(browser: BrowserHandle, boardId: string, expectation: string) {
  if (!await untilQuiet(() => logStatusOf(browser, boardId)?.phase === 'synced')) throw relayNeverSynced(browser, boardId, expectation);
}

/** Model the share the owner performs from the UI on this path: one Drive ACL
 * grant. Nothing else is required — no directory policy, no device approval. */
function shareBoard(cloud: Cloud, boardId: string, grantee: BrowserHandle, driveRole: string) {
  cloud.drive.grant(boardId, grantee.email, driveRole);
}

describe('owner and editor (plus viewer), two Google accounts', { timeout: 120_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let c: BrowserHandle;
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

  it('scenario 1: the editor attaches through Drive admission, one authority exists, and the viewer reads but never writes', async () => {
    const board = await a.rx.createProject('Shared with editor', 'project');
    await a.rx.addItem({ projectId: board.id, content: 'Owned content' });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await openBoard(a, board.id);
    await expectRelaySynced(a, board.id, 'the owner must run the board on the log');

    // A Drive-only viewer (no ACL share yet): sees nothing, and every write
    // attempt is refused without touching the board.
    await backgroundReconcile(c);
    expect(await c.rx.getProject(board.id), 'an unshared viewer must not see the board').toBeNull();

    shareBoard(cloud, board.id, c, 'reader');
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

    // The editor joins one relay room with the owner: one Drive folder, one room.
    shareBoard(cloud, board.id, b, 'writer');
    await backgroundReconcile(b);
    await openBoard(b, board.id);
    await expectRelaySynced(b, board.id, 'the ACL editor must reach the log through Drive admission');
    const roomsForBoard = [...cloud.signaling.rooms.values()].filter(room => room.board === board.id);
    expect(roomsForBoard.length, 'one Drive folder means one relay room').toBe(1);
    expect(roomFor(b, board.id)!.topic).toBe(roomFor(a, board.id)!.topic);

    // The relay never consulted the retired identity directory.
    expect(cloud.signaling.directory.size, 'no identity-directory policy exists on the Drive path').toBe(0);

    // The viewer never joins the board's room: the ACL gives it read access to
    // the folder, not a writable log seat, and the repository gate refuses its
    // writes before any broadcast. Its own account room is not this board's.
    const roomsOfViewer = cloud.signaling.admitted
      .filter(entry => entry.email === VIEWER)
      .map(entry => cloud.signaling.rooms.get(entry.room)?.board)
      .filter((boardId): boardId is string => boardId !== undefined && !boardId.startsWith('account:'));
    expect(roomsOfViewer, 'a viewer account must never be admitted to a board log room').toEqual([]);
  });

  it('scenario 2: the editor sees a new board the owner creates, created and empty, without a manual refresh', async () => {
    const board = await a.rx.createProject('Second shared board', 'project');
    liveBoard = board.id;
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    shareBoard(cloud, board.id, b, 'writer');

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
    await openBoard(b, liveBoard);
    await reattach(a);
    await reattach(b);
    await expectRelaySynced(a, liveBoard, 'the owner must be live before the editor writes');
    await expectRelaySynced(b, liveBoard, 'the editor must be live to write');

    const contents: string[][] = [];
    const stop = a.rx.subscribeCards(liveBoard, cards => contents.push(cards.map(card => card.content)));
    try {
      await b.rx.addItem({ projectId: liveBoard, content: 'Authored by the editor' });
      const landed = await untilQuiet(() => contents.some(list => list.includes('Authored by the editor')));
      if (!landed) {
        throw new Error(`PRODUCT GAP — the editor's card never reached the owner intact. Room A: ${JSON.stringify(roomFor(a, liveBoard)?.log ?? null)}; room B: ${JSON.stringify(roomFor(b, liveBoard)?.log ?? null)}. `
          + 'Both devices share one plaintext Drive-authorized room (createPlaintextOperationCodec), so a missing delivery is a transport '
          + 'or projection fault, never a key hand-off.');
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

    // Role refusal: history gardening is owner-only; the editor must be refused,
    // not silently allowed.
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
