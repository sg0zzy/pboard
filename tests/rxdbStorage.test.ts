import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createRxRepository, type RxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { compareOrdered, initialOrderKeys, orderKeyBetween } from "../src/storage/orderKey";
import { createBackendProjectSnapshotStore, deserializeProjectSnapshot, serializeProjectSnapshot } from "../src/sync/snapshot";
import { createRepository, STORAGE_KEY, type KeyValueStorage } from "../src/storage/repository";
import type { AppState } from "../src/types";

const unique = () => `pboardtest${crypto.randomUUID().replaceAll("-", "")}`;
const open = (name: string) => createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
// Gate for tests that must observe an intermediate state: the awaited promise
// stays pending until the test releases it, so no wall-clock timer is involved.
type Gate<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("fractional order keys", () => {
  it("inserts at either end and repeatedly inside one gap", () => {
    const first = orderKeyBetween(null, null);
    const before = orderKeyBetween(null, first);
    const after = orderKeyBetween(first, null);
    expect(before < first && first < after).toBe(true);
    let right = after;
    for (let index = 0; index < 30; index++) {
      right = orderKeyBetween(first, right);
      expect(first < right && right < after).toBe(true);
    }
    expect(initialOrderKeys(3)).toEqual([...initialOrderKeys(3)].sort());
  });

  it("uses card ID as deterministic tie breaker", () => {
    expect([{ id: "b", orderKey: "a0" }, { id: "a", orderKey: "a0" }].sort(compareOrdered).map((card) => card.id)).toEqual(["a", "b"]);
  });
});

describe("RxDB local repository", () => {
  it.each(["editor", "viewer"] as const)("removes a %s's shared project from their account without touching shared content", async (role) => {
    const name = unique();
    const hidden: string[] = [];
    const deleting: string[] = [];
    const deleted: string[] = [];
    const rx: RxRepository = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`),
      events: { projectHidden: async (id) => {
          hidden.push(id);
          await rx.applyProjectOrder("collaborator", { ids: [], updatedAt: new Date().toISOString() });
        },
        projectDeleting: (project) => { deleting.push(project.id); },
        projectDeleted: (id) => { deleted.push(id); } } });
    try {
      const shared = await rx.createProject("Shared");
      const card = await rx.addItem({ projectId: shared.id, content: "Owner content" });
      const fallback = await rx.createProject("Personal");
      await rx.selectProject(shared.id);
      await rx.setProjectOrderAccount("collaborator");
      rx.setMutatorRole(shared.id, role);
      const beforeProject = (await rx.db.projects.findOne(shared.id).exec())!.toJSON();
      const beforeCard = (await rx.db.cards.findOne(card.id).exec())!.toJSON();
      await rx.deleteProject(shared.id);
      expect(await rx.getProject(shared.id)).toBeNull();
      expect(await rx.listCards(shared.id)).toEqual([]);
      expect((await rx.getCurrentProject())?.id).toBe(fallback.id);
      expect((await rx.db.projects.findOne(shared.id).exec())!.toJSON()).toEqual(beforeProject);
      expect((await rx.db.cards.findOne(card.id).exec())!.toJSON()).toEqual(beforeCard);
      expect(hidden).toEqual([shared.id]);
      expect(deleting).toEqual([]);
      expect(deleted).toEqual([]);
      // An account preference must never hide the original in another account.
      await rx.setProjectOrderAccount("owner");
      expect((await rx.getProject(shared.id))?.name).toBe("Shared");
      expect((await rx.listCards(shared.id))[0].content).toBe("Owner content");
      await rx.setProjectOrderAccount("collaborator");
      expect(await rx.getProject(shared.id)).toBeNull();
    } finally { await rx.db.close(); }
  });

  it("rechecks ownership when an editor role replaces a cached owner role", async () => {
    const name = unique();
    const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`),
      resolveDeletionRole: async () => "editor" });
    try {
      const shared = await rx.createProject("Shared");
      rx.setMutatorRole(shared.id, "owner");
      await rx.deleteProject(shared.id);
      expect(await rx.getProject(shared.id)).toBeNull();
      expect(await rx.db.projects.findOne(shared.id).exec()).not.toBeNull();
    } finally { await rx.db.close(); }
  });

  it("allows a verified owner to delete shared records and invokes deletion callbacks", async () => {
    const name = unique();
    const deleted: string[] = [];
    const rx: RxRepository = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`),
      resolveDeletionRole: async () => "owner",
      events: { projectDeleted: async (id) => {
        deleted.push(id);
        await rx.applyProjectOrder("owner", { ids: [], updatedAt: new Date().toISOString() });
      } } });
    try {
      const shared = await rx.createProject("Shared");
      const card = await rx.addItem({ projectId: shared.id, content: "Owner content" });
      rx.setMutatorRole(shared.id, "owner");
      await rx.deleteProject(shared.id);
      expect(await rx.db.projects.findOne(shared.id).exec()).toBeNull();
      expect((await rx.db.cards.findOne(card.id).exec())?.deletedAt).toBeTruthy();
      expect(deleted).toEqual([shared.id]);
    } finally { await rx.db.close(); }
  });

  it("commits the account marker and selection before resolving Drive ownership", async () => {
    const name = unique();
    const entered = gate<void>();
    const propagation = gate<void>();
    let markerCommitted = false;
    let selectedProject: string | undefined;
    const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`),
      resolveDeletionRole: async (projectId) => {
        markerCommitted = await rx.isDeletedProject(projectId);
        selectedProject = (await rx.getCurrentProject())?.id;
        entered.resolve();
        await propagation.promise;
        return "owner";
      } });
    try {
      const fallback = await rx.createProject("Personal");
      const shared = await rx.createProject("Shared");
      const card = await rx.addItem({ projectId: shared.id, content: "Owner content" });
      await rx.selectProject(shared.id);
      const pending = rx.deleteProject(shared.id);
      await entered.promise;
      expect(markerCommitted).toBe(true);
      expect(selectedProject).toBe(fallback.id);
      // Shared content is untouched while ownership is still being verified.
      expect((await rx.db.cards.findOne(card.id).exec())?.deletedAt).toBeUndefined();
      propagation.resolve();
      await pending;
      expect((await rx.db.cards.findOne(card.id).exec())?.deletedAt).toBeTruthy();
      expect((await rx.db.projects.findOne(shared.id).exec())).toBeNull();
    } finally { await rx.db.close(); }
  });

  it("keeps the committed account removal when the ownership check fails afterwards", async () => {
    const name = unique();
    const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`),
      resolveDeletionRole: async () => { throw new Error("Drive role check failed"); } });
    try {
      const shared = await rx.createProject("Shared");
      await rx.selectProject(shared.id);
      await expect(rx.deleteProject(shared.id)).rejects.toThrow("Drive role check failed");
      expect(await rx.isDeletedProject(shared.id)).toBe(true);
      expect((await rx.db.projects.findOne(shared.id).exec())).not.toBeNull();
    } finally { await rx.db.close(); }
  });

  it("persists account-specific project order without changing shared documents or viewer permissions", async () => {
    const name = unique();
    const rx = await open(name);
    const a = await rx.createProject("A");
    const b = await rx.createProject("B");
    await rx.setProjectOrderAccount("pippo");
    rx.setMutatorRole(a.id, "viewer");
    const before = (await rx.db.projects.find().exec()).map((doc) => doc.toJSON());
    await rx.reorderProjects([b.id, a.id]);
    expect((await rx.listProjects()).map((project) => project.id)).toEqual([b.id, a.id]);
    expect((await rx.db.projects.find().exec()).map((doc) => doc.toJSON())).toEqual(before);
    await expect(rx.renameProject(a.id, "Forbidden")).rejects.toThrow("view-only");
    await rx.setProjectOrderAccount("pluto");
    await rx.reorderProjects([a.id, b.id]);
    await rx.setProjectOrderAccount("pippo");
    expect((await rx.listProjects()).map((project) => project.id)).toEqual([b.id, a.id]);
    await rx.setProjectOrderAccount(null);
    await rx.db.close();
    const reopened = await open(name);
    expect((await reopened.listProjects()).map((project) => project.id)).toEqual([b.id, a.id]);
    await reopened.setProjectOrderAccount("pluto");
    expect((await reopened.listProjects()).map((project) => project.id)).toEqual([a.id, b.id]);
    await reopened.db.close();
  });
  it("persists CRUD, subscriptions, one-card moves and restart", async () => {
    const name = unique();
    const rx = await open(name);
    const changes: string[][] = [];
    const project = await rx.createProject("Board", "project");
    const unsubscribe = rx.subscribeCards(project.id, (cards) => changes.push(cards.map((card) => card.id)));
    const a = await rx.addItem({ projectId: project.id, content: "A" });
    const b = await rx.addItem({ projectId: project.id, content: "B" });
    const c = await rx.addItem({ projectId: project.id, content: "C", afterItemId: a.id });
    expect((await rx.listCards(project.id)).map((card) => card.id)).toEqual([a.id, c.id, b.id]);
    const oldKeys = new Map((await rx.db.cards.find().exec()).map((doc) => [doc.id, doc.orderKey]));
    await rx.reorderItems(project.id, [b.id, a.id, c.id]);
    expect((await rx.listCards(project.id)).map((card) => card.id)).toEqual([b.id, a.id, c.id]);
    const newKeys = new Map((await rx.db.cards.find().exec()).map((doc) => [doc.id, doc.orderKey]));
    expect([...newKeys].filter(([id, key]) => oldKeys.get(id) !== key)).toHaveLength(1);
    const beforeDown = new Map(newKeys);
    await rx.reorderItems(project.id, [a.id, c.id, b.id]);
    expect((await rx.listCards(project.id)).map((card) => card.id)).toEqual([a.id, c.id, b.id]);
    const afterDown = new Map((await rx.db.cards.find().exec()).map((doc) => [doc.id, doc.orderKey]));
    expect([...afterDown].filter(([id, key]) => beforeDown.get(id) !== key)).toHaveLength(1);
    await rx.updateItem(a.id, { status: "done", content: "Edited" });
    expect((await rx.listCardsByStatus(project.id, "done")).map((card) => card.id)).toEqual([a.id]);
    await rx.deleteItem(c.id);
    expect((await rx.listCards(project.id)).map((card) => card.id)).toEqual([a.id, b.id]);
    expect((await rx.db.cards.findOne(c.id).exec())?.deletedAt).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changes.some((ids) => ids.includes(a.id))).toBe(true);
    unsubscribe();
    await rx.db.close();
    const reopened = await open(name);
    expect((await reopened.listCards(project.id)).map((card) => card.id)).toEqual([a.id, b.id]);
    await reopened.db.close();
  });

  it("keeps Blob bytes out of cards and deduplicates duplicated images", async () => {
    const rx = await open(unique());
    const project = await rx.createProject("Images");
    const image = { dataUrl: "data:image/webp;base64,AAAA", mimeType: "image/webp", width: 20, height: 10 };
    const card = await rx.addItem({ projectId: project.id, content: "Screenshot", image });
    const duplicate = await rx.duplicateItem(card.id);
    const raw = await rx.db.cards.find().exec();
    expect(raw[0].toJSON()).not.toHaveProperty("image");
    expect(raw[0].imageId).toBe(raw[1].imageId);
    expect(duplicate.imageId).toBe(card.imageId);
    expect(await rx.hasImage(card.imageId!)).toBe(true);
    expect((await rx.exportProject(project.id)).items[0].image?.dataUrl).toBe(image.dataUrl);
    await rx.deleteItem(card.id);
    expect(await rx.hasImage(card.imageId!)).toBe(true);
    await expect(rx.deleteImage(card.imageId!)).rejects.toThrow("still referenced");
    await rx.db.close();
  });

  it("keeps Drive v1 snapshots compatible while importing images into Blob storage", async () => {
    const rx = await open(unique());
    const storage: KeyValueStorage = { get: async () => ({}), set: async () => undefined };
    const adapter = createBackendProjectSnapshotStore(storage, async () => rx);
    const project = await rx.createProject("Drive");
    const image = { dataUrl: "data:image/webp;base64,AAAA", mimeType: "image/webp", width: 2, height: 2 };
    const card = await rx.addItem({ projectId: project.id, content: "Image", image });
    const snapshot = await adapter.read(project.id);
    await rx.blobs.deleteBlob(card.imageId!);
    expect(await adapter.applyIfNewer(snapshot)).toBe("equal");
    expect(await rx.hasImage(card.imageId!)).toBe(true);
    await rx.updateItem(card.id, { content: "Keep newer live text" });
    await rx.blobs.deleteBlob(card.imageId!);
    expect(await adapter.applyIfNewer(snapshot)).toBe("local-newer");
    expect(await rx.hasImage(card.imageId!)).toBe(true);
    expect((await rx.getCard(card.id))?.content).toBe("Keep newer live text");
    expect(deserializeProjectSnapshot(serializeProjectSnapshot(snapshot.project, snapshot.items)).items[0].image).toEqual(image);
    expect((await rx.db.cards.findOne(card.id).exec())?.toJSON()).not.toHaveProperty("image");
    const remote = { ...snapshot, project: { ...snapshot.project, updatedAt: "2099-01-01T00:00:00.000Z", revision: 50 }, items: snapshot.items.map((item) => ({ ...item, content: "Remote image" })) };
    expect(await adapter.applyIfNewer(remote)).toBe("applied");
    expect((await rx.getCard(card.id))?.content).toBe("Remote image");
    expect((await adapter.read(project.id)).items[0].image?.dataUrl).toBe(image.dataUrl);
    await rx.deleteItem(card.id);
    expect(await rx.getCard(card.id)).toBeNull();
    const later = { ...remote, project: { ...remote.project, updatedAt: "2100-01-01T00:00:00.000Z" } };
    expect(await adapter.applyIfNewer(later)).toBe("applied");
    expect((await rx.getCard(card.id))?.content).toBe("Remote image");
    await rx.db.close();
  });

  it("exports a recoverable legacy AppState without changing its saved key", async () => {
    const rx = await open(unique());
    const project = await rx.createProject("Rollback");
    await rx.addItem({ projectId: project.id, content: "Recover me" });
    const legacyState = await rx.exportAll();
    const values: Record<string, unknown> = {};
    const storage: KeyValueStorage = {
      get: async (key) => ({ [key]: values[key] }),
      set: async (next) => { Object.assign(values, next); }
    };
    await storage.set({ [STORAGE_KEY]: legacyState });
    expect((await createRepository(storage).load()).boardItems[0].content).toBe("Recover me");
    expect(values[STORAGE_KEY]).toBeDefined();
    await rx.db.close();
  });

  it("imports old state idempotently with IDs, order, templates, trash and image data", async () => {
    const rx = await open(unique());
    const image = { dataUrl: "data:image/webp;base64,AAAA", mimeType: "image/webp", width: 2, height: 2 };
    const state: AppState = { version: 3, currentProjectId: "project-b", projects: [
      { id: "project-a", name: "A", template: "idea", revision: 4, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
      { id: "project-b", name: "B", template: "project", revision: 1, createdAt: "2025-01-02T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" }
    ], boardItems: [
      { id: "b", projectId: "project-a", type: "note", status: "trash", content: "long ".repeat(1000), order: 8, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
      { id: "a", projectId: "project-a", type: "note", status: "candidate", content: "Picture", image,
        source: { provider: "web", conversationUrl: "https://example.com/page", sourceText: "Original text" },
        displayMode: "expanded", order: 2, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
      { id: "c", projectId: "project-b", type: "task", status: "done", content: "Other", order: 0, createdAt: "2025-01-02T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" }
    ] };
    await rx.importState(state);
    await rx.importState(state);
    expect((await rx.listProjects()).map((project) => project.id)).toEqual(["project-a", "project-b"]);
    expect((await rx.listCards("project-a")).map((card) => card.id)).toEqual(["a", "b"]);
    expect((await rx.getCard("a"))?.source).toEqual(state.boardItems[1].source);
    expect((await rx.getCard("a"))?.displayMode).toBe("expanded");
    expect((await rx.getCurrentProject())?.id).toBe("project-b");
    expect((await rx.exportProject("project-a")).items[0].image?.dataUrl).toBe(image.dataUrl);
    await rx.db.close();
  });
});
