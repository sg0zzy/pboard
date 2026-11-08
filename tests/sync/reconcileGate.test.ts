/**
 * The automatic round's per-board gate.
 *
 * A reconcile round used to open, verify, list and project **every** board it
 * could name, every round — including boards that were clean, already synced,
 * bound, had nothing unpublished, and whose Drive folder no device had written
 * since this context last synchronized it. `stage 6` of the idle-cost mandate is
 * that this stops: idle CPU must not grow with board count.
 *
 * The gate (`runtime.ts:roundNeedsWork`) is the smallest set of facts that
 * proves a board owes the round nothing, and these tests pin both directions of
 * it: the round does no per-board work when it can prove that, and it does the
 * work whenever it cannot. Every assertion is a *count of calls*, never a
 * duration: a board's synchronize either happened or it did not.
 *
 * Counts come from the product's own diagnostics (`events['reconcile.board']`,
 * `events['reconcile.skip']`), so the numbers in a failure report are the ones
 * `pboardCollaboration()` shows in a real browser. That requires the counters to
 * be enabled *before* the runtime module graph is evaluated, which is why the
 * build is loaded through `loadBuild` exactly as `transportInvariants.test.ts`
 * does — a static import would capture a disabled counters instance.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveRuntime } from '../../src/sync/runtime';
import type { RxRepository } from '../../src/storage/rxdbRepository';
import { DRIVE_LAST_RECONCILED_AT_KEY } from '../../src/sync/runtime';
import { DriveStub } from './driveStub';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * The product graph under test, loaded with the diagnostics flag in place.
 *
 * `counters.ts` reads `__PBOARD_DIAGNOSTICS__` when it is evaluated, and
 * `runtime.ts` imports it statically, so both have to come from one graph built
 * after the stub. The types below are the product's own; only the *values* are
 * dynamic, because the module registry has to be reset between graphs.
 */
async function loadBuild() {
  vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
  vi.resetModules();
  const { collaborationCounters } = await import('../../src/collab/counters');
  const runtimeModule = await import('../../src/sync/runtime');
  const repositoryModule = await import('../../src/storage/rxdbRepository');
  const blobModule = await import('../../src/storage/blobStore');
  expect(collaborationCounters.enabled, 'these assertions read the diagnostics the product exposes').toBe(true);
  return { collaborationCounters, createDriveRuntime: runtimeModule.createDriveRuntime,
    createRxRepository: repositoryModule.createRxRepository, createIndexedDbBlobStore: blobModule.createIndexedDbBlobStore };
}

type Build = Awaited<ReturnType<typeof loadBuild>>;

/**
 * A Drive stub that also answers the Changes feed.
 *
 * `DriveStub` deliberately does not implement it (its own suites never reconcile
 * an operation-protocol board), and the round reads the feed once to prove which
 * folders moved. The answer here is the *truthful* one — `newStartPageToken` with
 * no changes, because the account genuinely had none between the rounds these
 * tests drive. A scenario that needs a change reports it through `changes`.
 *
 * A wrapper rather than a subclass: `DriveStub.fetch` is an instance property,
 * so a subclass cannot reach it through `super`.
 */
function feedStub() {
  const drive = new DriveStub();
  const feed = {
    drive,
    /** Change rows the next feed page will report. */
    changes: [] as { fileId: string; file?: { id: string; name: string; parents?: string[] }; removed?: boolean }[],
    cursor: 1,
    feedRequests: 0
  };
  const base = drive.fetch;
  drive.fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/drive/v3/changes/startPageToken')) {
      feed.feedRequests += 1;
      return Response.json({ startPageToken: String(feed.cursor) });
    }
    if (url.pathname.endsWith('/drive/v3/changes')) {
      feed.feedRequests += 1;
      const rows = feed.changes.splice(0);
      feed.cursor += 1;
      // Drive always answers with a `changes` array, empty when nothing moved —
      // the feed rejects a page without one, and a stub that omitted it would
      // look like a failure of the client rather than of the fixture.
      return Response.json({ changes: rows, newStartPageToken: String(feed.cursor) });
    }
    return await base(String(input), init);
  };
  return feed;
}
type FeedStub = ReturnType<typeof feedStub>;

/**
 * One browser profile on a shared Drive stub.
 *
 * The repository's `projectChanged` event is wired exactly as the composition
 * root wires it (`src/storage/browser.ts`): without it a created board is never
 * marked dirty, and every round would take the full Drive path for every board —
 * measuring the fixture instead of the runtime.
 */
async function profile(build: Build, stub: FeedStub) {
  const name = `pboardgate${crypto.randomUUID().replaceAll('-', '')}`;
  // Declared before the repository because `projectChanged` resolves the runtime
  // lazily, exactly as the composition root does through its module singleton.
  const state: { runtime: { driveSyncState: { markDirty(projectId: string): Promise<void> } } | null } = { runtime: null };
  const repository: RxRepository = await build.createRxRepository({ name, blobs: build.createIndexedDbBlobStore(`${name}images`),
    events: { projectChanged: (projectId: string) => { void state.runtime?.driveSyncState.markDirty(projectId); } } });
  const data: Record<string, unknown> = {};
  const runtime = build.createDriveRuntime({
    auth: { getAccessToken: async () => 'token', getConnectionState: async () => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
    storage: { get: async (key: string) => ({ [key]: structuredClone(data[key]) }), set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); } },
    getRepository: async () => repository, fetcher: stub.drive.fetch as typeof fetch
  });
  state.runtime = runtime;
  await runtime.collaborationManager.setEnabled(false);
  closes.push(async () => { await runtime.collaborationManager.stop(); for (const id of repository.operationSource.bindings.keys()) await runtime.operationService.close(id); await repository.db.close(); });
  return { runtime, repository, data };
}

/**
 * N boards that are clean, bound, synced and Drive-quiet.
 *
 * Each is published to Drive and then settled by one forced round, which is what
 * leaves this context holding the two facts the gate compares against: the local
 * change token and the folder revision its last completed pass answered for.
 */
async function settledBoards(build: Build, count: number) {
  const stub = feedStub();
  stub.drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const a = await profile(build, stub);
  const boards: string[] = [];
  for (let index = 0; index < count; index++) {
    const board = await a.repository.createProject(`Board ${index}`, 'project');
    await a.repository.addItem({ projectId: board.id, content: `Card on board ${index}` });
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    boards.push(board.id);
  }
  await a.runtime.googleDrive.reconcileAll({ force: true });
  return { stub, a, boards };
}

/**
 * An automatic round that is not served by the coalescing stamp.
 *
 * A completed round stamps shared storage for `RECONCILE_COALESCE_MS`, so a
 * second *unforced* round within 30 s answers from the stamp without running at
 * all. That is a different optimisation (one round per window per profile), and
 * a test that measured it would never reach the gate. Clearing the stamp is what
 * asks the runtime to run the round, which is the thing under test.
 */
async function automaticRound(a: Awaited<ReturnType<typeof profile>>) {
  delete a.data[DRIVE_LAST_RECONCILED_AT_KEY];
  return await a.runtime.googleDrive.reconcileAll();
}

/**
 * The card contents of one board, read until they settle.
 *
 * The projection that writes a pulled operation is scheduled off the sync, so a
 * read immediately after the round can still see the old value. This polls the
 * repository's own reader — no fixed turn count is treated as a state, and no
 * duration is measured — and returns the last answer either way, so a broken
 * convergence fails on the content comparison rather than on a timeout.
 */
async function untilConverged(repository: RxRepository, boardId: string): Promise<string[]> {
  let contents = (await repository.listCards(boardId)).map(item => item.content);
  for (let attempt = 0; attempt < 200 && !contents.includes('Changed in browser A'); attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    contents = (await repository.listCards(boardId)).map(item => item.content);
  }
  return contents;
}

const events = (build: Build) => build.collaborationCounters.snapshot().events;
const count = (build: Build, name: string) => events(build)[name] ?? 0;

describe('the automatic round skips boards it can prove owe nothing', () => {
  it('does zero sync.board legs for a round over 20 clean boards, and says so', async () => {
    const build = await loadBuild();
    const { a, boards } = await settledBoards(build, 20);
    // The forced round `settledBoards` ends with is the baseline: it must still
    // reconcile every board, or the comparison below would be meaningless.
    const baseline = { board: count(build, 'reconcile.board'), skip: count(build, 'reconcile.skip'), round: count(build, 'reconcile.round') };

    const clean = await automaticRound(a);
    expect(count(build, 'reconcile.round') - baseline.round).toBe(1);
    // Nothing moved on any board: not one was opened, verified, listed or
    // projected. `reconcile.board` is the counter that measures exactly that.
    expect(count(build, 'reconcile.board') - baseline.board).toBe(0);
    expect(count(build, 'reconcile.skip') - baseline.skip).toBe(boards.length);
    expect(clean).toMatchObject({ status: 'reconciled', imported: 0, pulled: 0 });
    // And the round still answers for every board it skipped: the sidebar reads
    // `relay[projectId]`, and "skipped" must not mean "silent".
    expect(Object.keys(clean.relay ?? {}).sort()).toEqual([...boards].sort());
    expect(Object.values(clean.relay ?? {}).every(outcome => outcome === 'idle:not-attached')).toBe(true);
  }, 180_000);

  it('one dirty board makes exactly one sync.board leg, and that board converges', async () => {
    const build = await loadBuild();
    const { a, boards } = await settledBoards(build, 20);
    const dirty = boards[7];
    const card = await a.repository.addItem({ projectId: dirty, content: 'Written after the round settled' });
    // The repository event that marks the board dirty is what a real edit fires;
    // awaiting the state makes the premise explicit instead of implied by a tick.
    await a.runtime.driveSyncState.markDirty(dirty);
    const baseline = { board: count(build, 'reconcile.board'), skip: count(build, 'reconcile.skip') };

    await automaticRound(a);
    expect(count(build, 'reconcile.board') - baseline.board).toBe(1);
    expect(count(build, 'reconcile.skip') - baseline.skip).toBe(boards.length - 1);
    expect((await a.repository.listCards(dirty)).map(item => item.id)).toContain(card.id);
    // An *automatic* round synchronizes the board but deliberately does not
    // flush an operation that is still inside its idle window (`flushDue` is
    // false, so `publish` is false): the board keeps its work pending, which is
    // the product's batching rule and not a failure to converge. The forced
    // pass is the user's "Sync now" and must settle it.
    expect((await a.runtime.driveSyncState.get(dirty)).status, 'the round did not record a failure').not.toBe('error');
    await a.runtime.googleDrive.syncProject(dirty, { force: true });
    expect(await a.runtime.driveSyncState.get(dirty)).toMatchObject({ dirty: false, status: 'synced' });
    expect((await a.repository.listCards(dirty)).map(item => item.id)).toContain(card.id);
  }, 180_000);

  it('a forced round still works all 20 boards', async () => {
    const build = await loadBuild();
    const { a, boards } = await settledBoards(build, 20);
    const baseline = { board: count(build, 'reconcile.board'), skip: count(build, 'reconcile.skip') };
    await a.runtime.googleDrive.reconcileAll({ force: true });
    expect(count(build, 'reconcile.board') - baseline.board).toBe(boards.length);
    expect(count(build, 'reconcile.skip') - baseline.skip).toBe(0);
  }, 180_000);

  it('a board whose Drive folder moved is synchronized even though it is locally clean', async () => {
    const build = await loadBuild();
    const { stub, a, boards } = await settledBoards(build, 3);
    // Another device publishes an operation segment into board 1's folder. The
    // account feed is the only thing that knows; the local state is untouched,
    // so a gate built on local facts alone would have skipped this board and the
    // edit would never arrive.
    const folder = stub.drive.files.find(file => file.name === boards[1] && file.mimeType === 'application/vnd.google-apps.folder')!;
    expect(folder, 'the board has a Drive folder to write into').toBeTruthy();
    stub.changes.push({ fileId: 'foreign-segment', file: { id: 'foreign-segment', name: 'operations-foreign.json', parents: [folder.id] } });
    const baseline = { board: count(build, 'reconcile.board'), skip: count(build, 'reconcile.skip') };

    await automaticRound(a);
    expect(count(build, 'reconcile.board') - baseline.board).toBe(1);
    expect(count(build, 'reconcile.skip') - baseline.skip).toBe(2);
  }, 180_000);

  /**
   * The acceptance case the reduction must not buy its savings with: an edit
   * made in one browser still reaches another, through the gate.
   *
   * Both profiles share one Drive stub and one feed exactly as two devices of
   * one account do, so B's proof that A's board moved comes from the same fact
   * the gate uses — the folder revision the feed reports. The assertion is on
   * the *content* arriving, and on B having skipped nothing it needed: A's write
   * changes the folder, so B works exactly that board.
   */
  it('an edit in browser A reaches browser B through the gate, and only that board is worked', async () => {
    const build = await loadBuild();
    const stub = feedStub();
    stub.drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
    const a = await profile(build, stub), b = await profile(build, stub);
    const edited = await a.repository.createProject('Edited in A', 'project');
    const quiet = await a.repository.createProject('Untouched', 'project');
    for (const board of [edited, quiet]) {
      await a.repository.addItem({ projectId: board.id, content: 'First draft' });
      await a.runtime.googleDrive.syncProject(board.id, { force: true });
    }
    // B imports both from Drive and settles them, so both are bound, synced and
    // have a recorded folder revision on B — the state the gate needs to skip.
    await b.runtime.googleDrive.reconcileAll({ force: true });
    expect((await b.repository.listProjects()).map(project => project.id).sort()).toEqual([edited.id, quiet.id].sort());

    const card = (await a.repository.listCards(edited.id))[0];
    await a.repository.updateItem(card.id, { content: 'Changed in browser A' });
    await a.runtime.googleDrive.syncProject(edited.id, { force: true });
    // A's publish is what the feed reports: the operation segment it wrote into
    // the board's folder. Reporting it is the fixture's job; the client would
    // learn the same fact from Google on its next page.
    const folder = stub.drive.files.find(file => file.name === edited.id && file.mimeType === 'application/vnd.google-apps.folder')!;
    const segment = stub.drive.files.filter(file => file.name.startsWith('operations-') && file.parents.includes(folder.id)).at(-1)!;
    expect(segment, 'A published an operation segment for the edited board').toBeTruthy();
    stub.changes.push({ fileId: segment.id, file: { id: segment.id, name: segment.name, parents: [folder.id] } });

    const baseline = { board: count(build, 'reconcile.board'), skip: count(build, 'reconcile.skip') };
    delete b.data[DRIVE_LAST_RECONCILED_AT_KEY];
    await b.runtime.googleDrive.reconcileAll();
    // Exactly the board A wrote: the other one is provably quiet and skipped.
    expect(count(build, 'reconcile.board') - baseline.board, 'B works the board that moved').toBe(1);
    expect(count(build, 'reconcile.skip') - baseline.skip, 'and skips the one that did not').toBe(1);
    // Convergence, and the reason the "one leg" assertion above is not enough on
    // its own: the edit arrived at B, so the leg B ran was the one that mattered.
    // (A gate that skipped the edited board would fail the leg count too, but
    // this is the assertion that reads the user's content rather than a
    // counter.)
    expect(await untilConverged(b.repository, edited.id)).toEqual(['Changed in browser A']);
    // The quiet board is untouched at B: B skipping it changed no content.
    expect((await b.repository.listCards(quiet.id)).map(item => item.content)).toEqual(['First draft']);
  }, 180_000);

  it('a board that errored last round is retried, not skipped', async () => {
    const build = await loadBuild();
    const { a, boards } = await settledBoards(build, 4);
    const failing = boards[2];
    await a.runtime.driveSyncState.markError(failing, 'Drive unavailable for this board');
    expect(await a.runtime.driveSyncState.get(failing)).toMatchObject({ status: 'error' });
    const baseline = { board: count(build, 'reconcile.board') };

    const result = await automaticRound(a);
    expect(count(build, 'reconcile.board') - baseline.board).toBe(1);
    expect(result.status).toBe('reconciled');
    // The retry settled the board and cleared the recorded cause.
    expect(await a.runtime.driveSyncState.get(failing)).toMatchObject({ dirty: false, status: 'synced', error: undefined });
  }, 180_000);
});
