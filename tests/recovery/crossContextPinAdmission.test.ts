// The extension worker (page context menu "Pin selection to Pboard") writes
// through its own repository handle and never holds live board authority, so
// its card commands land as pending drafts. This guards the user-reported
// "Synchronization pending" notice after pinning while the sidebar sits open:
// the authorized context must admit those drafts automatically, without the
// "Verify board access and reconcile now" button. The worker side is replayed
// exactly as the mutation guard runs it there: draftCommand against a second
// ChangeJournal instance over the same durable stores (RxDB forbids two
// database objects with one name inside a single context, so the second
// repository handle is represented by the journal + scratch draft path).
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";
import { ChangeJournal } from "../../src/storage/changeJournal";
import { draftCommand } from "../../src/storage/pendingWork";
import { installLiveBoardMutations } from "../../src/collab/security/liveMutations";
import { generateDeviceKey } from "../../src/collab/security/keys";
import { signManifest, verifyManifest } from "../../src/collab/security/manifest";

it("admits a card pinned by a second repository context into the live signed board", async () => {
  const key = await generateDeviceKey();
  const now = Date.now();
  const name = `crosspin${crypto.randomUUID().replaceAll("-", "")}`;
  const sidebar = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}imgs`) });
  const board = await sidebar.createProject("Live board", "project");
  const manifest = await verifyManifest(await signManifest({ protocol: 2, boardId: board.id, driveFolderId: "f", driveProjectFileId: "p",
    authorityKeyId: key.keyId, epoch: 1, issuedAt: now, expiresAt: now + 300_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: "owner" as const }] }, key), key.publicJwk, key.keyId);
  // The sidebar context holds the verified session, like the collaboration
  // manager after start().
  const guard = await installLiveBoardMutations({ projectId: board.id, cards: sidebar.db.cards, projects: sidebar.db.projects,
    attestExisting: true, security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, manifest, boardId: board.id, ownSessionId: "sidebar" } });
  // The worker context: its own journal over the same durable stores, no
  // live authority — exactly the situation of a context-menu pin.
  const worker = new ChangeJournal(name);
  await worker.open();
  try {
    const permission = await worker.permissions.get(board.id);
    expect(permission?.authorityKeyId).toBeTruthy();
    const boardDoc = (await sidebar.db.projects.findOne(board.id).exec())!.toJSON(true) as Record<string, unknown>;
    const pinned = await draftCommand({ boardId: board.id, journal: worker, deviceKeyId: permission!.deviceKeyId!, authorityKeyId: permission!.authorityKeyId!,
      source: [{ collection: "projects", value: boardDoc }], command: "addItem", args: [{ projectId: board.id, content: "Pinned from the page" }],
      createScratch: async () => createRxRepository({ name: `scratch${crypto.randomUUID().replaceAll("-", "")}`, storage: getRxStorageMemory(),
        blobs: createIndexedDbBlobStore(`scratch${crypto.randomUUID().replaceAll("-", "")}imgs`), pendingScratch: true }) });
    // No manual admitPendingWork or renewBoardAuthorization anywhere below.
    await vi.waitFor(async () => {
      const card = await sidebar.db.cards.findOne(pinned.id).exec();
      expect(card?.content).toBe("Pinned from the page");
      expect(card?.toJSON()._sec?.provenance.payloadHash).toHaveLength(64);
    }, { timeout: 8000 });
    // The draft is gone from the actionable queue.
    await vi.waitFor(async () => expect((await sidebar.listPendingWork()).filter((entry) => entry.boardId === board.id)).toHaveLength(0), { timeout: 4000 });
  } finally {
    await guard.uninstall().catch(() => undefined);
    worker.close();
    await sidebar.db.close();
  }
});

it("never sweeps drafts of boards this context has no editor session for", async () => {
  const key = await generateDeviceKey();
  const now = Date.now();
  const name = `crosspinneg${crypto.randomUUID().replaceAll("-", "")}`;
  const live = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}imgs`) });
  const signedBoard = await live.createProject("Signed", "project");
  const manifest = await verifyManifest(await signManifest({ protocol: 2, boardId: signedBoard.id, driveFolderId: "f", driveProjectFileId: "p",
    authorityKeyId: key.keyId, epoch: 1, issuedAt: now, expiresAt: now + 300_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: "owner" as const }] }, key), key.publicJwk, key.keyId);
  // The session here covers only `signedBoard`; it must never sweep a draft
  // that belongs to another board.
  const guard = await installLiveBoardMutations({ projectId: signedBoard.id, cards: live.db.cards, projects: live.db.projects,
    attestExisting: true, security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, manifest, boardId: signedBoard.id, ownSessionId: "sidebar" } });
  try {
    // A draft for a board with no live session here must stay retained.
    const base = await (await import("../../src/storage/changeJournal")).makeChange({ boardId: "some-other-board", collection: "cards",
      documentId: "x".repeat(20), parents: [], ancestry: "unknown", value: { content: "elsewhere" } });
    await live.journal.pendingEdits.put({ id: "foreign-draft", boardId: "some-other-board", base,
      value: { content: "elsewhere" } as never, deviceKeyId: key.keyId, authorityKeyId: key.keyId, supersedes: [], creation: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await live.journal.pendingEdits.get("foreign-draft")).toBeTruthy();
    expect((await live.journal.entries.where("boardId").equals("some-other-board").toArray())).toHaveLength(0);
    // Nothing was admitted for the signed board either (no draft existed).
    expect((await live.journal.entries.where("boardId").equals(signedBoard.id).toArray()).filter((e) => !e.value.name)).toHaveLength(0);
  } finally {
    await guard.uninstall().catch(() => undefined);
    await live.db.close();
  }
});
