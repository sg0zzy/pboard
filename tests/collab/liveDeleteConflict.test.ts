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
import { signManifest, verifyManifest } from "../../src/collab/security/manifest";
import type { PboardRole } from "../../src/sync/drivePermissions";

const wrtc = createSimplePeerWrtc(NodeDataChannel);
const repos: RxRepository[] = [], managers: CollaborationManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop().catch(() => {});
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
