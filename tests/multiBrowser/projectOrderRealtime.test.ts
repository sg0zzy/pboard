/**
 * Project-list sorting as a realtime, account-level fact.
 *
 * The order is a property of the *per-account list*, not of one board, so its
 * vehicle is the account room: a `board.order` record carrying the total order
 * plus a clock, published when `reorderProjects` settles and consumed by
 * applying the order locally. The Drive preference document stays the durable
 * record a fresh browser reads.
 *
 * These scenarios are the acceptance for that shape, in the user's terms:
 *  - (a) A reorders while both sessions are connected; B's `listProjects()`
 *    order matches with **zero** Drive reconcile rounds on B.
 *  - (b) one settling reorder is one record — a drag preview publishes nothing,
 *    and a burst of reorders collapses in the outbox.
 *  - (c) B holds a board A's order does not mention: B keeps it, at a defined
 *    relative position.
 *  - (d) two concurrent reorders converge to one order in both browsers.
 *  - (e) applying a realtime order publishes nothing (no echo).
 *
 * Waiting is in scheduler turns on zero-delay timers, the convention the rest
 * of `tests/multiBrowser` uses; every assertion is on counts or on values the
 * test wrote, never on elapsed time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, type BrowserHandle, type Cloud } from './fixtures/browser';
import { hashBlob } from '../../src/storage/blobStore';
import { publicKeyFingerprint } from '../../src/collab/security/keys';
import type { DeviceRequest, EnrollmentBundle } from '../../src/collab/security/enrollment';
import type { AccountLifecycleChannel } from '../../src/sync/operations/accountChannel';
import type { Project } from '../../src/types';

const OWNER = 'owner@example.com';

type AccountRuntime = {
  experimentalEnrollment: {
    initialize(kind: 'account'): Promise<EnrollmentBundle>;
    request(kind: 'account'): Promise<DeviceRequest>;
    approve(raw: string, deviceKeyId: string, email: string): Promise<EnrollmentBundle>;
    trust(raw: string, authorityFingerprint: string): Promise<unknown>;
  };
  accountChannel: AccountLifecycleChannel;
};
const runtime = (browser: BrowserHandle) => browser.runtime as unknown as AccountRuntime;
const ordersApplied = (browser: BrowserHandle) => runtime(browser).accountChannel.status().appliedByKind['board.order'] ?? 0;
const channelProblem = (browser: BrowserHandle) => JSON.stringify(runtime(browser).accountChannel.status());

/**
 * Bounded wait over the observable the scenario owns.
 *
 * Both bounds are needed. A turn count alone is not a timeout: a zero-delay
 * spin runs tens of thousands of turns in the time one real millisecond takes,
 * so it exhausts long before a real timer fires — and one leg of these
 * scenarios really does wait on a timer (the relay goes `unreachable`, the
 * socket is killed, and the channel's reconnect ladder is a `setTimeout` with a
 * one-second base). Under parallel suite load that turned "the collapsed order
 * never reached B" into a load-dependent failure. The 1 ms yield plus the
 * real-time budget is the same rule `tests/multiBrowser/boardLifecycle.test.ts`
 * documents.
 */
async function until(probe: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (await probe()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  return await probe();
}

async function enrollSecondDevice(owner: BrowserHandle, joiner: BrowserHandle, email: string) {
  const request = await runtime(joiner).experimentalEnrollment.request('account');
  const bundle = await runtime(owner).experimentalEnrollment.approve(JSON.stringify(request), request.payload.deviceKeyId, email);
  await runtime(joiner).experimentalEnrollment.trust(JSON.stringify(bundle), await publicKeyFingerprint(bundle.authority));
}

async function connectAccountChannel(...browsers: BrowserHandle[]) {
  for (let pass = 0; pass < 3; pass++) {
    for (const browser of browsers) await runtime(browser).accountChannel.start();
    if (browsers.every(browser => runtime(browser).accountChannel.status().state === 'connected')) return;
  }
}

const projectIds = async (browser: BrowserHandle) => (await browser.rx.listProjects()).map(project => project.id);

describe('project-list sorting over the account room', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let account = '';
  /** The boards both browsers hold, in the order A lists them. */
  let boards: Project[] = [];

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'laptop', email: OWNER, cloud });
    b = await createBrowser({ label: 'desktop', email: OWNER, cloud });
    account = await hashBlob(new Blob([OWNER]));
    await runtime(a).experimentalEnrollment.initialize('account');
    await enrollSecondDevice(a, b, OWNER);
    // Both browsers hold the same three boards. A creates them; B takes the
    // snapshot directly, so setup never depends on a Drive round trip.
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const project = await a.rx.createProject(name, 'project');
      await b.rx.importProject(project, []);
      boards.push(project);
    }
    // Both channels connect, which is also what scopes each repository to this
    // account's order document (`runtime.ts:ensureAccountChannel`).
    await connectAccountChannel(a, b);
    expect(runtime(a).accountChannel.status().state, `A's account channel: ${channelProblem(a)}`).toBe('connected');
    expect(runtime(b).accountChannel.status().state, `B's account channel: ${channelProblem(b)}`).toBe('connected');
  }, 120_000);

  afterAll(async () => {
    await b?.close();
    await a?.close();
  });

  it('(a) A reorders and B follows, with zero reconcile rounds on B', async () => {
    const [alpha, beta, gamma] = boards.map(project => project.id);
    expect(await projectIds(a), 'setup: A lists the boards in creation order').toEqual([alpha, beta, gamma]);
    expect(await projectIds(b), 'setup: B holds the same boards in the same order').toEqual([alpha, beta, gamma]);

    // Count Drive rounds on B: the claim is "the record was the source", not
    // "the poll arrived first".
    const provider = b.runtime.googleDrive;
    const real = provider.reconcileAll.bind(provider);
    let polls = 0;
    provider.reconcileAll = (async (options?: Parameters<typeof real>[0]) => { polls++; return await real(options); }) as typeof provider.reconcileAll;
    const before = ordersApplied(b);
    try {
      await a.rx.reorderProjects([gamma, alpha, beta]);
      expect(await until(async () => (await projectIds(b)).join(',') === [gamma, alpha, beta].join(',')),
        `B never took A's order; its channel says ${channelProblem(b)}`).toBe(true);
      expect(await projectIds(a)).toEqual([gamma, alpha, beta]);
      expect(ordersApplied(b) - before, 'one record carried the order').toBe(1);
      expect(polls, 'the order arrived over the room, not from a Drive reconcile round').toBe(0);
    } finally { provider.reconcileAll = real; }
  });

  it('(b) one settling reorder is one record, and a burst collapses in the outbox', async () => {
    const [alpha, beta, gamma] = boards.map(project => project.id);
    // A drag preview never reaches the repository: `ProjectPicker` computes the
    // preview locally and calls `reorderProjects` once, on drop. So one settled
    // drop is one record.
    const before = ordersApplied(b);
    await a.rx.reorderProjects([beta, gamma, alpha]);
    // Wait on the *list*, not on the applied counter: the counter names the
    // record handed to the verification path, and the repository apply is the
    // step after it. "One record" is asserted once the list has moved.
    expect(await until(async () => (await projectIds(b)).join(',') === [beta, gamma, alpha].join(',')),
      `B did not take the single order record: ${channelProblem(b)}`).toBe(true);
    expect(ordersApplied(b) - before, 'one settling reorder is one order record').toBe(1);

    // A burst with the room unreachable: the outbox is keyed by the record's
    // scope id, so five reorders queue one order record — the newest — not five.
    const signaling = cloud.signaling;
    signaling.unreachable = true;
    try {
      for (const socket of signaling.sockets.filter(socket => socket.room?.board === `account:${account}`)) socket.kill();
      expect(await until(() => runtime(a).accountChannel.status().state !== 'connected' || runtime(a).accountChannel.status().outbox === 0),
        'A had no queued record to start from').toBe(true);
      const beforeBurst = runtime(a).accountChannel.status().outbox;
      for (const order of [[alpha, beta, gamma], [gamma, beta, alpha], [beta, alpha, gamma], [alpha, gamma, beta], [gamma, alpha, beta]]) {
        await a.rx.reorderProjects(order);
      }
      expect(await until(() => runtime(a).accountChannel.status().outbox > beforeBurst)).toBe(true);
      expect(runtime(a).accountChannel.status().outbox - beforeBurst,
        'a burst of reorders is one order record, not one per step').toBe(1);
    } finally { signaling.unreachable = false; }

    // And the collapsed record is the newest order: it is what B ends with.
    expect(await until(async () => (await projectIds(b)).join(',') === [gamma, alpha, beta].join(',')),
      `the collapsed order never reached B: ${channelProblem(b)}`).toBe(true);
    expect(await projectIds(a)).toEqual([gamma, alpha, beta]);
  });

  it('(c) B keeps a board A\'s order does not mention, at a defined relative position', async () => {
    const [alpha, beta, gamma] = boards.map(project => project.id);
    // A board only B has: created there, never announced, never seen by A.
    const mine = await b.rx.createProject('Only on the desktop', 'project');
    await b.rx.setProjectOrderAccount(await connectedAccount(b));
    // B's list is alpha, mine, beta, gamma — `mine` sits right after alpha.
    await b.rx.reorderProjects([alpha, mine.id, beta, gamma]);
    expect(await projectIds(b)).toEqual([alpha, mine.id, beta, gamma]);

    // A reorders the boards it has: gamma before alpha, beta after alpha.
    await a.rx.reorderProjects([gamma, alpha, beta]);
    const expected = [gamma, alpha, mine.id, beta];
    expect(await until(async () => (await projectIds(b)).join(',') === expected.join(',')),
      `B's merge did not keep its own board in place; it lists ${JSON.stringify(await projectIds(b))} (${channelProblem(b)})`).toBe(true);
    // Never imported into A: an order is not a creation record.
    expect(await projectIds(a), 'an order must not import a board the sender does not have').toEqual([gamma, alpha, beta]);
    // And B never lost it.
    expect((await b.rx.listProjects()).some(project => project.id === mine.id)).toBe(true);
  });

  it('(d) two concurrent reorders converge to one order in both browsers', async () => {
    const [alpha, beta, gamma] = boards.map(project => project.id);
    const mine = (await b.rx.listProjects()).find(project => project.name === 'Only on the desktop')!.id;
    // Put both lists back to a common baseline, then reorder in the same turn.
    await a.rx.reorderProjects([alpha, beta, gamma]);
    await b.rx.reorderProjects([alpha, beta, gamma, mine]);
    await until(async () => (await projectIds(b)).join(',') === [alpha, beta, gamma, mine].join(',') && (await projectIds(a)).join(',') === [alpha, beta, gamma].join(','));

    const beforeA = ordersApplied(a), beforeB = ordersApplied(b);
    await Promise.all([
      a.rx.reorderProjects([gamma, beta, alpha]),
      b.rx.reorderProjects([beta, alpha, gamma, mine])
    ]);
    // Each session must apply the other's record: two new order rows each.
    expect(await until(() => ordersApplied(a) - beforeA >= 1 && ordersApplied(b) - beforeB >= 1),
      `the concurrent reorders did not both cross the room: A ${channelProblem(a)}, B ${channelProblem(b)}`).toBe(true);
    // Convergence is on the shared boards, which is what both sessions can
    // express; B's private board has no rank on A and stays local to B. The
    // winner is the newer of the two records by `updatedAt`-then-`seq`, so the
    // agreed order is exactly one of the two orders that were asked for — never
    // a blend of them and never a per-device difference.
    const asked = [[gamma, beta, alpha].join(','), [beta, alpha, gamma].join(',')];
    expect(await until(async () => {
      const ofA = (await projectIds(a)).join(',');
      const ofB = (await projectIds(b)).filter(id => id !== mine).join(',');
      return ofA === ofB && asked.includes(ofA);
    }), `the two sessions kept different orders: A ${JSON.stringify(await projectIds(a))}, B ${JSON.stringify(await projectIds(b))}`).toBe(true);
    expect((await projectIds(a))).toEqual((await projectIds(b)).filter(id => id !== mine));
  });

  it('(e) applying a realtime order publishes nothing — no echo back into the room', async () => {
    const [alpha, beta, gamma] = boards.map(project => project.id);
    const channel = runtime(b).accountChannel;
    const realPublish = channel.publishOrder.bind(channel);
    const realPublishLocal = channel.publishLocalOrder.bind(channel);
    let orderRecords = 0;
    channel.publishOrder = async (...args) => { orderRecords++; return await realPublish(...args); };
    channel.publishLocalOrder = async (...args) => { orderRecords++; return await realPublishLocal(...args); };
    const before = ordersApplied(b);
    try {
      await a.rx.reorderProjects([beta, alpha, gamma]);
      expect(await until(() => ordersApplied(b) - before >= 1), `B never applied the order: ${channelProblem(b)}`).toBe(true);
      expect(await until(async () => (await projectIds(b)).filter(id => id !== undefined).slice(0, 3).join(',') === [beta, alpha, gamma].join(','))).toBe(true);
      // The apply is a local write; it must not look like a reorder.
      expect(orderRecords, 'applying an order must not queue a record (the poll would otherwise become the realtime path)').toBe(0);
    } finally {
      channel.publishOrder = realPublish;
      channel.publishLocalOrder = realPublishLocal;
    }
  });
});

/** B's order scope, as the channel set it: the hashed Google account. Every
 * `reorderProjects` on B then writes the same document a received order does. */
async function connectedAccount(browser: BrowserHandle): Promise<string> {
  const status = runtime(browser).accountChannel.status();
  if (!status.account) throw new Error(`B has no connected account scope: ${JSON.stringify(status)}`);
  return status.account;
}
