/**
 * The Drive-hosted presence store is the product's largest *recurring* quota
 * consumer: with a board open, the poll loop runs every two seconds per room,
 * and each poll used to spend a name lookup, a download of the session's own
 * record, an upload, a roster listing and a download of every presence file
 * (including its own and the ones left behind by sessions that died without
 * deleting anything). At Google's documented prices — 100 units for a listing,
 * 200 for a download, 50 for a write — one room cost roughly 950 units every two
 * seconds, which is what tipped a normal editing session into
 * `403 rateLimitExceeded / Units per minute per user`.
 *
 * The rules these tests pin:
 *   - the session's own presence file is remembered (id + body), never re-read;
 *   - a peer record is re-downloaded when its `modifiedTime` moved, or after the
 *     re-read window, so a same-second write is delayed but never lost;
 *   - a presence file that has not been rewritten while the room's newest moved
 *     on by two TTLs is a dead session and is never downloaded again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDriveSignalStore,
  type DriveFileRef,
  type DrivePermissionTransport,
  type DriveSharedProjectStore
} from "../src/sync/drivePermissions";
import type { PboardDriveSignalRecord } from "../src/collab/signaling";
import { driveHttpError } from "../src/sync/driveHttp";

type FakeFile = { id: string; name: string; contents: string; modifiedTime: number };

/**
 * A Drive that stamps every write with its own clock. `driveTime` is Drive's
 * wall clock (what `modifiedTime` reports) and is advanced by the test; the
 * store's `now` is a separate clock, because the poll loop's notion of time is
 * not Drive's.
 */
function makeRoom(options: { presenceTtlMs?: number; start?: number } = {}) {
  const drive = { t: options.start ?? Date.parse("2026-01-01T00:00:00.000Z") };
  const store = { t: 0 };
  const files = new Map<string, FakeFile>();
  const calls = { find: 0, list: 0, download: 0, upload: 0, create: 0, delete: 0 };
  const failNextUpload = { error: null as unknown };
  /** One injected failure for the next listing/download: a resource Drive stops
   * serving in the middle of a poll (a presence file deleted as its session
   * left, a folder removed since this session resolved its id). */
  const failNext = { list: null as unknown, download: null as unknown, delete: null as unknown };
  let seq = 0;

  const toRef = (file: FakeFile): DriveFileRef => ({
    id: file.id,
    name: file.name,
    mimeType: "application/json",
    modifiedTime: new Date(file.modifiedTime).toISOString(),
    parents: ["rt"]
  });

  const transport = {
    findFile: vi.fn(async (name: string) => {
      calls.find += 1;
      const found = [...files.values()].find((file) => file.name === name);
      return found ? toRef(found) : null;
    }),
    listFiles: vi.fn(async () => {
      calls.list += 1;
      if (failNext.list !== null) { const error = failNext.list; failNext.list = null; throw error; }
      return [...files.values()].map(toRef);
    }),
    downloadFile: vi.fn(async (fileId: string) => {
      calls.download += 1;
      if (failNext.download !== null) { const error = failNext.download; failNext.download = null; throw error; }
      const found = files.get(fileId);
      if (!found) throw new Error("404 not found");
      return found.contents;
    }),
    uploadJsonFile: vi.fn(async (fileId: string, contents: string) => {
      if (failNextUpload.error !== null) {
        const error = failNextUpload.error;
        failNextUpload.error = null;
        throw error;
      }
      calls.upload += 1;
      const found = files.get(fileId);
      // Drive's answer for an id it does not have, so a write is tested against
      // the failure the client actually sees rather than a convenience error.
      if (!found) throw driveHttpError(404, `Google Drive request failed (404): notFound: File not found: ${fileId}.`);
      found.contents = contents;
      drive.t += 1_000;
      found.modifiedTime = drive.t;
      return toRef(found);
    }),
    createJsonFile: vi.fn(async (name: string, _parentId: string, contents: string) => {
      calls.create += 1;
      drive.t += 1_000;
      const file: FakeFile = { id: `f-${++seq}`, name, contents, modifiedTime: drive.t };
      files.set(file.id, file);
      return toRef(file);
    }),
    deleteFile: vi.fn(async (fileId: string) => {
      calls.delete += 1;
      if (failNext.delete !== null) { const error = failNext.delete; failNext.delete = null; throw error; }
      files.delete(fileId);
    })
  } as unknown as DrivePermissionTransport;

  const sharedProjects = { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as unknown as DriveSharedProjectStore;

  /** A presence file written by somebody else, at the current Drive time. */
  function seedPeer(peerId: string, record: PboardDriveSignalRecord, ageMs = 0) {
    drive.t += 1_000;
    const file: FakeFile = {
      id: `peer-${peerId}`,
      name: `sig-cards-${peerId}.json`,
      contents: JSON.stringify(record),
      modifiedTime: drive.t - ageMs
    };
    files.set(file.id, file);
    return file;
  }

  function build(peerId: string) {
    return createDriveSignalStore({
      transport,
      sharedProjects,
      projectId: "p1",
      peerId,
      topic: "cards",
      realtimeFolderId: vi.fn().mockResolvedValue("rt"),
      now: () => store.t,
      ...(options.presenceTtlMs === undefined ? {} : { presenceTtlMs: options.presenceTtlMs })
    });
  }

  return {
    drive, store, files, calls, transport, failNextUpload, failNext, seedPeer, build,
    /** What the next poll would see as the record's contents. */
    contentsOf: (peerId: string) => JSON.parse(files.get(`peer-${peerId}`)?.contents ?? files.get("f-1")?.contents ?? "null")
  };
}

const record = (updatedAt: number, extra: Partial<PboardDriveSignalRecord> = {}): PboardDriveSignalRecord => ({
  updatedAt, peers: [], outbox: [], ...extra
});

describe("Drive presence store request cost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("recreates its own presence file when Drive no longer serves it", async () => {
    // A collaborator's cleanup, or this client's own expiry, can remove a presence
    // file while Drive's listing still names it. Writing to the remembered id then
    // answers 404, and the failure used to leave `writeOwn` — so it escaped
    // `join()`, closed the room, and the retry resolved the *same* dead id from a
    // listing that had not caught up: the console filled with `uploadJsonFile`
    // 404s for file after file while no room started at all.
    const room = makeRoom();
    const store = room.build("me");
    await store.writeOwn(record(1));
    const created = room.calls.create;
    const mine = [...room.files.values()].find((file) => file.name === "sig-cards-me.json")!;
    room.files.delete(mine.id); // removed behind the store's back

    await expect(store.writeOwn(record(2))).resolves.toBeUndefined();
    expect(room.calls.create).toBe(created + 1);
    const rewritten = [...room.files.values()].find((file) => file.name === "sig-cards-me.json")!;
    expect(JSON.parse(rewritten.contents).updatedAt).toBe(2);

    // And the poll no longer names the file it cannot serve.
    expect(Object.keys(await store.listPeers())).toEqual(["me"]);
  });

  it("remembers its own presence file instead of resolving and downloading it every poll", async () => {
    const room = makeRoom();
    const store = room.build("me");

    await store.writeOwn(record(0));
    const afterFirstWrite = { ...room.calls };
    expect(afterFirstWrite.find).toBe(1); // the one name lookup that created the file
    expect(afterFirstWrite.create).toBe(1);

    // Three more polls: the roster listing is unavoidable, but our own file is
    // already known by id and already holds what we wrote.
    for (let poll = 0; poll < 3; poll++) await store.listPeers();
    expect(room.calls.list).toBe(afterFirstWrite.list + 3);
    expect(room.calls.find).toBe(afterFirstWrite.find);
    expect(room.calls.download).toBe(afterFirstWrite.download);

    // The heartbeat rewrite reuses the remembered id: a write, never a lookup.
    await store.writeOwn(record(1));
    expect(room.calls.upload).toBe(1);
    expect(room.calls.find).toBe(afterFirstWrite.find);
  });

  it("serves the poll's own-record read without a Drive request, while readPeer stays Drive truth", async () => {
    const room = makeRoom();
    const store = room.build("me");
    expect(store.ownRecord?.()).toBeNull(); // nothing written yet
    await store.writeOwn(record(5, { peers: ["x"], outbox: [] }));

    // What the poll loop asks for every tick: the body this session wrote.
    const before = { ...room.calls };
    expect(store.ownRecord?.()).toEqual(record(5, { peers: ["x"] }));
    expect(room.calls).toEqual(before);

    // `readPeer` makes no such promise, and must not lie about Drive: a file
    // edited or deleted behind our back reads as it actually is.
    expect(await store.readPeer("me")).toEqual(record(5, { peers: ["x"] }));
    const own = [...room.files.values()].find((file) => file.name === "sig-cards-me.json")!;
    own.contents = "{ broken";
    expect(await store.readPeer("me")).toBeNull();
    room.seedPeer("other", record(7));
    expect(await store.readPeer("other")).toEqual(record(7));
  });

  it("re-downloads a peer record only when its modification time moved", async () => {
    const room = makeRoom();
    const store = room.build("me");
    const peer = room.seedPeer("other", record(1));

    expect(await store.listPeers()).toEqual({ other: record(1) });
    expect(room.calls.download).toBe(1);
    await store.listPeers();
    await store.listPeers();
    expect(room.calls.download).toBe(1); // unchanged listing, nothing fetched

    // The peer rewrote its record within the same Drive second…
    peer.contents = JSON.stringify(record(2, { peers: ["me"] }));
    peer.modifiedTime = room.drive.t;
    await store.listPeers();
    expect(room.calls.download).toBe(1); // …indistinguishable from the listing
    // …so the bounded re-read window picks it up rather than losing it.
    room.store.t += 15_000;
    expect(await store.listPeers()).toEqual({ other: record(2, { peers: ["me"] }) });
    expect(room.calls.download).toBe(2);
  });

  it("never downloads a presence file whose session is gone, not even once", async () => {
    const room = makeRoom({ presenceTtlMs: 60_000 });
    const store = room.build("me");
    room.seedPeer("live", record(1));
    // A session that died: its file has not been rewritten while the room moved on.
    const dead = room.seedPeer("dead", record(2), 200_000);

    const first = await store.listPeers();
    // The dead session is not fetched even on the cold first poll: its record is
    // past the presence TTL, so the caller would discard it.
    expect(Object.keys(first)).toEqual(["live"]);
    expect(room.calls.download).toBe(1);

    // The live peer keeps rewriting; the dead file never changes again.
    for (let poll = 0; poll < 5; poll++) {
      room.store.t += 2_000;
      const live = [...room.files.values()].find((file) => file.name === "sig-cards-live.json")!;
      live.modifiedTime = room.drive.t + 1_000;
      room.drive.t += 1_000;
      live.contents = JSON.stringify(record(poll + 3));
      expect((await store.listPeers()).dead).toBeUndefined();
    }
    // One fetch per poll for the live file, whose modification time really moved;
    // none for the dead one, whose contents the poll never needs.
    expect(room.calls.download).toBe(1 + 5);
    // Ignored, and left in place: the room's removal waits well past this, because
    // a throttled collaborator can be silent this long while entirely alive.
    expect(dead.contents).toBeTruthy();
  });

  it("removes a presence file whose session left, without being asked", async () => {
    // Ignoring a dead session's record saved the download but not the room: the
    // folder is shared by every browser that ever opened the board, so an
    // abandoned file went on being listed, role-checked and offered to on every
    // pass of every reader. A folder of them is how a two-browser room spent its
    // Drive quota and its peer negotiation on sessions that had already closed,
    // and never reached the browser it was looking for.
    const room = makeRoom({ presenceTtlMs: 60_000 });
    const store = room.build("me");
    room.seedPeer("live", record(1));
    // Past every window a throttled collaborator could be quiet in — see the
    // margin the store documents — so its owner is not coming back.
    room.seedPeer("abandoned", record(2), 400_000);

    expect(Object.keys(await store.listPeers())).toEqual(["live"]);
    expect(room.calls.delete).toBe(1);
    expect([...room.files.values()].map((file) => file.name)).toEqual(["sig-cards-live.json"]);

    // The live session keeps rewriting, the poll keeps running, and the removal is
    // not repeated for a file the listing no longer names.
    for (let poll = 0; poll < 4; poll++) {
      room.store.t += 2_000;
      const live = [...room.files.values()].find((file) => file.name === "sig-cards-live.json")!;
      live.modifiedTime = room.drive.t + 1_000;
      room.drive.t += 1_000;
      live.contents = JSON.stringify(record(poll + 3));
      expect(Object.keys(await store.listPeers())).toEqual(["live"]);
    }
    expect(room.calls.delete).toBe(1);
  });

  it("asks Drive to remove an abandoned presence file once, not every poll", async () => {
    // A file this account may not delete answers 403 forever. The room has to
    // remember it tried, or every poll of every reader pays for the same refusal.
    const room = makeRoom({ presenceTtlMs: 60_000 });
    const store = room.build("me");
    room.seedPeer("live", record(1));
    room.seedPeer("frozen", record(2), 400_000);
    room.failNext.delete = driveHttpError(403, "Google Drive request failed (403): permissionDenied");

    expect(Object.keys(await store.listPeers())).toEqual(["live"]);
    expect(room.calls.delete).toBe(1);
    expect(room.files.get("peer-frozen")).toBeTruthy(); // Drive said no

    for (let poll = 0; poll < 3; poll++) {
      room.store.t += 2_000;
      expect(Object.keys(await store.listPeers())).toEqual(["live"]);
    }
    expect(room.calls.delete).toBe(1);
  });

  it("forgets its own file id when a write fails, so the next poll re-resolves", async () => {
    const room = makeRoom();
    const store = room.build("me");
    await store.writeOwn(record(1));
    const findsAfterFirstWrite = room.calls.find;

    room.failNextUpload.error = new Error("404 file not found");
    await expect(store.writeOwn(record(2))).rejects.toThrow(/404/);

    // The remembered id is suspect now: the next write resolves the name again.
    await store.writeOwn(record(3));
    expect(room.calls.find).toBe(findsAfterFirstWrite + 1);
    expect(room.contentsOf("me")).toEqual(record(3));
    expect(room.calls.upload).toBe(1); // the file still exists, so it is updated, not recreated
    expect(room.calls.create).toBe(1);
  });

  it("stops tracking a presence file that disappears from the listing", async () => {
    const room = makeRoom();
    const store = room.build("me");
    const peer = room.seedPeer("other", record(1));
    expect(Object.keys(await store.listPeers())).toEqual(["other"]);

    room.files.delete(peer.id);
    expect(await store.listPeers()).toEqual({});

    // A file reappearing under the same id is unknown to us: it is read again.
    room.files.set(peer.id, { ...peer, contents: JSON.stringify(record(9)), modifiedTime: room.drive.t + 5_000 });
    room.drive.t += 5_000;
    expect(await store.listPeers()).toEqual({ other: record(9) });
    expect(room.calls.download).toBe(2);
  });

  it("deletes the remembered file and forgets it, without another lookup", async () => {
    const room = makeRoom();
    const store = room.build("me");
    await store.writeOwn(record(1));
    const findsBeforeDelete = room.calls.find;

    await store.deleteOwn();
    expect(room.calls.delete).toBe(1);
    expect(room.calls.find).toBe(findsBeforeDelete);
    expect(room.files.size).toBe(0);
    expect(store.ownRecord?.()).toBeNull();

    // Idempotent, and with nothing remembered it goes back to resolving by name.
    await store.deleteOwn();
    expect(room.calls.delete).toBe(1);
    expect(room.calls.find).toBe(findsBeforeDelete + 1);
  });

  it("treats a presence folder Drive no longer has as an empty room", async () => {
    const room = makeRoom();
    const store = room.build("me");
    room.seedPeer("live", record(1));
    expect(Object.keys(await store.listPeers())).toEqual(["live"]);

    // The folder was removed after this session resolved its id. Every peer is
    // then invisible — the same answer as an empty roster — and a poll that
    // rejected instead would stop the room from starting at all.
    room.failNext.list = driveHttpError(404, "Google Drive request failed (404): fileNotFound");
    await expect(store.listPeers()).resolves.toEqual({});
    // Recovered by itself, from the next listing.
    expect(Object.keys(await store.listPeers())).toEqual(["live"]);
    // Only a missing resource degrades: any other listing failure still surfaces.
    room.failNext.list = driveHttpError(500, "Google Drive request failed (500)");
    await expect(store.listPeers()).rejects.toThrow(/500/);
  });

  it("asks Drive once for a presence file it lists but cannot serve", async () => {
    const room = makeRoom();
    const store = room.build("me");
    room.seedPeer("ghost", record(1));
    room.seedPeer("staying", record(2));
    // The listing named the file; Drive cannot serve it — deleted as its session
    // left — and goes on naming it in the next listing too. Its record is
    // unknowable, so it is asked for once and the roster carries the peer that
    // can be read.
    room.failNext.download = driveHttpError(404, "Google Drive request failed (404): fileNotFound");
    expect(Object.keys(await store.listPeers())).toEqual(["staying"]);
    const asked = room.calls.download;
    for (let poll = 0; poll < 4; poll++) {
      room.store.t += 2_000;
      expect(Object.keys(await store.listPeers()).sort()).toEqual(["staying"]);
    }
    // Repeating the request would change nothing: Drive's answer about an id it
    // has deleted does not change, and each repetition cost a download.
    expect(room.calls.download).toBe(asked);
  });

  it("re-asks a retired presence file a few times, then removes it", async () => {
    // The folder holds the other browsers' live sessions, so one failed read must
    // not exclude a peer for the rest of the session; an abandoned file must not
    // be re-read every poll either. A small budget, spaced a minute apart — and
    // then the file is removed, because this budget lives in memory and the
    // folder is shared by every browser that ever opened the board, so a room
    // with a graveyard paid for it again on every reload.
    const room = makeRoom();
    const store = room.build("me");
    room.seedPeer("ghost", record(1));
    const ask = async () => {
      room.failNext.download = driveHttpError(404, "Google Drive request failed (404): fileNotFound");
      room.store.t += 60_000; // past the retirement window, and stale the cache
      const before = room.calls.download;
      await store.listPeers();
      return room.calls.download - before;
    };
    expect(Object.keys(await store.listPeers())).toEqual(["ghost"]); // first read succeeded
    const asked = room.calls.download;
    room.files.get("peer-ghost")!.modifiedTime += 1_000;
    expect(await ask()).toBe(1); // the 404 that retires it
    expect(await ask()).toBe(1); // re-asked once
    expect(await ask()).toBe(1); // and once more, which spends the budget
    expect(room.calls.delete).toBe(1); // the file Drive cannot serve is removed
    for (let poll = 0; poll < 3; poll++) {
      room.store.t += 60_000;
      await store.listPeers(); // the listing no longer names it
    }
    expect(room.calls.download - asked).toBe(3);
    expect(await store.listPeers()).toEqual({});
  });

  it("retires a peer whose presence file Drive stopped serving", async () => {
    const room = makeRoom();
    const store = room.build("me");
    const ghost = room.seedPeer("ghost", record(1));
    expect((await store.listPeers()).ghost).toBeTruthy(); // read while it existed

    // The session deleted the file; Drive's listing is still naming it, and it
    // will keep naming it. Its last record is known — serving it would keep the
    // phantom peer in the roster, where the caller's role lookup would go back
    // to the same unreadable file on every pass — so the peer is dropped.
    ghost.modifiedTime += 60_000; // the cache is stale, so the poll reads again
    room.failNext.download = driveHttpError(404, "Google Drive request failed (404): fileNotFound");
    expect(Object.keys(await store.listPeers())).toEqual([]);
    for (let poll = 0; poll < 3; poll++) {
      room.store.t += 2_000;
      expect(Object.keys(await store.listPeers())).toEqual([]);
    }
  });
});
