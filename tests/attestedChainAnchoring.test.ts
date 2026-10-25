import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { installLiveBoardMutations } from "../src/collab/security/liveMutations";
import { generateDeviceKey } from "../src/collab/security/keys";
import { signManifest, verifyManifest } from "../src/collab/security/manifest";

it("keeps an attested board on one journal chain through edits and deletion", async () => {
  const key = await generateDeviceKey();
  const now = Date.now();
  const name = `attestedchain${crypto.randomUUID().replaceAll("-", "")}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  // The board predates collaboration: its stored rows were written unsigned.
  const board = await rx.createProject("Legacy unsigned", "project");
  await rx.addItem({ projectId: board.id, content: "First card" });
  const manifest = await verifyManifest(await signManifest({ protocol: 2, boardId: board.id, driveFolderId: "folder", driveProjectFileId: "file",
    authorityKeyId: key.keyId, epoch: 1, issuedAt: now, expiresAt: now + 300_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: "owner" }] }, key), key.publicJwk, key.keyId);
  let guard: Awaited<ReturnType<typeof installLiveBoardMutations>> | undefined;
  try {
    guard = await installLiveBoardMutations({ projectId: board.id, cards: rx.db.cards, projects: rx.db.projects, attestExisting: true,
      security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, manifest, boardId: board.id, ownSessionId: "session" } });
    await rx.renameProject(board.id, "Renamed");
    await rx.deleteProject(board.id);
    expect(await rx.getProject(board.id)).toBeNull();
    expect(await rx.isDeletedProject(board.id)).toBe(true);
    // A healthy delete must not leave "retained conflict evidence on removed
    // boards" behind; that panel would demand a redundant permanent delete.
    expect((await rx.listConflicts()).map((c) => [c.collection, c.documentId, c.result.reason])).toEqual([]);
    expect((await rx.listPendingWork()).map((p) => p.boardId)).toEqual([]);
    for (const collection of ["projects", "cards"] as const) {
      const entries = (await rx.journal.entries.where("boardId").equals(board.id).toArray()).filter((e) => e.collection === collection);
      expect(entries.length).toBeGreaterThan(0);
      // The remove write must anchor on the live head, not a synthesized
      // baseline root: exactly one root (the original creation) and no
      // baseline fragments anywhere in the chain.
      expect(entries.filter((e) => e.origin === "baseline")).toEqual([]);
      expect(entries.filter((e) => !e.parents.length).map((e) => e.id)).toHaveLength(1);
    }
    const deleted = (await rx.journal.entries.where("boardId").equals(board.id).toArray())
      .filter((e) => e.collection === "projects" && e.value._deleted === true);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].parents).toHaveLength(1);
    expect((await rx.journal.entries.where("boardId").equals(board.id).toArray())
      .some((e) => e.id === deleted[0].parents[0] && e.value.name === "Renamed" && e.value._deleted !== true)).toBe(true);
  } finally {
    await guard?.uninstall();
    await rx.db.remove();
  }
}, 30_000);
