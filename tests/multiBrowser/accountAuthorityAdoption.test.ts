/**
 * The account authority's bootstrap, in the one state that used to have no
 * answer: an `account:<hash>` pin already exists.
 *
 * The field defect this pins down: the automatic bootstrap generated a fresh
 * authority key and then tried to publish over the manifest the *existing*
 * authority had signed, so every browser whose account had been pinned by the
 * old enrollment button ended at
 * `no account pin [absent-pin] authority:failed (Manifest authority does not
 * match the pinned authority)` and its account room could never start.
 *
 * The rule these scenarios hold the code to: **a pin is truth**. The bootstrap
 * reuses it (`adopted` when this browser holds its key), never generates a key
 * that would replace it, states `authority-not-local` when the pinned key is
 * genuinely absent from this browser, and never moves the pin — not on success,
 * not on refusal, not when two contexts race.
 *
 * Timing follows the rest of `tests/multiBrowser`: waiting means polling an
 * observable on zero-delay task-queue turns within a real-time budget, never a
 * fixed wall-clock sleep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, createSharedProfile, type BrowserHandle, type Cloud } from './fixtures/browser';
import { hashBlob } from '../../src/storage/blobStore';
import { generateDeviceKey } from '../../src/collab/security/keys';
import type { EnrollmentBundle } from '../../src/collab/security/enrollment';

/** What the runtime publishes about the account room and its authority. */
type AccountChannelStatus = {
  account: string | null;
  state: string;
  reason: string;
  error: string | null;
  authority?: { state: string; reason: string; authorization?: string };
};
type AccountRuntime = {
  experimentalEnrollment: { initialize(kind: 'account'): Promise<EnrollmentBundle> };
  accountChannel: { status(): AccountChannelStatus; start(): Promise<void>; close(): Promise<void> };
};
const runtime = (browser: BrowserHandle) => browser.runtime as unknown as AccountRuntime;
const status = (browser: BrowserHandle) => runtime(browser).accountChannel.status();
const describeStatus = (browser: BrowserHandle) => JSON.stringify(status(browser));

type PinnedAuthority = {
  scope: string;
  authorityKeyId: string;
  authorityPublicKey: unknown;
  pinnedAt: number;
  kind: 'account';
};
const pinsOf = async (browser: BrowserHandle): Promise<Record<string, PinnedAuthority>> =>
  ((await browser.storage.get('pboardSecurityPins')).pboardSecurityPins ?? {}) as Record<string, PinnedAuthority>;

/** Polls one observable on task-queue turns within a real-time budget. */
async function until(observable: () => boolean, budgetMs = 20_000): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (observable()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  return observable();
}
async function untilSettled(probe: () => Promise<boolean>, budgetMs = 20_000): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (await probe()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  return probe();
}

/** The product's own startup: a board is opened, which is what starts the
 * account channel and therefore the authority bootstrap. Nothing here calls the
 * bootstrap directly — the scenario is about what a person's board open does. */
async function openBoard(browser: BrowserHandle, name: string): Promise<string> {
  const board = await browser.rx.createProject(name, 'project');
  await browser.runtime.googleDrive.syncProject(board.id, { force: true });
  await browser.runtime.collaborationManager.start(board.id);
  return board.id;
}

/** A fresh Google account per scenario: `appDataFolder` is private per account,
 * so this is what keeps one scenario's published authority out of the next. */
const freshEmail = () => `adopt-${crypto.randomUUID()}@example.com`;

describe('account authority: an existing pin is truth', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  beforeAll(() => { cloud = createCloud(); });

  it('reuses the pin an earlier enrollment wrote, instead of minting a second authority', async () => {
    const email = freshEmail();
    const account = await hashBlob(new Blob([email]));
    const browser = await createBrowser({ label: 'pinned', email, cloud });
    try {
      // The old enrollment button: authority key minted, manifest published,
      // `account:<hash>` pinned. This is the state every field-broken browser
      // was in when the automatic bootstrap refused it.
      await runtime(browser).experimentalEnrollment.initialize('account');
      const before = (await pinsOf(browser))[`account:${account}`];
      expect(before, 'the enrollment wrote the pin').toBeDefined();

      await openBoard(browser, 'Pinned before the bootstrap');

      expect(await until(() => status(browser).authority?.state === 'adopted'),
        `the bootstrap must adopt the pin it found: ${describeStatus(browser)}`).toBe(true);
      expect(status(browser).authority?.reason, 'the report says the pin was reused, not merely that one exists')
        .toMatch(/reused/);
      expect(status(browser).authority?.reason, 'and that this browser holds the authority key').toMatch(/holds its key/);

      // Never moved: the same key, the same pin timestamp, the same manifest.
      expect((await pinsOf(browser))[`account:${account}`], 'an adopted pin is not rewritten').toEqual(before);
      const authorityKeyIds = new Set(cloud.drive.files
        .filter(file => file.appDataOwner === email && file.name.startsWith('pboard-account-manifest-'))
        .map(file => new TextDecoder().decode(file.bytes)));
      expect(authorityKeyIds.size, 'exactly one published account authority').toBe(1);

      // And the room itself works: this browser holds the authority key, so its
      // own courier pass creates the account content key and the channel dials.
      expect(await until(() => status(browser).state === 'connected'),
        `the account room must start for a browser whose pin was adopted: ${describeStatus(browser)}`).toBe(true);
    } finally { await browser.close(); }
  });

  it('states `authority-not-local` — not a mismatch — when the pinned key is not in this browser', async () => {
    const email = freshEmail();
    const account = await hashBlob(new Blob([email]));
    const authority = await generateDeviceKey();
    const pin: PinnedAuthority = { scope: account, authorityKeyId: authority.keyId,
      authorityPublicKey: authority.publicJwk, pinnedAt: 1, kind: 'account' };
    const browser = await createBrowser({ label: 'pin-without-key', email, cloud,
      seed: { pboardSecurityPins: { [`account:${account}`]: pin } } });
    try {
      await openBoard(browser, 'Pinned elsewhere');

      expect(await until(() => status(browser).authority?.state === 'authority-not-local'),
        `the absent key is its own stated cause: ${describeStatus(browser)}`).toBe(true);
      const reason = status(browser).authority!.reason;
      expect(reason, 'the reason names the missing key').toMatch(/does not hold its key/);
      expect(reason, 'and never reports it as an authority mismatch').not.toMatch(/does not match/);

      // The pin is untouched, and no account authority was minted in its
      // place: nothing was generated, so no authority file was published to
      // this account's Drive. Board grant mirrors are a different artifact —
      // public grant metadata a first board legitimately publishes — and are
      // not this assertion's subject.
      expect((await pinsOf(browser))[`account:${account}`]).toEqual(pin);
      expect(cloud.drive.files.some(file => file.appDataOwner === email && file.name.startsWith('pboard-account-manifest-')), 'no account authority was published')
        .toBe(false);
    } finally { await browser.close(); }
  });

  it('leaves the pin untouched when Drive holds a manifest signed by a different authority', async () => {
    const email = freshEmail();
    const account = await hashBlob(new Blob([email]));
    const owner = await createBrowser({ label: 'owner', email, cloud });
    const other = await generateDeviceKey();
    const foreignPin: PinnedAuthority = { scope: account, authorityKeyId: other.keyId,
      authorityPublicKey: other.publicJwk, pinnedAt: 7, kind: 'account' };
    let confused: BrowserHandle | undefined;
    try {
      // The account's real authority publishes; this browser is pinned to a
      // different key (a pin from before a recovery, a copied profile).
      await runtime(owner).experimentalEnrollment.initialize('account');
      confused = await createBrowser({ label: 'confused', email, cloud,
        seed: { pboardSecurityPins: { [`account:${account}`]: foreignPin } } });

      await openBoard(confused, 'Pinned to another authority');

      expect(await until(() => status(confused!).authority?.state === 'failed'),
        `a manifest under a foreign authority is refused: ${describeStatus(confused)}`).toBe(true);
      expect(status(confused).authority!.reason, 'the refusal says which fact disagreed')
        .toMatch(/signed by a different authority/);
      expect(status(confused).authority!.reason, 'and it does not pretend the pin matched').not.toMatch(/does not match the pinned/);
      expect((await pinsOf(confused))[`account:${account}`], 'a refusal never moves the pin').toEqual(foreignPin);
    } finally {
      await confused?.close();
      await owner.close();
    }
  });

  it('two contexts racing with no pin end with exactly one pin, byte-identical to the published authority', async () => {
    const email = freshEmail();
    const account = await hashBlob(new Blob([email]));
    // One browser profile, two JS contexts — the worker and the sidebar, each
    // running its own bootstrap over the same storage and the same keys.
    const profile = createSharedProfile();
    const [worker, sidebar] = await Promise.all([
      createBrowser({ label: 'race-worker', email, cloud, profile }),
      createBrowser({ label: 'race-sidebar', email, cloud, profile })
    ]);
    try {
      // Starting the channel is the product's own trigger (a board open and a
      // reconcile round both call it). Neither start is awaited: the product
      // contract is that nothing a person waits for depends on the account
      // room, so the assertion is the pin, not the channel's promise.
      void runtime(worker).accountChannel.start().catch(() => undefined);
      void runtime(sidebar).accountChannel.start().catch(() => undefined);

      expect(await untilSettled(async () => Boolean((await pinsOf(worker))[`account:${account}`]), 30_000),
        `one of the two contexts must establish the pin: worker ${describeStatus(worker)}; sidebar ${describeStatus(sidebar)}`).toBe(true);
      const pins = await pinsOf(worker);
      expect(Object.keys(pins).filter(key => key.startsWith('account:')), 'exactly one account pin').toEqual([`account:${account}`]);

      // The pin names the authority Drive actually holds — the loser adopted
      // the winner's authority instead of minting a second one.
      const published = cloud.drive.files.filter(file => file.appDataOwner === email
        && file.name.startsWith('pboard-account-manifest-'));
      expect(published.length, 'one published account authority, however many contexts raced').toBe(1);
      const parsed = JSON.parse(new TextDecoder().decode(published[0].bytes)) as
        { authority: { x: string; y: string } };
      const { publicKeyFingerprint } = await import('../../src/collab/security/keys');
      expect(pins[`account:${account}`].authorityKeyId).toBe(await publicKeyFingerprint(
        { kty: 'EC', crv: 'P-256', x: parsed.authority.x, y: parsed.authority.y }));

      // And neither context reports the other as a mismatch.
      for (const handle of [worker, sidebar]) {
        const authority = status(handle).authority;
        expect(authority?.state, `the race leaves no browser at a mismatch: ${describeStatus(handle)}`)
          .not.toBe('failed');
      }
    } finally {
      await sidebar.close();
      await worker.close();
    }
  });
});
