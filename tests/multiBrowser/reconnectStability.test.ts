/**
 * Reconnect stability under churn: when the relay tunnel keeps dying, the
 * browser must stop instead of looping (a loop spends the one request budget
 * every device shares), an automatic heal must not punch through that stop,
 * and only the owner's explicit heal may pass it once. Also pinned: a healthy
 * board stays silent — an idle MV3 worker restart, a forced reconcile, or an
 * epoch change may not generate relay traffic for boards that need nothing.
 *
 * These are the behaviors the November incident lacked: 256 identity
 * challenges in ten minutes from two browsers, all invisible because the
 * 429s were never logged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, logStatusOf, roomFor } from './fixtures/browser';
import type { BrowserHandle, Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';

async function openBoard(browser: BrowserHandle, boardId: string) {
  await browser.runtime.collaborationManager.start(boardId);
}
async function backgroundReconcile(browser: BrowserHandle) {
  await browser.runtime.googleDrive.reconcileAll({ force: true });
}
async function reattach(browser: BrowserHandle) {
  await browser.runtime.collaborationManager.setEnabled(false);
  await browser.runtime.collaborationManager.setEnabled(true);
}
async function grantRound(browsers: BrowserHandle[], boardId: string) {
  for (const browser of browsers) await browser.runtime.boardCollaboration.identitySharing.sync(boardId, true);
}
async function untilQuiet(predicate: () => boolean): Promise<boolean> {
  for (let turn = 0; turn < 12_000; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}
async function expectRelaySynced(browser: BrowserHandle, boardId: string) {
  const room = roomFor(browser, boardId);
  if (!await untilQuiet(() => logStatusOf(browser, boardId)?.phase === 'synced'))
    throw new Error(`browser ${browser.label} never synced board ${boardId}: ${JSON.stringify({ error: room?.error ?? null, log: room?.log ?? null })}`);
}
/** Absence assertion only: there is no event to await when the promise is
 * that nothing happens. The window is deliberately wider than the shortest
 * reconnect the client can schedule (base 1 s at ±25 % jitter). */
async function quiet(ms: number) { await new Promise<void>(resolve => setTimeout(resolve, ms)); }

describe('reconnect stability', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let boardId = '';

  /** Every live relay socket that holds a room of this board, whichever browser
   * dialled it. Read through the socket's attach map, not its primary room: the
   * account channel is attached to the same connection, so the primary is
   * whichever room authenticated first — not the board. */
  const boardSockets = () => cloud.signaling.socketsForBoard(boardId);

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    b = await createBrowser({ label: 'B', email: OWNER, cloud });
    const board = await a.rx.createProject('Reconnect stability board', 'project');
    boardId = board.id;
    await a.rx.addItem({ projectId: board.id, content: 'storm drill' });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await openBoard(a, board.id);
    await expectRelaySynced(a, board.id);
    await backgroundReconcile(b);
    await openBoard(b, board.id);
    await untilQuiet(() => (cloud.signaling.directory.get(board.id)?.pending.length ?? 0) >= 1);
    await grantRound([a, b], board.id);
    await reattach(b);
    await expectRelaySynced(b, board.id);
  // Real Drive and relay round trips in setup; vitest's 10 s hook default is a
  // fixture budget, not a behavioural claim, and exceeding it reports the whole
  // file as skipped behind a hook timeout instead of failing a test.
  }, 120_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('a healthy board heals to silence: no sockets, admissions, or grants move', async () => {
    const sockets = boardSockets().length;
    const admitted = cloud.signaling.admitted.length;
    expect(await a.runtime.healRelay(boardId)).toBe('idle:synced');
    expect(boardSockets().length).toBe(sockets);
    expect(cloud.signaling.admitted.length).toBe(admitted);
  });

  it('a connect-to-die storm meets the reconnect ceiling and stops on its own', async () => {
    // Twelve kill rounds are more than the ceiling needs: each reconnection
    // costs one attempt, six attempts inside the window is the ceiling, and
    // only a backoff-skip could add a seventh. If the loop is still alive
    // after twelve, something is reconnecting past the ceiling.
    const synced = (browser: BrowserHandle) => logStatusOf(browser, boardId)?.phase === 'synced';
    const throttled = (browser: BrowserHandle) => roomFor(browser, boardId)?.log?.throttled ?? false;
    for (let round = 0; round < 12 && !(throttled(a) && throttled(b)); round++) {
      for (const socket of boardSockets()) socket.close();
      // Reconnect, converge, kill again: the cadence the proxy-aging tab
      // produces, without racing the bootstrap the ceiling does not care
      // about (it counts attempts, not outcomes). Convergence is per browser
      // so a throttled one never makes the other's wait spin.
      await untilQuiet(() => throttled(a) || synced(a));
      await untilQuiet(() => throttled(b) || synced(b));
    }
    expect(roomFor(a, boardId)?.log?.throttled, 'browser A never stopped reconnecting').toBe(true);
    expect(roomFor(b, boardId)?.log?.throttled, 'browser B never stopped reconnecting').toBe(true);
    expect(roomFor(a, boardId)?.log?.error).toBe('reconnect:throttled');
    const frozen = boardSockets().length;
    await quiet(2_500); // several base delays: nobody retries behind the ceiling
    expect(boardSockets().length).toBe(frozen);

  });

  it('an automatic heal reports the ceiling instead of punching through it', async () => {
    const outcome = await b.runtime.healRelay(boardId);
    expect(outcome).toContain('reconnect:throttled');
    expect(roomFor(b, boardId)?.log?.throttled).toBe(true);
    const frozen = boardSockets().length;
    await quiet(1_500);
    expect(boardSockets().length).toBe(frozen);
  });

  it('the owner action passes the ceiling once and leaves exactly one healthy socket', async () => {
    const healed = await a.runtime.healRelay(boardId, { force: true });
    expect(healed, `force heal did not repair: ${healed}`).toContain('reconnected');
    expect(await untilQuiet(() => logStatusOf(a, boardId)?.phase === 'synced'), 'force-healed browser A did not resync').toBe(true);
    expect(roomFor(a, boardId)?.log?.throttled).toBe(false);
    // One socket for A's open board — the bypass must not fan out — and B is
    // still stopped, because A's gesture speaks only for A.
    await quiet(2_500);
    expect(boardSockets().length).toBe(1);
    expect(roomFor(b, boardId)?.log?.throttled).toBe(true);
    expect(await a.runtime.healRelay(boardId, { force: true })).toContain('idle:synced');
    expect(boardSockets().length).toBe(1); // idempotent when pressed twice
  });

  it('the second browser recovers the same way and ends converged', async () => {
    expect(await b.runtime.healRelay(boardId, { force: true })).toContain('reconnected');
    expect(await untilQuiet(() => logStatusOf(b, boardId)?.phase === 'synced')).toBe(true);
    await quiet(1_000);
    expect(boardSockets().length).toBe(2); // exactly one per open board
    const card = (await b.rx.db.cards.find({ selector: { projectId: boardId } }).exec()).at(0);
    expect(card?.content).toBe('storm drill');
  });
});
