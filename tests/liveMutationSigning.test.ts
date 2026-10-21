import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import type { RxDocumentData } from "rxdb";
import type { CardRecord } from "../src/storage/rxdbSchemas";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { installLiveBoardMutations } from "../src/collab/security/liveMutations";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { generateDeviceKey } from "../src/collab/security/keys";
import { signManifest, verifyManifest } from "../src/collab/security/manifest";
import { verifyMutation, createMutationReplayCache } from "../src/collab/security/mutation";

it("rejects a new independent authority before changing any previously signed local data", async () => {
  const first = await generateDeviceKey(), replacement = await generateDeviceKey();
  const name = `authoritymigration${crypto.randomUUID().replaceAll("-", "")}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const board = await rx.createProject("Keep original trust", "project");
  await rx.addItem({ projectId: board.id, content: "Original signed content" });
  const context = (key: typeof first) => {
    const now = Date.now();
    const manifest = { protocol: 2 as const, boardId: board.id, driveProjectFileId: "", driveFolderId: "", authorityKeyId: key.keyId, epoch: 1, issuedAt: now, expiresAt: now + 300_000, devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: "owner" as const }] };
    return { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, boardId: board.id, manifest, ownSessionId: "session", manifestHistory: new Map([[1, manifest]]) };
  };
  try {
    const guard = await installLiveBoardMutations({ projectId: board.id, cards: rx.db.cards, projects: rx.db.projects, security: context(first), attestExisting: true });
    await guard.uninstall();
    const held = await rx.addItem({ projectId: board.id, content: "Unsigned writes remain private pending work" });
    expect(await rx.db.cards.findOne(held.id).exec()).toBeNull();
    const before = [await rx.db.cards.find().exec(), await rx.db.projects.find().exec()].map(rows => rows.map(doc => structuredClone(doc.toJSON())));
    await expect(installLiveBoardMutations({ projectId: board.id, cards: rx.db.cards, projects: rx.db.projects, security: context(replacement), attestExisting: true, preserveSignedData: true })).rejects.toThrow();
    const after = [await rx.db.cards.find().exec(), await rx.db.projects.find().exec()].map(rows => rows.map(doc => structuredClone(doc.toJSON())));
    expect(after).toEqual(before);
  } finally { await rx.db.remove(); }
});

it("signs repository writes but rejects forged storage writes without signing for the sender", async () => {
  const key = await generateDeviceKey(); const now = Date.now();
  const name = `livemutations${crypto.randomUUID().replaceAll("-", "")}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const board = await rx.createProject("Attested", "project");
  const signed = await signManifest({ protocol: 2, boardId: board.id, driveFolderId: "folder", driveProjectFileId: "file", authorityKeyId: key.keyId, epoch: 1, issuedAt: now, expiresAt: now + 300_000, devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: "owner" }] }, key);
  const manifest = await verifyManifest(signed, key.publicJwk, key.keyId);
  const guard = await installLiveBoardMutations({ projectId: board.id, cards: rx.db.cards, projects: rx.db.projects, attestExisting: true,
    security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, manifest, boardId: board.id, ownSessionId: "session" } });
  try {
    const card = await rx.addItem({ projectId: board.id, content: "signed local change" });
    const doc = structuredClone((await rx.db.cards.findOne(card.id).exec())!.toJSON()) as RxDocumentData<CardRecord>;
    expect(doc._sec?.provenance.payloadHash).toHaveLength(64);
    await expect(verifyMutation(doc, { boardId: board.id, collection: "cards", manifest }, createMutationReplayCache())).resolves.toBeTruthy();
    const forged = { ...doc, content: "forged", _rev: `9-${"a".repeat(32)}` };
    const result = await rx.db.cards.storageInstance.bulkWrite([{ previous: doc, document: forged }], "replication-forged");
    expect(result.error).toHaveLength(1);
    expect((await rx.db.cards.findOne(card.id).exec())?.content).toBe("signed local change");
    const snapshot = await rx.exportProject(board.id);
    snapshot.items[0].content = "untrusted Drive overwrite";
    snapshot.items[0].updatedAt = new Date(Date.now() + 10000).toISOString();
    await expect(rx.mergeSharedSnapshot(snapshot.project, snapshot.items, async () => true)).rejects.toThrow();
    expect((await rx.db.cards.findOne(card.id).exec())?.content).toBe("signed local change");
    await rx.deleteItem(card.id);
    const tombstone = (await rx.db.cards.findOne(card.id).exec())!.toJSON();
    await expect(verifyMutation(tombstone, { boardId: board.id, collection: "cards", manifest }, createMutationReplayCache())).resolves.toBeTruthy();
    await rx.deleteProject(board.id);
    expect(await rx.getProject(board.id)).toBeNull();
    const [deletedProject] = await rx.db.projects.storageInstance.findDocumentsById([board.id], true);
    await expect(verifyMutation(deletedProject, { boardId: board.id, collection: "projects", manifest }, createMutationReplayCache())).resolves.toBeTruthy();
    await expect(verifyMutation({ ...doc, _deleted: true }, { boardId: board.id, collection: "cards", manifest }, createMutationReplayCache())).rejects.toThrow(/deletion/);
  } finally { await guard.uninstall(); await rx.db.remove(); }
});

it('creates a separate collaborative copy without changing the original signed board or reusing its provenance', async () => {
  const { createCollaborativeCopy } = await import('../src/collab/collaborativeCopy');
  const name = `copy${crypto.randomUUID().replaceAll('-', '')}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const key = await generateDeviceKey(), now = Date.now();
  const board = await rx.createProject('Original authority', 'project');
  await rx.addItem({ projectId: board.id, content: 'Keep me', title: 'Title', source: { conversationUrl: 'https://example.test/conversation' }, status: 'confirmed' });
  const manifest = { protocol: 2 as const, boardId: board.id, driveFolderId: '', driveProjectFileId: '', authorityKeyId: key.keyId, epoch: 1, issuedAt: now, expiresAt: now+300000, devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' as const }] };
  const guard = await installLiveBoardMutations({ projectId: board.id, cards: rx.db.cards, projects: rx.db.projects, attestExisting: true, security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, boardId: board.id, manifest, ownSessionId: 'original', manifestHistory: new Map([[1,manifest]]) } });
  try {
    const sourceProject = (await rx.db.projects.findOne(board.id).exec())!.toJSON();
    const sourceCards = (await rx.db.cards.find({ selector: { projectId: board.id } }).exec()).map(doc=>doc.toJSON());
    const copy = await createCollaborativeCopy(rx, board.id);
    expect(copy).not.toBe(board.id);
    expect((await rx.db.projects.findOne(board.id).exec())!.toJSON()).toEqual(sourceProject);
    expect((await rx.db.cards.find({ selector: { projectId: board.id } }).exec()).map(doc=>doc.toJSON())).toEqual(sourceCards);
    const cloned = await rx.listCards(copy);
    expect(cloned).toHaveLength(1);
    expect(cloned[0]).toMatchObject({ content: 'Keep me', title: 'Title', status: 'confirmed', source: { conversationUrl: 'https://example.test/conversation' } });
    expect(cloned[0].id).not.toBe(sourceCards[0].id);
    expect((await rx.db.cards.findOne(cloned[0].id).exec())!.toJSON()._sec).toBeUndefined();
    expect((await rx.db.projects.findOne(copy).exec())!.toJSON()._sec).toBeUndefined();
  } finally { await guard.uninstall(); await rx.db.remove(); }
});

it('fails closed if direct empty-card attestation overlaps an untrusted import', async () => {
  const rx = await createRxRepository({ name: `bootstraprace${crypto.randomUUID().replaceAll('-', '')}` });
  const board = await rx.createProject('New board', 'project');
  await rx.addItem({ projectId: board.id, content: '' });
  const key = await generateDeviceKey(), now = Date.now();
  const manifest = { protocol: 2 as const, boardId: board.id, driveFolderId: '', driveProjectFileId: '', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: now, expiresAt: now + 300000, devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' as const }] };
  const { withUntrustedImport } = await import('../src/collab/security/liveMutations');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const recovering = withUntrustedImport([rx.db.cards, rx.db.projects], () => blocked);
  try {
    await expect(installLiveBoardMutations({ projectId: board.id, cards: rx.db.cards, projects: rx.db.projects, attestExisting: true,
      security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, boardId: board.id, manifest, ownSessionId: 'race', manifestHistory: new Map([[1, manifest]]) } })).rejects.toThrow();
  } finally { release(); await recovering; await rx.db.close(); }
});


it('queues empty-card bootstrap behind an actual snapshot import and keeps recovered bytes unsigned', async () => {
  const rx = await createRxRepository({ name: `queuedbootstrap${crypto.randomUUID().replaceAll('-', '')}` });
  const board = await rx.createProject('New empty board', 'project');
  const card = await rx.addItem({ projectId: board.id, content: '' });
  const key = await generateDeviceKey(), now = Date.now();
  const manifest = { protocol: 2 as const, boardId: board.id, driveFolderId: '', driveProjectFileId: '', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: now, expiresAt: now + 300000, devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' as const }] };
  const remote = { ...board, id: crypto.randomUUID(), name: 'Other private recovered board' };
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = rx.db.projects.upsert.bind(rx.db.projects);
  const upsert = vi.spyOn(rx.db.projects, 'upsert').mockImplementationOnce(async value => { entered(); await blocked; return original(value); });
  let guard: Awaited<ReturnType<typeof rx.installBoardSecurity>> | undefined;
  try {
    const recovering = rx.importProject(remote, []); await started;
    let completed = false;
    const initializing = rx.installBoardSecurity({ attestExisting: true, preserveSignedData: true,
      security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, boardId: board.id, manifest, ownSessionId: 'queued', manifestHistory: new Map([[1, manifest]]) } }).then(value => { completed = true; return value; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(completed).toBe(false);
    release(); await recovering; guard = await initializing;
    const saved = (await rx.db.cards.findOne(card.id).exec())!.toJSON();
    await expect(verifyMutation(saved, { boardId: board.id, collection: 'cards', manifest }, createMutationReplayCache())).resolves.toBeTruthy();
    expect(saved.content).toBe('');
    expect((await rx.db.projects.findOne(remote.id).exec())!._sec).toBeUndefined();
    await rx.updateItem(card.id, { content: 'Still editable' });
    expect((await rx.getCard(card.id))?.content).toBe('Still editable');
  } finally { release(); upsert.mockRestore(); await guard?.uninstall(); await rx.db.close(); }
});

it('finishes an in-flight signed edit before selection teardown uninstalls its guard', async () => {
  const rx = await createRxRepository({ name: `teardownsigned${crypto.randomUUID().replaceAll('-', '')}` });
  const board = await rx.createProject('Switching boards', 'project');
  const card = await rx.addItem({ projectId: board.id, content: '' });
  const key = await generateDeviceKey(), now = Date.now();
  const manifest = { protocol: 2 as const, boardId: board.id, driveFolderId: '', driveProjectFileId: '', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: now, expiresAt: now + 300000, devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' as const }] };
  const guard = await rx.installBoardSecurity({ attestExisting: true, security: { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, boardId: board.id, manifest, ownSessionId: 'switch', manifestHistory: new Map([[1, manifest]]) } });
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  rx.db.cards.preSave(async () => { entered(); await blocked; }, false);
  try {
    const write = rx.updateItem(card.id, { content: 'Durable edit before switching' }); await started;
    let stopped = false;
    const stop = guard.uninstall().then(() => { stopped = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(stopped).toBe(false); release(); await Promise.all([write, stop]);
    const saved = (await rx.db.cards.findOne(card.id).exec())!.toJSON();
    expect(saved.content).toBe('Durable edit before switching');
    await expect(verifyMutation(saved, { boardId: board.id, collection: 'cards', manifest }, createMutationReplayCache())).resolves.toBeTruthy();
  } finally { release(); await guard.uninstall(); await rx.db.close(); }
});
