/**
 * The single-authority invariant on the Drive-authorized path, measured
 * directly at the relay.
 *
 * There is no device-local authority to duplicate here: the relay derives a
 * room's identity from `(boardId, folderId)` and admits an attach only after
 * verifying the account's Google identity and the folder capability
 * (`src/sync/operations/googleDriveAdmission.ts`, `admission.rs`). Two devices
 * that resolve the same Drive folder therefore *land in the same room* — the
 * invariant is structural, not a decision some code path must make.
 *
 * That is exactly the property the retired signed-manifest path needed a
 * decision point (`adoptAuthority` in `src/collab/boardGrants.ts`) to protect,
 * because a device could mint its own root key. What still needs proving on
 * this path:
 *  - the exporting owner adopts the log on open,
 *  - a second browser of the same account joins that one room with no manual
 *    step, and the two converge on the same content,
 *  - no second room can appear for the board, including from a stranger that
 *    holds no ACL access at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, logStatusOf, roomFor } from './fixtures/browser';
import type { BrowserHandle, Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';

async function backgroundReconcile(browser: BrowserHandle) {
  await browser.runtime.googleDrive.reconcileAll({ force: true });
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

async function untilAsync(predicate: () => Promise<boolean>): Promise<boolean> {
  for (let turn = 0; turn < 4000; turn++) {
    if (await predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return await predicate();
}

/** The service's rooms carrying this board: one room means one authority. */
function authorityRooms(cloud: Cloud, boardId: string): string[] {
  return [...new Set([...cloud.signaling.rooms.values()].filter(room => room.board === boardId).map(room => room.room))];
}

describe('one board, one authority', { timeout: 120_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let boardId = '';

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    b = await createBrowser({ label: 'B', email: OWNER, cloud });
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('a Drive-exported board auto-adopts the log, and B joins it without any manual authority step', async () => {
    const board = await a.rx.createProject('Exported then adopted', 'project');
    boardId = board.id;
    await a.rx.addItem({ projectId: board.id, content: 'Written before the relay existed' });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    // The Drive export marker is present — on this path it is the record that
    // makes the board discoverable by the other browser, and it never gated
    // trust: Drive authorization is the ACL, read per attach.
    expect(cloud.drive.contentsUnder(board.id).some(row => row.name === 'project.json'),
      'the Drive export must have published its project.json marker').toBe(true);

    await openBoard(a, board.id);
    const aSynced = await untilQuiet(() => logStatusOf(a, board.id)?.phase === 'synced');
    expect(aSynced, 'the exporting owner must adopt the durable log on open').toBe(true);

    // B boots blind: reconcile imports the board, opening it must be enough.
    await backgroundReconcile(b);
    expect((await b.rx.listProjects()).some(project => project.id === board.id)).toBe(true);
    await openBoard(b, board.id);
    const bSynced = await untilQuiet(() => logStatusOf(b, board.id)?.phase === 'synced');
    expect(bSynced, 'opening an adopted board must reach the same room with no manual step').toBe(true);
    expect(roomFor(b, boardId)!.topic).toBe(roomFor(a, boardId)!.topic);
    expect(authorityRooms(cloud, boardId), 'the board must hold exactly one relay room').toHaveLength(1);

    // One room, one plane: both devices seal and open the same rows.
    const typed = await b.rx.addItem({ projectId: board.id, content: 'Sealed in the single room' });
    const crossed = await untilAsync(async () => (await a.rx.listCards(board.id)).some(card => card.id === typed.id));
    expect(crossed, 'edits in the shared room must reach the other device').toBe(true);
    // The Drive path is a plaintext plane: there is no per-board content key to
    // hold at all, which is why a key never has to be couriered here.
    expect(a.holdsContentKey(board.id) || b.holdsContentKey(board.id),
      'the Drive-authorized room needs no content key').toBe(false);
    // And no identity-directory policy was ever published.
    expect(cloud.signaling.directory.size, 'no identity-directory policy exists on the Drive path').toBe(0);
  });

  it('no second room can appear for an adopted board — refusal is structural, not a decision', async () => {
    const board = await a.rx.createProject('Guarded board', 'project');
    const guarded = board.id;
    await a.runtime.googleDrive.syncProject(guarded, { force: true });
    await openBoard(a, guarded);
    expect(await untilQuiet(() => logStatusOf(a, guarded)?.phase === 'synced')).toBe(true);
    const roomsBefore = authorityRooms(cloud, guarded);
    expect(roomsBefore).toHaveLength(1);

    // B reconciles the board but never opens it: a stranger with a local copy.
    await backgroundReconcile(b);
    expect((await b.rx.listProjects()).some(project => project.id === guarded)).toBe(true);

    // A stranger account with no ACL access cannot attach a room for it at all:
    // `/drive/admit` answers 403 because the folder is not visible to it, so no
    // room exists — a second authority is unreachable by construction, not by
    // refusal inside a decision function.
    const strangerToken = cloud.drive.addAccount('stranger@example.com');
    cloud.accounts.set(strangerToken, 'stranger@example.com');
    const denied = await cloud.fetch('https://relay.invalid/drive/admit', {
      method: 'POST',
      body: JSON.stringify({ idToken: `id:${strangerToken}`, accessToken: strangerToken,
        boardId: guarded, folderId: cloud.drive.mustFind(guarded).id, challenge: 'c'.repeat(43), session: 's'.repeat(43) })
    });
    expect(denied.status, 'an account without the folder cannot be admitted to its room').toBe(403);
    expect(authorityRooms(cloud, guarded), 'no second room may appear beside the advertised authority').toEqual(roomsBefore);

    // Repetition by the holder is idempotent: re-opening costs no second room
    // and no new room identity.
    await reattach(b);
    await openBoard(b, guarded);
    expect(await untilQuiet(() => logStatusOf(b, guarded)?.phase === 'synced')).toBe(true);
    expect(authorityRooms(cloud, guarded), 'a same-account device shares the room, it does not add one').toEqual(roomsBefore);
  });
});
