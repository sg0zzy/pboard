import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createAccountPreferenceSync } from "../src/sync/accountPreferences";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { createGoogleDriveProvider } from "../src/sync/googleDriveProvider";
import { createSharedProjectSync } from "../src/sync/sharedSync";
import { createSharedBoardDiscovery } from "../src/sync/sharedDiscovery";
import { createBackendProjectSnapshotStore, serializeProjectSnapshot } from "../src/sync/snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore } from "../src/sync/state";
import type { DriveTransport } from "../src/sync/driveTransport";
import type { KeyValueStorage } from "../src/storage/repository";

function memoryStorage(): KeyValueStorage {
  const data: Record<string, unknown> = {};
  return { get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (values) => { Object.assign(data, structuredClone(values)); } };
}

function memoryDrive(): DriveTransport {
  const files = new Map<string, { id: string; name: string; contents: string }>();
  return {
    findProjectFile: async (id) => files.get(id) ?? null,
    listProjectFiles: async () => [...files.values()].reverse(),
    download: async (id) => files.get(id)!.contents,
    upload: async (id, contents) => {
      const file = { id, name: `${id}.pboard`, contents };
      files.set(id, file); return file;
    },
    delete: async (id) => { files.delete(id); }
  };
}

async function open(storage = memoryStorage()) {
  const syncState = createDriveSyncStateStore(storage);
  const name = `accountprefs${crypto.randomUUID().replaceAll("-", "")}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`),
    events: { projectChanged: (id) => syncState.markDirty(id) } });
  return { rx, storage, syncState };
}

describe("durable account project order", () => {
  it.each(["editor", "viewer"] as const)("persists a %s's removal for their other sessions while preserving the owner's project", async (role) => {
    const drive = memoryDrive();
    const owner = await open();
    const recipient = await open();
    const second = await open();
    try {
      const project = await owner.rx.createProject("Owner's board");
      await owner.rx.addItem({ projectId: project.id, content: "Keep this card" });
      const snapshot = await owner.rx.exportProject(project.id);
      for (const session of [recipient, second]) {
        await session.rx.importProject(snapshot.project, snapshot.items);
        session.rx.setMutatorRole(project.id, role);
      }
      const preferences = (session: typeof owner, account: string) => createAccountPreferenceSync({
        transport: drive, getAccountId: async () => account, getRepository: async () => session.rx
      });
      const ownerSync = preferences(owner, "owner");
      const recipientSync = preferences(recipient, "recipient");
      const secondSync = preferences(second, "recipient");
      await ownerSync();
      await recipientSync();
      await recipient.rx.deleteProject(project.id);
      await recipientSync();
      await secondSync();
      expect(await second.rx.getProject(project.id)).toBeNull();
      await second.rx.importProject(snapshot.project, snapshot.items);
      expect(await second.rx.getProject(project.id)).toBeNull();
      // Shared documents are intact, and the owner's private account data has
      // never received the recipient's removal marker.
      expect(await recipient.rx.db.projects.findOne(project.id).exec()).not.toBeNull();
      expect((await recipient.rx.db.cards.find().exec())[0].deletedAt).toBeUndefined();
      await ownerSync();
      expect(await owner.rx.exportProject(project.id)).toEqual(snapshot);
      expect((await owner.rx.getProjectOrder("owner"))?.deletedProjectIds ?? []).toEqual([]);
    } finally {
      await owner.rx.db.close(); await recipient.rx.db.close(); await second.rx.db.close();
    }
  });

  it("restores private/shared boards, cards, images and project order into session 2 after session 1 closes", async () => {
    const privateDrive = memoryDrive();
    const preferenceDrive = memoryDrive();
    const first = await open();
    const second = await open();
    let firstClosed = false;
    try {
      const a = await first.rx.createProject("Private A");
      const b = await first.rx.createProject("Shared B");
      const c = await first.rx.createProject("Private C");
      await first.rx.addItem({ projectId: a.id, content: "Private content" });
      await first.rx.addItem({ projectId: b.id, content: "Shared content", image: {
        dataUrl: "data:image/png;base64,AAECAwQ=", mimeType: "image/png", width: 1, height: 1
      } });
      let sharedBackup = serializeProjectSnapshot(b, []);
      const permissions = {
        myRole: async () => "owner" as const,
        projectFileId: async () => "shared-file",
        readSharedSnapshot: async () => sharedBackup,
        writeSharedSnapshot: async (_id: string, contents: string) => { sharedBackup = contents; },
        discoverSharedProjects: async () => [{ projectId: b.id, name: b.name, fileId: "shared-file" }]
      };
      const auth = { isConfigured: () => true, connect: async () => {}, disconnect: async () => {},
        getConnectionState: async () => "connected" as const, getAccessToken: async () => "token" };
      function provider(session: typeof first) {
        const snapshots = createBackendProjectSnapshotStore(session.storage, async () => session.rx, async (id) => id !== b.id);
        const syncPreferences = createAccountPreferenceSync({ transport: preferenceDrive,
          getAccountId: async () => "account-A", getRepository: async () => session.rx });
        const discover = createSharedBoardDiscovery({ connected: async () => true, permissions,
          getRepository: async () => session.rx, isDeleted: async () => false });
        return { syncPreferences, drive: createGoogleDriveProvider({ auth, transport: privateDrive, snapshots,
          syncState: session.syncState, tombstones: createDriveTombstoneStore(session.storage),
          isSharedProject: async (id) => id === b.id, beforeReconcile: discover, syncPreferences,
          syncSharedProject: createSharedProjectSync({ permissions, snapshots, syncState: session.syncState,
            getRepository: async () => session.rx }) }) };
      }
      const session1 = provider(first);
      await first.rx.setProjectOrderAccount("account-A");
      await first.rx.reorderProjects([c.id, b.id, a.id]);
      await session1.drive.syncProject(b.id);
      await session1.drive.reconcileAll();
      const expected = await first.rx.exportAll();
      await first.rx.db.close();
      firstClosed = true;

      // No WebRTC pool or live source session: everything comes from Drive.
      const session2 = provider(second);
      await session2.drive.reconcileAll();
      const actual = await second.rx.exportAll();
      expect(actual.projects.map((project) => project.id)).toEqual([c.id, b.id, a.id]);
      for (const project of expected.projects) {
        expect(await second.rx.exportProject(project.id)).toEqual({
          project, items: expected.boardItems.filter((card) => card.projectId === project.id)
        });
      }
    } finally {
      if (!firstClosed) await first.rx.db.close();
      await second.rx.db.close();
    }
  });

  it("persists order without dirty project content and preserves a reorder during upload", async () => {
    const { rx } = await open();
    try {
      const a = await rx.createProject("A");
      const b = await rx.createProject("B");
      await rx.setProjectOrderAccount("A");
      await rx.reorderProjects([b.id, a.id]);
      const transport = memoryDrive();
      const original = transport.upload;
      const upload = vi.spyOn(transport, "upload");
      upload.mockImplementationOnce(async (...args) => {
        await rx.reorderProjects([a.id, b.id]);
        return original(...args);
      });
      const sync = createAccountPreferenceSync({ transport, getAccountId: async () => "A", getRepository: async () => rx });
      await Promise.all([sync(), sync()]);
      expect(JSON.parse(await transport.download("A")).ids).toEqual([a.id, b.id]);
      expect(upload).toHaveBeenCalledTimes(2);
    } finally { await rx.db.close(); }
  });

  it("keeps accounts separate and retains saved positions for projects imported later", async () => {
    const { rx } = await open();
    try {
      const a = await rx.createProject("A");
      const b = await rx.createProject("B");
      const transport = memoryDrive();
      await transport.upload("first", JSON.stringify({ ids: ["future", b.id, a.id], updatedAt: "2026-10-04T22:00:00Z" }));
      await transport.upload("second", JSON.stringify({ ids: [a.id, b.id], updatedAt: "2026-01-03T00:00:00Z" }));
      const sync = (account: string) => createAccountPreferenceSync({ transport, getAccountId: async () => account, getRepository: async () => rx })();
      await sync("first");
      expect((await rx.listProjects()).map((project) => project.id)).toEqual([b.id, a.id]);
      await rx.importProject({ ...a, id: "future", name: "Imported later" }, []);
      expect((await rx.listProjects()).map((project) => project.id)).toEqual(["future", b.id, a.id]);
      await sync("second");
      expect((await rx.listProjects()).map((project) => project.id)).toEqual([a.id, b.id, "future"]);
      expect((await rx.getProjectOrder("first"))?.ids).toEqual(["future", b.id, a.id]);
    } finally { await rx.db.close(); }
  });

  it("keeps a newer offline reorder when reconnecting to an older Drive preference", async () => {
    const { rx } = await open();
    try {
      const a = await rx.createProject("A");
      const b = await rx.createProject("B");
      await rx.reorderProjects([b.id, a.id]);
      const transport = memoryDrive();
      await transport.upload("A", JSON.stringify({ ids: [a.id, b.id], updatedAt: "2026-01-01T00:00:00Z" }));
      await createAccountPreferenceSync({ transport, getAccountId: async () => "A", getRepository: async () => rx })();
      expect(JSON.parse(await transport.download("A")).ids).toEqual([b.id, a.id]);
      expect((await rx.listProjects()).map((project) => project.id)).toEqual([b.id, a.id]);
    } finally { await rx.db.close(); }
  });

  it("persists an offline project deletion across sessions and refuses stale snapshot resurrection", async () => {
    const first = await open();
    const second = await open();
    const fresh = await open();
    try {
      const a = await first.rx.createProject("Remaining");
      const b = await first.rx.createProject("Deleted shared project");
      await first.rx.addItem({ projectId: b.id, content: "Deleted content" });
      const stale = await first.rx.exportProject(b.id);
      const transport = memoryDrive();
      const sync = (rx: typeof first.rx) => createAccountPreferenceSync({
        transport, getAccountId: async () => "A", getRepository: async () => rx
      })();
      await sync(first.rx);
      await second.rx.importProject(a, []);
      await second.rx.importProject(stale.project, stale.items);
      await second.rx.selectProject(b.id);
      await sync(second.rx);
      // The account document already exists: reconnect must merge deletions
      // made in the local fallback while this browser was disconnected.
      await first.rx.setProjectOrderAccount(null);
      await first.rx.deleteProject(b.id);
      await sync(first.rx);
      await sync(second.rx);
      expect(await second.rx.getProject(b.id)).toBeNull();
      expect(await second.rx.listCards(b.id)).toEqual([]);
      expect((await second.rx.getCurrentProject())?.id).toBe(a.id);
      // A newer order from another session must not discard deletion markers.
      await transport.upload("A", JSON.stringify({ ids: [b.id, a.id], updatedAt: "2030-01-01T00:00:00Z" }));
      await sync(second.rx);
      expect(JSON.parse(await transport.download("A")).deletedProjectIds).toEqual([b.id]);
      await sync(fresh.rx);
      await fresh.rx.importProject(stale.project, stale.items);
      expect(await fresh.rx.getProject(b.id)).toBeNull();
      expect(await fresh.rx.isDeletedProject(b.id)).toBe(true);
      expect(await fresh.rx.db.projects.findOne(b.id).exec()).toBeNull();
    } finally {
      await first.rx.db.close(); await second.rx.db.close(); await fresh.rx.db.close();
    }
  });
});
