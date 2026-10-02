/**
 * Drive-backed signaling (`createDriveSignaling` and the `PboardDriveSignalStore`
 * behind it) plus the two-peer `PboardSignaling` contract every transport must
 * satisfy. The Drive seam is driven with an in-memory record store and an injected
 * clock; the memory scope is driven in-process. The shipped WebRTC path is
 * covered end-to-end in `collaborationManager.test.ts`.
 *
 * Every scenario uses a long `pollMs` (3.6h) so only an explicit `tick()` drives
 * presence/TTL behavior, and `leave()` is always awaited after each scenario —
 * each `join()` schedules a single pending poll timer, and `leave()` clears it
 * so no real timers outlive the test.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type PboardDriveSignalRecord,
  type PboardDriveSignalStore,
  type PboardDriveSignaling,
  type PboardDriveSignalingOptions,
  createDriveSignaling,
  createMemorySignalingScope,
} from "../src/collab/signaling";
import {
  type DriveFileRef,
  type DrivePermissionTransport,
  type DriveSharedProjectStore,
  createDriveSignalStore,
} from "../src/sync/drivePermissions";

type SignalReceiver = { from: string; payload: { kind: number } }[];

/**
 * A factory of `PboardDriveSignalStore` doubles backed by one shared in-memory
 * record map plus an injected clock. One store per peer; the shared map stands
 * in for the shared `realtime/` folder (each peer writes only its own file).
 */
type FakeRecordStoreFactory = {
  makeStore: (peerId: string) => PboardDriveSignalStore;
  now: () => number;
  advance: (ms: number) => void;
  seed: (peerId: string, record: PboardDriveSignalRecord) => void;
  state: () => Map<string, PboardDriveSignalRecord>;
};

function makeFakeRecordStoreFactory(): FakeRecordStoreFactory {
  let clock = 10_000;
  const records = new Map<string, PboardDriveSignalRecord>();

  function cloneRecord(record: PboardDriveSignalRecord): PboardDriveSignalRecord {
    const copy = JSON.parse(JSON.stringify(record)) as PboardDriveSignalRecord;
    return copy;
  }

  function storeFor(peerId: string): PboardDriveSignalStore {
    const readPeer = (id: string): Promise<PboardDriveSignalRecord | null> =>
      Promise.resolve(records.has(id) ? cloneRecord(records.get(id)!) : null);

    const writeOwn = (record: PboardDriveSignalRecord): Promise<void> => {
      records.set(peerId, cloneRecord(record));
      return Promise.resolve();
    };

    const listPeers = (): Promise<Record<string, PboardDriveSignalRecord>> =>
      Promise.resolve(Object.fromEntries(Array.from(records.entries())));

    const deleteOwn = (): Promise<void> => {
      records.delete(peerId);
      return Promise.resolve();
    };

    return {
      peerId,
      now: () => clock,
      readPeer,
      writeOwn,
      listPeers,
      deleteOwn,
    };
  }

  return {
    makeStore: storeFor,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    seed: (peerId: string, record: PboardDriveSignalRecord) => {
      records.set(peerId, cloneRecord(record));
    },
    state: () => new Map(records),
  };
}

function makeDriveSignaling(
  factory: FakeRecordStoreFactory,
  peerId: string,
  overrides?: Partial<PboardDriveSignalingOptions>,
): PboardDriveSignaling {
  const store = factory.makeStore(peerId);
  return createDriveSignaling({
    store,
    pollMs: 3_600_000,
    presenceTtlMs: 60_000,
    signalTtlMs: 240_000,
    ...overrides,
  });
}

/**
 * A minimal `DrivePermissionTransport` double backed by an in-memory file map.
 * Only the methods `createDriveSignalStore` uses are modeled (find/create/
 * upload/download/list/delete); the rest are stubs. `findFile` matches by name
 * only, so a single `realtime/` folder id is sufficient.
 */
type FakeFile = { id: string; name: string; contents: string };

function makeClock(initial = 10_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function toRef(f: FakeFile): DriveFileRef {
  return { id: f.id, name: f.name, mimeType: "application/json" };
}

function makeFakeTransport() {
  const clock = makeClock();
  const files = new Map<string, FakeFile>();
  let seq = 0;
  const nextId = (): string => `f-${++seq}`;

  function lookup(name: string): FakeFile | null {
    for (const f of files.values()) {
      if (f.name === name) return f;
    }
    return null;
  }

  const transport: DrivePermissionTransport = {
    currentIdentity: vi.fn().mockResolvedValue({ email: "me@example.com" }),
    findSharedRoot: vi.fn().mockResolvedValue(null),
    createFolder: vi.fn(),
    findFile: vi.fn(async (name: string) => {
      const f = lookup(name);
      return f ? toRef(f) : null;
    }),
    createJsonFile: vi.fn(async (name: string, parentId: string, contents: string) => {
      const f: FakeFile = { id: nextId(), name, contents };
      files.set(f.id, f);
      return toRef(f);
    }),
    uploadJsonFile: vi.fn(async (fileId: string, contents: string) => {
      const f = lookupBy(fileId);
      if (!f) throw new Error(`upload to unknown file ${fileId}`);
      f.contents = contents;
      return toRef(f);
    }),
    downloadFile: vi.fn(async (fileId: string) => {
      const f = lookupBy(fileId);
      if (!f) throw new Error(`download unknown file ${fileId}`);
      return f.contents;
    }),
    downloadFileOrNull: vi.fn().mockResolvedValue(null),
    getFile: vi.fn(),
    listFiles: vi.fn(async () => Array.from(files.values()).map(toRef)),
    deleteFile: vi.fn(async (fileId: string) => {
      files.delete(fileId);
    }),
    getFileParents: vi.fn().mockResolvedValue([]),
    listFilesByName: vi.fn().mockResolvedValue([]),
    listPermissions: vi.fn().mockResolvedValue([]),
    createPermission: vi.fn().mockResolvedValue({}),
    updatePermission: vi.fn().mockResolvedValue({}),
    deletePermission: vi.fn().mockResolvedValue(undefined),
  };

  function lookupBy(fileId: string): FakeFile | null {
    const f = files.get(fileId);
    return f ?? null;
  }

  return { transport, files, clock };
}

function buildDriveStore(
  transport: DrivePermissionTransport,
  peerId: string,
  clock: { now: () => number },
) {
  const sharedProjects: DriveSharedProjectStore = {
    get: vi.fn().mockResolvedValue({ folderId: "fld", projectFileId: "proj", realtimeFolderId: "rt" }),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return createDriveSignalStore({
    transport,
    sharedProjects,
    projectId: "p1",
    peerId,
    topic: "cards",
    realtimeFolderId: vi.fn().mockResolvedValue("rt"),
    now: clock.now,
  });
}

function makeDriveStore(peerId: string) {
  const { transport, files, clock } = makeFakeTransport();
  return {
    store: buildDriveStore(transport, peerId, clock),
    transport,
    files,
    clock,
  };
}

function sigOf(files: Map<string, FakeFile>, peerId: string): FakeFile | null {
  const prefix = "sig-cards-";
  const suffix = ".json";
  for (const f of files.values()) {
    if (f.name === prefix + peerId + suffix) return f;
  }
  return null;
}
function mockCallCount(fn: unknown): number {
  const m = fn as { mock: { calls: unknown[] } };
  return m.mock.calls.length;
}

describe("createDriveSignalStore", () => {
  it("round-trips the own record through create/upload and reports the injected clock", async () => {
    const { store, transport, files, clock } = makeDriveStore("a");
    const t0 = clock.now();
    await store.writeOwn({ updatedAt: t0, peers: [], outbox: [] });
    expect(files.size).toBe(1);
    expect(sigOf(files, "a")?.name).toBe("sig-cards-a.json");
    expect(sigOf(files, "a")?.contents).toBe(
      JSON.stringify({ updatedAt: t0, peers: [], outbox: [] }),
    );
    expect(store.peerId).toBe("a");
    expect(await store.readPeer("a")).toEqual({ updatedAt: t0, peers: [], outbox: [] });
    expect(store.now()).toBe(clock.now());
    expect(mockCallCount(transport.createJsonFile)).toBe(1);
    expect(mockCallCount(transport.uploadJsonFile)).toBe(0);
  });

  it("readPeer returns the record when present, null when absent, null when corrupt", async () => {
    const { store, files, clock } = makeDriveStore("a");
    const record: PboardDriveSignalRecord = { updatedAt: clock.now(), peers: ["x"], outbox: [] };
    await store.writeOwn(record);
    expect(await store.readPeer("a")).toEqual(record);
    expect(await store.readPeer("ghost")).toBeNull();
    const f = sigOf(files, "a")!;
    f.contents = "{ broken";
    expect(await store.readPeer("a")).toBeNull();
  });

  it("listPeers filters to the sig prefix, skips corrupt reads, and is owner-independent", async () => {
    const { transport, files, clock } = makeFakeTransport();
    const aStore = buildDriveStore(transport, "a", clock);
    files.set("u1", { id: "u1", name: "project.json", contents: "{}" });
    files.set("g1", {
      id: "g1",
      name: "sig-cards-b.json",
      contents: JSON.stringify({ updatedAt: 1, peers: [], outbox: [] }),
    });
    files.set("bd1", { id: "bd1", name: "sig-cards-c.json", contents: "not json" });
    const peers = await aStore.listPeers();
    expect(Object.keys(peers)).toEqual(["b"]);
    expect(peers.b).toEqual({ updatedAt: 1, peers: [], outbox: [] });
    // The same file is readable from a different peer's store (owner-independent).
    const bStore = buildDriveStore(transport, "b", clock);
    expect(await aStore.readPeer("b")).toEqual({ updatedAt: 1, peers: [], outbox: [] });
    expect(await bStore.readPeer("b")).toEqual({ updatedAt: 1, peers: [], outbox: [] });
  });

  it("deleteOwn removes the own file and is idempotent", async () => {
    const { store, files } = makeDriveStore("a");
    await store.writeOwn({ updatedAt: 1, peers: [], outbox: [] });
    expect(files.size).toBe(1);
    await store.deleteOwn();
    expect(files.size).toBe(0);
    await store.deleteOwn();
    expect(files.size).toBe(0);
    expect(await store.readPeer("a")).toBeNull();
  });

  it("writeOwn creates the file first, then uploads on re-write", async () => {
    const { store, transport } = makeDriveStore("a");
    await store.writeOwn({ updatedAt: 1, peers: ["b"], outbox: [] });
    expect(mockCallCount(transport.createJsonFile)).toBe(1);
    expect(mockCallCount(transport.uploadJsonFile)).toBe(0);
    await store.writeOwn({ updatedAt: 2, peers: ["b", "c"], outbox: [] });
    expect(mockCallCount(transport.createJsonFile)).toBe(1);
    expect(mockCallCount(transport.uploadJsonFile)).toBe(1);
    expect(await store.readPeer("a")).toEqual({ updatedAt: 2, peers: ["b", "c"], outbox: [] });
  });
});

describe("createDriveSignaling", () => {
  it("join emits the current roster and a heartbeat refreshes the peer record", async () => {
    const factory = makeFakeRecordStoreFactory();
    const b = makeDriveSignaling(factory, "b");
    const a = makeDriveSignaling(factory, "a");

    const bInfo = await b.join(() => {});
    expect(bInfo.peerId).toBe("b");
    expect(bInfo.peers).toEqual([]);

    factory.advance(100);
    const aInfo = await a.join();
    expect(aInfo.peerId).toBe("a");
    expect(aInfo.peers).toEqual(["b"]);

    const state = factory.state();
    expect(state.get("a").updatedAt).toBe(factory.now());
    expect(state.get("b").updatedAt).toBe(factory.now() - 100);

    await a.leave();
    await b.leave();
  });

  it("emits a roster change only when the live set changes, drops on TTL, then re-emits on rejoin", async () => {
    const factory = makeFakeRecordStoreFactory();
    const b = makeDriveSignaling(factory, "b", { presenceTtlMs: 5_000 });
    const a = makeDriveSignaling(factory, "a", { presenceTtlMs: 5_000 });
    const bRoster: string[][] = [];
    await b.join((ids) => {
      bRoster.push([...ids]);
    });
    await a.join(() => {});
    await b.tick(); // b sees a -> emits ["a"]
    await b.tick(); // live set unchanged -> no re-emit
    factory.advance(5_000); // a's record is now past the TTL
    await b.tick(); // a drops -> emits []
    factory.advance(5_000);
    await a.tick(); // a re-announces itself (fresh updatedAt)
    await b.tick(); // b sees a again -> emits ["a"]

    expect(bRoster).toEqual([["a"], [], ["a"]]);

    await a.leave();
    await b.leave();
  });

  it("bounds the outbox to the last sixteen signals and dedupes delivery per instance", async () => {
    const factory = makeFakeRecordStoreFactory();
    const b = makeDriveSignaling(factory, "b");
    const a = makeDriveSignaling(factory, "a");
    const bSignals: SignalReceiver = [];
    b.onSignal((from, payload) => {
      bSignals.push({ from, payload: payload as { kind: number } });
    });

    await b.join(() => {});
    await a.join(() => {});
    for (let i = 0; i < 20; i++) {
      await a.sendSignal("b", { kind: i });
    }

    const aInfo = factory.state().get("a")!;
    expect(aInfo.outbox.length).toBe(16);
    expect(aInfo.peers).toEqual(["b"]);
    const kinds = aInfo.outbox.map((s) => s.payload as { kind: number }).map((p) => p.kind);
    expect(kinds).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(aInfo.outbox.every((s) => s.sentAt === factory.now())).toBe(true);

    await b.tick();
    expect(bSignals.length).toBe(16);
    expect(bSignals.map((s) => s.payload.kind)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    await b.tick(); // dedupe: nothing new
    expect(bSignals.length).toBe(16);

    await a.leave();
    await b.leave();
  });

  it("delivers at-least-once across instances from the persistent outbox after a peer leaves", async () => {
    const factory = makeFakeRecordStoreFactory();
    const a = makeDriveSignaling(factory, "a");
    const bFirst = makeDriveSignaling(factory, "b");
    const bSecond = makeDriveSignaling(factory, "b");
    const bFirstSignals: SignalReceiver = [];
    const bSecondSignals: SignalReceiver = [];
    bFirst.onSignal((from, payload) => {
      bFirstSignals.push({ from, payload: payload as { kind: number } });
    });
    bSecond.onSignal((from, payload) => {
      bSecondSignals.push({ from, payload: payload as { kind: number } });
    });

    await a.join(() => {});
    await bFirst.join(() => {});
    await a.sendSignal("b", { kind: 1 });
    await bFirst.tick();
    expect(bFirstSignals).toEqual([{ from: "a", payload: { kind: 1 } }]);

    await bFirst.leave(); // b's record is deleted; a's outbox still persists

    const bSecondInfo = await bSecond.join(() => {});
    // bSecond's join tick reads a's persistent outbox and delivers once.
    expect(bSecondInfo.peers).toEqual(["a"]);
    expect(bSecondSignals.length).toBe(1);
    expect(bSecondSignals[0].from).toBe("a");
    expect(bSecondSignals[0].payload.kind).toBe(1);

    await bSecond.tick(); // dedupe: no double delivery
    expect(bSecondSignals.length).toBe(1);

    await bSecond.leave();
    await a.leave();
  });

  it("prunes stale outbox entries so an expired signal is never delivered", async () => {
    const factory = makeFakeRecordStoreFactory();
    const a = makeDriveSignaling(factory, "a");
    const b = makeDriveSignaling(factory, "b");
    const bSignals: SignalReceiver = [];
    b.onSignal((from, payload) => {
      bSignals.push({ from, payload: payload as { kind: number } });
    });

    const now = factory.now();
    factory.seed("a", {
      updatedAt: now - 5_000,
      peers: [],
      outbox: [
        { id: crypto.randomUUID(), payload: { kind: 99 }, sentAt: now - 2 * 240_000 - 10_000 },
      ],
    });

    await a.join(() => {});
    // a's first tick prunes the expired entry and rewrites an empty outbox.
    const aRecord = factory.state().get("a")!;
    expect(aRecord.outbox.length).toBe(0);
    expect(aRecord.updatedAt).toBe(factory.now());

    await b.join(() => {});
    // b's join tick reads a's pruned (now-empty) outbox -> nothing delivered.
    expect(bSignals.length).toBe(0);
    await b.tick();
    expect(bSignals.length).toBe(0);

    await a.leave();
    await b.leave();
  });

  it("leave deletes the own record and resets state so rejoin re-announces the roster", async () => {
    const factory = makeFakeRecordStoreFactory();
    const b = makeDriveSignaling(factory, "b");
    const a = makeDriveSignaling(factory, "a");
    const bSignals: SignalReceiver = [];
    b.onSignal((from, payload) => {
      bSignals.push({ from, payload: payload as { kind: number } });
    });
    const bRoster: string[][] = [];
    await b.join((ids) => {
      bRoster.push([...ids]);
    });
    await a.join(() => {});
    await a.sendSignal("b", { kind: 1 });
    await b.tick();
    expect(bSignals.length).toBe(1);
    expect(bRoster.at(-1)).toEqual(["a"]);

    await a.leave();
    await b.tick();
    expect(bSignals.length).toBe(1);
    expect(bRoster.at(-1)).toEqual([]);

    const aRoster: string[][] = [];
    await a.join((ids) => {
      aRoster.push([...ids]);
    });
    expect(aRoster).toEqual([["b"]]);

    await b.tick();
    expect(bRoster.at(-1)).toEqual(["a"]);

    await a.leave();
    await b.leave();
  });
});

describe("two-peer seam contract", () => {
  it("memory scope satisfies the two-peer PboardSignaling contract (roster, signal, leave)", async () => {
    const scope = createMemorySignalingScope();
    const b = scope.create("seam-mem");

    const bRoster: string[][] = [];
    const bSignals: SignalReceiver = [];
    b.onSignal((from, payload) => {
      bSignals.push({ from, payload: payload as { kind: number } });
    });
    const bInfo = await b.join((ids) => {
      bRoster.push([...ids]);
    });
    expect(bInfo.peers).toEqual([]);
    expect(bRoster.at(-1)).toEqual([]);

    const a = scope.create("seam-mem");
    const aInfo = await a.join(() => {});
    // The seam hands each peer its id via `join`; two peers in one room
    // get distinct ids and each sees the other in its roster.
    expect(aInfo.peerId).not.toBe(bInfo.peerId);
    expect(aInfo.peers).toEqual([bInfo.peerId]);
    expect(bRoster.at(-1)).toEqual([aInfo.peerId]);

    await a.sendSignal(bInfo.peerId, { kind: 1 });
    expect(bSignals).toEqual([{ from: aInfo.peerId, payload: { kind: 1 } }]);

    a.leave();
    expect(bRoster.at(-1)).toEqual([]);

    b.leave();
  });

  it("drive scope satisfies the two-peer contract, but peers must tick to observe", async () => {
    const factory = makeFakeRecordStoreFactory();
    const b = makeDriveSignaling(factory, "b");
    const a = makeDriveSignaling(factory, "a");

    const bRoster: string[][] = [];
    const bSignals: SignalReceiver = [];
    b.onSignal((from, payload) => {
      bSignals.push({ from, payload: payload as { kind: number } });
    });
    const bInfo = await b.join((ids) => {
      bRoster.push([...ids]);
    });
    expect(bInfo.peerId).toBe("b");
    expect(bInfo.peers).toEqual([]);

    const aInfo = await a.join(() => {});
    expect(aInfo.peerId).toBe("a");
    expect(aInfo.peers).toEqual(["b"]);
    // b does not observe a until its own next tick (Drive has no push);
    // b's initial roster [] is in bInfo.peers, and onRoster only fires for
    // later changes, so no roster callback listing "a" has fired yet.
    expect(bRoster.flat()).not.toContain(aInfo.peerId);

    await b.tick();
    expect(bRoster.at(-1)).toEqual(["a"]);

    await a.sendSignal("b", { kind: 1 });
    await b.tick();
    expect(bSignals).toEqual([{ from: "a", payload: { kind: 1 } }]);
    expect(bRoster.at(-1)).toEqual(["a"]);

    a.leave();
    await b.tick();
    expect(bRoster.at(-1)).toEqual([]);
    expect(bSignals.length).toBe(1);

    await b.leave();
  });
});
