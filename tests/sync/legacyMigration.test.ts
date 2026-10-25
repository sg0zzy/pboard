/**
 * The automatic legacy pass: silent, verified-before-flip migration of
 * AppData copies and legacy shared folders into `/pboard/`, with ACL
 * preservation, idempotent re-runs, and window-gated source cleanup.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { cleanupLegacySource, migrateLegacyBoards, type LegacyMigrationDeps } from '../../src/sync/legacyMigration';
import { createDriveBoardStore, BOARD_SNAPSHOT_FILENAME } from '../../src/sync/driveBoardStore';
import { compareProjectTimestamps, type ProjectSnapshot } from '../../src/sync/snapshot';
import { deserializeBoardSnapshotV2, v2EntitiesToV1 } from '../../src/sync/snapshotV2';
import { READ_ONLY_WINDOW_MS, type MigrationState } from '../../src/sync/privateMigration';
import type { BoardItem, Project } from '../../src/types';
import { DriveStub, REAL_ROOT_ID } from './driveStub';

const snapshot = (id: string, updatedAt: string, revision = 1, cards = 2): ProjectSnapshot => {
  const project: Project = { id, name: `Board ${id}`, createdAt: updatedAt, updatedAt, revision } as Project;
  const items: BoardItem[] = Array.from({ length: cards }, (_, index) => ({
    id: `${id}-card-${index}`, projectId: id, order: index, title: `Card ${index}`, displayMode: "normal"
  } as unknown as BoardItem));
  return { format: "pboard-project", version: 1, exportedAt: updatedAt, project, items };
};

const auth = {
  getAccessToken: async () => "token", connect: async () => {}, disconnect: async () => {},
  getConnectionState: async (): Promise<"connected"> => "connected", isConfigured: () => true
};

const harness = (options: { locals?: ProjectSnapshot[]; shared?: { projectId: string; folderId: string; projectFileId: string }[] } = {}) => {
  const stub = new DriveStub();
  const boards = createDriveBoardStore({ auth, fetcher: stub.fetch as unknown as typeof fetch });
  const store = new Map((options.locals ?? []).map(s => [s.project.id, s] as const));
  const syncFlags = new Map<string, { dirty: boolean; remoteFileId?: string; revision?: number }>();
  const snapshots = {
    read: async (id: string) => structuredClone(store.get(id) ?? (() => { throw new Error(`missing ${id}`); })()),
    list: async () => [...store.values()],
    apply: async (s: ProjectSnapshot) => { store.set(s.project.id, structuredClone(s)); return true; },
    applyIfNewer: async (s: ProjectSnapshot) => {
      const local = store.get(s.project.id);
      if (!local) { store.set(s.project.id, structuredClone(s)); return "applied" as const; }
      const comparison = compareProjectTimestamps(s.project, local.project);
      return comparison > 0 ? "applied" as const : comparison === 0 ? "equal" as const : "local-newer" as const;
    },
    remove: async (id: string) => { store.delete(id); }
  };
  const syncState = {
    get: async (id: string) => syncFlags.get(id),
    markSynced: async (id: string, revision: number, remoteFileId: string) => { syncFlags.set(id, { dirty: false, remoteFileId, revision }); }
  };
  const rx = {
    isDeletedProject: async () => false,
    getProject: async (id: string) => store.get(id)?.project ?? null,
    listProjects: async () => [...store.values()].map(s => s.project)
  };
  const migrations = new Map<string, MigrationState>();
  const clock = { now: 1000 };
  const failPermissions = { value: false };
  const deps: LegacyMigrationDeps = {
    store: boards,
    listAppDataBoards: async () => stub.files
      .filter(f => !f.trashed && f.parents.includes("appDataFolder") && f.name.startsWith("project-"))
      .map(f => ({ id: f.id, name: f.name })),
    listAppDataHistory: async (projectId) => stub.files
      .filter(f => !f.trashed && f.parents.includes("appDataFolder") && f.name === `history-${projectId}.pboard`)
      .map(f => ({ id: f.id, name: f.name })),
    downloadFile: async (fileId) => {
      const file = stub.files.find(f => f.id === fileId && !f.trashed);
      return file ? file.bytes.slice() : null;
    },
    deleteAppDataFile: async (fileId) => { const file = stub.files.find(f => f.id === fileId); if (file) file.trashed = true; },
    snapshots,
    syncState,
    tombstones: { get: async () => null },
    getRepository: async () => rx as never,
    deviceKeyId: async () => "device-test",
    sharedLegacy: async () => options.shared ?? [],
    listPermissions: async (folderId) => {
      if (failPermissions.value) throw new Error("acl boom");
      return (stub.permissions.get(folderId) ?? []).filter(p => p.type === "user");
    },
    createPermission: async (folderId, role, email) => {
      const list = stub.permissions.get(folderId) ?? [];
      stub.permissions.set(folderId, [...list, { id: `perm-${list.length}-${email}`, type: "user" as const, role, emailAddress: email }]);
    },
    migrations: {
      load: async (projectId) => migrations.get(projectId),
      save: async (state) => { migrations.set(state.projectId, state); },
      clear: async (projectId) => { migrations.delete(projectId); }
    },
    now: () => clock.now
  };
  const root = () => stub.files.find(f => f.name === "pboard" && f.parents.includes(REAL_ROOT_ID) && !f.trashed)!;
  const boardFolder = (boardId: string) => stub.files.find(f => f.name === boardId && f.parents.includes(root().id) && !f.trashed);
  const snapshotFile = (boardId: string) => stub.files.find(f => f.name === BOARD_SNAPSHOT_FILENAME && !f.trashed && f.parents.includes(boardFolder(boardId)?.id ?? ""));
  return { stub, deps, store, syncFlags, migrations, clock, failPermissions, root, boardFolder, snapshotFile };
};

const appDataFile = (h: ReturnType<typeof harness>, name: string, contents: string) =>
  h.stub.addFile(name, "appDataFolder", contents);

describe("legacy board migration pass", () => {
  it("migrates a private AppData board, verifies the canonical copy, and keeps sources intact", async () => {
    const h = harness({ locals: [snapshot("b1", "2026-01-01T00:00:00.000Z", 3)] });
    const legacy = appDataFile(h, "project-b1.pboard", JSON.stringify(snapshot("b1", "2025-12-01T00:00:00.000Z")));
    appDataFile(h, "history-b1.pboard", "{\"history\":true}");
    const result = await migrateLegacyBoards(h.deps);
    expect(result.migrated).toEqual(["b1"]);
    expect(result.failed).toEqual([]);
    const canonical = h.snapshotFile("b1");
    expect(canonical).toBeTruthy();
    const parsed = await deserializeBoardSnapshotV2(canonical!.bytes, { expectBoardId: "b1" });
    expect(v2EntitiesToV1(parsed.entities, "2026-01-01T00:00:00.000Z").project.id).toBe("b1");
    // Sources untouched: verification happened first, deletion is window-gated.
    expect(legacy.trashed).toBe(false);
    expect(h.migrations.get("b1")!.step).toBe("sealed");
    expect(h.syncFlags.get("b1")).toMatchObject({ dirty: false, remoteFileId: canonical!.id });
    // History archives relocate alongside the board.
    expect(h.stub.files.some(f => f.name === "history-b1.pboard" && !f.trashed && f.parents.includes(h.boardFolder("b1")!.id))).toBe(true);
  });

  it("imports the legacy copy locally on a fresh profile before migrating", async () => {
    const h = harness();
    appDataFile(h, "project-b1.pboard", JSON.stringify(snapshot("b1", "2025-12-01T00:00:00.000Z", 2, 4)));
    const result = await migrateLegacyBoards(h.deps);
    expect(result.migrated).toEqual(["b1"]);
    expect(h.store.get("b1")!.items).toHaveLength(4);
    expect(h.snapshotFile("b1")).toBeTruthy();
  });

  it("skips already-migrated boards and never re-uploads", async () => {
    const h = harness({ locals: [snapshot("b1", "2026-01-01T00:00:00.000Z")] });
    appDataFile(h, "project-b1.pboard", JSON.stringify(snapshot("b1", "2025-12-01T00:00:00.000Z")));
    await migrateLegacyBoards(h.deps);
    const version = h.snapshotFile("b1")!.version;
    const second = await migrateLegacyBoards(h.deps);
    expect(second.migrated).toEqual([]);
    expect(second.skipped).toContain("b1");
    expect(h.snapshotFile("b1")!.version).toBe(version);
  });

  it("replaces a corrupted canonical upload after a failed read-back and only then flips", async () => {
    const h = harness({ locals: [snapshot("b1", "2026-01-01T00:00:00.000Z")] });
    appDataFile(h, "project-b1.pboard", JSON.stringify(snapshot("b1", "2025-12-01T00:00:00.000Z")));
    let corruptedOnce = false;
    h.stub.onFetch = (url) => {
      if (corruptedOnce || !url.includes("alt=media")) return;
      corruptedOnce = true;
      const canonical = h.stub.files.find(f => f.name === BOARD_SNAPSHOT_FILENAME && !f.trashed);
      if (canonical) canonical.bytes = new TextEncoder().encode("junk");
    };
    const result = await migrateLegacyBoards(h.deps);
    expect(result.migrated).toEqual(["b1"]);
    const canonical = h.snapshotFile("b1")!;
    expect(canonical.version).toBeGreaterThan(1); // corrupted upload was replaced
    expect(await deserializeBoardSnapshotV2(canonical.bytes, { expectBoardId: "b1" })).toBeTruthy();
  });

  it("never flips while verification keeps failing, leaving the source untouched", async () => {
    const h = harness({ locals: [snapshot("b1", "2026-01-01T00:00:00.000Z")] });
    const legacy = appDataFile(h, "project-b1.pboard", JSON.stringify(snapshot("b1", "2025-12-01T00:00:00.000Z")));
    h.stub.onFetch = (url) => {
      if (!url.includes("alt=media")) return;
      const canonical = h.stub.files.find(f => f.name === BOARD_SNAPSHOT_FILENAME && !f.trashed);
      if (canonical) canonical.bytes = new TextEncoder().encode("junk");
    };
    const result = await migrateLegacyBoards(h.deps);
    expect(result.failed.map(f => f.projectId)).toEqual(["b1"]);
    expect(h.migrations.get("b1")!.step).toBe("history");
    expect(h.syncFlags.has("b1")).toBe(false); // flip never ran
    expect(legacy.trashed).toBe(false);
  });

  it("relocates legacy shared boards with a copied ACL before flipping", async () => {
    const h = harness();
    const folder = h.stub.addFolder("s1", "root");
    const projectFile = h.stub.addFile("project.json", folder.id, JSON.stringify(snapshot("s1", "2025-12-01T00:00:00.000Z", 5, 3)));
    h.stub.permissions.set(folder.id, [
      { id: "p0", type: "user", role: "owner", emailAddress: "me@example.test" },
      { id: "p1", type: "user", role: "reader", emailAddress: "b@example.test" },
      { id: "p2", type: "user", role: "writer", emailAddress: "c@example.test" }
    ]);
    const shared = [{ projectId: "s1", folderId: folder.id, projectFileId: projectFile.id }];
    h.deps.sharedLegacy = async () => shared;
    const result = await migrateLegacyBoards(h.deps);
    expect(result.failed).toEqual([]);
    expect(result.relocated).toEqual(["s1"]);
    const newFolder = h.boardFolder("s1")!;
    expect(newFolder.id).not.toBe(folder.id);
    const copied = h.stub.permissions.get(newFolder.id)!;
    expect(copied.map(p => `${p.role}:${p.emailAddress}`)).toEqual(["reader:b@example.test", "writer:c@example.test"]);
    expect(h.store.get("s1")!.items).toHaveLength(3);
    expect(h.snapshotFile("s1")).toBeTruthy();
    expect(h.syncFlags.get("s1")).toMatchObject({ dirty: false });
    // The legacy folder itself is never touched.
    expect(folder.trashed).toBe(false);
    expect(projectFile.trashed).toBe(false);
  });

  it("skips shared relocation entirely when the ACL cannot be listed", async () => {
    const h = harness();
    const folder = h.stub.addFolder("s1", "root");
    const projectFile = h.stub.addFile("project.json", folder.id, JSON.stringify(snapshot("s1", "2025-12-01T00:00:00.000Z")));
    const shared = [{ projectId: "s1", folderId: folder.id, projectFileId: projectFile.id }];
    h.deps.sharedLegacy = async () => shared;
    h.failPermissions.value = true;
    const result = await migrateLegacyBoards(h.deps);
    expect(result.relocated).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.failed.map(f => f.projectId)).toEqual(["s1"]);
    expect(h.boardFolder("s1")).toBeUndefined(); // no partial state was created
  });

  it("deletes legacy sources only after the read-only window elapsed", async () => {
    const h = harness({ locals: [snapshot("b1", "2026-01-01T00:00:00.000Z")] });
    const legacy = appDataFile(h, "project-b1.pboard", JSON.stringify(snapshot("b1", "2025-12-01T00:00:00.000Z")));
    const history = appDataFile(h, "history-b1.pboard", "{}");
    await migrateLegacyBoards(h.deps);
    const sealedAt = h.migrations.get("b1")!.sealedAt!;
    h.clock.now = sealedAt + READ_ONLY_WINDOW_MS - 1;
    await expect(cleanupLegacySource(h.deps, "b1")).rejects.toThrow(/window/);
    expect(legacy.trashed).toBe(false);
    h.clock.now = sealedAt + READ_ONLY_WINDOW_MS;
    expect(await cleanupLegacySource(h.deps, "b1")).toBe(true);
    expect(legacy.trashed).toBe(true);
    expect(history.trashed).toBe(true);
    expect(h.migrations.get("b1")).toBeUndefined();
    expect(await cleanupLegacySource(h.deps, "b1")).toBe(false);
  });
});
