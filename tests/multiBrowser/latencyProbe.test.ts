/**
 * Where the time goes for two browsers of one Google account, under **production
 * pacing**.
 *
 * Every other suite in this directory hands `createBrowser` a budget that paces
 * nothing (`tests/helpers/authBudget.ts`), because a protocol-coverage scenario
 * should not spend its hook budget in a token bucket. That seam is exactly what
 * makes "collaboration feels slow" unanswerable from the existing runs: no test
 * has ever measured a wall clock. This suite passes a real `createAuthBudget()` —
 * the production policy, 2.5 req/s with burst 5 and 8 relay dials per 10 s per
 * context — to both browsers and times each step from its cause to the effect a
 * person would notice:
 *
 *  1. discovery by B of a board A created (does the account channel deliver it?),
 *  2. an edit while both hold the board open (the realtime path),
 *  3. an edit while B works on a different board (whatever mechanism delivers
 *     it — measured, not assumed),
 *  4. the cost of B's relay sockets dying: re-attach, then the next edit,
 *  5. repeats of the edit path with min/median/max, because one sample says
 *     nothing about "unreliable".
 *
 * What this file asserts is deliberately weak: a step either completes inside a
 * generous ceiling or the file records that it did not and prints the finding.
 * The printed table is the deliverable; the assertions are only a flake gate.
 *
 * Waiting is a real-time poll (`performance.now`, 1 ms task-queue turns), never a
 * fixed sleep, and **every** wait has a budget — a step that can never complete is
 * reported as such instead of hanging the suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthBudget, type AuthBudget } from '../../src/collab/authBudget';
import { publicKeyFingerprint } from '../../src/collab/security/keys';
import type { DeviceRequest, EnrollmentBundle } from '../../src/collab/security/enrollment';
import type { FakeSocketImpl } from './fixtures/fakeSignaling';
import { createBrowser, createCloud, logStatusOf, type BrowserHandle, type BrowserRuntime, type Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';

/** Generous ceilings, not targets: a step may be slow; it may not hang.
 * Calibrated at roughly 5× the observed worst run. */
const CEILING = {
  discovery: 30_000,
  open: 25_000,
  realtimeEdit: 10_000,
  reattach: 25_000,
  postReconnectEdit: 10_000
};
/** Passive window for the "B is not looking at the board" case: long enough for a
 * relay round trip and a Drive coalesce, far short of the 10-minute account poll
 * (`src/sync/syncPolicy.ts:5`) and the 30-minute edit-idle flush (`:3`). */
const IDLE_WINDOW_MS = 3_000;

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const COLUMNS = ['step', 'ms', 'paced A/B', 'A open/dial/def', 'B open/dial/def', 'adm', 'exch', 'ref', '429', 'reconcile'];
const WIDTH = [44, 7, 12, 15, 15, 11, 6, 4, 4, 11];
let headerPrinted = false;

const pad = (value: string, width: number) => value.length >= width ? value.slice(0, width) : value.padEnd(width, ' ');

function tableRow(cells: string[]) {
  if (!headerPrinted) {
    headerPrinted = true;
    console.log(`\n[latency] ${COLUMNS.map((c, i) => pad(c, WIDTH[i])).join(' | ')}`);
    console.log(`[latency] ${WIDTH.map(w => '-'.repeat(w)).join('-+-')}`);
  }
  console.log(`[latency] ${cells.map((c, i) => pad(c, WIDTH[i])).join(' | ')}`);
}

type Row = { step: string; ms: number; delivered: boolean };
const measured: Row[] = [];

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

type Snap = {
  open: number;
  byKind: Record<string, number>;
  dialsUsed: number;
  deferrals: number;
  failedDials: number;
  cooldowns: number;
  admissions: number;
  exchanges: number;
  refusals: number;
  rounds: number;
  boards: number;
};

function snapshot(browser: BrowserHandle, budget: AuthBudget, cloud: Cloud): Snap {
  const budgetState = budget.snapshot();
  const counters = browser.counters();
  return {
    open: counters.active['transport.open'] ?? 0,
    byKind: { ...budgetState.byKind },
    dialsUsed: budgetState.relayDials.usedInWindow,
    deferrals: budgetState.relayDials.deferred + budgetState.relayAttempts.deferred,
    failedDials: budgetState.relayDials.failed,
    cooldowns: budgetState.cooldowns,
    admissions: cloud.signaling.admitted.length,
    exchanges: cloud.signaling.exchangeLog.length,
    refusals: cloud.signaling.refusals.length,
    rounds: counters.events['reconcile.round'] ?? 0,
    boards: counters.events['reconcile.board'] ?? 0
  };
}

/** The per-endpoint spend, on its own line under each row: the table has no
 * width for it, and "which automatic-auth call burned the wait" is the whole
 * point of the column. */
function byKindDelta(before: Snap, after: Snap): string {
  const kinds = Object.keys(after.byKind).filter(kind => (after.byKind[kind] ?? 0) > (before.byKind[kind] ?? 0));
  return kinds.length ? kinds.map(kind => `${kind}:+${after.byKind[kind] - (before.byKind[kind] ?? 0)}`).join(' ') : 'none';
}

type Pair = { before: Snap; after: Snap };

function record(step: string, ms: number, a: Pair, b: Pair, delivered: boolean, note: string, pacedA = 0, pacedB = 0) {
  measured.push({ step, ms, delivered });
  const deltaA = pacedA, deltaB = pacedB;
  tableRow([
    step,
    String(Math.round(ms)),
    `${Math.round(deltaA)}/${Math.round(deltaB)}`,
    `${a.after.open}/${a.after.dialsUsed}/+${a.after.deferrals - a.before.deferrals}`,
    `${b.after.open}/${b.after.dialsUsed}/+${b.after.deferrals - b.before.deferrals}`,
    `A+${a.after.admissions - a.before.admissions}/B+${b.after.admissions - b.before.admissions}`,
    `B+${b.after.exchanges - b.before.exchanges}`,
    `+${a.after.refusals - a.before.refusals + b.after.refusals - b.before.refusals}`,
    `+${a.after.cooldowns - a.before.cooldowns + b.after.cooldowns - b.before.cooldowns}`,
    `+${b.after.rounds - b.before.rounds}rd/+${b.after.boards - b.before.boards}bd`
  ]);
  console.log(`[latency]     ↳ ${delivered ? 'delivered' : 'NOT delivered'} — ${note}`);
  console.log(`[latency]     ↳ authBudget A: ${byKindDelta(a.before, a.after)} | B: ${byKindDelta(b.before, b.after)}`);
  // The overlap of this step's own window with the intervals spent inside
  // `acquire*`: a wait that began before the step opened contributes only its
  // overlapping part, so the number can never exceed the step it describes.
  console.log(`[latency]     ↳ budget wait overlapping this step: A ${Math.round(deltaA)}ms, B ${Math.round(deltaB)}ms`);
  console.log(`[latency]     ↳ failed dials (refused upgrades look like network failures): A +${a.after.failedDials - a.before.failedDials}, B +${b.after.failedDials - b.before.failedDials}`);
}

/**
 * The **production** budget, with a record of its waits.
 *
 * Passing the real policy in is half the measurement; the other half is
 * attributing a step's wall clock to it. A wait is recorded as the interval it
 * occupied, so a step can ask "how much of *my* window was spent inside
 * `acquire*`" (token bucket, dial allowance, 429 pause) without a wait that began
 * before the step opens being counted in full — which is what a cumulative
 * counter would do, and what made the first version of this probe report 162 %.
 * Everything other than the three `acquire`s is the product's own object.
 */
function meteredBudget(): { budget: AuthBudget; waitDuring: (from: number, to: number) => number } {
  const budget = createAuthBudget();
  const waits: { from: number; to: number }[] = [];
  const stopwatch = async <T>(run: () => Promise<T>): Promise<T> => {
    const from = performance.now();
    try { return await run(); } finally { waits.push({ from, to: performance.now() }); }
  };
  /** Union length of the wait intervals overlapping `[from, to)`. */
  function waitDuring(from: number, to: number): number {
    let total = 0;
    for (const wait of waits) {
      const overlap = Math.min(wait.to, to) - Math.max(wait.from, from);
      if (overlap > 0) total += overlap;
    }
    return total;
  }
  return {
    budget: {
      acquire: kind => stopwatch(() => budget.acquire(kind)),
      acquireRelayDial: () => stopwatch(() => budget.acquireRelayDial()),
      acquireRelayAttempt: () => stopwatch(() => budget.acquireRelayAttempt()),
      noteRelayDialFailure: () => budget.noteRelayDialFailure(),
      reportRateLimited: () => stopwatch(() => budget.reportRateLimited()),
      snapshot: () => budget.snapshot(),
      reset: () => budget.reset()
    },
    waitDuring
  };
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** Real-time poll with a deadline; returns how long the probe took to answer true
 * and whether it ever did. Never throws, so a step that cannot complete is
 * reported instead of hanging. */
async function waitFor(budgetMs: number, probe: () => boolean | Promise<boolean>): Promise<{ ms: number; ok: boolean }> {
  const start = performance.now();
  const deadline = start + budgetMs;
  for (;;) {
    if (await probe()) return { ms: performance.now() - start, ok: true };
    if (performance.now() >= deadline) return { ms: performance.now() - start, ok: false };
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function distribution(label: string, samples: { ms: number; ok: boolean }[]) {
  const delivered = samples.filter(sample => sample.ok).map(sample => sample.ms);
  if (!delivered.length) {
    console.log(`[latency] ${label}: 0/${samples.length} delivered inside the window — no distribution to report`);
    return;
  }
  console.log(`[latency] ${label}: delivered ${delivered.length}/${samples.length}; min=${Math.round(Math.min(...delivered))} `
    + `median=${Math.round(median(delivered))} max=${Math.round(Math.max(...delivered))} ms`);
  measured.push({ step: `${label} (median)`, ms: median(delivered), delivered: true });
}

// ---------------------------------------------------------------------------
// Runtime narrowing
// ---------------------------------------------------------------------------

/** The enrollment ceremony lives on the runtime; the shared fixture's structural
 * type predates it, so it is narrowed here exactly as `boardLifecycle.test.ts`
 * does rather than edited in the shared file. */
type EnrollmentRuntime = BrowserRuntime & {
  experimentalEnrollment: {
    initialize(kind: 'account'): Promise<EnrollmentBundle>;
    request(kind: 'account'): Promise<DeviceRequest>;
    approve(raw: string, deviceKeyId: string, email: string): Promise<EnrollmentBundle>;
    trust(raw: string, authorityFingerprint: string): Promise<unknown>;
  };
};
const enrollment = (browser: BrowserHandle) => browser.runtime as EnrollmentRuntime;
const channelState = (browser: BrowserHandle) => browser.runtime.accountChannel.status();

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('latency probe: two browsers, one account, production pacing', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let budgetA: AuthBudget;
  let budgetB: AuthBudget;
  let waitDuringA: (from: number, to: number) => number;
  let waitDuringB: (from: number, to: number) => number;
  let discovered = '';
  /** Relay device keys each browser was admitted under on the shared board. */
  let aDeviceKeys = new Set<string>();
  let bDeviceKeys = new Set<string>();

  const snapA = () => snapshot(a, budgetA, cloud);
  const snapB = () => snapshot(b, budgetB, cloud);

  /** Device keys holding a live relay room for `board`. */
  function keysHolding(board: string): Set<string> {
    const keys = new Set<string>();
    for (const socket of cloud.signaling.sockets as FakeSocketImpl[]) {
      if (!socket.deviceKeyId) continue;
      const boards = [...socket.rooms.values()].map(room => room.board);
      if (socket.room) boards.push(socket.room.board);
      if (boards.includes(board)) keys.add(socket.deviceKeyId);
    }
    return keys;
  }

  /** Whether the relay holds a live socket of browser B that carries `board`. */
  const bHolds = (board: string) => [...keysHolding(board)].some(key => bDeviceKeys.has(key));

  async function timeStep(
    step: string, ceilingMs: number, run: () => Promise<unknown>, probe: () => boolean | Promise<boolean>, note: (ok: boolean, ms: number) => string
  ): Promise<{ ok: boolean; ms: number }> {
    const beforeA = snapA(), beforeB = snapB();
    const cause = performance.now();
    await run();
    const outcome = await waitFor(Math.max(1, ceilingMs - (performance.now() - cause)), probe);
    const ms = performance.now() - cause;
    const finish = cause + ms;
    record(step, ms, { before: beforeA, after: snapA() }, { before: beforeB, after: snapB() }, outcome.ok, note(outcome.ok, ms),
      waitDuringA(cause, finish), waitDuringB(cause, finish));
    return { ok: outcome.ok, ms };
  }

  beforeAll(async () => {
    // The counter instance is captured when each browser's private module graph
    // loads, so the flag has to be stubbed before `createBrowser` evaluates it.
    vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
    cloud = createCloud();
    ({ budget: budgetA, waitDuring: waitDuringA } = meteredBudget());
    ({ budget: budgetB, waitDuring: waitDuringB } = meteredBudget());
    a = await createBrowser({ label: 'A', email: OWNER, cloud, authBudget: budgetA });
    b = await createBrowser({ label: 'B', email: OWNER, cloud, authBudget: budgetB });

    // Enrollment is what makes the account room admissible for B. A person does
    // this once, and its cost is measured like everything else.
    const enrolledAt = performance.now();
    const enrollBeforeA = snapA(), enrollBeforeB = snapB();
    await enrollment(a).experimentalEnrollment.initialize('account');
    const request = await enrollment(b).experimentalEnrollment.request('account');
    const bundle = await enrollment(a).experimentalEnrollment.approve(JSON.stringify(request), request.payload.deviceKeyId, OWNER);
    await enrollment(b).experimentalEnrollment.trust(JSON.stringify(bundle), await publicKeyFingerprint(bundle.authority));
    record('cold start: account enrollment (once)', performance.now() - enrolledAt,
      { before: enrollBeforeA, after: snapA() }, { before: enrollBeforeB, after: snapB() }, true,
      'device keys + account manifest to Drive + one approval round',
      waitDuringA(enrolledAt, performance.now()), waitDuringB(enrolledAt, performance.now()));

    // The account room is what makes board discovery realtime, so bringing it up
    // is part of the measured path. Both starts go out together and the channel's
    // own reconnect ledger owns the retries — no scenario-side sleep, so the
    // number is the product's, not the probe's.
    const channelAt = performance.now();
    const channelBeforeA = snapA(), channelBeforeB = snapB();
    const bothConnected = () => channelState(a).state === 'connected' && channelState(b).state === 'connected';
    await Promise.all([a.runtime.accountChannel.start(), b.runtime.accountChannel.start()]);
    let channel = await waitFor(CEILING.discovery, bothConnected);
    let extraPass = '';
    if (!channel.ok) {
      // The second device's key grant may need the holder's courier pass, which
      // is what a reconcile round drives. Recorded as a separate finding rather
      // than folded into the number above.
      const retryAt = performance.now();
      await a.runtime.googleDrive.reconcileAll({ force: true }).catch(() => undefined);
      await Promise.all([a.runtime.accountChannel.start(), b.runtime.accountChannel.start()]);
      channel = await waitFor(CEILING.discovery, bothConnected);
      extraPass = `; a courier-driven restart took a further ${Math.round(performance.now() - retryAt)}ms (${channel.ok ? 'connected' : 'still not connected'})`;
    }
    record('cold start: account channel (both browsers)', performance.now() - channelAt,
      { before: channelBeforeA, after: snapA() }, { before: channelBeforeB, after: snapB() }, channel.ok,
      `A=${channelState(a).state} B=${channelState(b).state} (${channelState(b).reason})${extraPass}`,
      waitDuringA(channelAt, performance.now()), waitDuringB(channelAt, performance.now()));
  }, 150_000);

  afterAll(async () => {
    const slowest = [...measured].sort((left, right) => right.ms - left.ms).slice(0, 4);
    console.log('[latency] slowest steps: ' + slowest.map(row => `${row.step} ${Math.round(row.ms)}ms`).join('; '));
    console.log('[latency] budget A: ' + JSON.stringify(budgetA.snapshot()));
    console.log('[latency] budget B: ' + JSON.stringify(budgetB.snapshot()));
    await b?.close();
    await a?.close();
  });

  async function openBoard(browser: BrowserHandle, boardId: string) {
    await browser.runtime.collaborationManager.start(boardId);
  }

  const synced = (browser: BrowserHandle, boardId: string) => logStatusOf(browser, boardId)?.phase === 'synced';

  /** Admission of a second same-account device: the grantee files a device
   * request, the online owner approves it, and both re-attach — the product's own
   * ceremony, as `sameAccount.test.ts` performs it. Returns the awaited leg times,
   * because "13 s" is only actionable once it is split into the rounds it is made
   * of. */
  async function admitBoth(boardId: string) {
    const legs: string[] = [];
    const leg = async (label: string, run: () => Promise<unknown>) => {
      const start = performance.now();
      await run();
      legs.push(`${label} ${Math.round(performance.now() - start)}ms`);
    };
    // B's round is what files the device request; A's and B's next rounds are what
    // approve it and let B read the grant. The pending wait is the scenario's own
    // observation of the directory, and it is reported apart.
    await leg('B identity round', () => b.runtime.boardCollaboration.identitySharing.sync(boardId, true).catch(() => undefined));
    const pendingStart = performance.now();
    await waitFor(6_000, () => (cloud.signaling.directory.get(boardId)?.pending.length ?? 0) >= 1);
    const pendingMs = performance.now() - pendingStart;
    for (const browser of [a, b]) {
      await leg(`${browser.label} grant round`, () => browser.runtime.boardCollaboration.identitySharing.sync(boardId, true).catch(() => undefined));
    }
    for (const browser of [a, b]) {
      await leg(`${browser.label} reattach`, async () => {
        await browser.runtime.collaborationManager.setEnabled(false);
        await browser.runtime.collaborationManager.setEnabled(true);
      });
    }
    return `legs: ${legs.join(', ')}, directory observation ${Math.round(pendingMs)}ms`;
  }

  it('scene 1: a board A created is discovered by B — the account channel or nothing', async () => {
    expect(channelState(b).state, 'B must hold the account channel before discovery can be attributed to it').toBe('connected');
    const appliedBefore = channelState(b).appliedSeq;
    const roundsBefore = b.counters().events['reconcile.round'] ?? 0;
    const arrivals: string[][] = [];
    const stop = b.rx.subscribeProjects(projects => arrivals.push(projects.map(project => project.id)));
    try {
      // The cause is the creation itself: the announcement is queued when the
      // local row appears (`markDirty`), so the clock starts before
      // `createProject`, not after the publish. Both legs run concurrently
      // because that is how the product behaves — the record races the Drive
      // publication, and the receiver defers it if Drive does not have the board
      // yet (src/sync/runtime.ts:582).
      const beforeA = snapA(), beforeB = snapB();
      const startedAt = performance.now();
      let created = '';
      const publishedAt: { ms: number } = { ms: -1 };
      const publish = (async () => {
        const board = await a.rx.createProject('Discovery probe', 'project');
        created = board.id;
        discovered = board.id;
        await a.rx.addItem({ projectId: board.id, content: 'first card' });
        await a.runtime.googleDrive.syncProject(board.id, { force: true });
        publishedAt.ms = performance.now() - startedAt;
      })();
      const seen = await waitFor(CEILING.discovery, () => Boolean(created) && arrivals.some(ids => ids.includes(created)));
      const discoveryMs = performance.now() - startedAt;
      await publish;
      record('1a. A: create board, card, publish to Drive', publishedAt.ms,
        { before: beforeA, after: snapA() }, { before: beforeB, after: snapB() }, true,
        'create + card + drive projection (the record is queued at creation)',
        waitDuringA(startedAt, startedAt + publishedAt.ms), waitDuringB(startedAt, startedAt + publishedAt.ms));
      record('1b. B: board row appears (no Drive poll)', discoveryMs,
        { before: beforeA, after: snapA() }, { before: beforeB, after: snapB() }, seen.ok,
        seen.ok
          ? `arrived ${discoveryMs < publishedAt.ms ? 'BEFORE' : 'after'} A's publish; account channel appliedSeq ${appliedBefore}→${channelState(b).appliedSeq}, lastKind=${channelState(b).lastKind ?? 'none'}, Drive rounds during the wait: ${(b.counters().events['reconcile.round'] ?? 0) - roundsBefore}`
          : `nothing within ${CEILING.discovery}ms; channel ${channelState(b).state} (${channelState(b).reason}), appliedSeq ${channelState(b).appliedSeq}, outbox ${channelState(b).outbox}, deferred ${channelState(b).deferred}`,
        waitDuringA(startedAt, startedAt + discoveryMs), waitDuringB(startedAt, startedAt + discoveryMs));
      expect(seen.ok, `B never received board ${discovered}: ${JSON.stringify(channelState(b))}`).toBe(true);
      expect(discoveryMs).toBeLessThan(CEILING.discovery);
    } finally { stop(); }
  });

  it('scene 2: an edit propagates while both hold the board open (realtime path)', async () => {
    expect(discovered, 'scene order: scene 1 created this board').not.toBe('');

    const openA = await timeStep('2a. A: open board → log synced', CEILING.open,
      () => openBoard(a, discovered), () => synced(a, discovered),
      ok => ok ? 'relay dial + attach + subscribe' : `never synced: ${JSON.stringify(logStatusOf(a, discovered) ?? null)}`);
    expect(openA.ok, `A never synced ${discovered}: ${JSON.stringify(logStatusOf(a, discovered) ?? null)}`).toBe(true);
    aDeviceKeys = keysHolding(discovered);

    // B's first open onto a board it is not yet granted: the device request, the
    // owner's approval, the grant re-read and the re-attach. One number, because
    // that is what a person waits for; the exchange column shows how many
    // identity rounds it took.
    const exchangesBefore = cloud.signaling.exchangeLog.length;
    let admissionLegs = '';
    const openB = await timeStep('2b. B: open board → admitted + log synced', CEILING.open,
      async () => { await openBoard(b, discovered); admissionLegs = await admitBoth(discovered); },
      () => synced(b, discovered),
      ok => `${cloud.signaling.exchangeLog.length - exchangesBefore} identity exchanges; ${admissionLegs}`
        + (ok ? '; then subscribe + replay' : `; never synced: log ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`));
    bDeviceKeys = new Set([...keysHolding(discovered)].filter(key => !aDeviceKeys.has(key)));
    expect(openB.ok, `B never synced ${discovered}: ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`).toBe(true);
    expect(bDeviceKeys.size, 'B must hold a relay connection of its own for the board').toBeGreaterThan(0);

    const seen: string[][] = [];
    const stop = b.rx.subscribeCards(discovered, cards => seen.push(cards.map(card => card.content)));
    try {
      const samples: { ms: number; ok: boolean }[] = [];
      for (let edit = 0; edit < 5; edit++) {
        const text = `realtime edit ${edit}`;
        const landed = await timeStep(`2c.${edit} A→B edit (both open)`, CEILING.realtimeEdit,
          () => a.rx.addItem({ projectId: discovered, content: text }),
          () => seen.some(list => list.includes(text)),
          ok => ok ? 'operation batch over the live board room' : `no emission in ${CEILING.realtimeEdit}ms; log ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`);
        samples.push(landed);
        expect(landed.ok, `edit "${text}" never reached B: ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`).toBe(true);
      }
      distribution('2c edit propagation, both browsers on the board', samples);
    } finally { stop(); }
  });

  it('scene 3: an edit while B works on a different board — what actually delivers it', async () => {
    expect(discovered).not.toBe('');
    // B's own board: no cross-device admission is needed, so the switch is a
    // clean detach rather than a loop against a board it cannot attach to.
    const parked = await b.rx.createProject('B is here instead', 'project');
    await b.runtime.googleDrive.syncProject(parked.id, { force: true });
    const leave = await timeStep('3a. B: switch board (own board first + detach)', CEILING.open,
      () => openBoard(b, parked.id), () => !bHolds(discovered) && synced(b, parked.id),
      ok => ok ? 'first attach to B\'s own board (admission + dial) and the shared room detached'
        : `relay still holds a room of B's for ${discovered} or its own board is not live; log ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`);
    expect(leave.ok, 'B never left the shared board, so "B is elsewhere" is not the state under test').toBe(true);

    const samples: { ms: number; ok: boolean }[] = [];
    for (let edit = 0; edit < 3; edit++) {
      const text = `idle edit ${edit}`;
      const landed = await timeStep(`3b.${edit} A→B edit (B elsewhere, ${IDLE_WINDOW_MS}ms window)`, IDLE_WINDOW_MS,
        () => a.rx.addItem({ projectId: discovered, content: text }),
        async () => (await b.rx.listCards(discovered)).some(card => card.content === text),
        ok => ok ? 'delivered while B is away — name the mechanism'
          : 'no passive delivery: no relay room, the edit-idle Drive flush is 30 min (syncPolicy.ts:3) and the account poll 10 min (:5)');
      samples.push(landed);
    }
    distribution('3b edits with B away (passive window only)', samples);

    // The next mechanism in production order: an account Drive poll round, which
    // is exactly what the 10-minute alarm runs (`src/sync/drivePolling.ts:12-25`).
    // It can only find what A actually published, so this leg separates "B never
    // looked" from "A never wrote it down".
    const editsSeen = () => b.rx.listCards(discovered).then(cards => cards.filter(card => card.content.startsWith('idle edit')).length);
    // The call's own cost and the passive window are measured apart: folding a
    // 25 s ceiling wait into the number would report the probe's patience as the
    // product's latency.
    const pollBeforeA = snapA(), pollBeforeB = snapB();
    const pollAt = performance.now();
    await b.runtime.googleDrive.reconcileAll({ force: true });
    const pollMs = performance.now() - pollAt;
    const foundByPoll = await waitFor(2_000, async () => await editsSeen() === 3);
    record('3c. B: an account Drive poll round (the 10-min alarm leg)', pollMs,
      { before: pollBeforeA, after: snapA() }, { before: pollBeforeB, after: snapB() }, foundByPoll.ok,
      foundByPoll.ok ? 'the poll found the edits — A had published'
        : 'the round found nothing: A\'s edits are unpublished (edit-idle flush 30 min, max-unpublished 25 min — src/sync/syncPolicy.ts:3-4), so there is nothing for B to poll for',
      waitDuringA(pollAt, pollAt + pollMs), waitDuringB(pollAt, pollAt + pollMs));

    // The mechanism a person actually uses: open the board. The relay's own
    // retained history is then the source, not Drive.
    const caughtUp = await timeStep('3d. B: reopen board → the edits arrive', CEILING.open,
      () => openBoard(b, discovered),
      async () => synced(b, discovered) && await editsSeen() === 3,
      ok => ok ? 'catch-up on attach from the log\'s replay window'
        : `still missing after ${CEILING.open}ms: ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`);
    expect(foundByPoll.ok || caughtUp.ok, 'the edits reached B by no mechanism at all — neither the poll nor reopening the board').toBe(true);
    console.log(`[latency] finding: an edit to a board B does not hold open is delivered by ${
      foundByPoll.ok ? 'a Drive poll round' : caughtUp.ok ? 'reopening the board (the relay replay window)' : 'nothing'}`
      + `${foundByPoll.ok ? '' : `; the poll round itself took ${Math.round(pollMs)}ms and delivered nothing`}`);

    // Back to a state where B holds the shared board, for the reconnect scene.
    bDeviceKeys = new Set([...keysHolding(discovered)].filter(key => !aDeviceKeys.has(key)));
  });

  it('scene 4: reconnect cost — B\'s relay sockets die, then the next edit must land', async () => {
    expect(bDeviceKeys.size, 'scene 2 must have identified B\'s device keys').toBeGreaterThan(0);
    const mine = (cloud.signaling.sockets as FakeSocketImpl[]).filter(socket => bDeviceKeys.has(socket.deviceKeyId));
    expect(mine.length, 'B held no relay socket to kill').toBeGreaterThan(0);

    const killed = mine.length;
    const killedAt = performance.now();
    const beforeA = snapA(), beforeB = snapB();
    for (const socket of mine) socket.kill();
    const reattached = await waitFor(CEILING.reattach, () => bHolds(discovered) && synced(b, discovered));
    record('4a. B: sockets killed → room re-attached', performance.now() - killedAt,
      { before: beforeA, after: snapA() }, { before: beforeB, after: snapB() }, reattached.ok,
      reattached.ok ? `${killed} socket(s) killed; reconnect backoff base 1 s ±25% (logSession.ts:566)`
        : `no re-attach in ${CEILING.reattach}ms; log ${JSON.stringify(logStatusOf(b, discovered) ?? null)}, dials ${JSON.stringify(budgetB.snapshot().relayDials)}`,
      waitDuringA(killedAt, killedAt + reattached.ms), waitDuringB(killedAt, killedAt + reattached.ms));
    expect(reattached.ok, `B never re-attached: ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`).toBe(true);

    const seen: string[][] = [];
    const stop = b.rx.subscribeCards(discovered, cards => seen.push(cards.map(card => card.content)));
    try {
      const text = 'first edit after reconnect';
      const landed = await timeStep('4b. A→B edit after the reconnect', CEILING.postReconnectEdit,
        () => a.rx.addItem({ projectId: discovered, content: text }),
        () => seen.some(list => list.includes(text)),
        ok => ok ? 'the re-attached room carries new batches' : 'the room is back but the edit did not cross it');
      expect(landed.ok, `the edit after the reconnect never reached B: ${JSON.stringify(logStatusOf(b, discovered) ?? null)}`).toBe(true);
    } finally { stop(); }
  });
});
