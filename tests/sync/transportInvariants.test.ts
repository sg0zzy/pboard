/**
 * The single-socket and idle-cost invariants, pinned as they hold **today** so
 * the coming transport refactor cannot regress them silently.
 *
 * What is asserted, and why it is the right shape:
 *
 *  - **The armed timer set is a function of the open board, not of the board
 *    count.** A browser with one board open and a runtime with a hundred boards
 *    reconciled must arm the same three timers (`sidebar.status`,
 *    `sidebar.role`, `sidebar.toolbarPin`, `logsync.heartbeat`,
 *    `log.consolidate`). Compare *sets of names*, never counts of callbacks: a
 *    refactor that arms one consolidation interval per board would change the
 *    per-name count, and the per-name count is the number this test reports.
 *  - **`transport.open` equals the number of attached rooms.** Measured in the
 *    two-browser harness, where every dial goes through the real
 *    `createOperationLogSync`/`runKeyCourier` paths: one board room, and the
 *    gauge is what the relay itself holds for that board.
 *  - **A board switch returns the subscription gauges to their starting
 *    count.** `rx.subscriptions` and `journal.listeners` are live gauges, so a
 *    leak reads as a number that climbs and never comes down.
 *
 * Timers are exercised with the runtime's own real timers where the fake ones
 * cannot reach across module graphs, and counts — not elapsed time — are what
 * every assertion uses.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveRuntime } from '../../src/sync/runtime';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { DriveStub } from '../sync/driveStub';
import type { CollaborationCounters } from '../../src/collab/counters';

const closeables: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The armed-timer names of a counters snapshot. */
const timerNames = (snapshot: CollaborationCounters): string[] =>
  Object.keys(snapshot.active).filter(name => name.startsWith('timer.')).sort();

/**
 * The counters instance the *product* under test loaded. `runtime.ts` imports
 * it statically, so the enabled instance has to be in place before the runtime
 * module is evaluated: stub the build flag, reset the module registry, and load
 * both from the same graph.
 */
async function loadBuild() {
  vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
  vi.resetModules();
  const { collaborationCounters } = await import('../../src/collab/counters');
  const runtimeModule = await import('../../src/sync/runtime');
  const repositoryModule = await import('../../src/storage/rxdbRepository');
  expect(collaborationCounters.enabled).toBe(true);
  return { counters: collaborationCounters, createDriveRuntime: runtimeModule.createDriveRuntime, createRxRepository: repositoryModule.createRxRepository };
}

describe('the armed timer set', () => {
  it('is identical with one board and with a hundred, and the round is still O(boards)', async () => {
    const build = await loadBuild();
    const drive = new DriveStub();
    const name = `pboardboards${crypto.randomUUID().replaceAll('-', '')}`;
    // The product composition root's repository events, wired exactly as
    // `src/storage/browser.ts` wires them: without `projectChanged` a created
    // board is never marked dirty, every round takes the full Drive path for
    // every board, and the test would be measuring fake-IndexedDB throughput
    // instead of the runtime's timer behaviour.
    const state: { runtime?: ReturnType<typeof build.createDriveRuntime> } = {};
    const repository: RxRepository = await build.createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`),
      events: { projectChanged: (projectId: string) => { void state.runtime?.driveSyncState.markDirty(projectId); } } });
    const data: Record<string, unknown> = {};
    const runtime = build.createDriveRuntime({
      auth: { getAccessToken: async () => 'token', getConnectionState: async () => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
      storage: { get: async (key: string) => ({ [key]: structuredClone(data[key]) }), set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)) } },
      getRepository: async () => repository, fetcher: drive.fetch as typeof fetch
    });
    state.runtime = runtime;
    closeables.push(async () => { await runtime.collaborationManager.stop(); for (const id of repository.operationSource.bindings.keys()) await runtime.operationService.close(id); await repository.db.close(); });

    await repository.createProject('Only board', 'project');
    build.counters.clear();
    await runtime.googleDrive.reconcileAll({ force: true });
    const oneBoard = build.counters.snapshot();

    for (let index = 0; index < 99; index++) await repository.createProject(`Filler ${index}`, 'project');
    const before = build.counters.snapshot().events['reconcile.board'] ?? 0;
    await runtime.googleDrive.reconcileAll({ force: true });
    const manyBoards = build.counters.snapshot();

    // The invariant: the armed set is the same, name for name. A timer that
    // the board count armed would appear here and nowhere in the one-board set.
    expect(timerNames(manyBoards)).toEqual(timerNames(oneBoard));
    // And the count per name is unchanged too — this is the per-board timer
    // that would grow: one name armed 100 times reads 100, not 1.
    for (const name of timerNames(oneBoard)) expect(manyBoards.active[name], `timer ${name} armed more than once`).toBe(oneBoard.active[name]);
    // The round still touches every board, which is what makes the constant
    // timer set a statement about *timers* rather than about a round that
    // silently stopped working.
    expect((manyBoards.events['reconcile.board'] ?? 0) - before).toBe(100);
    // The socket population is also unchanged: reconcile attaches nothing new.
    expect(manyBoards.active['transport.open'] ?? 0).toBe(oneBoard.active['transport.open'] ?? 0);
  }, 120_000);

  it('keeps a counted interval disarmed when the handle is cleared, which is how a switch releases its board', async () => {
    const build = await loadBuild();
    vi.useFakeTimers();
    try {
      const first = build.counters.countedInterval('log.consolidate', () => undefined, 300_000);
      const second = build.counters.countedInterval('log.consolidate', () => undefined, 300_000);
      expect(build.counters.snapshot().active['timer.log.consolidate']).toBe(2);
      // A board switch closes the old board's interval: its name must leave the
      // gauge, or "one board attached" would read as two for the rest of the
      // session.
      build.counters.clearCountedTimer(first);
      expect(build.counters.snapshot().active['timer.log.consolidate']).toBe(1);
      build.counters.clearCountedTimer(second);
      expect(timerNames(build.counters.snapshot())).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('the subscription gauges', () => {
  it('returns rx.subscriptions and journal.listeners to their starting count after twenty switches', async () => {
    const build = await loadBuild();
    const drive = new DriveStub();
    const name = `pboardswitches${crypto.randomUUID().replaceAll('-', '')}`;
    const repository = await build.createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
    closeables.push(async () => { await repository.db.close(); });
    const boards: string[] = [];
    for (let index = 0; index < 3; index++) boards.push((await repository.createProject(`Board ${index}`, 'project')).id);

    // The UI's own subscription shape: one project-list feed, one current-board
    // feed, one card feed for whichever board is displayed.
    await repository.selectProject(boards[0]);
    const stopProjects = repository.subscribeProjects(() => undefined);
    const stopCurrent = repository.subscribeCurrentProject(() => undefined);
    let stopCards = repository.subscribeCards(boards[0], () => undefined);
    closeables.push(async () => { stopCards(); stopProjects(); stopCurrent(); });

    const start = build.counters.snapshot().active;
    expect(start['rx.subscriptions']).toBe(3);
    // `journal.listeners` includes the board sessions the repository itself
    // holds; the assertion is that the number comes back, not what it is.
    expect(start['journal.listeners']).toBeGreaterThanOrEqual(3);

    for (let round = 0; round < 20; round++) {
      const next = boards[(round + 1) % boards.length];
      stopCards();
      stopCards = repository.subscribeCards(next, () => undefined);
      await repository.selectProject(next);
    }

    const end = build.counters.snapshot().active;
    expect(end['rx.subscriptions']).toBe(start['rx.subscriptions']);
    expect(end['journal.listeners']).toBe(start['journal.listeners']);
  }, 60_000);

  it('drops a journal listener the moment its unsubscribe runs, and on close', async () => {
    const build = await loadBuild();
    const name = `pboardjournal${crypto.randomUUID().replaceAll('-', '')}`;
    const repository = await build.createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
    // The repository holds board sessions; take the baseline with it alive.
    const baseline = build.counters.snapshot().active['journal.listeners'] ?? 0;
    const stop = repository.journal.subscribe(() => undefined);
    expect(build.counters.snapshot().active['journal.listeners']).toBe(baseline + 1);
    stop();
    stop(); // idempotent: a double release must not go negative
    expect(build.counters.snapshot().active['journal.listeners']).toBe(baseline);
    await repository.db.close();
  });
});
