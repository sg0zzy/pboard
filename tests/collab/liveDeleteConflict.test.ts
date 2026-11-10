// Production pipeline: real WebRTC document pools AND authenticated causal
// history sessions over presence-capable signaling, with signed mutations —
// the combination the stripped transport-fixture manager tests cannot
// express. Guards the user-reported "Conflict requires resolution" class
// when one session deletes a card the other session can see.
import "fake-indexeddb/auto";
import NodeDataChannel from "node-datachannel/polyfill";
import { afterEach, expect, it } from "vitest";
import { createSimplePeerWrtc } from "rxdb/plugins/replication-webrtc";
import { createCollaborationManager, type CollaborationManager, type CollaborationSecurityOptions } from "../../src/collab/manager";
import { createDriveSignaling, type PboardDriveSignalRecord, type PboardSignaling } from "../../src/collab/signaling";
import { createRxRepository, type RxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";
import { generateDeviceKey, type StoredDeviceKey } from "../../src/collab/security/keys";
import { manifestHash, signManifest, verifyManifest } from "../../src/collab/security/manifest";
import type { PboardRole } from "../../src/sync/drivePermissions";
import { documentValue, makeChange, type DocumentValue, type JournalEntry } from "../../src/storage/changeJournal";
import { provePresentedChange } from "../../src/collab/security/journalProof";
import { signMutation } from "../../src/collab/security/mutation";
import { createPeerHistorySession, type PeerHistorySession } from "../../src/collab/peerHistory";
import type { VerifiedSessionContext } from "../../src/collab/security/session";

const wrtc = createSimplePeerWrtc(NodeDataChannel);
const repos: RxRepository[] = [], managers: CollaborationManager[] = [], sessions: PeerHistorySession[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop().catch(() => {});
  for (const session of sessions.splice(0)) session.close();
  for (const repo of repos.splice(0)) await repo.db.close().catch(() => {});
});
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 20000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitUntil: condition not met within timeout");
}

// Presence-capable rendezvous (memory signaling ignores signed presence by
// design; a secured handshake only completes on transports that persist it).
function driveScope() {
  const rooms = new Map<string, Map<string, PboardDriveSignalRecord>>();
  return (peerId: string) => ({ create(topic: string): PboardSignaling {
    const records = rooms.get(topic) ?? new Map<string, PboardDriveSignalRecord>();
    rooms.set(topic, records);
    return createDriveSignaling({ pollMs: 40, store: {
      peerId, now: Date.now,
      readPeer: async (id) => structuredClone(records.get(id) ?? null),
      writeOwn: async (record) => { records.set(peerId, structuredClone(record)); },
      listPeers: async () => structuredClone(Object.fromEntries(records)),
      deleteOwn: async () => { records.delete(peerId); }
    } });
  } });
}

async function fixture() {
  const ownerKey = await generateDeviceKey(), editorKey = await generateDeviceKey();
  const ownerRepo = await createRxRepository({ name: `livedel-a-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`livedel-blobs-a-${crypto.randomUUID()}`) });
  repos.push(ownerRepo);
  const project = await ownerRepo.createProject("Live delete", "project");
  const payload = { protocol: 2 as const, boardId: project.id, driveProjectFileId: "live-file", driveFolderId: "live-folder", authorityKeyId: ownerKey.keyId,
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: ownerKey.keyId, publicKey: ownerKey.publicJwk, role: "owner" as const }, { deviceKeyId: editorKey.keyId, publicKey: editorKey.publicJwk, role: "editor" as const }] };
  const manifest = await verifyManifest(await signManifest(payload, { privateJwk: ownerKey.privateJwk }), ownerKey.publicJwk, ownerKey.keyId);
  return { ownerKey, editorKey, manifest, ownerRepo, board: project };
}

function makeManager(repo: RxRepository, key: StoredDeviceKey, role: PboardRole, scope: { create(topic: string): PboardSignaling }, attest: boolean, manifest: CollaborationSecurityOptions["manifest"]) {
  const security: CollaborationSecurityOptions = { boardId: manifest.boardId, manifest, ownSessionId: crypto.randomUUID(),
    signer: { deviceKeyId: key.keyId, privateJwk: key.privateJwk } };
  const manager = createCollaborationManager({
    myRole: async () => role,
    getSharedFileId: async () => "live-file",
    bootstrapFromDrive: async () => false,
    signalingFor: (topic) => scope.create(topic),
    getRepository: async () => repo,
    wrtc,
    boardSecurity: async () => security,
    installMutationGuard: async (_projectId, boardSecurity) =>
      repo.installBoardSecurity({ security: { ...security, ...(boardSecurity ?? {}) }, attestExisting: attest })
  });
  managers.push(manager);
  return manager;
}

/** Owner starts (attesting), a second browser bootstraps the signed snapshot,
 * both go live, and a card is created, edited and deleted by the owner. */
async function sharedBoard(preCreateLegacy = false) {
  const f = await fixture();
  const legacy = preCreateLegacy ? await f.ownerRepo.addItem({ projectId: f.board.id, content: "legacy card" }) : null;
  const scope = driveScope();
  const editorRepo = await createRxRepository({ name: `livedel-b-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`livedel-blobs-b-${crypto.randomUUID()}`) });
  repos.push(editorRepo);
  const owner = makeManager(f.ownerRepo, f.ownerKey, "owner", scope("owner-session"), true, f.manifest);
  await owner.start(f.board.id);
  await waitUntil(async () => Boolean((await f.ownerRepo.db.projects.findOne(f.board.id).exec())?.toJSON()._sec));
  const snapshot = await f.ownerRepo.exportProject(f.board.id);
  await editorRepo.importProject(snapshot.project, snapshot.items);
  const editor = makeManager(editorRepo, f.editorKey, "editor", scope("editor-session"), false, f.manifest);
  await editor.start(f.board.id);
  await waitUntil(() => owner.state().connectedPeers.length > 0 && editor.state().connectedPeers.length > 0);
  return { f, owner, editor, editorRepo, legacy };
}

async function expectDeletedCleanly(f: Awaited<ReturnType<typeof fixture>>, editorRepo: RxRepository, cardId: string): Promise<void> {
  await f.ownerRepo.deleteItem(cardId);
  await waitUntil(async () => Boolean((await editorRepo.db.cards.findOne(cardId).exec())?.toJSON().deletedAt));
  // The causal-history channel must converge: exactly one deleted head and no
  // actionable conflict on either side.
  await waitUntil(async () =>
    (await editorRepo.listConflicts()).length === 0 && (await f.ownerRepo.listConflicts()).length === 0
    && (await editorRepo.reconciliation.inspect({ boardId: f.board.id, collection: "cards", documentId: cardId })).kind === "deleted", 15000);
}

it("deleting an edited card in one live session leaves both sessions conflict-free", { timeout: 60000 }, async () => {
  const { f, editorRepo } = await sharedBoard();
  const card = await f.ownerRepo.addItem({ projectId: f.board.id, content: "created" });
  await waitUntil(async () => (await editorRepo.getCard(card.id))?.content === "created");
  await f.ownerRepo.updateItem(card.id, { content: "edited" });
  await waitUntil(async () => (await editorRepo.getCard(card.id))?.content === "edited");
  await waitUntil(async () => (await editorRepo.listConflicts()).length === 0 && (await f.ownerRepo.listConflicts()).length === 0, 5000);
  await expectDeletedCleanly(f, editorRepo, card.id);
});

it("deleting a card that predates the session snapshot leaves both sessions conflict-free", { timeout: 60000 }, async () => {
  const { f, editorRepo, legacy } = await sharedBoard(true);
  expect(legacy).not.toBeNull();
  await waitUntil(async () => (await editorRepo.getCard(legacy!.id))?.content === "legacy card");
  await expectDeletedCleanly(f, editorRepo, legacy!.id);
});

// Failure mode pinned here (the exit-101 class): the erasure marker commits after
// the mutation gate has already admitted the call, so the board retires while its
// signed mutation is in flight. The write path re-reads the markers before recording
// anything (the journal guard reads them inside the same strict transaction as the write),
// the storage wrapper must hand the refusal back to the caller as a complete
// per-row response. If it re-threw instead, RxDB's incremental write queue would
// never settle this caller — the rejection would surface as an unhandled rejection
// (which is what made vitest exit 101) and every later write on the collection
// would hang behind the queue left marked running.
it("refuses a mutation whose board retires mid-flight to its caller and records nothing for it", { timeout: 60000 }, async () => {
  const f = await fixture();
  const security: CollaborationSecurityOptions = { boardId: f.manifest.boardId, manifest: f.manifest, ownSessionId: crypto.randomUUID(),
    signer: { deviceKeyId: f.ownerKey.keyId, privateJwk: f.ownerKey.privateJwk } };
  await f.ownerRepo.installBoardSecurity({ security, attestExisting: true });
  const sibling = await f.ownerRepo.createProject("Retired mid-flight sibling", "project");
  const journal = f.ownerRepo.journal;
  const entryIds = (boardId: string) => journal.entries.where("boardId").equals(boardId).toArray().then(rows => rows.map(row => row.id).sort());
  const recordedBeforeRetirement = await entryIds(f.board.id);
  const readErasure = journal.boardErasure.bind(journal);
  let inFlight = true;
  journal.boardErasure = async (boardId: string) => {
    const marker = await readErasure(boardId);
    if (inFlight && boardId === f.board.id) {
      inFlight = false;
      await journal.beginBoardErasure(f.board.id, null, [], []);
    }
    return marker;
  };
  await expect(f.ownerRepo.addItem({ projectId: f.board.id, content: "Live delete" })).rejects.toThrow();
  // Nothing — not even a prepared row — is recorded for the retired board.
  expect(await entryIds(f.board.id)).toEqual(recordedBeforeRetirement);
  // A refusal must settle its caller instead of leaving the queue marked running: another
  // attempt on the retired board is answered, and a board that is still authorized completes.
  await expect(f.ownerRepo.addItem({ projectId: f.board.id, content: "second attempt" })).rejects.toThrow();
  const later = await f.ownerRepo.addItem({ projectId: sibling.id, content: "later write" });
  expect((await f.ownerRepo.getCard(later.id))?.content).toBe("later write");
  journal.boardErasure = readErasure;
});

// The presentation pass can only attest content this device signed under the verified
// manifest, so content carrying no provenance has to be skipped rather than thrown:
// one unattestable record must not abort the exchange for the rest of the history.
// The skip is not a mask — a record that is signed but not authorized still fails.
it("skips what it cannot attest and still fails an author the manifest does not list", async () => {
  const f = await fixture();
  const security: CollaborationSecurityOptions = { boardId: f.manifest.boardId, manifest: f.manifest, ownSessionId: crypto.randomUUID(),
    signer: { deviceKeyId: f.ownerKey.keyId, privateJwk: f.ownerKey.privateJwk } };
  const documentId = crypto.randomUUID();
  const value: DocumentValue = { id: documentId, content: "unattested content", type: "note", status: "candidate", orderKey: "a0" };
  const unattested = await makeChange({ boardId: f.manifest.boardId, collection: "cards", documentId, parents: [], ancestry: "unknown", value });
  expect(await provePresentedChange(unattested, security)).toBeUndefined();

  // The same record shape, signed by a device the verified manifest does not list.
  const outsider = await generateDeviceKey();
  const signed = await signMutation(value, { deviceKeyId: outsider.keyId, privateJwk: outsider.privateJwk },
    { boardId: f.manifest.boardId, collection: "cards", manifest: f.manifest, sequence: 1, operationId: "unauthorized-author", parents: [] });
  const unauthorized = await makeChange({ boardId: f.manifest.boardId, collection: "cards", documentId, parents: [], ancestry: "unknown", value: signed });
  await expect(provePresentedChange(unauthorized, security)).rejects.toThrow();
});
// Presentation pass contract, end to end: a record the presenting device cannot attest
// stays local and the pass continues to the record behind it. A pre-enrollment private
// root is never disclosed, so the record parented on it reaches the editor as the root its
// own bytes prove — and an author the verified manifest does not list can never attest it.
// The record after that one, signed under the verified manifest by the presenting device,
// still arrives as the root its own signature proves.
it("retains a record it cannot attest and keeps delivering the record behind it", async () => {
  const f = await fixture();
  const author: CollaborationSecurityOptions = { boardId: f.manifest.boardId, manifest: f.manifest, ownSessionId: "author",
    signer: { deviceKeyId: f.ownerKey.keyId, privateJwk: f.ownerKey.privateJwk } };
  // A device the verified manifest does not list can never hold a session, so the peer side
  // runs on the listed editor device while the outsider only signs bytes for a document value.
  const outsider = await generateDeviceKey();
  const peer: CollaborationSecurityOptions = { boardId: f.manifest.boardId, manifest: f.manifest, ownSessionId: "peer",
    signer: { deviceKeyId: f.editorKey.keyId, privateJwk: f.editorKey.privateJwk } };
  const peerRepo = await createRxRepository({ name: `livedel-peer-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`livedel-blobs-peer-${crypto.randomUUID()}`) });
  repos.push(peerRepo);
  const board = await f.ownerRepo.db.projects.findOne(f.board.id).exec();
  // Private recovery materializes a card only onto a board the receiving side already has.
  if (board) await peerRepo.db.projects.upsert(JSON.parse(JSON.stringify(board.toJSON())));

  const documentId = crypto.randomUUID();
  const moment = new Date().toISOString();
  const card = (content: string, orderKey: string): DocumentValue => ({ id: documentId, projectId: f.board.id, content,
    type: "note", status: "candidate", orderKey, _deleted: false, createdAt: moment, updatedAt: moment });
  // Provenance travels as plain data, so the identity the peer recomputes is the bytes the
  // signature covers; the author it names is the one the verified manifest must list.
  const signedCard = async (value: DocumentValue, key: StoredDeviceKey, operationId: string, sequence: number, parents: string[]): Promise<DocumentValue> =>
    documentValue(await signMutation(value, { deviceKeyId: key.keyId, privateJwk: key.privateJwk },
      { boardId: f.board.id, collection: "cards", manifest: f.manifest, sequence, operationId, parents }));
  const privateRoot = await makeChange({ boardId: f.board.id, collection: "cards", documentId, parents: [], ancestry: "unknown",
    value: card("recorded before enrollment", "a0") });
  const unattestable = await makeChange({ boardId: f.board.id, collection: "cards", documentId, parents: [privateRoot.id], ancestry: "known",
    value: await signedCard(card("signed by a device the manifest does not list", "a1"), outsider, "unlisted-author", 2, [privateRoot.id]) });
  const attested = await makeChange({ boardId: f.board.id, collection: "cards", documentId, parents: [unattestable.id], ancestry: "known",
    value: await signedCard(card("signed under the verified manifest", "a2"), f.ownerKey, "listed-author", 3, [unattestable.id]) });
  await f.ownerRepo.journal.accept([privateRoot, unattestable, attested].map((change) => ({ ...change, state: "committed", origin: "local" })));

  const context = (own: CollaborationSecurityOptions, remote: CollaborationSecurityOptions): VerifiedSessionContext => {
    const remoteDevice = own.manifest.devices.find((device) => device.deviceKeyId === remote.signer.deviceKeyId);
    if (!remoteDevice) throw new Error("peer device is not listed in the verified manifest");
    return { boardId: own.boardId, collection: "cards", ownDeviceKeyId: own.signer.deviceKeyId, remoteDeviceKeyId: remote.signer.deviceKeyId,
      remoteRole: remoteDevice.role, ownSessionId: own.ownSessionId, remoteSessionId: remote.ownSessionId, manifestEpoch: own.manifest.epoch,
      manifestHash: manifestHash(own.manifest), transcriptHash: "presentation-pass", manifestExpiresAt: own.manifest.expiresAt };
  };
  const errors: string[] = [];
  let toAuthor = Promise.resolve(), toPeer = Promise.resolve();
  const authorSession = createPeerHistorySession({ repository: f.ownerRepo, security: author, context: context(author, peer), active: () => true,
    send(frame) { toPeer = toPeer.then(() => peerSession.receive(frame)).catch((error) => { errors.push(String(error)); }); },
    onError: (error) => errors.push(String(error)) });
  const peerSession = createPeerHistorySession({ repository: peerRepo, security: peer, context: context(peer, author), active: () => true,
    send(frame) { toAuthor = toAuthor.then(() => authorSession.receive(frame)).catch((error) => { errors.push(String(error)); }); },
    onError: (error) => errors.push(String(error)) });
  sessions.push(authorSession, peerSession);
  await Promise.all([authorSession.flush(), peerSession.flush()]);
  // A wake-triggered pass can still be in flight after journal admission; drain it before reading state.
  await toAuthor; await toPeer;

  // Skipping is not an error: the pass finished for everything it could attest.
  expect(errors).toEqual([]);
  // The record it cannot attest is retained locally with the ancestry it actually recorded.
  const retained = await f.ownerRepo.journal.entries.get(unattestable.id);
  expect(retained?.value.content).toBe("signed by a device the manifest does not list");
  expect(retained?.ancestry).toBe("known");
  expect(retained?.parents).toEqual([privateRoot.id]);
  expect(await f.ownerRepo.journal.entries.get(privateRoot.id)).toBeDefined();
  // It is never attested as a relay, so nothing for it reaches the peer.
  expect(await peerRepo.journal.entries.get(unattestable.id)).toBeUndefined();
  // The peer's own board write is its other committed row; the only card history it
  // received is the record that is the root its own bytes prove.
  const delivered = (await peerRepo.journal.entries.where("boardId").equals(f.board.id).toArray())
    .filter((row) => row.collection === "cards" && row.state === "committed");
  expect(delivered).toHaveLength(1);
  expect(delivered[0].ancestry).toBe("unknown");
  expect(delivered[0].parents).toEqual([]);
  expect(delivered[0].origin).toBe("observed");
  expect(delivered[0].value.content).toBe("signed under the verified manifest");
  const peerCards = await peerRepo.listCards(f.board.id);
  expect(peerCards.map((c) => c.content)).toEqual(["signed under the verified manifest"]);
});
