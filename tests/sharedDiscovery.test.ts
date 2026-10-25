import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createSharedBoardDiscovery } from "../src/sync/sharedDiscovery";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { serializeProjectSnapshot } from "../src/sync/snapshot";

const open = () => {
  const name = `discovery${crypto.randomUUID().replaceAll("-", "")}`;
  return createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
};

describe("incoming board invitations", () => {
  it("adds a new invitation to the reactive project list, preserving selection, cards, images and local edits", async () => {
    const owner = await open();
    const recipient = await open();
    try {
      const mine = await recipient.createProject("My board");
      const invited = await owner.createProject("Invited board");
      const card = await owner.addItem({ projectId: invited.id, content: "Welcome", image: {
        dataUrl: "data:image/png;base64,AAECAwQ=", mimeType: "image/png", width: 1, height: 1
      } });
      const snapshot = await owner.exportProject(invited.id);
      let visible = false;
      const permissions = {
        discoverSharedProjects: vi.fn(async () => visible ? [{ projectId: invited.id, name: invited.id, fileId: "shared-file" }] : []),
        readSharedSnapshot: vi.fn(async () => serializeProjectSnapshot(snapshot.project, snapshot.items)),
        myRole: vi.fn(async () => "editor" as const)
      };
      const discover = createSharedBoardDiscovery({ connected: async () => true, permissions,
        getRepository: async () => recipient, isDeleted: async () => false });
      const lists: string[][] = [];
      const stop = recipient.subscribeProjects((projects) => lists.push(projects.map((project) => project.name)));
      try {
        await discover();
        expect(await recipient.getProject(invited.id)).toBeNull();
        visible = true;
        await Promise.all([discover(), discover()]);
        await vi.waitFor(() => expect(lists.some((list) => list.includes("Invited board"))).toBe(true));
        expect((await recipient.getCurrentProject())?.id).toBe(mine.id);
        expect((await recipient.listProjects()).map((project) => project.name)).toEqual(["My board", "Invited board"]);
        expect(await recipient.hasImage(card.imageId!)).toBe(true);
        await recipient.updateItem(card.id, { content: "My newer live edit" });
        await discover();
        expect((await recipient.getCard(card.id))?.content).toBe("My newer live edit");
        expect(permissions.readSharedSnapshot).toHaveBeenCalledTimes(1);
      } finally { stop(); }
    } finally { await owner.db.close(); await recipient.db.close(); }
  });

  it("skips disconnected, locally deleted and revoked invitations and isolates invalid snapshots", async () => {
    const owner = await open();
    const recipient = await open();
    try {
      const deleted = await owner.createProject("Deleted");
      const revoked = await owner.createProject("Revoked");
      const invalid = await owner.createProject("Wrong ID");
      const viewer = await owner.createProject("Viewer invitation");
      let connected = false;
      const permissions = {
        discoverSharedProjects: vi.fn(async () => [deleted, revoked, invalid, viewer].map((project) => ({
          projectId: project.id, name: project.name, fileId: project.id
        }))),
        readSharedSnapshot: async (id: string) => {
          const snapshot = await owner.exportProject(id === invalid.id ? viewer.id : id);
          return serializeProjectSnapshot(snapshot.project, snapshot.items);
        },
        myRole: async (id: string) => id === revoked.id ? null : "viewer" as const
      };
      const discover = createSharedBoardDiscovery({ connected: async () => connected, permissions,
        getRepository: async () => recipient, isDeleted: async (id) => id === deleted.id });
      await discover();
      expect(permissions.discoverSharedProjects).not.toHaveBeenCalled();
      connected = true;
      await expect(discover()).rejects.toThrow("different project");
      expect((await recipient.listProjects()).map((project) => project.id)).toEqual([viewer.id]);
      await expect(recipient.renameProject(viewer.id, "Forbidden")).rejects.toThrow("view-only");
    } finally { await owner.db.close(); await recipient.db.close(); }
  });

  it("imports a hidden board once discovery reports the owner re-invited", async () => {
    const owner = await open();
    const recipient = await open();
    try {
      const board = await owner.createProject("Re-invited");
      const snapshot = await owner.exportProject(board.id);
      const permissions = {
        discoverSharedProjects: vi.fn(async () => [{ projectId: board.id, name: board.id, fileId: board.id }]),
        readSharedSnapshot: vi.fn(async () => serializeProjectSnapshot(snapshot.project, snapshot.items)),
        myRole: vi.fn(async () => "editor" as const)
      };
      let hidden = true;
      const isReshared = vi.fn(async () => true);
      const onReshared = vi.fn(async () => { hidden = false; });
      const discover = createSharedBoardDiscovery({ connected: async () => true, permissions,
        getRepository: async () => recipient, isDeleted: async () => hidden, isReshared, onReshared });
      await discover();
      expect(isReshared).toHaveBeenCalledWith(board.id);
      expect(onReshared).toHaveBeenCalledWith(board.id);
      expect((await recipient.listProjects()).map((project) => project.name)).toEqual(["Re-invited"]);
      // A second pass is a no-op: the board is visible and no longer deleted.
      await discover();
      expect(permissions.readSharedSnapshot).toHaveBeenCalledTimes(1);
      expect((await recipient.listProjects())).toHaveLength(1);
    } finally { await owner.db.close(); await recipient.db.close(); }
  });

  it("leaves hidden boards untouched when no re-share evidence exists", async () => {
    const owner = await open();
    const recipient = await open();
    try {
      const board = await owner.createProject("Stale share");
      const permissions = {
        discoverSharedProjects: vi.fn(async () => [{ projectId: board.id, name: board.id, fileId: board.id }]),
        readSharedSnapshot: vi.fn(async () => { throw new Error("must not read"); }),
        myRole: vi.fn(async () => "editor" as const)
      };
      const onReshared = vi.fn(async () => { throw new Error("must not restore"); });
      const discover = createSharedBoardDiscovery({ connected: async () => true, permissions,
        getRepository: async () => recipient, isDeleted: async () => true, onReshared });
      await discover();
      expect(onReshared).not.toHaveBeenCalled();
      expect(permissions.readSharedSnapshot).not.toHaveBeenCalled();
    } finally { await owner.db.close(); await recipient.db.close(); }
  });
});
