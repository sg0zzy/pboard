/**
 * An idle Drive signaling room must stop paying the fast poll's Drive traffic.
 * A room whose roster has been empty since the join rewrote its presence every
 * `pollMs` forever: two idle browsers each burned a Drive round trip every two
 * seconds per collection room, keeping the extension busy while nothing could
 * arrive. After `idleSlowMs` without a live peer, a delivered signal or an
 * outbound signal, the poll drops to `maxPollMs` — still well inside the
 * presence TTL, so two idle peers still find each other — and any activity
 * returns the room to the fast cadence on the very next schedule.
 *
 * The poll timer and the store's injected clock are advanced in lockstep, so
 * the counted writes are exactly the polls that ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type PboardDriveSignalRecord, type PboardDriveSignalStore, createDriveSignaling } from "../../src/collab/signaling";

function makeClock(initial = 10_000) {
  let clock = initial;
  return { now: () => clock, advance: (ms: number) => { clock += ms; } };
}

/** A shared in-memory record map standing in for one room's `realtime/` folder. */
function makeRoom() {
  const clock = makeClock();
  const records = new Map<string, PboardDriveSignalRecord>();
  const clone = (record: PboardDriveSignalRecord): PboardDriveSignalRecord => JSON.parse(JSON.stringify(record)) as PboardDriveSignalRecord;
  let writes = 0;
  function makeStore(peerId: string): PboardDriveSignalStore {
    return {
      peerId,
      now: clock.now,
      readPeer: async (id) => (records.has(id) ? clone(records.get(id)!) : null),
      writeOwn: async (record) => { writes += 1; records.set(peerId, clone(record)); },
      listPeers: async () => Object.fromEntries(Array.from(records.entries(), ([id, record]) => [id, clone(record)])),
      deleteOwn: async () => { records.delete(peerId); }
    };
  }
  return {
    clock,
    writes: () => writes,
    makeStore,
    seed: (peerId: string, record: PboardDriveSignalRecord) => { records.set(peerId, clone(record)); }
  };
}

describe("idle Drive signaling backoff", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  // eslint-disable-next-line no-empty-pattern
  it("drops an empty room to the slow cadence and returns to the fast one when a peer appears", async () => {
    const room = makeRoom();
    const signaling = createDriveSignaling({
      store: room.makeStore("me"),
      pollMs: 1_000,
      maxPollMs: 15_000,
      idleSlowMs: 5_000,
      presenceTtlMs: 60_000
    });
    try {
      await signaling.join(() => {});
      expect(room.writes()).toBe(1); // join's own presence write

      // Fast cadence while the room is young: one poll per second at t=1..5s.
      for (let step = 0; step < 5; step++) {
        room.clock.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(room.writes()).toBe(6);

      // After the idle boundary the next schedule waits the full slow interval.
      for (let step = 0; step < 14; step++) {
        room.clock.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(room.writes()).toBe(6); // t=6..19s: no polls, no Drive traffic

      // The slow poll at t=20s is the only traffic; the next waits a full interval.
      room.clock.advance(1_000); // t=20s
      await vi.advanceTimersByTimeAsync(1_000);
      expect(room.writes()).toBe(7); // one poll in the fifteen slow seconds
      for (let step = 0; step < 14; step++) {
        room.clock.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(room.writes()).toBe(7); // and nothing again until the next slow interval
    } finally {
      await signaling.leave();
      vi.useRealTimers();
    }
  });

  it("a live peer keeps the room on the fast cadence and any delivered signal does too", async () => {
    const room = makeRoom();
    let idleWrites = 0;
    const store = room.makeStore("me");
    const signaling = createDriveSignaling({
      store,
      pollMs: 1_000,
      maxPollMs: 15_000,
      idleSlowMs: 5_000,
      presenceTtlMs: 60_000
    });
    const received: string[] = [];
    signaling.onSignal((from) => received.push(from));
    try {
      await signaling.join(() => {});
      // Seed a live peer before the idle boundary: the roster keeps activity fresh.
      room.seed("other", { updatedAt: room.clock.now(), peers: [], outbox: [] });
      for (let step = 0; step < 10; step++) {
        room.clock.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(room.writes()).toBe(11); // join + ten fast polls: the peer held the cadence
      idleWrites = room.writes();

      // The peer disappears (stale presence); the room idles out and slows down.
      room.seed("other", { updatedAt: room.clock.now() - 120_000, peers: [], outbox: [] });
      for (let step = 0; step < 5; step++) {
        room.clock.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const afterIdle = room.writes();
      for (let step = 0; step < 10; step++) {
        room.clock.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      // Only the single slow poll ran in ten seconds of idle emptiness.
      expect(room.writes() - afterIdle).toBeLessThanOrEqual(1);

      // An outbound signal re-arms the fast cadence immediately.
      const before = room.writes();
      await signaling.sendSignal("other", { type: "offer" } as never);
      for (let step = 0; step < 6; step++) {
        room.clock.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(room.writes() - before).toBeGreaterThanOrEqual(6); // send + six fast polls
      expect(idleWrites).toBeGreaterThan(0);
    } finally {
      await signaling.leave();
      vi.useRealTimers();
    }
  });
});
