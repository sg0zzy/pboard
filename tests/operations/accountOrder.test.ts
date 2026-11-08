/**
 * The account list's order as a realtime record: the wire format, the merge
 * rule a receiver applies, the clock that picks a winner, and the repository's
 * application of a received order.
 *
 * Everything here is clock-injected or count-based. The record's
 * `updatedAt`/`seq`/row-id comparison is a pure function of values the test
 * writes, so no assertion depends on how fast the machine is.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LIFECYCLE_KINDS,
  ACCOUNT_ORDER_SCOPE,
  MAX_ORDER_IDS,
  createAccountLifecycleProjection,
  decodeAccountLifecycle,
  encodeAccountLifecycle,
  type AccountLifecycleRecord
} from "../../src/sync/operations/accountLifecycle";
import { mergeBoardOrder } from "../../src/storage/projectOrder";
import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";

const order = (ids: string[], updatedAt: number, seq = 1): AccountLifecycleRecord =>
  ({ kind: "board.order", boardId: ACCOUNT_ORDER_SCOPE, updatedAt, seq, ids });

describe("the board.order record", () => {
  it("round-trips the total order and its clock", () => {
    const record = order(["b", "a", "c"], 1_700_000_000_000, 7);
    expect(decodeAccountLifecycle(encodeAccountLifecycle(record))).toEqual({ record: { ...record } });
  });

  it("is a kind this build knows, alongside the board lifecycle records", () => {
    expect(ACCOUNT_LIFECYCLE_KINDS).toContain("board.order");
  });

  it("refuses a list that is not a total order: a duplicate rank is not an order", () => {
    const encoded = JSON.stringify({ v: 1, kind: "board.order", boardId: ACCOUNT_ORDER_SCOPE, updatedAt: 10, seq: 1, ids: ["a", "a"] });
    expect(decodeAccountLifecycle(encoded)).toEqual({ skip: "malformed" });
  });

  it("refuses an id outside the wire charset and an order published under a board id", () => {
    const badId = JSON.stringify({ v: 1, kind: "board.order", boardId: ACCOUNT_ORDER_SCOPE, updatedAt: 10, seq: 1, ids: ["../etc"] });
    expect(decodeAccountLifecycle(badId)).toEqual({ skip: "malformed" });
    const wrongScope = JSON.stringify({ v: 1, kind: "board.order", boardId: "some-board", updatedAt: 10, seq: 1, ids: ["a"] });
    expect(decodeAccountLifecycle(wrongScope)).toEqual({ skip: "malformed" });
  });

  it("bounds the list, and refuses to encode one past the bound", () => {
    const tooMany = Array.from({ length: MAX_ORDER_IDS + 1 }, (_, index) => `b${index}`);
    expect(decodeAccountLifecycle(JSON.stringify({ v: 1, kind: "board.order", boardId: ACCOUNT_ORDER_SCOPE, updatedAt: 10, seq: 1, ids: tooMany })))
      .toEqual({ skip: "too-large" });
    expect(() => encodeAccountLifecycle(order(tooMany, 10))).toThrow();
    // One id below the bound still encodes *and* stays inside the relay's own
    // per-operation payload cap, which is the bound that actually binds.
    const atBound = Array.from({ length: MAX_ORDER_IDS }, (_, index) => `b${index}`);
    expect(encodeAccountLifecycle(order(atBound, 10)).length).toBeLessThan(64 * 1024);
  });

  it("still reads every board lifecycle record as before", () => {
    const created: AccountLifecycleRecord = { kind: "board.created", boardId: "board-1", updatedAt: 5, seq: 2 };
    expect(decodeAccountLifecycle(encodeAccountLifecycle(created))).toEqual({ record: created });
    const named: AccountLifecycleRecord = { kind: "board.metadata", boardId: "board-1", updatedAt: 5, seq: 2, name: "Renamed" };
    expect(decodeAccountLifecycle(encodeAccountLifecycle(named))).toEqual({ record: named });
  });
});

describe("merging a received order into the list this device holds", () => {
  it("orders the known ids exactly as the record gives them", () => {
    expect(mergeBoardOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("drops a received id this device does not have — an order never imports a board", () => {
    expect(mergeBoardOrder(["a", "b"], ["a", "ghost", "b"])).toEqual(["a", "b"]);
    expect(mergeBoardOrder(["a"], ["ghost"])).toEqual(["a"]);
  });

  it("keeps a local board the record does not mention at its relative position", () => {
    // A and B reorder, but a third local board is not in the record at all. It
    // followed b locally, so it stays right behind b: b, c, a.
    expect(mergeBoardOrder(["a", "b", "c"], ["b", "a"])).toEqual(["b", "c", "a"]);
    // The unmentioned board follows a locally, so it moves with a.
    expect(mergeBoardOrder(["a", "c", "b"], ["b", "a"])).toEqual(["b", "a", "c"]);
    // Two unmentioned boards in a row move as one run, anchored to the board
    // that precedes them locally.
    expect(mergeBoardOrder(["a", "x", "y", "b"], ["b", "a"])).toEqual(["b", "a", "x", "y"]);
    // An unmentioned board at the head stays at the head.
    expect(mergeBoardOrder(["x", "a", "b"], ["b", "a"])).toEqual(["x", "b", "a"]);
  });

  it("is idempotent: merging a device's own order changes nothing", () => {
    const local = ["a", "b", "c", "d"];
    expect(mergeBoardOrder(local, local)).toEqual(local);
    const merged = mergeBoardOrder(local, ["d", "b"]);
    expect(mergeBoardOrder(merged, ["d", "b"])).toEqual(merged);
  });
});

describe("the account projection's clock", () => {
  it("newer updatedAt wins, then the sender's seq", () => {
    const projection = createAccountLifecycleProjection();
    projection.apply([{ ...order(["a"], 20, 1), tie: "d:1" }]);
    const stale = projection.apply([{ ...order(["b"], 10, 9), tie: "d:1" }]);
    expect(stale[0].duplicate).toBe(true);
    expect(projection.entry(ACCOUNT_ORDER_SCOPE)?.ids).toEqual(["a"]);
    const newer = projection.apply([{ ...order(["b"], 20, 2), tie: "d:1" }]);
    expect(newer[0].duplicate).toBe(false);
    expect(projection.entry(ACCOUNT_ORDER_SCOPE)?.ids).toEqual(["b"]);
  });

  it("two records with the same clock and seq resolve by the log row, the same way on every device", () => {
    const first = { ...order(["a", "b"], 100, 3), tie: "device-a:3" };
    const second = { ...order(["b", "a"], 100, 3), tie: "device-b:3" };
    const one = createAccountLifecycleProjection();
    const two = createAccountLifecycleProjection();
    // The same two rows, delivered in the two possible orders.
    one.apply([first, second]);
    two.apply([second, first]);
    expect(one.entry(ACCOUNT_ORDER_SCOPE)?.ids).toEqual(["b", "a"]);
    expect(two.entry(ACCOUNT_ORDER_SCOPE)?.ids).toEqual(["b", "a"]);
  });

  it("does not report the order scope as a board that exists", () => {
    const projection = createAccountLifecycleProjection();
    projection.apply([{ ...order(["a"], 10), tie: "d:1" }]);
    expect(projection.live()).toEqual([]);
  });
});

async function openRepository() {
  const name = `accountorder${crypto.randomUUID().replaceAll("-", "")}`;
  const published: Array<{ account: string | null; ids: string[]; updatedAt: number }> = [];
  const data: Record<string, unknown> = {};
  const storage = {
    data,
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }
  };
  const rx = await createRxRepository({
    name, blobs: createIndexedDbBlobStore(`${name}images`),
    events: { projectChanged: () => undefined, projectOrderChanged: change => { published.push(change); } }
  });
  return { rx, published };
}

describe("applying a received order to the repository", () => {
  it("reorders the local list without importing a board the record names", async () => {
    const { rx } = await openRepository();
    try {
      const a = await rx.createProject("A"), b = await rx.createProject("B");
      await rx.setProjectOrderAccount("acct");
      expect(await rx.applyRealtimeProjectOrder("acct", { ids: ["ghost", b.id, a.id], updatedAt: 2_000, seq: 4 })).toBe(true);
      expect((await rx.listProjects()).map(project => project.id)).toEqual([b.id, a.id]);
      expect(await rx.getProject("ghost")).toBeNull();
      expect((await rx.getProjectOrder("acct"))?.ids).not.toContain("ghost");
    } finally { await rx.db.close(); }
  });

  it("keeps a local board the record does not mention, at its relative position", async () => {
    const { rx } = await openRepository();
    try {
      const a = await rx.createProject("A"), b = await rx.createProject("B"), mine = await rx.createProject("Only here");
      await rx.setProjectOrderAccount("acct");
      await rx.reorderProjects([a.id, mine.id, b.id]);
      // The sender's order knows nothing about `mine`, and puts b before a.
      await rx.applyRealtimeProjectOrder("acct", { ids: [b.id, a.id], updatedAt: Date.parse((await rx.getProjectOrder("acct"))!.updatedAt) + 1, seq: 2 });
      // `mine` follows `a` locally, so it lands after a's new position.
      expect((await rx.listProjects()).map(project => project.id)).toEqual([b.id, a.id, mine.id]);
    } finally { await rx.db.close(); }
  });

  it("ignores a record older than the local reorder, so the loser is superseded and not reverted", async () => {
    const { rx } = await openRepository();
    try {
      const a = await rx.createProject("A"), b = await rx.createProject("B");
      await rx.setProjectOrderAccount("acct");
      await rx.reorderProjects([b.id, a.id]);
      const local = (await rx.getProjectOrder("acct"))!;
      // Strictly older record: the local reorder already answered it.
      expect(await rx.applyRealtimeProjectOrder("acct", { ids: [a.id, b.id], updatedAt: Date.parse(local.updatedAt) - 1, seq: 99 })).toBe(false);
      expect((await rx.listProjects()).map(project => project.id)).toEqual([b.id, a.id]);
    } finally { await rx.db.close(); }
  });

  it("resolves two reorders made under one clock to the same order on both devices", async () => {
    const one = await openRepository(), two = await openRepository();
    try {
      const a = await one.rx.createProject("A"), b = await one.rx.createProject("B");
      // Both devices hold the same two boards, and both preferences carry the
      // same clock — which is what a shared injected clock, or two reorders in
      // the same millisecond, produces.
      const snapshot = await one.rx.exportProject(a.id);
      await two.rx.importProject(snapshot.project, snapshot.items);
      const board = await one.rx.getProject(b.id);
      await two.rx.importProject(board!, []);
      await one.rx.setProjectOrderAccount("acct");
      await two.rx.setProjectOrderAccount("acct");
      const clock = "2026-11-06T12:00:00.000Z";
      await one.rx.applyProjectOrder("acct", { ids: [b.id, a.id], updatedAt: clock });
      await two.rx.applyProjectOrder("acct", { ids: [a.id, b.id], updatedAt: clock });
      // Each session receives the other's reorder under that same clock. The
      // local intent was never stamped by the log, so the orders themselves are
      // the tie-break; both devices see both arrays and pick the same winner.
      await one.rx.applyRealtimeProjectOrder("acct", { ids: [a.id, b.id], updatedAt: Date.parse(clock), seq: 9 });
      await two.rx.applyRealtimeProjectOrder("acct", { ids: [b.id, a.id], updatedAt: Date.parse(clock), seq: 9 });
      const ids = async (session: typeof one) => (await session.rx.listProjects()).map(project => project.id);
      const settled = await ids(one);
      // One of the two orders that were asked for, the same one on both devices.
      expect([[a.id, b.id], [b.id, a.id]].map(list => list.join(','))).toContain(settled.join(','));
      expect(await ids(two)).toEqual(settled);
    } finally { await one.rx.db.close(); await two.rx.db.close(); }
  });

  it("publishes nothing when it applies an order — no echo back into the room", async () => {
    const { rx, published } = await openRepository();
    try {
      const a = await rx.createProject("A"), b = await rx.createProject("B");
      await rx.setProjectOrderAccount("acct");
      await rx.reorderProjects([b.id, a.id]);
      expect(published).toHaveLength(1);
      // The order arrives from a peer (and, on the publisher, as its own echo).
      await rx.applyRealtimeProjectOrder("acct", { ids: [a.id, b.id], updatedAt: Date.now() + 1_000, seq: 5 });
      await rx.applyProjectOrder("acct", { ids: [a.id, b.id], updatedAt: new Date(Date.now() + 2_000).toISOString() });
      expect(published, "applying an order must not be mistaken for a local reorder").toHaveLength(1);
    } finally { await rx.db.close(); }
  });

  it("does not fire a second publication for the publisher's own echo of its reorder", async () => {
    const { rx, published } = await openRepository();
    try {
      const a = await rx.createProject("A"), b = await rx.createProject("B");
      await rx.setProjectOrderAccount("acct");
      await rx.reorderProjects([b.id, a.id]);
      const own = published[0];
      // The sender sees its own row come back over the room. Nothing moves, and
      // nothing is republished: the ids and the clock are its own.
      expect(await rx.applyRealtimeProjectOrder("acct", { ids: own.ids, updatedAt: own.updatedAt, seq: 1 })).toBe(false);
      expect(published).toHaveLength(1);
    } finally { await rx.db.close(); }
  });
});

describe("a reorder publishes once per settling reorder", () => {
  it("counts publications, not drag steps, and advances the clock each time", async () => {
    const { rx, published } = await openRepository();
    try {
      const a = await rx.createProject("A"), b = await rx.createProject("B"), c = await rx.createProject("C");
      await rx.setProjectOrderAccount("acct");
      // Three drops: three settling reorders and therefore three publications.
      // The repository never sees a drag preview — the picker computes one
      // locally and calls `reorderProjects` only when the drop settles — so
      // there is no per-step publish to suppress.
      await rx.reorderProjects([b.id, a.id, c.id]);
      await rx.reorderProjects([c.id, b.id, a.id]);
      await rx.reorderProjects([a.id, b.id, c.id]);
      expect(published.map(change => change.ids)).toEqual([[b.id, a.id, c.id], [c.id, b.id, a.id], [a.id, b.id, c.id]]);
      for (const change of published) expect(Number.isFinite(change.updatedAt)).toBe(true);
      expect(new Set(published.map(change => change.updatedAt)).size, "a second reorder must advance the clock").toBe(3);
    } finally { await rx.db.close(); }
  });
});

describe("the repository's order scope", () => {
  it("keeps one order document per account", async () => {
    const { rx } = await openRepository();
    try {
      const a = await rx.createProject("A"), b = await rx.createProject("B");
      await rx.setProjectOrderAccount("one");
      await rx.reorderProjects([b.id, a.id]);
      await rx.setProjectOrderAccount("two");
      await rx.reorderProjects([a.id, b.id]);
      expect((await rx.getProjectOrder("one"))?.ids).toEqual([b.id, a.id]);
      expect((await rx.getProjectOrder("two"))?.ids).toEqual([a.id, b.id]);
    } finally { await rx.db.close(); }
  });
});
