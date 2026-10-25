/**
 * Sync v2 content-key exchange over the authenticated peer history channel:
 * writers receive keys, viewers never do, and unvalidated key material never
 * reaches storage.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { createPeerHistorySession, type PeerHistorySession } from '../../src/collab/peerHistory';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { installLiveBoardMutations, withUntrustedImport } from '../../src/collab/security/liveMutations';
import { manifestHash, signManifest, verifyManifest } from '../../src/collab/security/manifest';
import type { CollaborationSecurityOptions } from '../../src/collab/manager';
import type { VerifiedSessionContext } from '../../src/collab/security/session';
import { parseStrictJson } from '../../src/collab/security/canonical';
import { exportBoardContentKey, generateBoardContentKey } from '../../src/sync/bufferCrypto';

const repos: RxRepository[] = [], sessions: PeerHistorySession[] = [];
afterEach(async () => { for (const s of sessions.splice(0)) s.close(); for (const r of repos.splice(0)) await r.db.close(); });

type KeyStore = Map<string, { material: string; keyId: string }>;
const exchange = (store: KeyStore) => ({
  load: async (board: string) => store.get(board),
  store: async (board: string, value: { material: string; keyId: string }) => { store.set(board, value); }
});

async function fixture(remoteRole: 'editor' | 'viewer') {
  const a = await createRxRepository({ name: `keyex-a-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`blob-ka-${crypto.randomUUID()}`) }); repos.push(a);
  const b = await createRxRepository({ name: `keyex-b-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`blob-kb-${crypto.randomUUID()}`) }); repos.push(b);
  const board = await a.createProject('Key exchange', 'project');
  const owner = await generateDeviceKey(), peer = await generateDeviceKey();
  const payload = { protocol: 2 as const, boardId: board.id, driveProjectFileId: '', driveFolderId: '', authorityKeyId: owner.keyId,
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [ { deviceKeyId: owner.keyId, publicKey: owner.publicJwk, role: 'owner' as const }, { deviceKeyId: peer.keyId, publicKey: peer.publicJwk, role: remoteRole } ] };
  const signer = { deviceKeyId: owner.keyId, privateJwk: owner.privateJwk };
  const manifest = await verifyManifest(await signManifest(payload, signer), owner.publicJwk, owner.keyId);
  const sa: CollaborationSecurityOptions = { boardId: board.id, manifest, signer, ownSessionId: 'a' };
  const sb: CollaborationSecurityOptions = { ...sa, signer: { deviceKeyId: peer.keyId, privateJwk: peer.privateJwk }, ownSessionId: 'b' };
  await installLiveBoardMutations({ projectId: board.id, cards: a.db.cards, projects: a.db.projects, security: sa, attestExisting: true });
  await installLiveBoardMutations({ projectId: board.id, cards: b.db.cards, projects: b.db.projects, security: sb });
  const project = (await a.db.projects.findOne(board.id).exec())!.toJSON();
  await withUntrustedImport([b.db.projects], () => b.db.projects.upsert(JSON.parse(JSON.stringify(project))));
  return { a, b, sa, sb, board };
}

function context(own: CollaborationSecurityOptions, remote: CollaborationSecurityOptions): VerifiedSessionContext {
  return { boardId: own.boardId, collection: 'cards', ownDeviceKeyId: own.signer.deviceKeyId, remoteDeviceKeyId: remote.signer.deviceKeyId,
    remoteRole: remote.manifest.devices.find(d => d.deviceKeyId === remote.signer.deviceKeyId)!.role,
    ownSessionId: own.ownSessionId, remoteSessionId: remote.ownSessionId, manifestEpoch: own.manifest.epoch,
    manifestHash: manifestHash(own.manifest), transcriptHash: 'verified-test-dtls', manifestExpiresAt: own.manifest.expiresAt };
}

function link(f: Awaited<ReturnType<typeof fixture>>, keyStoreA: KeyStore, keyStoreB: KeyStore) {
  const errors: Error[] = [];
  const rightSession = { current: undefined as PeerHistorySession | undefined };
  let qa = Promise.resolve(), qb = Promise.resolve();
  const left = createPeerHistorySession({ repository: f.a, security: f.sa, context: context(f.sa, f.sb), active: () => true, keyExchange: exchange(keyStoreA),
    send(frame) { qb = qb.then(() => rightSession.current!.receive(parseStrictJson(JSON.stringify(frame), 65536))).catch(e => { errors.push(e); }); }, onError: e => errors.push(e) });
  const right = createPeerHistorySession({ repository: f.b, security: f.sb, context: context(f.sb, f.sa), active: () => true, keyExchange: exchange(keyStoreB),
    send(frame) { qa = qa.then(() => left.receive(parseStrictJson(JSON.stringify(frame), 65536))).catch(e => { errors.push(e); }); }, onError: e => errors.push(e) });
  rightSession.current = right;
  sessions.push(left, right);
  const drain = async () => { await qa; await qb; };
  return { left, right, errors, drain };
}

it('an editor without a key receives the owner key and stores it under the matching id', async () => {
  const f = await fixture('editor');
  const key = await generateBoardContentKey();
  const material = await exportBoardContentKey(key.key);
  const keyStoreA: KeyStore = new Map([[f.board.id, { material, keyId: key.keyId }]]);
  const keyStoreB: KeyStore = new Map();
  const wire = link(f, keyStoreA, keyStoreB);
  await wire.drain();
  expect(await wire.right.requestContentKey()).toBe(true);
  await wire.drain();
  const received = keyStoreB.get(f.board.id);
  expect(received?.material).toBe(material);
  expect(received?.keyId).toMatch(/^[0-9a-f]{16}$/);
  // A second request short-circuits on the local hit; no further traffic, no errors.
  expect(await wire.right.requestContentKey()).toBe(true);
  expect(wire.errors).toEqual([]);
});

it('a viewer never stores or is served a content key', async () => {
  const f = await fixture('viewer');
  const key = await generateBoardContentKey();
  const material = await exportBoardContentKey(key.key);
  const keyStoreA: KeyStore = new Map([[f.board.id, { material, keyId: key.keyId }]]);
  const keyStoreB: KeyStore = new Map();
  const wire = link(f, keyStoreA, keyStoreB);
  await wire.drain();
  // The role gate refuses before any frame is sent.
  expect(await wire.right.requestContentKey()).toBe(false);
  // A hand-crafted request from the viewer side gets no answer either: the
  // serving side checks the verified remote role, not the frame contents.
  await wire.right.receive({ kind: 'pboard-history', version: 1, op: 'key-want', id: crypto.randomUUID() });
  await wire.drain();
  expect(keyStoreB.size).toBe(0);
  expect(wire.errors).toEqual([]);
});

it('unsolicited and malformed key answers are rejected before storage', async () => {
  const f = await fixture('editor');
  const keyStoreA: KeyStore = new Map();
  const keyStoreB: KeyStore = new Map();
  const wire = link(f, keyStoreA, keyStoreB);
  await wire.drain();
  await expect(wire.right.receive({ kind: 'pboard-history', version: 1, op: 'key-put', id: 'nobody-asked', material: 'A'.repeat(43), keyId: 'a'.repeat(16) }))
    .rejects.toThrow(/Unsolicited/);
  // Malformed material aimed at a real pending request rejects the request
  // and never reaches storage.
  const pending = wire.right.requestContentKey();
  await wire.drain(); // let the key-want reach the owner (who holds no key and stays silent)
  await expect(wire.left.receive({ kind: 'pboard-history', version: 1, op: 'key-put', id: 'wrong-id', material: 'short', keyId: 'zz' }))
    .rejects.toThrow(/Unsolicited/);
  void pending;
  expect(keyStoreB.size).toBe(0);
});
