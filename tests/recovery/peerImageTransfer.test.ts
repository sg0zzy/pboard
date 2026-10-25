import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore, hashBlob, imageToBlob, blobToDataUrl } from '../../src/storage/blobStore';
import { createPeerHistorySession, type PeerHistorySession } from '../../src/collab/peerHistory';
import { createProjectImageSync, type SharedImageTransport } from '../../src/collab/imageSync';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { installLiveBoardMutations, withUntrustedImport } from '../../src/collab/security/liveMutations';
import { manifestHash, signManifest, verifyManifest } from '../../src/collab/security/manifest';
import type { CollaborationSecurityOptions } from '../../src/collab/manager';
import type { VerifiedSessionContext } from '../../src/collab/security/session';
import { parseStrictJson } from '../../src/collab/security/canonical';

const repos: RxRepository[] = [], sessions: PeerHistorySession[] = [];
afterEach(async () => { vi.useRealTimers(); for (const s of sessions.splice(0)) s.close(); for (const r of repos.splice(0)) await r.db.close(); });

const editor_image = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', mimeType: 'image/png', width: 1, height: 1 };

async function imageFixture() {
  const a = await createRxRepository({ name: `peersimage-a-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`blob-a-${crypto.randomUUID()}`) }); repos.push(a);
  const b = await createRxRepository({ name: `peersimage-b-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`blob-b-${crypto.randomUUID()}`) }); repos.push(b);
  const board = await a.createProject('Image exchange', 'project');
  const owner = await generateDeviceKey(), editor = await generateDeviceKey();
  const payload = { protocol: 2 as const, boardId: board.id, driveProjectFileId: '', driveFolderId: '', authorityKeyId: owner.keyId,
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [ { deviceKeyId: owner.keyId, publicKey: owner.publicJwk, role: 'owner' as const }, { deviceKeyId: editor.keyId, publicKey: editor.publicJwk, role: 'editor' as const } ] };
  const signer = { deviceKeyId: owner.keyId, privateJwk: owner.privateJwk };
  const manifest = await verifyManifest(await signManifest(payload, signer), owner.publicJwk, owner.keyId);
  const sa: CollaborationSecurityOptions = { boardId: board.id, manifest, signer, ownSessionId: 'a' };
  const sb: CollaborationSecurityOptions = { ...sa, signer: { deviceKeyId: editor.keyId, privateJwk: editor.privateJwk }, ownSessionId: 'b' };
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

function link(f: Awaited<ReturnType<typeof imageFixture>>, transform: (frame: any) => any = frame => frame) {
  const errors: Error[] = [], frames: unknown[] = [];
  const rightSession = { current: undefined as PeerHistorySession | undefined };
  let qa = Promise.resolve(), qb = Promise.resolve();
  const left = createPeerHistorySession({ repository: f.a, security: f.sa, context: context(f.sa, f.sb), active: () => true,
    send(frame) { frames.push(frame); qb = qb.then(() => rightSession.current!.receive(parseStrictJson(JSON.stringify(transform(frame)), 65536))).catch(e => { errors.push(e); }); }, onError: e => errors.push(e) });
  const right = createPeerHistorySession({ repository: f.b, security: f.sb, context: context(f.sb, f.sa), active: () => true,
    send(frame) { frames.push(frame); qa = qa.then(() => left.receive(parseStrictJson(JSON.stringify(transform(frame)), 65536))).catch(e => { errors.push(e); }); }, onError: e => errors.push(e) });
  rightSession.current = right;
  sessions.push(left, right);
  const drain = async () => { await qa; await qb; };
  return { left, right, errors, frames, drain, quiet: () => expect(errors).toEqual([]),
    async sync() { await Promise.all([left.flush(), right.flush()]); await drain(); this.quiet(); },
    close() { left.close(); right.close(); } };
}

it('an authorized peer receives verified image bytes over the DataChannel, and tampered payloads stay out of storage', async () => {
  const f = await imageFixture();
  const card = await f.a.addItem({ projectId: f.board.id, content: 'With picture', image: editor_image });
  const imageId = (await f.a.getCard(card.id))!.imageId!;
  const wire = link(f);
  // Receiver-driven request over the already-authorized session; the sender
  // serves bytes and the receiver re-derives the hash before storing.
  await wire.right.requestImages([imageId]);
  await wire.drain();; wire.quiet();
  expect(await f.b.hasImage(imageId)).toBe(true);;
  const stored = await f.b.getImage(imageId);
  expect(stored && await hashBlob(stored.blob)).toBe(imageId);
  expect(JSON.stringify(wire.frames.find(frame => (frame as Record<string, unknown>).op === 'image-put'))).toContain(imageId);
  // Repeated identical requests converge without duplicating bytes.
  const sizeBefore = (await f.b.getImage(imageId))!.blob.size;
  await wire.right.requestImages([imageId]);;
  await wire.drain();; wire.quiet();
  expect((await f.b.getImage(imageId))!.blob.size).toBe(sizeBefore);;
  // An unsolicited payload is rejected before it can reach blob storage.
  await expect(wire.right.receive({ kind: 'pboard-history', version: 1, op: 'image-put', id: 'x', imageId, image: { ...editor_image, dataUrl: 'data:image/png;base64,AAAA' } }))
    .rejects.toThrow(/Unrequested/);
  expect((await f.b.getImage(imageId))!.blob.size).toBe(sizeBefore);
});

it('image requests fail closed without a negotiated, authorized session', async () => {
  const f = await imageFixture();
  await f.a.addItem({ projectId: f.board.id, content: 'With picture', image: editor_image });
  const wire = link(f);
  await expect(wire.left.receive({ kind: 'pboard-history', version: 1, op: 'image-want', id: 'y', ids: [ 'a'.repeat(64) ] })).rejects.toThrow('capability');
  wire.quiet();
  expect(await f.b.hasImage('a'.repeat(64))).toBe(false);
});

it('imageSync recovers a missing attachment through the peer bridge without replacing newer card text', async () => {
  const f = await imageFixture();
  const card = await f.a.addItem({ projectId: f.board.id, content: 'Original', image: editor_image });
  const imageId = (await f.a.getCard(card.id))!.imageId!;
  const wire = link(f);
  await wire.sync();
  const requests: string[][] = [];
  const noTransport: SharedImageTransport = { readImage: async () => null, writeImage: async () => {} };
  // Newer local text arrives while attachment bytes are still missing.
  await f.b.updateItem(card.id, { content: 'Offline edited' });
  const sync = createProjectImageSync({ projectId: f.board.id, repository: f.b, transport: noTransport, canWrite: true,
    requestFromPeers: async ids => { requests.push(ids); await wire.right.requestImages(ids); await wire.drain(); },
    onError: e => { }, pollMs: 5 });
  sync.start();
  await sync.tick();
  expect(requests).toEqual([[ imageId ]]);
  expect(await f.b.hasImage(imageId)).toBe(true);
  // Image arrival must not clobber the newer local text.
  expect((await f.b.getCard(card.id))?.content).toBe('Offline edited');
  await sync.stop();
});

it('refuses private/pending global blobs and unsolicited image payloads even for authorized board peers', async () => {
  const f = await imageFixture();
  const imageId = await f.a.putImage(editor_image); // no signed reference in the shared board
  const wire = link(f);
  const transfer = wire.right.requestImages([imageId]).catch(e => e);
  await vi.waitFor(() => expect(wire.errors.some(e => e.message.includes('not authorized for this board'))).toBe(true));
  expect(await f.b.hasImage(imageId)).toBe(false);
  await expect(wire.right.receive({ kind: 'pboard-history', version: 1, op: 'image-put', id: 'unsolicited', imageId: 'b'.repeat(64), image: editor_image })).rejects.toThrow('Unrequested');
  wire.close(); await transfer;
});

it('transfers a 600 KiB image in acknowledged bounded parts, with the original content hash', async () => {
  const f = await imageFixture();
  const blob = new Blob([await (await imageToBlob(editor_image.dataUrl)).arrayBuffer(), new Uint8Array(600 * 1024)], { type: 'image/png' });
  const image = { ...editor_image, dataUrl: await blobToDataUrl(blob) };
  const card = await f.a.addItem({ projectId: f.board.id, content: 'Large image', image });
  const imageId = (await f.a.getCard(card.id))!.imageId!;
  const wire = link(f); await wire.sync();
  await wire.right.requestImages([imageId]); await wire.drain(); wire.quiet();
  expect(await hashBlob((await f.b.getImage(imageId))!.blob)).toBe(imageId);
  const parts = wire.frames.filter((frame: any) => frame.op === 'image-part');
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every(frame => new TextEncoder().encode(JSON.stringify(frame)).length < 65536)).toBe(true);
});

it('Drive failures do not prevent peer recovery and other image uploads do not block missing-image requests', async () => {
  const errors: unknown[] = [], requests: string[][] = [];
  const rx = { listCards: async () => [{ imageId: 'a'.repeat(64) }, { imageId: 'b'.repeat(64) }],
    getImage: async (id: string) => id.startsWith('a') ? { blob: await imageToBlob(editor_image.dataUrl), ...editor_image } : null,
    subscribeCards: () => () => {}, subscribeImages: () => () => {} } as unknown as RxRepository;
  const sync = createProjectImageSync({ projectId: 'b', repository: rx, canWrite: true,
    transport: { readImage: async () => { throw Error('Drive read unavailable'); }, writeImage: async () => { throw Error('Drive upload unavailable'); } },
    requestFromPeers: async ids => { requests.push(ids); }, onError: e => errors.push(e) });
  sync.start(); await sync.tick(); await sync.stop();
  expect(requests).toEqual([['b'.repeat(64)]]);
  expect(errors).toHaveLength(2);
});

it('discards an interrupted partial image and recovers the exact bytes on a new session', async () => {
  const f = await imageFixture();
  const blob = new Blob([new Uint8Array(600 * 1024)], { type: 'image/png' });
  const card = await f.a.addItem({ projectId: f.board.id, content: 'Interrupted image', image: { ...editor_image, dataUrl: await blobToDataUrl(blob) } });
  const imageId = (await f.a.getCard(card.id))!.imageId!;
  const interrupted = link(f); await interrupted.sync();
  const outcome = interrupted.right.requestImages([imageId]).catch(e => e);
  await vi.waitFor(() => expect(interrupted.frames.some((frame: any) => frame.op === 'image-part')).toBe(true));
  interrupted.close(); expect(await outcome).toBeInstanceOf(Error);
  expect(await f.b.hasImage(imageId)).toBe(false);
  const resumed = link(f); await resumed.sync(); await resumed.right.requestImages([imageId]); resumed.quiet();
  expect(await hashBlob((await f.b.getImage(imageId))!.blob)).toBe(imageId);
});


it.each(['tampered', 'out-of-order'])('rejects %s image parts without persisting a partial or forged asset', async mode => {
  const f = await imageFixture();
  const image = { ...editor_image, dataUrl: await blobToDataUrl(new Blob([new Uint8Array(600 * 1024)], { type: 'image/png' })) };
  const card = await f.a.addItem({ projectId: f.board.id, content: 'Protected image', image });
  const imageId = (await f.a.getCard(card.id))!.imageId!;
  const wire = link(f, frame => frame.op === 'image-part' && frame.index === 0
    ? mode === 'tampered' ? { ...frame, data: frame.data.replace('AAAA', 'AQAA') } : { ...frame, index: 1 }
    : frame);
  await wire.sync();
  const result = wire.right.requestImages([imageId]).catch(e => e);
  await vi.waitFor(() => expect(wire.errors.some(e => /integrity|Out-of-order/.test(e.message))).toBe(true));
  expect(await f.b.hasImage(imageId)).toBe(false); wire.close(); await result;
});
