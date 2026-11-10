// @vitest-environment jsdom
/**
 * What a startup costs the thread the person is typing into, measured.
 *
 * The owner reports the sidebar becoming "somewhat laggy or less responsive"
 * on startup, with a single browser. Three costs were candidates, and this
 * file measures each one instead of assuming it:
 *
 *   1. **duplicate reconciliation** — the MV3 worker's cold start forces a
 *      round (`src/sync/background.ts`), and the sidebar ran a second, full
 *      round of its own in its own JS context (`App.tsx` → `discoverSharedBoards`);
 *   2. **per-settle re-reads and re-renders** — every settled journal burst
 *      re-reads a view (`subscribeRead`) and may re-render the tree;
 *   3. **long synchronous slices** — the per-board loop of a round runs its
 *      projection, materialisation and journal writes back to back.
 *
 * What the measurements said, before any of this changed:
 *
 *   - (1) is real, and it is the whole of the user-visible cost. The worker's
 *     round is not the problem: it yields at every Drive await, and its
 *     longest blocking slice was 2-9 ms even while importing twenty boards of
 *     fifty cards. The *sidebar's own* round was the problem — the same work
 *     in the page's own JS context blocked it for 80-99 ms on a one-board
 *     startup. It was also redundant: the same account, the same local
 *     database, the same round the worker had just been asked for, and the
 *     mount asked for it twice. The sidebar now asks the worker once, as a
 *     background refresh, and keeps its local round only as the fallback for
 *     a worker that cannot answer at all.
 *   - (2) is not real as a render cost. A settled burst publishes one value
 *     and the sidebar's comparators suppress the rest: 13 renders for a
 *     twenty-board remount and 56 for a hundred-card board. The reads are
 *     0-1 ms each (`view.read.<subscription>.ms`, now measured). Coalescing
 *     them further would change nothing a person can feel, so it was not done.
 *   - (3) is not real. The round's longest blocking slice is single-digit
 *     milliseconds, with twenty board legs of 350-420 ms each — the loop
 *     already yields at every per-board await and never holds the thread for
 *     one board's work. Adding yields between boards would have been churn.
 *
 * Two findings the three hypotheses did not predict:
 *
 *   - `App`'s first render plus its effects costs a 55-60 ms slice that is
 *     flat in board count (one board) and flat in content (three cards or
 *     fifty). It is the size of the tree plus module-graph evaluation, and
 *     because each real sidebar load is a fresh JS context this first-mount
 *     number is the honest one — later mounts in this process measure a warm
 *     JIT (13-17 ms). Left alone: it is not a round, not a re-render loop, and
 *     not something a yield can split.
 *   - A cold start sends the sidebar's discovery request exactly once and the
 *     worker runs exactly one round; before, the mount sent it twice on top of
 *     the worker's cold start and the page then ran a third of its own.
 *
 * ## The fixture
 *
 * The product's own composition root in **two module graphs**, which is what
 * the extension has: an MV3 worker and a sidebar page, each with its own Drive
 * runtime, its own counters and its own single-flight guards, sharing one
 * extension storage, one Drive account and one local database. One deviation
 * is deliberate and stated: both graphs hold the same `RxRepository` instance,
 * because two RxDB instances on one database name cannot coexist in one
 * process (RxDB rejects the duplicate) while two real extension contexts are
 * two heaps with two Dexie handles on one IndexedDB database. Everything the
 * repository counts (`view.read`, `view.emit.*`, `journal.notify`) therefore
 * lands in the graph that constructs it, which is the worker's; the table
 * reports the totals and the per-context lines say who owns which count.
 *
 * ## What this file asserts
 *
 * Only things that are facts about behaviour, never about time: the number of
 * rounds each context runs, how they divide, and that a cold start asks for
 * exactly one round in total. Durations are printed because they are the
 * deliverable, and a printed number that drifts is a report, not a flake.
 */
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DriveStub } from './sync/driveStub';
import type { BoardItem } from '../src/types';
import type { RxRepository } from '../src/storage/rxdbRepository';

// ---------------------------------------------------------------------------
// The extension platform, shared by both JS contexts: one `storage.local`,
// `onChanged` fanned out to every listener, and a message channel whose far
// side is whichever context registered a dispatcher (the worker).
// ---------------------------------------------------------------------------
type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

const platform = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  const listeners = new Set<ChangeListener>();
  const holder: {
    data: Record<string, unknown>;
    listeners: Set<ChangeListener>;
    dispatch?: (message: unknown) => unknown;
    messages: Record<string, number>;
    api: {
      runtime: { getURL(path: string): string; sendMessage(message: unknown): Promise<unknown> };
      identity: Record<string, unknown>;
      storage: {
        local: {
          get(key: string | null): Promise<Record<string, unknown>>;
          set(patch: Record<string, unknown>): Promise<void>;
          remove(key: string): Promise<void>;
          clear(): Promise<void>;
        };
        onChanged: { addListener(listener: ChangeListener): void; removeListener(listener: ChangeListener): void };
      };
      alarms: Record<string, unknown>;
      tabs: Record<string, unknown>;
      permissions: Record<string, unknown>;
    };
  } = { data, listeners, messages: {}, api: undefined as unknown as NonNullable<typeof holder>['api'] };
  holder.api = {
    runtime: {
      getURL: (path: string) => `https://extension.invalid/${path}`,
      sendMessage: async (message: unknown) => {
        const type = typeof message === 'object' && message !== null && 'type' in message ? String(message.type) : 'unknown';
        holder.messages[type] = (holder.messages[type] ?? 0) + 1;
        // Anything the worker does not own is the toolbar pin context, which
        // the real worker answers from the active tab's content script.
        return holder.dispatch?.(message) ?? { page: false, selection: false, link: false, accessible: false };
      }
    },
    identity: { getRedirectURL: (path: string) => `https://chromiumapp.org/${path}`, getAuthToken: async () => 'token', removeCachedAuthToken: async () => undefined },
    storage: {
      local: {
        get: async (key: string | null) => key === null ? structuredClone(data) : { [key]: structuredClone(data[key]) },
        set: async (patch: Record<string, unknown>) => {
          const changes: Record<string, { newValue?: unknown }> = {};
          for (const [key, value] of Object.entries(patch)) { changes[key] = { newValue: value }; data[key] = structuredClone(value); }
          for (const listener of listeners) listener(changes, 'local');
        },
        remove: async (key: string) => { delete data[key]; },
        clear: async () => { for (const key of Object.keys(data)) delete data[key]; }
      },
      onChanged: {
        addListener: (listener: ChangeListener) => { listeners.add(listener); },
        removeListener: (listener: ChangeListener) => { listeners.delete(listener); }
      }
    },
    alarms: { get: async () => null, create: () => undefined, onAlarm: { addListener: () => undefined, removeListener: () => undefined } },
    tabs: {
      onActivated: { addListener: () => undefined, removeListener: () => undefined },
      onUpdated: { addListener: () => undefined, removeListener: () => undefined }
    },
    permissions: { contains: async () => true, request: async () => true }
  };
  return holder;
});

vi.mock('../src/platform/browser', () => ({ browser: platform.api }));

// ---------------------------------------------------------------------------
// One Google Drive account, in memory, with a network round trip.
// ---------------------------------------------------------------------------
/**
 * Per-request latency the fixture imposes. A real Drive round trip is tens of
 * milliseconds; without it every `await` resolves in the same microtask turn
 * and a round collapses into one long synchronous sweep, which would
 * *overstate* every slice this file reports. Kept small so the suite is not
 * slow: the point is that a round yields at all, not how long Google takes.
 */
const NETWORK_MS = 5;

let drive = new DriveStub();
let inFlight = 0;
let driveRequests = 0;

/** A fresh Drive account. The Changes feed is answered truthfully — nothing
 * has moved — because `DriveStub` does not model it and the operation
 * inventory reads it once per round to prove which folders moved. */
function installDrive(): DriveStub {
  drive = new DriveStub();
  drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const inner = drive.fetch;
  drive.fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/drive/v3/changes/startPageToken')) return Response.json({ startPageToken: '1' });
    if (url.pathname.endsWith('/drive/v3/changes')) return Response.json({ changes: [], newStartPageToken: String(Number(url.searchParams.get('pageToken') ?? 1) + 1) });
    return await inner(String(input), init);
  };
  return drive;
}
installDrive();

vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
  inFlight += 1;
  driveRequests += 1;
  await new Promise((resolve) => setTimeout(resolve, NETWORK_MS));
  try { return await drive.fetch(String(input), init); } finally { inFlight -= 1; }
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
const COLUMNS = ['phase', 'boards', 'rounds w/s', 'legs w/s', 'Drive w/s', 'reads', 'renders', 'max slice ms', 'slices>8ms', 'startup ms'];
const WIDTH = [27, 6, 10, 9, 9, 7, 8, 13, 11, 10];
const pad = (value: string, width: number) => value.length >= width ? value.slice(0, width) : value.padEnd(width, ' ');
let headerPrinted = false;
function printRow(cells: (string | number)[]) {
  if (!headerPrinted) {
    headerPrinted = true;
    console.log(`\n[startup] ${COLUMNS.map((column, index) => pad(column, WIDTH[index]!)).join(' | ')}`);
    console.log(`[startup] ${WIDTH.map((width) => '-'.repeat(width)).join('-+-')}`);
  }
  console.log(`[startup] ${cells.map((cell, index) => pad(String(cell), WIDTH[index]!)).join(' | ')}`);
}

type Snapshot = {
  events: Record<string, number>;
  renders: Record<string, number>;
  emissions: Record<string, number>;
  active: Record<string, number>;
  timings: Record<string, { runs: number; lastMs: number; totalMs: number }>;
  driveCost: { requests: number };
};
type Counters = typeof import('../src/collab/counters')['collaborationCounters'];

const count = (snapshot: Snapshot, name: string) => snapshot.events[name] ?? 0;
const sumPrefixed = (record: Record<string, number>, prefix: string) =>
  Object.entries(record).filter(([key]) => key.startsWith(prefix)).reduce((total, [, value]) => total + value, 0);

// ---------------------------------------------------------------------------
// One browser profile: one local database, then its two contexts.
// ---------------------------------------------------------------------------
type Profile = {
  repository: RxRepository;
  workerCounters: Counters;
  workerReconcile: (options?: { force?: boolean }) => Promise<unknown>;
  sidebar: { App: typeof import('../src/sidebar/App')['App']; counters: Counters };
};

/**
 * The worker's module graph. Everything the repository counts lands here,
 * because this is the graph that constructs the journal and `subscribeRead`.
 */
async function openWorker(name: string) {
  vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
  const { collaborationCounters } = await import('../src/collab/counters');
  const { createRxRepository } = await import('../src/storage/rxdbRepository');
  const { createIndexedDbBlobStore } = await import('../src/storage/blobStore');
  const repository = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const sync = await import('../src/sync/browser');
  sync.registerRxRepositoryResolver(async () => repository);
  const { handleDriveSyncMessage } = await import('../src/sync/background');
  platform.dispatch = (message: unknown) => handleDriveSyncMessage(message);
  return { counters: collaborationCounters, sync, repository };
}

/**
 * The sidebar's module graph: a fresh registry, so its Drive runtime, its
 * single-flight guards and its counters are its own, as a page's are.
 * `storage/browser` is the one seam replaced — the page's repository is the
 * profile's database, not a second copy of it (see the header).
 */
async function openSidebar(repository: RxRepository) {
  vi.resetModules();
  vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
  const { collaborationCounters } = await import('../src/collab/counters');
  vi.doMock('../src/storage/browser', async () => {
    const sync = await import('../src/sync/browser');
    sync.registerRxRepositoryResolver(async () => repository);
    // The composition root presents every subscription as a promise; the
    // facade keeps that shape while delegating to the profile's repository.
    const asPromise = (register: (listener: (value: never) => void) => () => void) =>
      async (listener: (value: never) => void) => register(listener);
    return {
      repository: {
        ...repository,
        subscribeProjects: asPromise(repository.subscribeProjects as never),
        subscribeCurrentProject: asPromise(repository.subscribeCurrentProject as never),
        subscribeCards: (projectId: string, listener: (value: BoardItem[]) => void) => Promise.resolve(repository.subscribeCards(projectId, listener)),
        subscribeCard: (id: string, listener: (value: BoardItem | null) => void) => Promise.resolve(repository.subscribeCard(id, listener)),
        subscribeImage: async (imageId: string, listener: () => void) => repository.subscribeImages((changed) => { if (changed === imageId) listener(); }),
        subscribePendingWork: (listener: Parameters<RxRepository['subscribePendingWork']>[0]) => Promise.resolve(repository.subscribePendingWork(listener))
      },
      RXDB_MIGRATION_ERROR_KEY: 'rxdbMigrationError'
    };
  });
  const { App } = await import('../src/sidebar/App');
  return { counters: collaborationCounters, App };
}

/** A fresh profile: empty platform storage, a fresh Drive account, and a local
 * database holding `boards` boards of `cards` cards each, published to Drive
 * so a restart of an ordinary profile is what is measured. */
async function openProfile(boards: number, cards: number): Promise<Profile> {
  for (const key of Object.keys(platform.data)) delete platform.data[key];
  platform.listeners.clear();
  platform.dispatch = undefined;
  platform.messages = {};
  installDrive();

  vi.resetModules();
  const worker = await openWorker(`startup${crypto.randomUUID().replaceAll('-', '')}`);
  for (let board = 0; board < boards; board += 1) {
    const project = await worker.repository.createProject(`Board ${board}`, 'project');
    for (let card = 0; card < cards; card += 1) await worker.repository.addItem({ projectId: project.id, content: `Card ${card} on board ${board}` });
  }
  const listed = await worker.repository.listProjects();
  if (listed[0]) await worker.repository.selectProject(listed[0].id);
  await worker.sync.googleDrive.reconcileAll({ force: true });
  // A restart does not inherit a reconcile stamp from the previous session.
  delete platform.data['pboardDriveLastReconciledAt'];

  const sidebar = await openSidebar(worker.repository);
  return {
    repository: worker.repository,
    workerCounters: worker.counters,
    workerReconcile: (options) => worker.sync.googleDrive.reconcileAll(options),
    sidebar: { App: sidebar.App, counters: sidebar.counters }
  };
}

/** A profile whose boards exist only on Drive: startup has to import them,
 * which is the burst that made the owner's sidebar feel sticky. */
async function openImportingProfile(boards: number, cards: number): Promise<Profile> {
  for (const key of Object.keys(platform.data)) delete platform.data[key];
  platform.listeners.clear();
  platform.dispatch = undefined;
  platform.messages = {};
  installDrive();

  vi.resetModules();
  const scaffold = await openWorker(`seed${crypto.randomUUID().replaceAll('-', '')}`);
  for (let board = 0; board < boards; board += 1) {
    const project = await scaffold.repository.createProject(`Board ${board}`, 'project');
    for (let card = 0; card < cards; card += 1) await scaffold.repository.addItem({ projectId: project.id, content: `Card ${card} on board ${board}` });
  }
  const listed = await scaffold.repository.listProjects();
  if (listed[0]) await scaffold.repository.selectProject(listed[0].id);
  await scaffold.sync.googleDrive.reconcileAll({ force: true });
  // Throw the scaffolding profile away: only Drive keeps the boards now.
  await scaffold.repository.db.close();
  delete platform.data['pboardDriveLastReconciledAt'];
  platform.listeners.clear();

  vi.resetModules();
  const worker = await openWorker(`importing${crypto.randomUUID().replaceAll('-', '')}`);
  const sidebar = await openSidebar(worker.repository);
  return {
    repository: worker.repository,
    workerCounters: worker.counters,
    workerReconcile: (options) => worker.sync.googleDrive.reconcileAll(options),
    sidebar: { App: sidebar.App, counters: sidebar.counters }
  };
}

// ---------------------------------------------------------------------------
// One measured startup window.
// ---------------------------------------------------------------------------
type Phase = {
  label: string;
  boards: number;
  rounds: [number, number];
  legs: [number, number];
  drive: [number, number];
  reads: number;
  renders: number;
  maxSliceMs: number;
  slowSlices: number;
  elapsedMs: number;
};

/**
 * How a phase drives the two contexts:
 *  - `cold`   — the worker's cold start and the sidebar mount together;
 *  - `warm`   — the sidebar remounts with data already local, worker alive;
 *  - `worker` — the worker's round alone: no sidebar, so no page cost;
 *  - `page`   — the sidebar mount alone: the worker is unreachable, which is
 *               also the one path where the sidebar still runs its fallback.
 */
type Mode = 'cold' | 'warm' | 'worker' | 'page';

async function measure(profile: Profile, options: { label: string; boards: number; mode: Mode; root?: Root }): Promise<Phase & { root: Root }> {
  const { workerCounters, sidebar } = profile;
  workerCounters.clear();
  sidebar.counters.clear();
  driveRequests = 0;
  const messagesBefore: Record<string, number> = { ...platform.messages };
  const workerRuns = options.mode === 'cold' || options.mode === 'worker';
  const pageRuns = options.mode !== 'worker';
  if (options.mode === 'page') platform.dispatch = undefined;

  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = options.root ?? createRoot(document.body.appendChild(document.createElement('div')));

  // The slice probe: a `setTimeout(0)` chain. The interval between two turns is
  // time the thread spent without yielding to input — exactly what a keystroke
  // waits for. It measures; the assertions below never read it.
  let probing = true;
  let last = performance.now();
  const slices: number[] = [];
  const tick = () => {
    if (!probing) return;
    const now = performance.now();
    slices.push(now - last);
    last = now;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);

  const startedAt = performance.now();
  if (workerRuns) void platform.api.storage.local.set({ pboardWorkerEpoch: Date.now() });
  const round = workerRuns ? profile.workerReconcile({ force: true }).catch(() => undefined) : Promise.resolve();
  if (pageRuns) await act(async () => { root.render(<sidebar.App />); });

  // Quiescence: counters and the network both static for twenty turns.
  const snapshot = () => JSON.stringify([workerCounters.snapshot().events, sidebar.counters.snapshot().events, inFlight]);
  let previous = '';
  let quiet = 0;
  for (let turn = 0; turn < 4_000; turn += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
    const current = snapshot();
    quiet = current === previous && inFlight === 0 ? quiet + 1 : 0;
    previous = current;
    if (quiet > 20) break;
  }
  await round;
  const elapsedMs = performance.now() - startedAt;
  probing = false;

  const worker = workerCounters.snapshot();
  const page = sidebar.counters.snapshot();
  const slow = slices.filter((slice) => slice > 8);
  const phase: Phase = {
    label: options.label,
    boards: options.boards,
    rounds: [count(worker, 'reconcile.round'), count(page, 'reconcile.round')],
    legs: [count(worker, 'reconcile.board'), count(page, 'reconcile.board')],
    drive: [worker.driveCost.requests, page.driveCost.requests],
    reads: count(worker, 'view.read'),
    renders: page.renders['App'] ?? 0,
    maxSliceMs: Math.round(Math.max(0, ...slices)),
    slowSlices: slow.length,
    elapsedMs: Math.round(elapsedMs)
  };
  printRow([phase.label, phase.boards, `${phase.rounds[0]}/${phase.rounds[1]}`, `${phase.legs[0]}/${phase.legs[1]}`,
    `${phase.drive[0]}/${phase.drive[1]}`, phase.reads, phase.renders, phase.maxSliceMs, phase.slowSlices, phase.elapsedMs]);
  console.log(`[startup]     ↳ worker  ${JSON.stringify({ rounds: count(worker, 'reconcile.round'), legs: count(worker, 'reconcile.board'), skip: count(worker, 'reconcile.skip'), notify: count(worker, 'journal.notify'), reads: count(worker, 'view.read'), readsBy: Object.fromEntries(Object.entries(worker.events).filter(([key]) => key.startsWith('view.read.')).map(([key, value]) => [key.slice('view.read.'.length), value])), emits: Object.fromEntries(Object.entries(worker.emissions).filter(([key]) => key.startsWith('view.emit.'))), legMs: worker.timings['sync.board']?.lastMs ?? 0 })}`);
  console.log(`[startup]     ↳ sidebar ${JSON.stringify({ rounds: count(page, 'reconcile.round'), legs: count(page, 'reconcile.board'), skip: count(page, 'reconcile.skip'), renders: page.renders, effects: page.effects, emissions: page.emissions, subscriptions: page.active['rx.subscriptions'] ?? 0, messages: Object.fromEntries(Object.entries(platform.messages).map(([type, total]) => [type, total - (messagesBefore[type] ?? 0)])), legMs: page.timings['sync.board']?.lastMs ?? 0, identityMs: page.timings['identity.sync']?.lastMs ?? 0 })}`);
  console.log(`[startup]     ↳ ${driveRequests} Drive requests; slices over 8 ms [${slow.map((slice) => Math.round(slice)).join(', ') || 'none'}]; total reads ${sumPrefixed(worker.events, 'view.read.')}`);
  return { ...phase, root };
}

it('measures what a startup costs, and how the two contexts divide the work', async () => {
  // ---- one board: the owner's case ---------------------------------------
  const one = await openProfile(1, 3);
  const coldOne = await measure(one, { label: 'cold, 1 board (first mount)', boards: 1, mode: 'cold' });
  await act(async () => { coldOne.root.unmount(); });
  // The same phase again: if its longest slice collapses, that first number was
  // this process warming React and the module graph, not a cost of startup.
  const coldOneAgain = await measure(one, { label: 'cold, 1 board (second)', boards: 1, mode: 'cold' });
  await act(async () => { coldOneAgain.root.unmount(); });
  const warmOne = await measure(one, { label: 'warm remount, 1 board', boards: 1, mode: 'warm' });
  await act(async () => { warmOne.root.unmount(); });
  await one.repository.db.close();

  // ---- twenty boards that only exist on Drive: the import burst ----------
  const importing = await openImportingProfile(20, 3);
  const coldImport = await measure(importing, { label: 'cold import, 20 boards', boards: 20, mode: 'cold' });
  await act(async () => { coldImport.root.unmount(); });
  const warmImport = await measure(importing, { label: 'warm remount, 20 boards', boards: 20, mode: 'warm' });
  await act(async () => { warmImport.root.unmount(); });

  // ---- attribution: which context owns the blocking work? ----------------
  const workerOnly = await openProfile(20, 3);
  const roundOnly = await measure(workerOnly, { label: 'worker round only, 20', boards: 20, mode: 'worker' });
  await act(async () => { roundOnly.root.unmount(); });
  await workerOnly.repository.db.close();

  const pageOnly = await openProfile(20, 3);
  const mountOnly = await measure(pageOnly, { label: 'sidebar mount only, 20', boards: 20, mode: 'page' });
  await act(async () => { mountOnly.root.unmount(); });
  await pageOnly.repository.db.close();
  await importing.repository.db.close();

  // ---- what the numbers must say, as behaviour ---------------------------
  // One round per context is the whole contract: the worker owns the round,
  // and the sidebar asks for it instead of running one. A cold start that
  // reports two rounds in the sidebar is the duplicate this file measured.
  expect(coldOne.rounds[0], 'the worker runs the round').toBe(1);
  expect(coldOne.rounds[1], 'the sidebar does not run a round of its own').toBe(0);
  expect(coldImport.rounds[1], 'still one round per startup with 20 boards importing').toBe(0);
  // And the round is still asked for exactly once, not twice (the mount used
  // to send the same message and the discovery effect again).
  expect(platform.messages['DRIVE_RECONCILE_ALL']).toBe(1);
  // The worker's round is still O(boards): twenty boards, twenty legs.
  expect(coldImport.legs[0]).toBe(20);
  // A page-only startup has no round at all to run, and the round-only startup
  // renders nothing: the two contexts really are separable in this fixture.
  expect(roundOnly.renders).toBe(0);
  expect(mountOnly.legs[0]).toBe(0);
}, 900_000);
