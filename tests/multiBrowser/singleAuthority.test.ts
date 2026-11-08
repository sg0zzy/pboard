/**
 * The single-source-authority invariant, measured directly.
 *
 * A Drive-exported board must auto-adopt the durable operation log when its
 * owner opens it, and no entry point — not the automatic paths, not the
 * explicit "create authority" panel call, not the Drive-ownership re-key —
 * may ever give a second device a *second* authority for the same board.
 * Every creation attempt routes through one decision point
 * (`adoptAuthority` in src/collab/boardGrants.ts); this suite exercises each
 * public entry and asserts the answer is refusal or idempotence, never an
 * addition. The relay room identity is derived from the authority key, and
 * only the authority device may mint a content key, so "one room, one seal"
 * is the observable measure of "one authority".
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

async function grantRound(browsers: BrowserHandle[], boardId: string) {
  for (const browser of browsers) await browser.runtime.boardCollaboration.identitySharing.sync(boardId, true);
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
    // The Drive export marker is present — the very record that used to gate
    // adoption. Adoption must now proceed *because of* export, not despite it.
    expect(cloud.drive.contentsUnder(board.id).some(row => row.name === 'project.json'),
      'the Drive export must have published its project.json marker').toBe(true);

    await openBoard(a, board.id);
    const aSynced = await untilQuiet(() => logStatusOf(a, board.id)?.phase === 'synced');
    expect(aSynced, 'the exporting owner must auto-adopt the durable log on open').toBe(true);

    // B boots blind: reconcile imports the board, opening it must be enough
    // — the identity round files the device request by itself.
    await backgroundReconcile(b);
    expect((await b.rx.listProjects()).some(project => project.id === board.id)).toBe(true);
    await openBoard(b, board.id);
    const filed = await untilQuiet(() => (cloud.signaling.directory.get(board.id)?.pending.length ?? 0) >= 1);
    expect(filed, 'opening an adopted board must file B’s device request through the identity round, without any manual sync').toBe(true);
    // Until admission, B still shares A’s single room and key — never its own.
    expect(authorityRooms(cloud, boardId), 'the board must hold exactly one relay room (one authority)').toHaveLength(1);

    await grantRound([a, b], boardId);
    await reattach(b);
    const bSynced = await untilQuiet(() => logStatusOf(b, board.id)?.phase === 'synced');
    expect(bSynced, 'the admitted same-account device must reach the same room').toBe(true);
    expect(roomFor(b, boardId)!.topic).toBe(roomFor(a, boardId)!.topic);
    expect(authorityRooms(cloud, boardId), 'one room after admission too').toHaveLength(1);
    // One content key, observably: both devices seal and open the same rows.
    const typed = await b.rx.addItem({ projectId: board.id, content: 'Sealed under the single key' });
    const crossed = await untilAsync(async () => (await a.rx.listCards(board.id)).some(card => card.id === typed.id));
    expect(crossed, 'edits sealed under the shared key must reach the other device').toBe(true);
    expect(a.holdsContentKey(board.id) && b.holdsContentKey(board.id)).toBe(true);
  });

  it('every entry point refuses a second authority for an adopted board — refusal and idempotence, never addition', async () => {
    const board = await a.rx.createProject('Guarded board', 'project');
    const guarded = board.id;
    await a.runtime.googleDrive.syncProject(guarded, { force: true });
    await openBoard(a, guarded);
    expect(await untilQuiet(() => logStatusOf(a, guarded)?.phase === 'synced')).toBe(true);
    const roomsBefore = authorityRooms(cloud, guarded);
    expect(roomsBefore).toHaveLength(1);

    // B never opens this board — it stays a stranger with a local copy,
    // which is exactly the split-brain candidate. Each creation entry point
    // is exercised against a board whose authority the service advertises.
    await backgroundReconcile(b);
    expect((await b.rx.listProjects()).some(project => project.id === guarded)).toBe(true);
    expect(await b.runtime.boardCollaboration.ownsAuthority(guarded)).toBe(false);

    // 1. The decision point itself: the automatic path every caller shares.
    const decision = await b.runtime.boardCollaboration.adoptAuthority(guarded);
    expect(decision.outcome, `the decision point must refuse, said: ${decision.reason}`).toBe('refuse');
    expect(decision.reason).toMatch(/advertises an existing authority|join/i);

    // 2. The panel’s explicit Create call.
    await expect(b.runtime.boardCollaboration.initialize(guarded)).rejects.toThrow(/advertises an existing authority|second authority|join/i);

    // 3. The explicit Drive-ownership re-key (strongest user-level proof a
    //    second device could bring): still refused while an authority lives.
    await expect(b.runtime.reestablishAuthorityFromDrive(guarded)).rejects.toThrow();

    // Repetition is idempotent, never additive.
    const again = await b.runtime.boardCollaboration.adoptAuthority(guarded);
    expect(again.outcome).toBe('refuse');
    expect(await b.runtime.boardCollaboration.ownsAuthority(guarded)).toBe(false);
    expect(await b.runtime.boardCollaboration.localBundle(guarded), 'a refused adoption leaves no bundle behind').toBeNull();
    expect(authorityRooms(cloud, guarded), 'no second room may appear beside the advertised authority').toEqual(roomsBefore);

    // The authority holder asking again is idempotent, not a second mint.
    const holder = await a.runtime.boardCollaboration.adoptAuthority(guarded);
    expect(holder.outcome).toBe('already-adopted');
    expect(await a.runtime.boardCollaboration.ownsAuthority(guarded)).toBe(true);

    // Admission is the only way in: afterwards B *shares* the one authority.
    await openBoard(b, guarded);
    expect(await untilQuiet(() => (cloud.signaling.directory.get(guarded)?.pending.length ?? 0) >= 1)).toBe(true);
    await grantRound([a, b], guarded);
    await reattach(b);
    expect(await untilQuiet(() => logStatusOf(b, guarded)?.phase === 'synced')).toBe(true);
    expect(authorityRooms(cloud, guarded), 'admission shares the authority, it does not add one').toEqual(roomsBefore);
    expect((await b.runtime.boardCollaboration.adoptAuthority(guarded)).outcome).toBe('already-adopted');

    // A stranger that holds neither copy nor grant cannot manufacture a
    // board to adopt either: the decision point requires a local board.
    const c = await createBrowser({ label: 'C', email: OWNER, cloud });
    try {
      const ghost = await c.runtime.boardCollaboration.adoptAuthority(guarded);
      expect(ghost.outcome).toBe('refuse');
      expect(ghost.reason).toMatch(/local board|local copy/i);
      await expect(c.runtime.boardCollaboration.initialize(guarded)).rejects.toThrow();
      expect(authorityRooms(cloud, guarded)).toEqual(roomsBefore);
    } finally { await c.close(); }
  });
});
