/**
 * The account authority's explicit re-pin: the one way out of the `foreign`
 * dead end, and the proof that it is never automatic.
 *
 * The field state: the pin names authority A, the account file published in this
 * account's Drive `appDataFolder` is signed by authority B, and the automatic
 * bootstrap reports
 * `no account pin [absent-pin] authority:failed (… signed by a different
 * authority …)` while changing nothing. That fail-closed default is deliberate —
 * whoever can write that folder could otherwise become the account's authority —
 * and it stays the default here:
 *
 *  - `repinPublishedAuthority()` trusts the *published* authorization, but only
 *    after verifying it under the key it carries, checking that it names exactly
 *    `account:<hash>`, that it lists this browser's own account device, that it
 *    is unexpired, and that both Drive bindings are empty. Each refusal names
 *    itself and leaves every byte of storage alone.
 *  - Nothing automatic calls it. Opening a board over the same *valid* published
 *    manifest a re-pin would accept still ends in `failed` with the pin
 *    untouched — the only difference between the two outcomes is the gesture.
 *  - Re-pinning twice is the same pin, not a second write.
 *  - The account room's queued lifecycle records are not touched by the act and
 *    flush from it.
 *
 * Timing follows the rest of `tests/multiBrowser`: waiting polls an observable on
 * zero-delay task-queue turns within a real-time budget, never a fixed sleep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, createSharedProfile, type BrowserHandle, type Cloud, type SharedProfile } from './fixtures/browser';
import { hashBlob } from '../../src/storage/blobStore';
import { generateDeviceKey, importSigningKey, publicKeyFingerprint, signBytes, type StoredDeviceKey } from '../../src/collab/security/keys';
import { validateManifest, type BoardPermissionManifest, type ManifestDevice } from '../../src/collab/security/manifest';
import { DOMAIN_MANIFEST, signedBytes } from '../../src/collab/security/canonical';
import { openAccountAuthorityFile, sealAccountAuthorityFile } from '../../src/collab/security/accountAuthority';
import type { AccountChannelStatus } from '../../src/sync/operations/accountChannel';
import type { AccountRepinResult } from '../../src/sync/runtime';

type AccountRuntime = {
  accountChannel: {
    status(): AccountChannelStatus;
    start(): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
    repinPublishedAuthority(): Promise<AccountRepinResult>;
  };
};
const runtime = (browser: BrowserHandle) => browser.runtime as unknown as AccountRuntime;
const status = (browser: BrowserHandle) => runtime(browser).accountChannel.status();
const describeStatus = (browser: BrowserHandle) => JSON.stringify(status(browser));

type PinnedAuthority = {
  scope: string; authorityKeyId: string; authorityPublicKey: unknown; pinnedAt: number; kind: 'account';
};
const pinsOf = async (browser: BrowserHandle): Promise<Record<string, PinnedAuthority>> =>
  ((await browser.storage.get('pboardSecurityPins')).pboardSecurityPins ?? {}) as Record<string, PinnedAuthority>;

/** Polls one observable on task-queue turns within a real-time budget. The
 * optional `nudge` is what a caller uses instead of a timer: each turn asks the
 * product to try again (`flush`), which is the same act its own `synced` edge
 * performs. */
async function until(observable: () => boolean, budgetMs = 20_000, nudge?: () => Promise<void>): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (observable()) return true;
    await nudge?.();
    if (observable()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  return observable();
}

/** The product's own startup: a board open starts the account channel and
 * therefore the authority bootstrap. */
async function openBoard(browser: BrowserHandle, name: string): Promise<string> {
  const board = await browser.rx.createProject(name, 'project');
  await browser.runtime.googleDrive.syncProject(board.id, { force: true });
  await browser.runtime.collaborationManager.start(board.id);
  return board.id;
}

const freshEmail = (label: string) => `repin-${label}-${crypto.randomUUID()}@example.com`;

/** The device-key store this profile shares between its runtime contexts. The
 * keys module is evaluated once per browser graph and pinned to this factory, so
 * seeding the same store is what lets a scenario model "this browser already has
 * an account device key" before any runtime code has run. */
function keyDatabase(profile: SharedProfile): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = profile.keyFactory.open('pboard-security-keys', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('device-keys')) request.result.createObjectStore('device-keys');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedPurposeKey(profile: SharedProfile, purpose: string, key: StoredDeviceKey): Promise<void> {
  const database = await keyDatabase(profile);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('device-keys', 'readwrite');
      // The same two slots `ensureDeviceKey` writes: the purpose slot it reads and
      // the key id the store keeps by identity.
      transaction.objectStore('device-keys').put(key, `purpose:${purpose}`);
      transaction.objectStore('device-keys').put(key, key.keyId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

/** Publishes one account-authority file into this account's `appDataFolder`
 * exactly as `createDriveTransport(...).upload` would: multipart metadata plus
 * payload, owned by the account. This is the file the runtime reads. */
async function publishAccountAuthority(cloud: Cloud, email: string, account: string, contents: string) {
  // The fixture resolves a caller from its bearer, so the account has to exist
  // before the file is written. `createBrowser` registers the same account and
  // token again; the map entry is the same key, so this is idempotent.
  const token = cloud.drive.addAccount(email);
  const boundary = `pboard_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const metadata = JSON.stringify({ name: `pboard-account-manifest-${account}.pboard`, parents: ['appDataFolder'], mimeType: 'application/json' });
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', metadata,
    `--${boundary}`, 'Content-Type: application/json', '', contents,
    `--${boundary}--`, ''
  ].join('\r\n');
  const response = await cloud.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, Authorization: `Bearer ${token}` },
    body
  });
  expect(response.ok, 'the fixture Drive accepted the published account authorization').toBe(true);
}

const accountManifest = (account: string, authority: StoredDeviceKey, devices: ManifestDevice[], overrides: Partial<BoardPermissionManifest> = {}): BoardPermissionManifest => ({
  protocol: 2, boardId: `account:${account}`, driveProjectFileId: '', driveFolderId: '',
  authorityKeyId: authority.keyId, epoch: 7, issuedAt: Date.now(), expiresAt: Date.now() + 240_000,
  devices, ...overrides
});

/** Signs a payload directly. `signManifest` validates first, which is right for
 * the product and useless for the one refusal a scenario has to construct: an
 * account manifest that claims a Drive binding. The signature here is genuine, so
 * the refusal under test is the rule, not a broken signature. */
const rawSignature = async (payload: BoardPermissionManifest, authority: StoredDeviceKey): Promise<string> =>
  await signBytes(await importSigningKey(authority.privateJwk as JsonWebKey), signedBytes(DOMAIN_MANIFEST, payload as never));

/** The published file for one manifest, sealed the way the product seals it. */
async function published(manifest: BoardPermissionManifest, authority: StoredDeviceKey, signature?: string) {
  const payload = validateManifest(manifest);
  return sealAccountAuthorityFile(authority.publicJwk, {
    payload, signature: signature ?? await rawSignature(payload, authority)
  });
}

describe('account authority: explicit re-pin out of a foreign pin', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  beforeAll(() => { cloud = createCloud(); });

  it('re-pins to the published authority and opens the account room when its key is local', async () => {
    const email = freshEmail('success');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    const authority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 11, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    // This browser is the account's authority (its key is here) and its pin is
    // stale, which is the dead end: the published file is the truth it cannot reach.
    await seedPurposeKey(profile, `account-authority:${account}`, authority);
    await seedPurposeKey(profile, `account-device:${account}`, own);
    await publishAccountAuthority(cloud, email, account, await published(accountManifest(account, authority, [
      { deviceKeyId: authority.keyId, publicKey: authority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ]), authority));
    const browser = await createBrowser({ label: 'repin', email, cloud, profile });
    try {
      await openBoard(browser, 'Pinned to a stale authority');
      expect(await until(() => status(browser).authority?.state === 'failed'),
        `the automatic bootstrap must refuse the foreign pin first: ${describeStatus(browser)}`).toBe(true);
      expect((await pinsOf(browser))[`account:${account}`], 'and leave it untouched').toEqual(stalePin);

      const target = await publicKeyFingerprint(authority.publicJwk);
      const result = await runtime(browser).accountChannel.repinPublishedAuthority();

      expect(result.previousAuthorityKeyId, 'the result names the pin it replaced').toBe(stale.keyId);
      expect(result.authorityKeyId, 'and the authority it now trusts').toBe(target);
      expect(result.unchanged).toBe(false);
      expect(result.canRenew, 'this browser holds the new authority’s key, so it can renew').toBe(true);
      const after = (await pinsOf(browser))[`account:${account}`];
      expect(after.authorityKeyId, 'the pin now names the published authority').toBe(target);
      expect(after.authorityPublicKey).toEqual(authority.publicJwk);
      expect(status(browser).authority?.state,
        `the bootstrap settled on the new pin: ${describeStatus(browser)}`).toBe('adopted');

      // A working account room, not a generic failure: this browser holds the new
      // authority's key, so its own courier pass creates the content key and the
      // channel dials.
      expect(await until(() => status(browser).state === 'connected'),
        `the account room must start after the re-pin: ${describeStatus(browser)}`).toBe(true);
      expect(result.channelState === 'connected' || result.channelState === 'starting',
        `the pass reports a real state, never a generic failure: ${JSON.stringify(result)}`).toBe(true);
    } finally { await browser.close(); }
  });

  it('re-pins and states the honest later cause when the new authority’s key is not local', async () => {
    const email = freshEmail('not-local');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    // Held only here, never stored in the browser: the "authority lives on
    // another device" case, which is every ordinary second browser.
    const publishedAuthority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 21, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-device:${account}`, own);
    await publishAccountAuthority(cloud, email, account, await published(accountManifest(account, publishedAuthority, [
      { deviceKeyId: publishedAuthority.keyId, publicKey: publishedAuthority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ]), publishedAuthority));
    const browser = await createBrowser({ label: 'not-local', email, cloud, profile });
    try {
      await openBoard(browser, 'Authority lives elsewhere');
      expect(await until(() => status(browser).authority?.state === 'failed'),
        `the foreign pin is refused first: ${describeStatus(browser)}`).toBe(true);

      const result = await runtime(browser).accountChannel.repinPublishedAuthority();
      expect(result.authorityKeyId).toBe(publishedAuthority.keyId);
      expect(result.canRenew, 'this browser does not hold the new authority’s key').toBe(false);
      expect((await pinsOf(browser))[`account:${account}`].authorityKeyId).toBe(publishedAuthority.keyId);
      expect(status(browser).authority?.state, 'the report says the key is not local, not that the pin mismatched')
        .toBe('authority-not-local');
      // The stated later cause: the manifest is accepted, but the account room
      // cannot open because no content key exists and this browser may not create
      // one. That is the consequence the UI has to say out loud.
      expect(result.channelState).toBe('failed');
      expect(result.channelReason).toBe('no account content key');
    } finally { await browser.close(); }
  });

  it('refuses a published manifest that fails its own signature, and changes nothing', async () => {
    const email = freshEmail('bad-signature');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    const publishedAuthority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 31, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-device:${account}`, own);
    const manifest = accountManifest(account, publishedAuthority, [
      { deviceKeyId: publishedAuthority.keyId, publicKey: publishedAuthority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ]);
    // A signature that is well-formed base64url but is not the manifest's.
    await publishAccountAuthority(cloud, email, account, await published(manifest, publishedAuthority, 'A'.repeat(86)));
    const browser = await createBrowser({ label: 'bad-signature', email, cloud, profile });
    try {
      await openBoard(browser, 'Bad signature');
      expect(await until(() => status(browser).authority?.state === 'failed')).toBe(true);

      await expect(runtime(browser).accountChannel.repinPublishedAuthority())
        .rejects.toThrow(/does not verify under the authority it carries/);
      expect((await pinsOf(browser))[`account:${account}`], 'a refused re-pin moves nothing').toEqual(stalePin);
      expect(status(browser).state, 'and the channel stays where it was').toBe('absent-pin');
      expect(status(browser).authority?.state).toBe('failed');
    } finally { await browser.close(); }
  });

  it('refuses a published manifest for a different account, and changes nothing', async () => {
    const email = freshEmail('other-account');
    const account = await hashBlob(new Blob([email]));
    const other = await hashBlob(new Blob([freshEmail('someone-else')]));
    const stale = await generateDeviceKey();
    const publishedAuthority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 41, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-device:${account}`, own);
    await publishAccountAuthority(cloud, email, account, await published(accountManifest(other, publishedAuthority, [
      { deviceKeyId: publishedAuthority.keyId, publicKey: publishedAuthority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ]), publishedAuthority));
    const browser = await createBrowser({ label: 'other-account', email, cloud, profile });
    try {
      await openBoard(browser, 'Other account');
      expect(await until(() => status(browser).authority?.state === 'failed')).toBe(true);

      await expect(runtime(browser).accountChannel.repinPublishedAuthority())
        .rejects.toThrow(new RegExp(`names account:${other}, not account:${account}`));
      expect((await pinsOf(browser))[`account:${account}`]).toEqual(stalePin);
      expect(status(browser).state).toBe('absent-pin');
    } finally { await browser.close(); }
  });

  it('refuses a published manifest that does not list this browser’s device, and changes nothing', async () => {
    const email = freshEmail('not-listed');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    const publishedAuthority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 51, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-device:${account}`, own);
    await publishAccountAuthority(cloud, email, account, await published(accountManifest(account, publishedAuthority, [
      { deviceKeyId: publishedAuthority.keyId, publicKey: publishedAuthority.publicJwk, role: 'owner' }
    ]), publishedAuthority));
    const browser = await createBrowser({ label: 'not-listed', email, cloud, profile });
    try {
      await openBoard(browser, 'Device not admitted');
      expect(await until(() => status(browser).authority?.state === 'failed')).toBe(true);

      await expect(runtime(browser).accountChannel.repinPublishedAuthority())
        .rejects.toThrow(/does not list this browser's account device/);
      expect((await pinsOf(browser))[`account:${account}`]).toEqual(stalePin);
      expect(status(browser).state).toBe('absent-pin');
    } finally { await browser.close(); }
  });

  it('refuses a published account manifest with a Drive binding, and changes nothing', async () => {
    const email = freshEmail('binding');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    const publishedAuthority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 61, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-device:${account}`, own);
    // Sealed as a file whose signature is genuine: the payload is what carries
    // the binding, and the runtime reads it before the signature it cannot accept.
    const payload: BoardPermissionManifest = { ...accountManifest(account, publishedAuthority, [
      { deviceKeyId: publishedAuthority.keyId, publicKey: publishedAuthority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ]), driveProjectFileId: 'project-file', driveFolderId: 'folder' };
    await publishAccountAuthority(cloud, email, account,
      sealAccountAuthorityFile(publishedAuthority.publicJwk, { payload, signature: await rawSignature(payload, publishedAuthority) }));
    const browser = await createBrowser({ label: 'binding', email, cloud, profile });
    try {
      await openBoard(browser, 'Drive-bound manifest');
      expect(await until(() => status(browser).authority?.state === 'failed')).toBe(true);

      await expect(runtime(browser).accountChannel.repinPublishedAuthority())
        .rejects.toThrow(/bound to a Drive file or folder/);
      expect((await pinsOf(browser))[`account:${account}`]).toEqual(stalePin);
      expect(status(browser).state).toBe('absent-pin');
    } finally { await browser.close(); }
  });

  it('refuses an expired published manifest, and changes nothing', async () => {
    const email = freshEmail('expired');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    const publishedAuthority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 71, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-device:${account}`, own);
    const issuedAt = Date.now() - 10 * 60_000;
    await publishAccountAuthority(cloud, email, account, await published(accountManifest(account, publishedAuthority, [
      { deviceKeyId: publishedAuthority.keyId, publicKey: publishedAuthority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ], { issuedAt, expiresAt: issuedAt + 240_000 }), publishedAuthority));
    const browser = await createBrowser({ label: 'expired', email, cloud, profile });
    try {
      await openBoard(browser, 'Expired manifest');
      expect(await until(() => status(browser).authority?.state === 'failed')).toBe(true);

      await expect(runtime(browser).accountChannel.repinPublishedAuthority())
        .rejects.toThrow(/expired at/);
      expect((await pinsOf(browser))[`account:${account}`]).toEqual(stalePin);
      expect(status(browser).state).toBe('absent-pin');
    } finally { await browser.close(); }
  });

  it('never re-pins by itself: a bootstrap over the very manifest a re-pin would accept still fails closed', async () => {
    const email = freshEmail('automatic');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    const publishedAuthority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 81, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-device:${account}`, own);
    // Every check the re-pin performs passes here: genuine signature, this
    // account, this device, current, no Drive binding. The only reason it is not
    // adopted is that nobody asked.
    await publishAccountAuthority(cloud, email, account, await published(accountManifest(account, publishedAuthority, [
      { deviceKeyId: publishedAuthority.keyId, publicKey: publishedAuthority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ]), publishedAuthority));
    const browser = await createBrowser({ label: 'automatic', email, cloud, profile });
    try {
      await openBoard(browser, 'Automatic bootstrap');
      expect(await until(() => status(browser).authority?.state === 'failed'),
        `a foreign pin is refused, not adopted: ${describeStatus(browser)}`).toBe(true);
      expect(status(browser).authority?.reason).toMatch(/signed by a different authority/);

      // More product triggers — a channel start, a reconcile round, a second
      // board open — must all leave the pin exactly where it was.
      await runtime(browser).accountChannel.start();
      const second = await browser.rx.createProject('Second round', 'project');
      await browser.runtime.googleDrive.syncProject(second.id, { force: true });
      await browser.runtime.collaborationManager.start(second.id);
      await runtime(browser).accountChannel.start();

      expect(await until(() => status(browser).authority?.state === 'failed'),
        `still refused, no gesture was made: ${describeStatus(browser)}`).toBe(true);
      expect((await pinsOf(browser))[`account:${account}`], 'the pin never moved').toEqual(stalePin);
      expect(status(browser).state, 'and the channel is still without a pin it can use').toBe('absent-pin');
    } finally { await browser.close(); }
  });

  it('is idempotent, and the account room’s queued records survive the re-pin and flush', async () => {
    const email = freshEmail('queue');
    const account = await hashBlob(new Blob([email]));
    const stale = await generateDeviceKey();
    const authority = await generateDeviceKey();
    const own = await generateDeviceKey();
    const stalePin: PinnedAuthority = { scope: account, authorityKeyId: stale.keyId,
      authorityPublicKey: stale.publicJwk, pinnedAt: 91, kind: 'account' };
    const profile = createSharedProfile({ pboardSecurityPins: { [`account:${account}`]: stalePin } });
    await seedPurposeKey(profile, `account-authority:${account}`, authority);
    await seedPurposeKey(profile, `account-device:${account}`, own);
    await publishAccountAuthority(cloud, email, account, await published(accountManifest(account, authority, [
      { deviceKeyId: authority.keyId, publicKey: authority.publicJwk, role: 'owner' },
      { deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'editor' }
    ]), authority));
    const browser = await createBrowser({ label: 'queue', email, cloud, profile });
    try {
      await openBoard(browser, 'Queued while foreign');
      expect(await until(() => status(browser).authority?.state === 'failed')).toBe(true);
      // Records queued while the room could not open: the outbox is durable even
      // with no pin the channel can use, which is exactly the field state.
      for (const name of ['Queued one', 'Queued two', 'Queued three']) {
        const queued = await browser.rx.createProject(name, 'project');
        await browser.runtime.driveSyncState.markDirty(queued.id);
      }
      expect(await until(() => status(browser).outbox >= 3),
        `the records wait in the outbox: ${describeStatus(browser)}`).toBe(true);
      const queuedBefore = status(browser).outbox;

      const first = await runtime(browser).accountChannel.repinPublishedAuthority();
      expect(first.queuedBefore).toBe(queuedBefore);
      expect(first.canRenew).toBe(true);
      const pinAfterFirst = (await pinsOf(browser))[`account:${account}`];
      expect(pinAfterFirst.authorityKeyId).toBe(authority.keyId);
      expect(await until(() => status(browser).state === 'connected'),
        `the room opened: ${describeStatus(browser)}`).toBe(true);
      // The queued records go out through the channel's own queue. A record
      // announced while a pass was already running waits for the next pass, and
      // the channel's documented "retry the queue now" is exactly that pass — no
      // timer, no reconnect, and nothing the re-pin itself has to loop over.
      const drained = await until(() => status(browser).outbox === 0, 20_000, () => runtime(browser).accountChannel.flush());
      expect(drained, `the queued records flushed: ${describeStatus(browser)}`).toBe(true);

      // Idempotent: the same act again writes nothing at all — same pin object,
      // same timestamp, same key — and does not disturb the working room.
      const second = await runtime(browser).accountChannel.repinPublishedAuthority();
      expect(second.unchanged).toBe(true);
      expect(second.authorityKeyId).toBe(first.authorityKeyId);
      expect(second.previousAuthorityKeyId).toBe(first.authorityKeyId);
      expect((await pinsOf(browser))[`account:${account}`], 'a second re-pin is not a second write').toEqual(pinAfterFirst);
      expect(status(browser).state).toBe('connected');

      // And the records really arrived: the account room holds their rows.
      const room = [...cloud.signaling.rooms.values()].find(entry => entry.board === `account:${account}`);
      expect(room, 'the account room exists after the flush').toBeDefined();
      expect(room!.rows.length, 'every queued record reached the room').toBeGreaterThanOrEqual(queuedBefore);
    } finally { await browser.close(); }
  });
});
