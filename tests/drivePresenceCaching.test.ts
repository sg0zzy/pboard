import { expect, it, vi } from 'vitest';
import { createDriveSignalStore } from '../src/sync/drivePermissions';

function fakeTransport(files: { id: string; name: string; modifiedTime: string }[]) {
  let clock = 0;
  const downloads: string[] = [];
  const transport = {
    listFiles: vi.fn(async () => files.map(f => ({ ...f }))),
    downloadFile: vi.fn(async (id: string) => {
      downloads.push(id);
      clock += 1;
      return JSON.stringify({ updatedAt: Date.now(), peers: [], outbox: [] });
    }),
    findFile: vi.fn(async (name: string, _folder: string) => files.find(f => f.name === name) ?? null),
    uploadJsonFile: vi.fn(async (id: string) => ({ id, name: files.find(f => f.id === id)?.name ?? "", modifiedTime: "m" })),
    createJsonFile: vi.fn(async () => ({ id: "new", name: "x", modifiedTime: "m" })),
    deleteFile: vi.fn(async () => {}),
  };
  return { transport, downloads };
}

it('does not re-download a peer record whose modifiedTime has not moved', async () => {
  let now = Date.now();
  const fresh = new Date().toISOString();
  const files = [
    { id: "self", name: "sig-t-self.json", modifiedTime: fresh },
    { id: "peer", name: "sig-t-other.json", modifiedTime: fresh },
  ];
  const { transport, downloads } = fakeTransport(files);
  const store = createDriveSignalStore({
    transport: transport as never, sharedProjects: { get: async () => ({ folderId: "f" }) } as never,
    projectId: "p", peerId: "self", topic: "t", realtimeFolderId: async () => "f",
    now: () => now,
  });
  const first = await store.listPeers();
  const afterFirst = downloads.length;
  // several polls inside rereadMs
  for (let i = 0; i < 3; i += 1) { now += 500; await store.listPeers(); }
  const afterPolls = downloads.length;
  // one poll after the reread window (rereadMs is presenceTtl/4 = 15s by default)
  now += 20_000; await store.listPeers();
  expect({ afterFirst, afterPolls, total: downloads.length }).toEqual({ afterFirst, afterPolls, total: afterPolls + 2 });
});

it('stabilises downloads for two peers across many polls', async () => {
  let now = Date.now();
  const files = [
    { id: "a", name: "sig-t-a.json", modifiedTime: "2026-01-01T00:00:00.000Z" },
    { id: "b", name: "sig-t-b.json", modifiedTime: "2026-01-01T00:00:00.000Z" },
  ];
  const { transport, downloads } = fakeTransport(files);
  const store = createDriveSignalStore({
    transport: transport as never, sharedProjects: { get: async () => ({ folderId: "f" }) } as never,
    projectId: "p", peerId: "a", topic: "t", realtimeFolderId: async () => "f",
    now: () => now,
  });
  const perPoll: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const before = downloads.length;
    await store.listPeers();
    perPoll.push(downloads.length - before);
    now += 500; // 2s poll cadence, well inside rereadMs
  }
  console.log("perPoll", JSON.stringify(perPoll));
  expect(perPoll.slice(1)).toEqual([0, 0, 0, 0, 0]);
});

it('serves our own record through the cached path when another context wrote it', async () => {
  // readOwn() prefers ownRecord() — the copy this session wrote — and only falls
  // back to readPeer(me). A sidebar and a background worker both open the same
  // room, and each polls readOwn() on every tick; the one that did not write the
  // file pays a 200-unit media download per tick for a record it mostly already
  // knows. Measured on a live profile: ~1.7 such downloads per second, forever.
  let now = Date.now();
  const files = [{ id: "s", name: "sig-t-self.json", modifiedTime: new Date().toISOString() }];
  const { transport, downloads } = fakeTransport(files);
  const store = createDriveSignalStore({
    transport: transport as never, sharedProjects: { get: async () => ({ folderId: "f" }) } as never,
    projectId: "p", peerId: "self", topic: "t", realtimeFolderId: async () => "f",
    now: () => now,
  });
  const before = downloads.length;
  for (let i = 0; i < 10; i += 1) { await store.readOwnCached!(); now += 100; }
  // One download, then cached: unchanged `modifiedTime` and inside `rereadMs`.
  expect(downloads.length - before).toBe(1);
  // `readPeer` keeps its faithful-read contract and stays uncached.
  const faithful = downloads.length;
  for (let i = 0; i < 3; i += 1) { await store.readPeer("self"); now += 100; }
  expect(downloads.length - faithful).toBe(3);
});
