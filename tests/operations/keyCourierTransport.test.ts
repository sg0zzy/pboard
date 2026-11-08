import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { instantAuthBudget } from '../helpers/authBudget';
import { runKeyCourier, type KeyCourierOptions } from '../../src/sync/operations/keyCourierTransport';
import { exportCourierPublicKey, importCourierPeerKey, openKeyEnvelope, sealKeyEnvelope } from '../../src/sync/operations/keyCourier';
import { ensureWrapKey, generateDeviceKey, generateWrapKey, importWrapKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest } from '../../src/collab/security/manifest';
import { prepareRelayAdmission, type RelayAuthorization } from '../../src/collab/security/relayAdmission';
import { exportBoardContentKey, generateBoardContentKey } from '../../src/sync/bufferCrypto';

/**
 * The courier against a scripted relay.
 *
 * Like the log's convergence harness this is a fake socket that speaks the
 * real handshake — welcome, authenticate version 2, then the `sync` envelope
 * with replies in arrival order — so the transport is exercised end to end,
 * signature included. The fake answers the four courier actions with the
 * shape and the filters `local://key-courier-contract.md` promises:
 * `fetchKeyGrants` only ever returns rows addressed to the `deviceKeyId` that
 * authenticated, and `publishKeyGrants` replaces rows per sender+recipient.
 * Grants are checked by *opening them with the peer's own wrap key*, so a
 * broken derivation fails here rather than on a second device.
 */
const board = 'board-1', topic = `pboard-collab-${board}-cards`, challenge = 'c'.repeat(43), session = 's'.repeat(43);

type DeviceRow = { deviceKeyId: string; publicKey?: string };
type GrantRow = { to: string; from: string; envelope: string };

class CourierRelay {
  static OPEN = 1;
  static instances: CourierRelay[] = [];
  static devices: DeviceRow[] = [];
  static fetchScript: GrantRow[][] = [];
  /** Rows accepted by `publishKeyGrants`, per (sender, recipient). */
  static stored = new Map<string, { from: string; to: string; envelope: string }>();
  static storedCalls = 0;
  /** A relay predating the courier answers the actions with a refusal. */
  static unknown = false;
  /** `stored: false` is the idempotent no-op the contract defines. */
  static deviceKeyStored = true;
  readyState = 1;
  room = '';
  deviceKeyId = '';
  fetches = 0;
  sent: Record<string, any>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;

  constructor(_url: string | URL) {
    CourierRelay.instances.push(this);
    queueMicrotask(() => this.push({ type: 'welcome', version: 1, supportedVersions: [1, 2], challenge, session }));
  }
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  private frame(action: string, fields: Record<string, unknown> = {}) { return { type: 'sync', action, board: this.room, ...fields }; }
  get requests() { return this.sent.filter(entry => entry.type === 'sync').map(entry => entry.request); }
  get actions() { return this.requests.map(request => request.action); }

  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === 'authenticate') {
      this.room = message.room; this.deviceKeyId = message.deviceKeyId;
      queueMicrotask(() => this.push({ type: 'authenticated', peerId: message.deviceKeyId, session }));
      return;
    }
    if (message.type !== 'sync') return;
    if (CourierRelay.unknown) { queueMicrotask(() => this.push(this.frame('error', { code: 'invalid_request' }))); return; }
    const request = message.request;
    if (request.action === 'publishDeviceKey') queueMicrotask(() => this.push(this.frame('deviceKeyStored', { stored: CourierRelay.deviceKeyStored })));
    if (request.action === 'listDeviceKeys') queueMicrotask(() => this.push(this.frame('deviceKeys', { devices: CourierRelay.devices })));
    if (request.action === 'fetchKeyGrants') {
      const rows = (CourierRelay.fetchScript[this.fetches++] ?? [])
        .filter(row => row.to === this.deviceKeyId)
        .map(({ to: _to, from, envelope }: GrantRow) => ({ fromDeviceKeyId: from, envelope }));
      queueMicrotask(() => this.push(this.frame('keyGrants', { grants: rows })));
    }
    if (request.action === 'publishKeyGrants') {
      CourierRelay.storedCalls++;
      for (const grant of request.grants as { deviceKeyId: string; envelope: string }[]) {
        CourierRelay.stored.set(`${this.deviceKeyId}>${grant.deviceKeyId}`, { from: this.deviceKeyId, to: grant.deviceKeyId, envelope: grant.envelope });
      }
      queueMicrotask(() => this.push(this.frame('keyGrantsStored', { stored: (request.grants as unknown[]).length })));
    }
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

let keys: StoredDeviceKey[], authorization: RelayAuthorization, room: string, ourWrap: Awaited<ReturnType<typeof ensureWrapKey>>, ourPublic: string;
const relay = () => CourierRelay.instances.at(-1)!;

beforeAll(async () => {
  keys = [await generateDeviceKey(), await generateDeviceKey()];
  const manifest = await signManifest({
    protocol: 2, boardId: board, driveProjectFileId: 'file-1', driveFolderId: 'folder-1', authorityKeyId: keys[0].keyId,
    epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
    devices: keys.map((key, index) => ({ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: index === 0 ? 'owner' : 'editor' })),
  }, keys[0]);
  authorization = { authority: keys[0].publicJwk, manifest };
  room = (await prepareRelayAdmission(topic, authorization, keys[0].keyId)).room;
  ourWrap = await ensureWrapKey();
  ourPublic = await exportCourierPublicKey(ourWrap.publicJwk);
});

beforeEach(() => {
  CourierRelay.instances = []; CourierRelay.devices = []; CourierRelay.fetchScript = [];
  CourierRelay.stored = new Map(); CourierRelay.storedCalls = 0;
  CourierRelay.unknown = false; CourierRelay.deviceKeyStored = true;
});

async function run(overrides: Partial<KeyCourierOptions> = {}) {
  const content = await generateBoardContentKey();
  const options: KeyCourierOptions = {
    topic, url: 'wss://relay.example.test/ws',
    getKey: async () => keys[0], getAuthorization: async () => authorization,
    isWriter: true,
    isAuthority: true,
    heldKey: async () => undefined,
    ensureKey: async () => content,
    storeKey: async () => content,
    authBudget: instantAuthBudget(),
    webSocket: CourierRelay as unknown as typeof WebSocket,
    sleep: async () => {},
    ...overrides
  };
  return { content, outcome: await runKeyCourier(options) };
}

/** Open an envelope the way the addressed peer would. */
async function openAsPeer(envelope: string, peerPrivate: JsonWebKey, sealerPublic: string) {
  return await openKeyEnvelope({ board: room, privateKey: await importWrapKey(peerPrivate), peerPublicKey: await importCourierPeerKey(sealerPublic), envelope });
}

describe('key courier transport', () => {
  it('a writer publishes its wrap key and hands every peer a grant that opens with the peer’s own key', async () => {
    const peer = await generateWrapKey();
    CourierRelay.devices = [
      { deviceKeyId: keys[0].keyId, publicKey: ourPublic },
      { deviceKeyId: keys[1].keyId, publicKey: await exportCourierPublicKey(peer.publicJwk) }
    ];
    const { content, outcome } = await run();
    expect(outcome.error).toBeNull();
    expect(outcome.source).toBe('generated');
    expect(outcome.key?.keyId).toBe(content.keyId);
    expect(outcome.published).toBe(1);
    const requests = relay().requests;
    expect(requests.map(request => request.action)).toEqual(['publishDeviceKey', 'listDeviceKeys', 'fetchKeyGrants', 'publishKeyGrants']);
    // Every request names the admitted room as its board, and the published
    // public key is this device's real wrap SPKI on the wire.
    for (const request of requests) expect(request.board).toBe(room);
    expect(requests[0].publicKey).toBe(ourPublic);
    const grant = (requests[3].grants as { deviceKeyId: string; envelope: string }[])[0];
    expect(grant.deviceKeyId).toBe(keys[1].keyId); // addressed by authenticated identity, not the wrap fingerprint
    expect(await openAsPeer(grant.envelope, peer.privateJwk, ourPublic))
      .toBe(await exportBoardContentKey(content.key));
    // One short-lived exchange: it leaves the room, and only one socket opened.
    expect(CourierRelay.instances).toHaveLength(1);
    expect(relay().sent.some(message => message.type === 'leave')).toBe(true);
  });

  it('a reader fetches the grant addressed to it, stores the material, and never generates', async () => {
    const sender = await generateWrapKey();
    const content = await generateBoardContentKey();
    const sealed = await sealKeyEnvelope({ board: room, privateKey: await importWrapKey(sender.privateJwk), peerPublicKey: await importCourierPeerKey(ourPublic), material: await exportBoardContentKey(content.key) });
    CourierRelay.devices = [{ deviceKeyId: keys[1].keyId, publicKey: await exportCourierPublicKey(sender.publicJwk) }];
    // A stale row that cannot open is tried and skipped, not fatal.
    CourierRelay.fetchScript = [[
      { to: keys[0].keyId, from: keys[1].keyId, envelope: 'AAAA' },
      { to: keys[0].keyId, from: keys[1].keyId, envelope: sealed }
    ]];
    const store = vi.fn(async (_material: string) => content);
    const ensure = vi.fn(async () => { throw new Error('a reader must not generate a board key'); });
    const { outcome } = await run({ isWriter: false, storeKey: store, ensureKey: ensure });
    expect(store).toHaveBeenCalledTimes(1);
    expect(await store.mock.calls[0][0]).toBe(await exportBoardContentKey(content.key));
    expect(ensure).not.toHaveBeenCalled();
    expect(outcome.source).toBe('granted');
    expect(outcome.key?.keyId).toBe(content.keyId);
    expect(CourierRelay.storedCalls).toBe(0); // a reader hands nothing out
  });

  it('a received grant always wins over generating a new key — two writers never fork a board', async () => {
    const sender = await generateWrapKey();
    const granted = await generateBoardContentKey();
    const sealed = await sealKeyEnvelope({ board: room, privateKey: await importWrapKey(sender.privateJwk), peerPublicKey: await importCourierPeerKey(ourPublic), material: await exportBoardContentKey(granted.key) });
    CourierRelay.devices = [{ deviceKeyId: keys[1].keyId, publicKey: await exportCourierPublicKey(sender.publicJwk) }];
    CourierRelay.fetchScript = [[{ to: keys[0].keyId, from: keys[1].keyId, envelope: sealed }]];
    const ensure = vi.fn(async () => { throw new Error('generation is forbidden once a grant exists'); });
    const store = vi.fn(async (_material: string) => granted);
    const { outcome } = await run({ ensureKey: ensure, storeKey: store });
    expect(ensure).not.toHaveBeenCalled();
    expect(outcome.source).toBe('granted');
    expect(outcome.key?.keyId).toBe(granted.keyId);
  });

  it('a device that already holds the key keeps it over any grant and shares it onward', async () => {
    const held = await generateBoardContentKey();
    const other = await generateBoardContentKey();
    const sealed = await sealKeyEnvelope({ board: room, privateKey: await importWrapKey((await generateWrapKey()).privateJwk), peerPublicKey: await importCourierPeerKey(ourPublic), material: await exportBoardContentKey(other.key) });
    CourierRelay.fetchScript = [[{ to: keys[0].keyId, from: keys[1].keyId, envelope: sealed }]];
    CourierRelay.devices = [{ deviceKeyId: keys[1].keyId, publicKey: await exportCourierPublicKey((await generateWrapKey()).publicJwk) }];
    const store = vi.fn(async (_material: string) => other);
    const { outcome } = await run({ heldKey: async () => held, storeKey: store });
    expect(store).not.toHaveBeenCalled();
    expect(outcome.source).toBe('local');
    expect(outcome.key?.keyId).toBe(held.keyId);
    // Sharing onward means the relay now holds an envelope the peer can open.
    expect(outcome.published).toBe(1);
  });

  it('a peer that has not published its wrap key does not block the writer’s attach', async () => {
    CourierRelay.devices = [
      { deviceKeyId: keys[1].keyId }, // present, no wrap key yet
      { deviceKeyId: keys[0].keyId, publicKey: ourPublic } // ourselves
    ];
    const { content, outcome } = await run();
    expect(outcome.error).toBeNull();
    expect(outcome.source).toBe('generated');
    expect(outcome.key?.keyId).toBe(content.keyId);
    expect(outcome.published).toBe(0);
    expect(relay().actions).not.toContain('publishKeyGrants');
  });

  it('a reader waits with backoff for a writer that is still finishing its first run', async () => {
    const sender = await generateWrapKey();
    const content = await generateBoardContentKey();
    const sealed = await sealKeyEnvelope({ board: room, privateKey: await importWrapKey(sender.privateJwk), peerPublicKey: await importCourierPeerKey(ourPublic), material: await exportBoardContentKey(content.key) });
    CourierRelay.devices = [{ deviceKeyId: keys[1].keyId, publicKey: await exportCourierPublicKey(sender.publicJwk) }];
    CourierRelay.fetchScript = [[], [], [{ to: keys[0].keyId, from: keys[1].keyId, envelope: sealed }]];
    const sleeps: number[] = [];
    const { outcome } = await run({ isWriter: false, attempts: 3, sleep: async (ms: number) => { sleeps.push(ms); } });
    expect(outcome.source).toBe('granted');
    expect(sleeps).toEqual([500, 1000]);
    expect(relay().actions.filter(action => action === 'fetchKeyGrants')).toHaveLength(3);
    expect(CourierRelay.instances).toHaveLength(1); // one connection carries the retries
  });

  it('gives up cleanly against a relay that does not know the courier, without retry loops', async () => {
    CourierRelay.unknown = true;
    const ensure = vi.fn(async () => { throw new Error('the fallback below provisions instead'); });
    const { outcome } = await run({ ensureKey: ensure });
    expect(outcome.key).toBeUndefined();
    expect(outcome.source).toBe('none');
    expect(outcome.error).toBe('Key courier refused: invalid_request');
    expect(relay().actions).toEqual(['publishDeviceKey']); // no retry storm
  });

  it('re-publishing an identical device key (stored: false) is the normal no-op, not a failure', async () => {
    CourierRelay.deviceKeyStored = false;
    const peer = await generateWrapKey();
    CourierRelay.devices = [{ deviceKeyId: keys[1].keyId, publicKey: await exportCourierPublicKey(peer.publicJwk) }];
    const { content, outcome } = await run();
    expect(outcome.error).toBeNull();
    expect(outcome.key?.keyId).toBe(content.keyId);
    expect(outcome.published).toBe(1);
  });

  it('keeps grant publishes inside the wire cap of 32 envelopes per batch', async () => {
    const peer = await generateWrapKey();
    const publicKey = await exportCourierPublicKey(peer.publicJwk);
    CourierRelay.devices = Array.from({ length: 40 }, (_unused, index) => ({ deviceKeyId: `peer-${index}`, publicKey }));
    const { outcome } = await run();
    expect(outcome.published).toBe(40);
    const batches = relay().requests.filter(request => request.action === 'publishKeyGrants')
      .map(request => (request.grants as unknown[]).length);
    expect(batches).toEqual([32, 8]);
  });

  it('refusals never surface envelope or key material in the outcome', async () => {
    CourierRelay.unknown = true;
    const secret = await generateBoardContentKey();
    const outcome = await runKeyCourier({
      topic, url: 'wss://relay.example.test/ws',
      getKey: async () => keys[0], getAuthorization: async () => authorization,
      isWriter: true,
      isAuthority: true,
      heldKey: async () => undefined,
      ensureKey: async () => secret,
      storeKey: async () => secret,
      webSocket: CourierRelay as unknown as typeof WebSocket,
      sleep: async () => {}
    });
    const serialized = JSON.stringify({ ...outcome, key: undefined });
    expect(outcome.error).toContain('invalid_request');
    expect(serialized).not.toContain((await exportBoardContentKey(secret.key)).slice(0, 12));
  });
});
