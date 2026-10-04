import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createProjectImageSync, type SharedImageTransport } from "../src/collab/imageSync";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import type { BoardImage } from "../src/types";

const image: BoardImage = { dataUrl: "data:image/png;base64,AAECAwQ=", mimeType: "image/png", width: 1, height: 1 };
const open = () => {
  const name = `pboardimagesync${crypto.randomUUID().replaceAll("-", "")}`;
  return createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
};

describe("shared image sync", () => {
  it("repairs existing missing blobs for a viewer and notifies the UI without changing live cards", async () => {
    const owner = await open(); const viewer = await open();
    const assets = new Map<string, BoardImage>();
    const transport: SharedImageTransport = {
      readImage: async (_project, id) => assets.get(id) ?? null,
      writeImage: vi.fn(async (_project, id, value) => { assets.set(id, value); })
    };
    const errors: unknown[] = [];
    const project = await owner.createProject("Images");
    const card = await owner.addItem({ projectId: project.id, content: "Image", image });
    await viewer.importProject(project, []);
    await viewer.db.cards.insert((await owner.db.cards.findOne(card.id).exec())!.toJSON());
    const before = (await viewer.db.cards.findOne(card.id).exec())!.toJSON();
    const notices: string[] = [];
    const stopNotices = viewer.subscribeImages((id) => notices.push(id));
    const publish = createProjectImageSync({ projectId: project.id, repository: owner, transport, canWrite: true, onError: (err) => errors.push(err) });
    const receive = createProjectImageSync({ projectId: project.id, repository: viewer, transport, canWrite: false, onError: (err) => errors.push(err) });
    try {
      await expect(viewer.exportProject(project.id)).rejects.toThrow("Image data is missing");
      publish.start(); await publish.tick();
      receive.start(); await receive.tick();
      expect(await viewer.hasImage(card.imageId!)).toBe(true);
      expect(notices).toContain(card.imageId);
      expect((await viewer.db.cards.findOne(card.id).exec())!.toJSON()).toEqual(before);
      expect((await viewer.exportProject(project.id)).items[0].image).toEqual(image);
      expect(transport.writeImage).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
    } finally {
      await publish.stop(); await receive.stop(); stopNotices();
      await owner.db.close(); await viewer.db.close();
    }
  });

  it("rejects mismatched image bytes and retries a missing asset when its source finishes uploading", async () => {
    const owner = await open(); const receiver = await open();
    const project = await owner.createProject("Integrity");
    const card = await owner.addItem({ projectId: project.id, content: "Image", image });
    await receiver.importProject(project, []);
    await receiver.db.cards.insert((await owner.db.cards.findOne(card.id).exec())!.toJSON());
    let remote: BoardImage | null = null;
    const errors: unknown[] = [];
    const sync = createProjectImageSync({ projectId: project.id, repository: receiver, canWrite: false, onError: (err) => errors.push(err), transport: {
      readImage: async () => remote, writeImage: async () => { throw new Error("Viewer cannot upload"); }
    } });
    try {
      sync.start(); await sync.tick();
      expect(await receiver.hasImage(card.imageId!)).toBe(false);
      remote = { ...image, dataUrl: "data:image/png;base64,BQQDAgEA" };
      await sync.tick();
      expect(errors.map(String)).toContain("Error: Shared image failed integrity verification");
      expect(await receiver.hasImage(card.imageId!)).toBe(false);
      remote = image;
      await sync.tick();
      expect(await receiver.hasImage(card.imageId!)).toBe(true);
    } finally { await sync.stop(); await owner.db.close(); await receiver.db.close(); }
  });
});
