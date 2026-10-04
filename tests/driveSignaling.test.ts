import { describe, expect, it, vi } from "vitest";
import { createDriveSignaling, type PboardDriveSignaling, type PboardDriveSignalRecord, type PboardDriveSignalStore } from "../src/collab/signaling";

// All peers in a room share one realtime folder, so the backing `records` map
// (and the clock) are shared across the signaling instances in a room. Each
// peer's store reads/writes its own record against that shared map.
type Room = {
  clock: { t: number };
  records: Map<string, PboardDriveSignalRecord>;
  makeSignaling(peerId: string, overrides?: { presenceTtlMs?: number; signalTtlMs?: number }): { signaling: PboardDriveSignaling; store: PboardDriveSignalStore };
};

function makeRoom(): Room {
  const clock = { t: 0 };
  const records = new Map<string, PboardDriveSignalRecord>();
  const makeSignaling = (
    peerId: string,
    overrides: { presenceTtlMs?: number; signalTtlMs?: number } = {}
  ): { signaling: PboardDriveSignaling; store: PboardDriveSignalStore } => {
    const store: PboardDriveSignalStore = {
      peerId,
      now: () => clock.t,
      readPeer: async (id) => structuredClone(records.get(id) ?? null),
      writeOwn: async (record) => {
        records.set(peerId, structuredClone(record));
      },
      listPeers: async () => structuredClone(Object.fromEntries(records)),
      deleteOwn: async () => {
        records.delete(peerId);
      }
    };
    return {
      store,
      signaling: createDriveSignaling({
        store,
        pollMs: 10_000,
        presenceTtlMs: overrides.presenceTtlMs ?? 60_000,
        signalTtlMs: overrides.signalTtlMs ?? 240_000
      })
    };
  };
  return { clock, records, makeSignaling };
}

describe("createDriveSignaling", () => {
  it("keeps concurrent heartbeat and handshake writes and delivers each signal only to its recipient", async () => {
    const room = makeRoom();
    const a = room.makeSignaling("a").signaling;
    const b = room.makeSignaling("b").signaling;
    const c = room.makeSignaling("c").signaling;
    const bSignals: unknown[] = [];
    const cSignals: unknown[] = [];
    try {
      await a.join(() => {}); await b.join(() => {}); await c.join(() => {});
      b.onSignal((_from, signal) => bSignals.push(signal));
      c.onSignal((_from, signal) => cSignals.push(signal));
      await Promise.all([a.tick(), a.sendSignal("b", "offer-b"), a.sendSignal("c", "offer-c")]);
      await b.tick(); await c.tick();
      expect(bSignals).toEqual(["offer-b"]);
      expect(cSignals).toEqual(["offer-c"]);
      expect(room.records.get("a")?.outbox).toHaveLength(2);
    } finally { await a.leave(); await b.leave(); await c.leave(); }
  });

  it("reports a failed periodic poll and continues polling after recovery", async () => {
    vi.useFakeTimers();
    const room = makeRoom();
    const { signaling, store } = room.makeSignaling("a");
    const failures: unknown[] = [];
    signaling.onError?.((error) => failures.push(error));
    try {
      await signaling.join(() => {});
      const list = vi.spyOn(store, "listPeers").mockRejectedValueOnce(new Error("Drive offline"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(failures).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(list).toHaveBeenCalledTimes(3);
      await signaling.leave();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(room.records.has("a")).toBe(false);
      expect(list).toHaveBeenCalledTimes(3);
    } finally { await signaling.leave(); vi.useRealTimers(); }
  });

  it("keeps its session identity and discovers peers after an initial Drive failure", async () => {
    vi.useFakeTimers();
    const room = makeRoom();
    const { signaling: a, store } = room.makeSignaling("a");
    const b = room.makeSignaling("b").signaling;
    const failures: unknown[] = [];
    const rosters: string[][] = [];
    a.onError?.((error) => failures.push(error));
    vi.spyOn(store, "listPeers").mockRejectedValueOnce(new Error("Drive offline"));
    try {
      expect((await a.join((roster) => rosters.push(roster))).peerId).toBe("a");
      expect(failures).toHaveLength(1);
      await b.join(() => {});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rosters).toContainEqual(["b"]);
    } finally { await a.leave(); await b.leave(); vi.useRealTimers(); }
  });
  it("keeps polling so a browser opened after the first scheduled poll is discovered", async () => {
    vi.useFakeTimers();
    const room = makeRoom();
    const a = room.makeSignaling("a").signaling;
    const b = room.makeSignaling("b").signaling;
    const rosters: string[][] = [];
    try {
      await a.join((roster) => rosters.push(roster));
      await vi.advanceTimersByTimeAsync(20_000);
      await b.join(() => {});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rosters).toContainEqual(["b"]);
    } finally {
      await a.leave(); await b.leave(); vi.useRealTimers();
    }
  });
  it("returns the peer id and an empty roster for a fresh room", async () => {
    const room = makeRoom();
    const { signaling } = room.makeSignaling("a");
    const result = await signaling.join(() => {});
    expect(result.peerId).toBe("a");
    expect(result.peers).toEqual([]);
    await signaling.leave();
  });

  it("announces two peers to each other via the roster", async () => {
    const room = makeRoom();
    const a = room.makeSignaling("a").signaling;
    const b = room.makeSignaling("b").signaling;
    const aRosters: string[][] = [];
    const bRosters: string[][] = [];

    await a.join((roster) => aRosters.push(roster));
    await b.join((roster) => bRosters.push(roster));

    // b's join wrote its presence; a's poll observes b appear.
    await a.tick();
    expect(aRosters).toContainEqual(["b"]);
    // a's join wrote its presence; b's poll observes a appear.
    await b.tick();
    expect(bRosters).toContainEqual(["a"]);

    await a.leave();
    await b.leave();
  });

  it("delivers a signal once and does not re-deliver it on later ticks", async () => {
    const room = makeRoom();
    const a = room.makeSignaling("a").signaling;
    const b = room.makeSignaling("b").signaling;
    const received: Array<[string, unknown]> = [];

    await a.join(() => {});
    await b.join(() => {});
    b.onSignal((from, signal) => received.push([from, signal]));

    await a.sendSignal("b", { type: "offer", sdp: "sdp-a" });
    await b.tick();
    expect(received).toEqual([["a", { type: "offer", sdp: "sdp-a" }]]);

    // Further ticks must not re-deliver the same outbox entry (at-least-once, deduped).
    await b.tick();
    await b.tick();
    expect(received).toHaveLength(1);

    await a.leave();
    await b.leave();
  });

  it("prunes a signal from the sender's outbox once it is older than the signal TTL", async () => {
    const room = makeRoom();
    const a = room.makeSignaling("a", { signalTtlMs: 1000 });
    const b = room.makeSignaling("b").signaling;
    const received: unknown[] = [];

    await a.signaling.join(() => {});
    await b.join(() => {});
    b.onSignal((_from, signal) => received.push(signal));

    await a.signaling.sendSignal("b", "s1");
    await b.tick();
    expect(received).toHaveLength(1);

    // Advance past the signal TTL and let a refresh its presence: the stale
    // signal is dropped from a's outbox.
    room.clock.t += 2000;
    await a.signaling.tick();
    const aRecord = await a.store.readPeer("a");
    expect(aRecord?.outbox.map((s) => s.payload)).toEqual([]);

    await a.signaling.leave();
    await b.leave();
  });

  it("drops a peer from the roster once its presence file is older than the presence TTL", async () => {
    const room = makeRoom();
    const a = room.makeSignaling("a", { presenceTtlMs: 1000 }).signaling;
    const b = room.makeSignaling("b", { presenceTtlMs: 1000 }).signaling;
    const aRosters: string[][] = [];

    await a.join((roster) => aRosters.push(roster));
    await b.join(() => {});
    await a.tick();
    expect(aRosters).toContainEqual(["b"]);

    // b goes quiet; advance past the presence TTL without b rewriting.
    room.clock.t += 2000;
    await a.tick();
    expect(aRosters.at(-1)).toEqual([]);

    // b reappears when it writes presence again.
    await b.tick();
    await a.tick();
    expect(aRosters.at(-1)).toEqual(["b"]);

    await a.leave();
    await b.leave();
  });

  it("removes own presence on leave so peers see the departure", async () => {
    const room = makeRoom();
    const a = room.makeSignaling("a").signaling;
    const b = room.makeSignaling("b").signaling;
    const bRosters: string[][] = [];

    await a.join(() => {});
    await b.join((roster) => bRosters.push(roster));
    await b.tick();
    expect(bRosters).toContainEqual(["a"]);

    await a.leave();
    await b.tick();
    expect(bRosters.at(-1)).toEqual([]);

    await b.leave();
  });
});
