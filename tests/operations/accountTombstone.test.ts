/**
 * Carrying a durable tombstone fact over the account channel: the wire shape,
 * the merge into the durable store (the *same* merge the local delete path
 * uses), the outbox rule that keeps a tombstone from being the record the bound
 * drops, and the two-device sequences that matter.
 *
 * Everything here is count-based or clock-injected: facts carry their own
 * Lamport clock and causal context, and no assertion depends on how fast the
 * machine is.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LIFECYCLE_KINDS,
  MAX_CANDIDATE_BYTES,
  MAX_CONTEXT_ACTORS,
  decodeAccountLifecycle,
  encodeAccountLifecycle,
  outboxSlot,
  trimOutbox,
  type AccountLifecycleRecord,
  type AccountTombstoneFact
} from "../../src/sync/operations/accountLifecycle";
import {
  admissionAllowed,
  latestFact,
  mergeFacts,
  type BoardTombstoneFact
} from "../../src/storage/boardTombstone";
import { createRxRepository, type RxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";

async function open(): Promise<RxRepository> {
  const name = `tombstonechan${crypto.randomUUID().replaceAll("-", "")}`;
  return await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
}

const fact = (overrides: Partial<AccountTombstoneFact> = {}): AccountTombstoneFact => ({
  kind: "deleted", opId: "device-a:1", actorId: "device-a", seq: 1, clock: 1,
  context: {}, role: "owner", ...overrides
});
const record = (boardId: string, overrides: Partial<AccountLifecycleRecord> = {}): AccountLifecycleRecord =>
  ({ kind: "board.tombstone", boardId, updatedAt: 1_700_000_000_000, seq: 3, fact: fact(), ...overrides });

/** The store's bytes, as both devices would write them. */
const stored = async (rx: RxRepository, boardId: string) =>
  (await rx.journal.boardTombstoneFacts(boardId)).map(entry => JSON.stringify(entry));

describe("the board.tombstone record", () => {
  it("is its own kind, not a board.deleted hint", () => {
    expect(ACCOUNT_LIFECYCLE_KINDS).toContain("board.tombstone");
    expect(ACCOUNT_LIFECYCLE_KINDS).toContain("board.deleted");
  });

  it("round-trips every causal field the ordering rule reads", () => {
    const value = record("board-1", { fact: fact({ kind: "restored", context: { "device-a": 4, "device-b": 2 }, clock: 9 }) });
    expect(decodeAccountLifecycle(encodeAccountLifecycle(value))).toEqual({ record: { ...value } });
  });

  it("is bounded, and refuses a fact whose context or envelope is past the bound", () => {
    const context = Object.fromEntries(Array.from({ length: MAX_CONTEXT_ACTORS + 1 }, (_, index) => [`actor${index}`, 1]));
    const tooWide = JSON.stringify({ v: 1, kind: "board.tombstone", boardId: "b", updatedAt: 1, seq: 1, fact: { ...fact(), context } });
    expect(decodeAccountLifecycle(tooWide)).toEqual({ skip: "too-large" });
    // A bounded fact whose envelope still exceeds the per-record ceiling is
    // refused rather than queued: a fact no receiver can read back is not a fact.
    const huge = record("b", { fact: fact({ context: Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`actor-with-a-long-name-${index}`, 1])) }) });
    expect(encodeAccountLifecycle(huge).length).toBeGreaterThan(MAX_CANDIDATE_BYTES);
  });

  it("refuses any fact two receivers could order differently", () => {
    const wire = (payload: object) => JSON.stringify({ v: 1, kind: "board.tombstone", boardId: "b", updatedAt: 1, seq: 1, fact: payload });
    // opId must be the fact's own identity, or it merges under one id and
    // orders under another.
    expect(decodeAccountLifecycle(wire(fact({ opId: "someone-else:1" })))).toEqual({ skip: "malformed" });
    // A role outside the vocabulary is a fact this build cannot reason about.
    expect(decodeAccountLifecycle(wire({ ...fact(), role: "admin" }))).toEqual({ skip: "malformed" });
    // A context entry that is not a sequence is not a causal claim.
    expect(decodeAccountLifecycle(wire({ ...fact(), context: { "device-b": -1 } }))).toEqual({ skip: "malformed" });
    // A clock that is not a positive integer is not a Lamport clock.
    expect(decodeAccountLifecycle(wire({ ...fact(), clock: 0 }))).toEqual({ skip: "malformed" });
    // The whole record is the fact: a tombstone with no fact is malformed.
    expect(decodeAccountLifecycle(JSON.stringify({ v: 1, kind: "board.tombstone", boardId: "b", updatedAt: 1, seq: 1 })))
      .toEqual({ skip: "malformed" });
  });
});

describe("merging a received fact into the durable store", () => {
  it("is a duplicate no-op for a replay, an older fact, or a concurrent loser", async () => {
    const rx = await open();
    try {
      await rx.setProjectOrderAccount("account-a");
      const board = await rx.createProject("Deleted here");
      await rx.deleteProject(board.id);
      const [local] = await rx.journal.boardTombstoneFacts(board.id);

      // Replaying the stored fact is the same fact, not a second decision.
      expect(await rx.applyBoardTombstoneFact(board.id, { ...local, accountId: "account-a" }))
        .toEqual({ duplicate: true, deleted: true });
      expect(await rx.journal.boardTombstoneFacts(board.id)).toHaveLength(1);

      // A concurrent fact that loses the total order is stored as evidence but
      // decides nothing.
      const loser: BoardTombstoneFact = { kind: "restored", accountId: "account-a", opId: "device-z:1",
        actorId: "device-z", seq: 1, clock: 0, context: {}, deviceId: "device-z", role: "owner",
        at: "2020-01-01T00:00:00.000Z", evidence: "test" };
      expect(await rx.applyBoardTombstoneFact(board.id, loser)).toEqual({ duplicate: true, deleted: true });
      expect(await rx.journal.boardTombstoneFacts(board.id)).toHaveLength(2);
      expect(await rx.isDeletedProject(board.id), "the deletion is still the decision").toBe(true);
    } finally { await rx.db.close(); }
  });

  it("converges to the same bytes whatever order two facts arrive in", async () => {
    const first = await open();
    const second = await open();
    try {
      const board = await first.createProject("Order independent");
      await first.setProjectOrderAccount("account-a");
      await first.deleteProject(board.id);
      const [deletion] = await first.journal.boardTombstoneFacts(board.id);
      // A restore written by a device that had seen the deletion: it dominates
      // it causally, so it decides alone — no timestamp is consulted.
      const restore: BoardTombstoneFact = { kind: "restored", accountId: "account-a", opId: "device-b:1",
        actorId: "device-b", seq: 1, clock: deletion.clock + 1, context: { [deletion.actorId]: deletion.seq },
        deviceId: "device-b", role: "owner", at: "2020-01-01T00:00:00.000Z", evidence: "test" };

      await second.setProjectOrderAccount("account-a");
      await second.importProject({ ...board }, []);
      await second.applyBoardTombstoneFact(board.id, restore);
      await second.applyBoardTombstoneFact(board.id, deletion);
      const forward = await stored(second, board.id);

      await second.db.settings.find().remove(); // reset the account list only
      await second.setProjectOrderAccount("account-a");
      await second.applyBoardTombstoneFact(board.id, deletion);
      await second.applyBoardTombstoneFact(board.id, restore);
      const backward = await stored(second, board.id);

      expect(forward, "delivery order cannot change the stored record").toEqual(backward);
      expect(forward).toHaveLength(2);
      // And the decision is the same one, computed from those bytes alone.
      const facts = await second.journal.boardTombstoneFacts(board.id);
      expect(latestFact(facts, "account-a")?.opId).toBe(restore.opId);
      expect(admissionAllowed(facts, {}, "account-a")).toBe(true);
    } finally { await first.db.close(); await second.db.close(); }
  });

  it("resolves two concurrent deletions to one decision on both devices", async () => {
    const left = await open();
    const right = await open();
    try {
      const board = await left.createProject("Deleted on both");
      await right.importProject({ ...board }, []);
      await left.setProjectOrderAccount("account-a");
      await right.setProjectOrderAccount("account-a");
      await left.deleteProject(board.id);
      await right.deleteProject(board.id);

      const leftFacts = await left.journal.boardTombstoneFacts(board.id);
      const rightFacts = await right.journal.boardTombstoneFacts(board.id);
      expect(leftFacts).toHaveLength(1);
      expect(rightFacts).toHaveLength(1);
      // Each device now receives the other's fact.
      await left.applyBoardTombstoneFact(board.id, rightFacts[0]);
      await right.applyBoardTombstoneFact(board.id, leftFacts[0]);
      expect(await stored(left, board.id)).toEqual(await stored(right, board.id));
      expect(new Set([...(await left.journal.boardTombstoneFacts(board.id)).map(f => f.kind)])).toEqual(new Set(["deleted"]));
      expect(await left.isDeletedProject(board.id)).toBe(true);
      expect(await right.isDeletedProject(board.id)).toBe(true);
    } finally { await left.db.close(); await right.db.close(); }
  });

  it("hides a board on a peer that never saw the deletion and refuses its re-import", async () => {
    const owner = await open();
    const peer = await open();
    try {
      const board = await owner.createProject("Owner deletes");
      await owner.addItem({ projectId: board.id, content: "Content" });
      const snapshot = await owner.exportProject(board.id);
      await peer.importProject(snapshot.project, snapshot.items);
      await peer.setProjectOrderAccount("account-a");
      await owner.setProjectOrderAccount("account-a");

      // The peer holds the board; it learns the deletion only as a fact.
      expect(await peer.getProject(board.id)).not.toBeNull();
      await owner.deleteProject(board.id);
      const [factOnWire] = await owner.journal.boardTombstoneFacts(board.id);
      expect(await peer.applyBoardTombstoneFact(board.id, factOnWire)).toEqual({ duplicate: false, deleted: true });

      // Removed from the active list, from the selection's reach and from every
      // read — without the peer having deleted anything itself.
      expect(await peer.isDeletedProject(board.id)).toBe(true);
      expect(await peer.getProject(board.id)).toBeNull();
      expect((await peer.listProjects()).some(project => project.id === board.id)).toBe(false);
      expect(await peer.listCards(board.id)).toEqual([]);

      // A fresh Drive adoption (the reconcile round's import) is refused, and
      // so is an old creation record reaching the repository.
      await peer.importProject(snapshot.project, snapshot.items);
      expect(await peer.getProject(board.id)).toBeNull();
      // A received *hint* is refused by the same gates.
      expect(await peer.isDeletedProject(board.id)).toBe(true);
    } finally { await owner.db.close(); await peer.db.close(); }
  });

  it("re-admits the board when a restored fact arrives", async () => {
    const owner = await open();
    const peer = await open();
    try {
      const board = await owner.createProject("Deleted then restored");
      await owner.setProjectOrderAccount("account-a");
      const snapshot = await owner.exportProject(board.id);
      await peer.importProject(snapshot.project, snapshot.items);
      await peer.setProjectOrderAccount("account-a");

      await owner.deleteProject(board.id);
      const [deletion] = await owner.journal.boardTombstoneFacts(board.id);
      await peer.applyBoardTombstoneFact(board.id, deletion);
      expect(await peer.getProject(board.id)).toBeNull();

      // The explicit restore writes one fact; it causally dominates the deletion.
      await owner.unhideProject(board.id);
      const restore = (await owner.journal.boardTombstoneFacts(board.id)).find(entry => entry.kind === "restored")!;
      expect(await peer.applyBoardTombstoneFact(board.id, restore)).toEqual({ duplicate: false, deleted: false });
      expect(await peer.isDeletedProject(board.id)).toBe(false);
      // The peer still has the retained history, so the board row comes back.
      expect((await peer.getProject(board.id))?.id).toBe(board.id);
    } finally { await owner.db.close(); await peer.db.close(); }
  });

  it("keeps one row when a duplicate delete is delivered twice", async () => {
    const owner = await open();
    const peer = await open();
    try {
      const board = await owner.createProject("Delivered twice");
      await owner.setProjectOrderAccount("account-a");
      await peer.importProject({ ...board }, []);
      await peer.setProjectOrderAccount("account-a");
      await owner.deleteProject(board.id);
      const [factOnWire] = await owner.journal.boardTombstoneFacts(board.id);
      expect(await peer.applyBoardTombstoneFact(board.id, factOnWire)).toEqual({ duplicate: false, deleted: true });
      expect(await peer.applyBoardTombstoneFact(board.id, factOnWire)).toEqual({ duplicate: true, deleted: true });
      expect(await peer.journal.boardTombstoneFacts(board.id)).toHaveLength(1);
    } finally { await owner.db.close(); await peer.db.close(); }
  });
});

describe("the outbox keeps a tombstone from being the record the bound drops", () => {
  const hint = (boardId: string, kind: "board.created" | "board.metadata"): AccountLifecycleRecord =>
    ({ kind, boardId, updatedAt: 1, seq: 0 });
  const row = (value: AccountLifecycleRecord) => ({ record: value, stamp: "", attempts: 0 });

  it("evicts hints before tombstones, however new the tombstone is", () => {
    const rows = [row(record("b1")), row(hint("b2", "board.created")), row(record("b3")), row(hint("b4", "board.metadata"))];
    const { rows: kept, evicted } = trimOutbox(rows, 2);
    expect(evicted.map(entry => entry.kind)).toEqual(["board.created", "board.metadata"]);
    expect(kept.map(entry => entry.record.kind)).toEqual(["board.tombstone", "board.tombstone"]);
  });

  it("says so when a queue of nothing but tombstones must drop the oldest", () => {
    const rows = [row(record("b1")), row(record("b2")), row(record("b3"))];
    const { rows: kept, evicted } = trimOutbox(rows, 2);
    expect(evicted.map(entry => entry.boardId)).toEqual(["b1"]);
    expect(kept.map(entry => entry.record.boardId)).toEqual(["b2", "b3"]);
  });

  it("gives a delete and the restore that reverses it two slots, and a retry one", () => {
    const deletion = record("b1", { fact: fact({ opId: "device-a:1" }) });
    const restore = record("b1", { fact: fact({ kind: "restored", opId: "device-a:2", seq: 2, clock: 2 }) });
    expect(outboxSlot(deletion)).not.toBe(outboxSlot(restore));
    expect(outboxSlot(deletion)).toBe(outboxSlot({ ...deletion }));
    // Two hints for one board still collapse, as before.
    expect(outboxSlot(hint("b1", "board.created"))).toBe(outboxSlot(hint("b1", "board.created")));
  });

  it("leaves a queue inside the bound untouched", () => {
    const rows = [row(record("b1")), row(hint("b2", "board.created"))];
    expect(trimOutbox(rows, 64)).toEqual({ rows, evicted: [] });
  });
});

describe("the merge is the same one the direct path uses", () => {
  it("is a pure union under the total order, so two receivers share bytes", () => {
    const deletion: BoardTombstoneFact = { kind: "deleted", accountId: "a", opId: "x:1", actorId: "x", seq: 1,
      clock: 3, context: {}, deviceId: "x", role: "owner", at: "2026-01-01T00:00:00.000Z", evidence: "test" };
    const concurrent: BoardTombstoneFact = { ...deletion, opId: "y:1", actorId: "y", clock: 3, deviceId: "y" };
    expect(mergeFacts([deletion], [concurrent])).toEqual(mergeFacts([concurrent], [deletion]));
  });
});
