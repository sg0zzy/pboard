import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { createSharedProjectRefresh } from "../src/sync/sharedSync";
import { serializeProjectSnapshot } from "../src/sync/snapshot";

async function setup() {
  const name = `refresh${crypto.randomUUID().replaceAll("-", "")}`;
  const changed = vi.fn();
  const repo = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`), events: { projectChanged: changed } });
  const project = await repo.createProject("Shared");
  const card = await repo.addItem({ projectId: project.id, content: "Original" });
  const snapshot = await repo.exportProject(project.id);
  const permissions = {
    myRole: vi.fn(async () => "owner" as const),
    readSharedSnapshot: vi.fn(async () => serializeProjectSnapshot(snapshot.project, snapshot.items)),
    writeSharedSnapshot: vi.fn()
  };
  let deleted = false;
  const refresh = createSharedProjectRefresh({ connected: async () => true, permissions,
    getRepository: async () => repo, isDeleted: async () => deleted });
  return { repo, project, card, snapshot, permissions, changed, refresh, hide: () => { deleted = true; } };
}
const future = "2099-01-01T00:00:00.000Z";

describe("read-only Drive catch-up before reconnect", () => {
  it("merges newer saved text, new cards and images without uploading or dirty notifications", async () => {
    const s = await setup();
    try {
      const previousKey = (await s.repo.db.cards.findOne(s.card.id).exec())!.orderKey;
      s.snapshot.project = { ...s.snapshot.project, name: "New name", updatedAt: future };
      s.snapshot.items[0] = { ...s.snapshot.items[0], content: "Saved on PC", updatedAt: future };
      s.snapshot.items.push({ ...s.card, id: "new-card", content: "Photo from PC", order: 1, updatedAt: future,
        image: { dataUrl: "data:image/png;base64,AAECAwQ=", mimeType: "image/png", width: 1, height: 1 } });
      s.changed.mockClear();
      s.repo.setMutatorRole(s.project.id, "viewer");
      await s.refresh(s.project.id, () => true);
      expect((await s.repo.getProject(s.project.id))?.name).toBe("New name");
      expect((await s.repo.getCard(s.card.id))?.content).toBe("Saved on PC");
      expect((await s.repo.db.cards.findOne(s.card.id).exec())!.orderKey).toBe(previousKey);
      const added = (await s.repo.getCard("new-card"))!;
      expect(added.content).toBe("Photo from PC");
      expect(await s.repo.hasImage(added.imageId!)).toBe(true);
      expect(s.permissions.writeSharedSnapshot).not.toHaveBeenCalled();
      expect(s.changed).not.toHaveBeenCalled();
      const before = (await s.repo.db.cards.findOne(s.card.id).exec())!.toJSON(true)._rev;
      const projectBefore = (await s.repo.db.projects.findOne(s.project.id).exec())!.toJSON(true)._rev;
      await s.refresh(s.project.id, () => true);
      expect(await s.repo.listCards(s.project.id)).toHaveLength(2);
      expect((await s.repo.db.cards.findOne(s.card.id).exec())!.toJSON(true)._rev).toBe(before);
      expect((await s.repo.db.projects.findOne(s.project.id).exec())!.toJSON(true)._rev).toBe(projectBefore);
    } finally { await s.repo.db.close(); }
  });

  it("preserves newer local edits, local-only cards and deletions even when the backup's board timestamp is newer", async () => {
    const s = await setup();
    try {
      await s.repo.updateItem(s.card.id, { content: "Unsynced phone edit" });
      const localOnly = await s.repo.addItem({ projectId: s.project.id, content: "Not uploaded yet" });
      const deleted = await s.repo.addItem({ projectId: s.project.id, content: "Deleted locally" });
      s.snapshot.items.push({ ...deleted, order: 2, updatedAt: future });
      await s.repo.deleteItem(deleted.id);
      s.snapshot.project.updatedAt = future;
      await s.refresh(s.project.id, () => true);
      expect((await s.repo.getCard(s.card.id))?.content).toBe("Unsynced phone edit");
      expect((await s.repo.getCard(localOnly.id))?.content).toBe("Not uploaded yet");
      expect(await s.repo.getCard(deleted.id)).toBeNull();
      expect(s.permissions.writeSharedSnapshot).not.toHaveBeenCalled();
    } finally { await s.repo.db.close(); }
  });

  it("rechecks edits made while Drive is downloading and ignores a response after leaving the board", async () => {
    const s = await setup();
    try {
      let finish!: (text: string) => void;
      s.permissions.readSharedSnapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const text = serializeProjectSnapshot(s.snapshot.project, s.snapshot.items);
      const pending = s.refresh(s.project.id, () => true);
      await vi.waitFor(() => expect(finish).toBeDefined());
      await s.repo.updateItem(s.card.id, { content: "Typed during request" });
      finish(text);
      await pending;
      expect((await s.repo.getCard(s.card.id))?.content).toBe("Typed during request");
      let active = true;
      s.snapshot.items[0] = { ...s.card, content: "Late stale session", updatedAt: future };
      s.permissions.readSharedSnapshot.mockImplementationOnce(async () => {
        active = false;
        return serializeProjectSnapshot(s.snapshot.project, s.snapshot.items);
      });
      await s.refresh(s.project.id, () => active);
      expect((await s.repo.getCard(s.card.id))?.content).toBe("Typed during request");
    } finally { await s.repo.db.close(); }
  });

  it("rejects unrelated snapshots and revoked access, and skips deleted boards", async () => {
    const s = await setup();
    try {
      s.snapshot.project.id = "unrelated";
      s.snapshot.items = [];
      await expect(s.refresh(s.project.id, () => true)).rejects.toThrow("different project");
      s.permissions.myRole.mockResolvedValueOnce(null as never);
      await expect(s.refresh(s.project.id, () => true)).rejects.toThrow("no longer have access");
      s.permissions.readSharedSnapshot.mockClear();
      s.hide();
      await s.refresh(s.project.id, () => true);
      expect(s.permissions.readSharedSnapshot).not.toHaveBeenCalled();
    } finally { await s.repo.db.close(); }
  });
});
