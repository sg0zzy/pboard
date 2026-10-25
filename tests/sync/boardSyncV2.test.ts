import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createBoardSyncV2 } from '../../src/sync/boardSyncV2';
import { createDriveBoardStore, BOARD_SNAPSHOT_FILENAME } from '../../src/sync/driveBoardStore';
import { compareProjectTimestamps, type ProjectSnapshot } from '../../src/sync/snapshot';
import { serializeBoardSnapshotV2, deserializeBoardSnapshotV2, v1SnapshotToEntities, v2EntitiesToV1 } from '../../src/sync/snapshotV2';
import type { BoardItem, Project } from '../../src/types';
import { DriveStub, REAL_ROOT_ID } from "./driveStub";

const snapshot = (id: string, updatedAt: string, revision = 1, extraCards = 0): ProjectSnapshot => {
  const project: Project = { id, name: `Board ${id}`, createdAt: updatedAt, updatedAt, revision } as Project;
  const items: BoardItem[] = Array.from({ length: extraCards }, (_, index) => ({
    id: `${id}-card-${index}`, projectId: id, order: index, title: `Card ${index}`, displayMode: "normal"
  } as unknown as BoardItem));
  return { format: "pboard-project", version: 1, exportedAt: updatedAt, project, items };
};

const auth = {
  getAccessToken: async () => "token",
  connect: async () => {},
  disconnect: async () => {},
  getConnectionState: async (): Promise<"connected"> => "connected",
  isConfigured: () => true
};

type StateRecord = { projectId: string; dirty: boolean; status: "synced" | "pending" | "syncing" | "error"; remoteFileId?: string; revision?: number; error?: string };

const harness = (locals: ProjectSnapshot[], seedState: Record<string, { dirty: boolean }> = {}) => {
  const stub = new DriveStub();
  const boards = createDriveBoardStore({ auth, fetcher: stub.fetch as unknown as typeof fetch });
  const store = new Map(locals.map(s => [s.project.id, s] as const));
  const state = new Map<string, StateRecord>(
    Object.entries(seedState).map(([id, s]) => [id, { projectId: id, dirty: s.dirty, status: "pending" }])
  );
  const snapshots = {
    read: async (id: string) => structuredClone(store.get(id) ?? (() => { throw new Error(`missing ${id}`); })()),
    list: async () => [...store.values()],
    apply: async (s: ProjectSnapshot) => { store.set(s.project.id, structuredClone(s)); return true; },
    applyIfNewer: async (s: ProjectSnapshot) => {
      const local = store.get(s.project.id);
      if (!local) { store.set(s.project.id, structuredClone(s)); return "applied" as const; }
      const comparison = compareProjectTimestamps(s.project, local.project);
      if (comparison > 0) { store.set(s.project.id, structuredClone(s)); return "applied" as const; }
      return comparison === 0 ? "equal" as const : "local-newer" as const;
    },
    remove: async (id: string) => { store.delete(id); }
  };
  const syncState = {
    get: async (id: string): Promise<StateRecord> => state.get(id) ?? { projectId: id, dirty: true, status: "pending" },
    ensureInitiallyDirty: async (id: string) => { if (!state.has(id)) state.set(id, { projectId: id, dirty: true, status: "pending" }); },
    markSynced: async (id: string, revision: number, remoteFileId: string) => { state.set(id, { projectId: id, dirty: false, status: "synced", remoteFileId, revision }); },
    markError: async (id: string, error: string) => { state.set(id, { ...(state.get(id) ?? { projectId: id, dirty: true, status: "pending" as const }), status: "error" as const, error }); },
    forget: async (id: string) => { state.delete(id); }
  };
  const tombstones = new Map<string, { projectId: string; remoteFileId?: string; deletedAt: string; projectUpdatedAt: string; revision: number }>();
  const tombstoneStore = {
    getAll: async () => [...tombstones.values()],
    get: async (id: string) => tombstones.get(id) ?? null,
    add: async (t: { projectId: string; remoteFileId?: string; deletedAt: string; projectUpdatedAt: string; revision: number }) => { tombstones.set(t.projectId, t); },
    clear: async (id: string) => { tombstones.delete(id); }
  };
  const rx = {
    isDeletedProject: async () => false,
    getProject: async (id: string) => store.get(id)?.project ?? null,
    listProjects: async () => [...store.values()].map(s => s.project)
  };
  const sync = createBoardSyncV2({
    store: boards, snapshots, syncState, tombstones: tombstoneStore,
    getRepository: async () => rx as never,
    connectionState: async () => "connected",
    deviceKeyId: async () => "device-test"
  });
  const root = () => stub.files.find(f => f.name === "pboard" && f.parents.includes(REAL_ROOT_ID) && !f.trashed)!;
  const boardFolder = (boardId: string) => stub.files.find(f => f.name === boardId && f.parents.includes(root().id) && !f.trashed)!;
  const snapshotFile = (boardId: string) => stub.files.find(f => f.name === BOARD_SNAPSHOT_FILENAME && f.parents.includes(boardFolder(boardId).id) && !f.trashed);
  return { stub, boards, sync, store, state, tombstones: tombstoneStore, rawTombstones: tombstones, root, boardFolder, snapshotFile };
};

/** Place a canonical snapshot into the fixture as another device would have. */
async function seedRemote(h: ReturnType<typeof harness>, snap: ProjectSnapshot, seq = 1) {
  const fileId = await h.boards.ensureSnapshotFile(snap.project.id);
  const meta = await h.boards.meta(snap.project.id);
  const bytes = await serializeBoardSnapshotV2(v1SnapshotToEntities(snap), {
    boardId: snap.project.id, appVersion: "test", snapshotSeq: seq, epoch: 0, writtenBy: { deviceKeyId: "other-device" }
  });
  const outcome = await h.boards.publish(snap.project.id, meta?.etag ?? "", bytes);
  expect(outcome.status).toBe("published");
  return fileId;
}

describe("boardSyncV2", () => {
  it("pushes a new dirty board into the unified /pboard layout", async () => {
    const h = harness([snapshot("b1", "2026-10-01T00:00:00.000Z")]);
    expect(await h.sync.syncProject("b1")).toBe("pushed");
    const file = h.snapshotFile("b1");
    expect(file).toBeTruthy();
    const parsed = await deserializeBoardSnapshotV2(new Uint8Array(file!.bytes), { expectBoardId: "b1" });
    expect(parsed.snapshotSeq).toBe(1);
    expect(h.state.get("b1")).toMatchObject({ dirty: false, remoteFileId: file!.id });
  });

  it("pulls when the canonical snapshot is newer", async () => {
    const h = harness([snapshot("b2", "2026-10-01T00:00:00.000Z", 1, 0)], { b2: { dirty: false } });
    await seedRemote(h, snapshot("b2", "2026-10-02T00:00:00.000Z", 2, 3));
    expect(await h.sync.syncProject("b2")).toBe("pulled");
    expect(h.store.get("b2")!.items).toHaveLength(3);
    expect(h.state.get("b2")!.dirty).toBe(false);
  });

  it("merges by applying remote then re-pushing when local work is pending", async () => {
    const h = harness([snapshot("b3", "2026-10-02T00:00:00.000Z", 3, 5)], { b3: { dirty: true } });
    await seedRemote(h, snapshot("b3", "2026-10-01T00:00:00.000Z", 2, 1));
    expect(await h.sync.syncProject("b3")).toBe("pushed");
    const parsed = await deserializeBoardSnapshotV2(new Uint8Array(h.snapshotFile("b3")!.bytes), { expectBoardId: "b3" });
    expect(parsed.snapshotSeq).toBe(2);
    expect(parsed.entities.cards).toHaveLength(5);
  });

  it("reconciles a concurrent writer once and publishes over the fresh revision", async () => {
    const h = harness([snapshot("b4", "2026-10-02T00:00:00.000Z", 4, 2)], { b4: { dirty: true } });
    await seedRemote(h, snapshot("b4", "2026-10-01T00:00:00.000Z", 3, 1));
    let raced = false;
    h.stub.onFetch = url => {
      if (!raced && url.includes("uploadType=media")) {
        raced = true;
        const file = h.snapshotFile("b4");
        if (file) file.version += 1; // another device landed between metadata read and publish
      }
    };
    expect(await h.sync.syncProject("b4")).toBe("pushed");
    expect(raced).toBe(true);
    const parsed = await deserializeBoardSnapshotV2(new Uint8Array(h.snapshotFile("b4")!.bytes), { expectBoardId: "b4" });
    expect(parsed.entities.cards).toHaveLength(2);
  });

  it("reconcileAll imports remote boards and pushes local ones without touching AppData", async () => {
    const h = harness([snapshot("local-only", "2026-10-03T00:00:00.000Z")]);
    await seedRemote(h, snapshot("remote-only", "2026-10-02T00:00:00.000Z", 1, 2));
    const result = await h.sync.reconcileAll();
    expect(result).toMatchObject({ status: "reconciled", imported: 1, pushed: 1 });
    expect(h.store.has("remote-only")).toBe(true);
    expect(h.stub.appDataCalls).toBe(0);
    expect(h.snapshotFile("local-only")).toBeTruthy();
  });

  it("shares the storage mechanism: private and shared-looking boards use identical paths", async () => {
    const h = harness([snapshot("private-board", "2026-10-03T00:00:00.000Z"), snapshot("shared-board", "2026-10-03T00:00:00.000Z")]);
    await h.sync.syncProject("private-board");
    await h.sync.syncProject("shared-board");
    for (const id of ["private-board", "shared-board"]) {
      expect(h.boardFolder(id).parents).toEqual([h.root().id]);
      expect(h.snapshotFile(id)!.name).toBe("board.json.gz");
    }
  });

  it("trashes the canonical file on delete and clears local bookkeeping", async () => {
    const h = harness([], {});
    const fileId = await seedRemote(h, snapshot("gone", "2026-10-01T00:00:00.000Z"));
    await h.tombstones.add({ projectId: "gone", remoteFileId: fileId, deletedAt: "2026-10-04T00:00:00.000Z", projectUpdatedAt: "2026-10-01T00:00:00.000Z", revision: 1 });
    expect(await h.sync.deleteProject("gone")).toBe("deleted");
    expect(h.stub.files.find(f => f.id === fileId)!.trashed).toBe(true);
    expect(h.rawTombstones.size).toBe(0);
  });

  it("pullProject round-trips the canonical snapshot", async () => {
    const h = harness([], {});
    const snap = snapshot("round", "2026-10-01T00:00:00.000Z", 1, 2);
    await seedRemote(h, snap);
    const pulled = await h.sync.pullProject("round");
    expect(pulled!.project.id).toBe("round");
    expect(pulled!.items).toHaveLength(2);
    expect(v2EntitiesToV1(v1SnapshotToEntities(snap), snap.exportedAt).project).toEqual(snap.project);
  });
});
