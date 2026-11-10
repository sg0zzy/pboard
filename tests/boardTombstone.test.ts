import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createRxRepository, type RxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { createSharedBoardDiscovery } from "../src/sync/sharedDiscovery";
import { createBackendProjectSnapshotStore, deserializeProjectSnapshot, serializeProjectSnapshot } from "../src/sync/snapshot";
import { createAccountPreferenceSync } from "../src/sync/accountPreferences";
import { admissionAllowed, dominates, mergeFacts, planLegacyDeletionMigration, totalOrder,
  type BoardTombstoneFact } from "../src/storage/boardTombstone";
import { mergeProjectOrder, parseProjectOrder } from "../src/storage/projectOrder";
import type { DriveTransport } from "../src/sync/driveTransport";
import type { KeyValueStorage } from "../src/storage/repository";

const unique = () => `tombstone${crypto.randomUUID().replaceAll("-", "")}`;
async function open(name = unique(), resolveDeletionRole?: () => Promise<"owner" | "editor" | "viewer">): Promise<{ rx: RxRepository; name: string }> {
  return { rx: await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`), ...(resolveDeletionRole ? { resolveDeletionRole } : {}) }), name };
}
function memoryStorage(): KeyValueStorage {
  const data: Record<string, unknown> = {};
  return { get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (values) => { Object.assign(data, structuredClone(values)); } };
}
function memoryDrive(): DriveTransport {
  const files = new Map<string, { id: string; name: string; contents: string }>();
  return { findProjectFile: async (id) => files.get(id) ?? null, listProjectFiles: async () => [...files.values()].reverse(),
    download: async (id) => files.get(id)!.contents,
    upload: async (id, contents) => { const file = { id, name: `${id}.pboard`, contents }; files.set(id, file); return file; },
    delete: async (id) => { files.delete(id); } };
}
const fact = (overrides: Partial<BoardTombstoneFact>): BoardTombstoneFact => ({
  kind: "deleted", accountId: null, opId: "a:1", actorId: "a", seq: 1, clock: 1, context: {},
  deviceId: "a", role: "owner", at: "2026-01-01T00:00:00.000Z", evidence: "test", ...overrides });

describe("board deletion tombstones: the ordering rule", () => {
  it("orders by causal dominance first, then by the total order — never by the timestamp", () => {
    const deletion = fact({ actorId: "a", seq: 1, clock: 1, at: "2030-01-01T00:00:00.000Z" });
    // A restore written by a device that had seen the deletion dominates it,
    // even though the deletion's own timestamp is later.
    const restore = fact({ kind: "restored", actorId: "b", seq: 1, clock: 2, context: { a: 1 }, at: "2020-01-01T00:00:00.000Z" });
    expect(dominates(restore.context, deletion)).toBe(true);
    expect(admissionAllowed([deletion, restore])).toBe(true);
    // A copy with no context never dominates a deletion, whatever its clock.
    expect(admissionAllowed([deletion])).toBe(false);
    expect(admissionAllowed([deletion], { a: 1 })).toBe(true);
  });

  it("resolves concurrency deterministically from the same bytes on both sides", () => {
    const left = fact({ actorId: "a", opId: "a:1", seq: 1, clock: 4 });
    const right = fact({ actorId: "b", opId: "b:1", seq: 1, clock: 4 });
    const forward = mergeFacts([left], [right]);
    const backward = mergeFacts([right], [left]);
    expect(forward).toEqual(backward);
    expect(totalOrder(forward[0], forward[1])).toBeLessThan(0);
    // Duplicate facts are idempotent: replaying a fact cannot add a second row.
    expect(mergeFacts(forward, [left, right])).toEqual(forward);
  });

  it("makes an old creation lose to a tombstone and an explicit restore win", async () => {
    // A collaborator's removal: the shared content stays, so the row survives
    // the hide and the test can watch the same row through delete/restore.
    const { rx } = await open(unique(), async () => "editor");
    try {
      const board = await rx.createProject("Deleted once");
      const stale = await rx.exportProject(board.id);
      await rx.deleteProject(board.id);
      expect((await rx.journal.boardTombstone(board.id)).deleted).toBe(true);
      await rx.importProject(stale.project, stale.items);
      expect(await rx.getProject(board.id)).toBeNull();
      // The explicit restore is the one fact that wins.
      await rx.unhideProject(board.id);
      expect(await rx.getProject(board.id)).not.toBeNull();
      expect(await rx.isDeletedProject(board.id)).toBe(false);
      const facts = await rx.journal.boardTombstoneFacts(board.id);
      expect(facts.map(entry => entry.kind)).toEqual(["deleted", "restored"]);
      // The restore causally dominates the deletion it reverses.
      expect(dominates(facts.find(entry => entry.kind === "restored")!.context, facts.find(entry => entry.kind === "deleted")!)).toBe(true);
      // And a copy that carries no context still cannot undo the restore's
      // successor: a second delete outranks it.
      await rx.deleteProject(board.id);
      expect((await rx.journal.boardTombstoneFacts(board.id)).map(entry => entry.kind)).toEqual(["deleted", "restored", "deleted"]);
      await rx.importProject(stale.project, stale.items);
      expect(await rx.getProject(board.id)).toBeNull();
    } finally { await rx.db.close(); }
  });
});

describe("board deletion tombstones: write ordering and crash safety", () => {
  it("writes the tombstone before any destructive local work", async () => {
    const { rx } = await open();
    try {
      const board = await rx.createProject("Ordered writes");
      await rx.addItem({ projectId: board.id, content: "Content" });
      const steps: string[] = [];
      const original = rx.journal.recordBoardDeletion.bind(rx.journal);
      const record = vi.spyOn(rx.journal, "recordBoardDeletion").mockImplementation(async (input) => {
        const written = await original(input);
        steps.push("tombstone");
        return written;
      });
      const storage = rx.db.projects.storageInstance;
      const remove = storage.bulkWrite.bind(storage);
      const erase = vi.spyOn(storage, "bulkWrite").mockImplementation(async (rows, context) => {
        if (rows.some(row => row.document._deleted === true)) steps.push("erase");
        return remove(rows, context);
      });
      await rx.deleteProject(board.id);
      erase.mockRestore();
      record.mockRestore();
      expect(steps.slice(0, 2)).toEqual(["tombstone", "erase"]);
    } finally { await rx.db.close(); }
  });

  it("leaves the tombstone behind when the process stops right after it", async () => {
    const name = unique();
    const first = await createRxRepository({ name });
    const board = await first.createProject("Crashes mid-delete");
    // The crash the ordering protects against: the process dies between the
    // tombstone write and every piece of cleanup, so only the tombstone is on
    // disk. Reproduce exactly that state and reopen.
    await first.journal.recordBoardDeletion({ boardId: board.id, accountId: null, context: {}, role: "owner",
      at: new Date().toISOString(), evidence: "local-delete:owner" });
    await first.db.close();
    const reopened = await createRxRepository({ name });
    try {
      expect(await reopened.isDeletedProject(board.id)).toBe(true);
      expect((await reopened.journal.boardTombstoneFacts(board.id)).map(entry => entry.kind)).toEqual(["deleted"]);
      expect(await reopened.getProject(board.id)).toBeNull();
      expect(await reopened.listCards(board.id)).toEqual([]);
      // The board's row is still there — no cleanup ran, and the decision is
      // what hides it. Nothing can re-admit it either.
      expect(await reopened.db.projects.findOne(board.id).exec()).not.toBeNull();
      await reopened.importProject(board, []);
      expect(await reopened.getProject(board.id)).toBeNull();
    } finally { await reopened.db.close(); }
  });

  it("turns a handled erase failure into an explicit restore fact, never a lost tombstone", async () => {
    const { rx } = await open();
    try {
      const board = await rx.createProject("Erase fails");
      const storage = rx.db.projects.storageInstance;
      const remove = storage.bulkWrite.bind(storage);
      const failing = vi.spyOn(storage, "bulkWrite").mockImplementation(async (rows, context) => {
        if (rows.some(row => row.document._deleted === true)) throw new Error("local storage refused the tombstone write");
        return remove(rows, context);
      });
      try { await expect(rx.deleteProject(board.id)).rejects.toThrow(); }
      finally { failing.mockRestore(); }
      // The rollback is a decision too: the board is visible again, and the
      // history says both things happened instead of silently forgetting.
      expect(await rx.isDeletedProject(board.id)).toBe(false);
      expect((await rx.journal.boardTombstoneFacts(board.id)).map(entry => entry.kind)).toEqual(["deleted", "restored"]);
    } finally { await rx.db.close(); }
  });
});

describe("board deletion tombstones: every import path consults them", () => {
  it("refuses a tombstoned board from shared discovery, snapshot recovery and legacy migration", async () => {
    const owner = await open();
    const recipient = await open();
    try {
      const board = await owner.rx.createProject("Shared then deleted");
      await owner.rx.addItem({ projectId: board.id, content: "Content" });
      const snapshot = await owner.rx.exportProject(board.id);
      const serialized = serializeProjectSnapshot(snapshot.project, snapshot.items);
      const permissions = { discoverSharedProjects: async () => [{ projectId: board.id, name: board.name, fileId: "f" }],
        readSharedSnapshot: async () => serialized, myRole: async () => "editor" as const };
      await recipient.rx.importProject(snapshot.project, snapshot.items);
      await recipient.rx.deleteProject(board.id);
      const discover = createSharedBoardDiscovery({ connected: async () => true, permissions,
        getRepository: async () => recipient.rx, isDeleted: async (id) => recipient.rx.isDeletedProject(id) });
      await discover();
      expect(await recipient.rx.getProject(board.id)).toBeNull();
      // Drive snapshot adoption (the reconcile round's import) refuses too, and
      // says so rather than reporting a successful pull.
      const snapshots = createBackendProjectSnapshotStore(memoryStorage(), async () => recipient.rx);
      expect(await snapshots.apply(deserializeProjectSnapshot(serialized))).toBe(false);
      expect(await snapshots.applyIfNewer(deserializeProjectSnapshot(serialized))).toBe("blocked");
      expect(await recipient.rx.getProject(board.id)).toBeNull();
      // `importState` (the RxDB legacy migration) skips it without failing its
      // own verification of what it did import.
      await recipient.rx.importState({ version: 3, projects: [snapshot.project], boardItems: snapshot.items, currentProjectId: null });
      expect(await recipient.rx.getProject(board.id)).toBeNull();
      // And the retained-history materializer refuses to rebuild its rows.
      await recipient.rx.privateRecovery.apply(board.id, async () => true);
      expect(await recipient.rx.db.projects.findOne(board.id).exec()).toBeNull();
    } finally { await owner.rx.db.close(); await recipient.rx.db.close(); }
  });
});

describe("board deletion tombstones: order records and preference merges", () => {
  it("cannot be lost to a preference merge or re-admitted through a board.order record", async () => {
    const { rx } = await open(unique(), async () => "editor");
    try {
      const board = await rx.createProject("Ordered away");
      const other = await rx.createProject("Stays");
      await rx.setProjectOrderAccount("account-a");
      await rx.deleteProject(board.id);
      // A newer remote order that still names the board must not make it visible…
      await rx.applyProjectOrder("account-a", { ids: [board.id, other.id], updatedAt: "2030-01-01T00:00:00.000Z" });
      expect(await rx.isDeletedProject(board.id)).toBe(true);
      expect(await rx.getProject(board.id)).toBeNull();
      expect((await rx.listProjects()).map(project => project.id)).toEqual([other.id]);
      // …and must not have cleared the legacy projection the preference carries.
      expect((await rx.getProjectOrder("account-a"))?.deletedProjectIds).toContain(board.id);
      // A realtime order record behaves the same way.
      await rx.applyRealtimeProjectOrder("account-a", { ids: [board.id, other.id], updatedAt: Date.now() + 60_000, seq: 9 });
      expect(await rx.getProject(board.id)).toBeNull();
      expect((await rx.getProjectOrder("account-a"))?.ids ?? []).not.toContain(board.id);
      // The repository's stored row is untouched: only the decision hides it.
      expect(await rx.db.projects.findOne(board.id).exec()).not.toBeNull();
      // A merge of a stale preference (no deletion marker, newer clock) cannot
      // resurrect the board either.
      const merged = mergeProjectOrder(
        parseProjectOrder(JSON.stringify({ ids: [board.id], updatedAt: "2026-01-01T00:00:00Z", deletedProjectIds: [board.id] })),
        parseProjectOrder(JSON.stringify({ ids: [board.id], updatedAt: "2026-02-01T00:00:00Z" })));
      expect(merged.deletedProjectIds).toContain(board.id);
      expect(merged.ids).not.toContain(board.id);
      await rx.applyProjectOrder("account-a", merged);
      expect(await rx.getProject(board.id)).toBeNull();
    } finally { await rx.db.close(); }
  });
});

describe("board deletion tombstones: legacy migration", () => {
  it("adopts a reliable deletedProjectIds marker and reports absence as unknown", () => {
    const plan = planLegacyDeletionMigration({
      preferences: [{ preferenceId: "localProjectOrder",
        preference: { ids: ["listed"], updatedAt: "2026-03-01T00:00:00.000Z", deletedProjectIds: ["marked"] } }],
      localProjectIds: ["marked", "unknown", "listed"],
      alreadyRecorded: () => false
    });
    expect(plan.adopt).toEqual([{ boardId: "marked", preferenceId: "localProjectOrder", updatedAt: "2026-03-01T00:00:00.000Z" }]);
    expect(plan.ambiguous).toEqual([{ boardId: "unknown", reason: "absent-from-preference" }]);
    expect(plan.restored).toEqual([]);
    // An existing restore fact outranks the marker; nothing is adopted.
    expect(planLegacyDeletionMigration({
      preferences: [{ preferenceId: "localProjectOrder",
        preference: { ids: ["listed"], updatedAt: "2026-03-01T00:00:00.000Z", deletedProjectIds: ["marked"] } }],
      localProjectIds: ["marked", "listed"], alreadyRecorded: id => id === "marked" }).adopt).toEqual([]);
  });

  it("adopts legacy markers on open, records the ambiguity, and decides nothing for it", async () => {
    const name = unique();
    const first = await createRxRepository({ name });
    const a = await first.createProject("Marked deleted");
    const b = await first.createProject("Listed and alive");
    const c = await first.createProject("Absent from every preference");
    // The legacy shape only: a marker in the preference document, no tombstone.
    await first.db.settings.upsert({ id: "localProjectOrder", value: JSON.stringify({
      ids: [b.id], updatedAt: "2026-03-01T00:00:00.000Z", deletedProjectIds: [a.id] }) });
    await first.db.close();

    const reopened = await createRxRepository({ name });
    try {
      expect((await reopened.journal.boardTombstoneFacts(a.id)).map(entry => entry.kind)).toEqual(["deleted"]);
      expect((await reopened.journal.boardTombstone(a.id)).fact?.evidence).toBe("legacy-preference:localProjectOrder");
      // A board the preference lists is untouched; a board it never mentions is
      // reported as unknown and stays listed — absence is not evidence.
      expect(await reopened.isDeletedProject(b.id)).toBe(false);
      expect(await reopened.isDeletedProject(c.id)).toBe(false);
      expect((await reopened.listProjects()).map(project => project.id)).toEqual(expect.arrayContaining([b.id, c.id]));
      const diagnostic = reopened.legacyDeletionDiagnostic();
      expect(diagnostic?.adopted).toEqual([a.id]);
      expect(diagnostic?.ambiguous).toEqual([c.id]);
      // Re-running the migration is idempotent.
      const plan = await reopened.migrateLegacyDeletions();
      expect(plan.adopt).toEqual([]);
      expect((await reopened.journal.boardTombstoneFacts(a.id)).length).toBe(1);
    } finally { await reopened.db.close(); }
  });
});

describe("board deletion tombstones: idempotence and account scoping", () => {
  it("records duplicates idempotently and scopes facts per account list", async () => {
    const { rx } = await open(unique(), async () => "editor");
    try {
      const board = await rx.createProject("Shared");
      await rx.setProjectOrderAccount("collaborator");
      await rx.deleteProject(board.id);
      await rx.journal.recordBoardDeletion({ boardId: board.id, accountId: "collaborator", context: {},
        role: "editor", at: new Date().toISOString(), evidence: "duplicate" });
      const facts = await rx.journal.boardTombstoneFacts(board.id);
      expect(facts.filter(entry => entry.accountId === "collaborator")).toHaveLength(2);
      expect(facts.every(entry => entry.kind === "deleted")).toBe(true);
      // Storing the same fact twice is the same record, not a third row.
      const [first] = facts;
      await rx.journal.tombstones.put({ boardId: board.id, facts: mergeFacts(facts, [first]) });
      expect((await rx.journal.boardTombstoneFacts(board.id)).length).toBe(facts.length);
      // The owner's account list on the same device still shows the board.
      await rx.setProjectOrderAccount("owner");
      expect(await rx.isDeletedProject(board.id)).toBe(false);
      expect((await rx.listProjects()).map(project => project.id)).toContain(board.id);
      await rx.setProjectOrderAccount("collaborator");
      expect(await rx.isDeletedProject(board.id)).toBe(true);
      expect((await rx.listProjects()).map(project => project.id)).not.toContain(board.id);
    } finally { await rx.db.close(); }
  });

  it("survives an account preference round trip through Drive", async () => {
    const first = await open();
    const second = await open();
    try {
      const board = await first.rx.createProject("Deleted on the first browser");
      const transport = memoryDrive();
      const sync = (rx: RxRepository) => createAccountPreferenceSync({ transport, getAccountId: async () => "A", getRepository: async () => rx })();
      await sync(first.rx);
      await second.rx.importProject(board, []);
      await second.rx.setProjectOrderAccount("A");
      await first.rx.deleteProject(board.id);
      await sync(first.rx);
      await sync(second.rx);
      expect(await second.rx.isDeletedProject(board.id)).toBe(true);
      expect(await second.rx.getProject(board.id)).toBeNull();
      // The tombstone outlives the preference file: even when a newer order
      // arrives with no deletion marker, the board stays gone.
      await transport.upload("A", JSON.stringify({ ids: [board.id], updatedAt: "2031-01-01T00:00:00Z" }));
      await sync(second.rx);
      expect(await second.rx.getProject(board.id)).toBeNull();
      expect(await second.rx.isDeletedProject(board.id)).toBe(true);
    } finally { await first.rx.db.close(); await second.rx.db.close(); }
  });
});
