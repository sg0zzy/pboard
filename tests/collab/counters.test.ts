/** The diagnostics ledger driven through the real Drive permission service: the
 * 60-second shared-discovery cache, the authoritative per-resource cost ledger,
 * snapshot immutability, and the production no-op contract. `instrumentFetcher`
 * is the only wiring point for `countDriveCost`, so every assertion drives the
 * service through an instrumented fake fetcher instead of counting directly. */
import { afterEach, expect, it, vi } from "vitest";
// Only the published per-method unit prices are needed at module scope; the
// counters module itself stays lazily loaded below so the diagnostics boundary
// is still exercised.
import * as driveQuotaUnits from "../../src/sync/driveQuota";
import type { GoogleAuthProvider } from "../../src/sync/googleAuth";
import type { DriveSharedProjectRecord, DriveSharedProjectStore } from "../../src/sync/drivePermissions";
import type { CollaborationCountersApi } from "../../src/collab/counters";
import type * as drivePermissions from "../../src/sync/drivePermissions";
import type * as driveQuota from "../../src/sync/driveQuota";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const JSON_MIME = "application/json";
const PROJECT_FILE_NAME = "project.json";
const COST_HEADER = "X-Drive-Request-Cost";
const DISCOVERY_TTL_MS = 60_000;

// `DIAGNOSTICS` is captured when `src/collab/counters` loads, so a static import
// would hoist above the stub and capture `false`; these tests assert the loading
// boundary itself, so the import has to happen after the global is stubbed. The
// type-only imports above are erased, so they do not disturb that boundary.
async function loadBuild(diagnostics: boolean): Promise<Build> {
  vi.stubGlobal("__PBOARD_DIAGNOSTICS__", diagnostics);
  vi.resetModules();
  return {
    counters: (await import("../../src/collab/counters")).collaborationCounters,
    drive: await import("../../src/sync/drivePermissions"),
    quota: await import("../../src/sync/driveQuota")
  };
}

// The build a test drives: the counters singleton plus the two modules whose
// behaviour the harness exercises. A named shape so `loadBuild` publishes a contract.
type Build = {
  counters: CollaborationCountersApi;
  drive: typeof drivePermissions;
  quota: typeof driveQuota;
};
type FakeFile = { id: string; name: string; mimeType: string; parents: string[] };

// Charged cost of one pass over the seeded board set. Google prices a list or a
// search at a flat `DRIVE_UNIT_LIST` whatever the caller projects or the page size
// asks for, and a single-resource read at `DRIVE_UNIT_READ`: the name search and
// the shared-with-me shelf are lists; the two board-folder file references are
// gets. Four priced requests, 210 units — the projection used to call the same
// pass 60, which is why the local ledger never once looked close to Google's
// 325,000 units/minute per-user budget.
const NAME_SEARCH = driveQuotaUnits.DRIVE_UNIT_LIST;
const SHELF_LIST = driveQuotaUnits.DRIVE_UNIT_LIST;
const FILE_REF = driveQuotaUnits.DRIVE_UNIT_READ;
const PASS_PROJECTED = NAME_SEARCH + SHELF_LIST + FILE_REF * 2;
const PASS_BY_RESOURCE = { search: NAME_SEARCH + SHELF_LIST, get: FILE_REF * 2 };

const SEED: FakeFile[] = [
  { id: "board-a", name: "board-a", mimeType: FOLDER_MIME, parents: [] },
  { id: "file-a", name: PROJECT_FILE_NAME, mimeType: JSON_MIME, parents: ["board-a"] },
  { id: "board-b", name: "board-b", mimeType: FOLDER_MIME, parents: [] },
  { id: "file-b", name: PROJECT_FILE_NAME, mimeType: JSON_MIME, parents: ["board-b"] }
];

function makeFakeStore(): DriveSharedProjectStore & { records: Map<string, DriveSharedProjectRecord> } {
  const records = new Map<string, DriveSharedProjectRecord>();
  const empty: DriveSharedProjectRecord = { folderId: null, projectFileId: null, realtimeFolderId: null };
  return {
    records,
    get: async (projectId) => records.get(projectId) ?? { ...empty },
    set: async (projectId, patch) => {
      const current = records.get(projectId) ?? { ...empty };
      records.set(projectId, { ...current, ...patch });
    },
    delete: async (projectId) => { records.delete(projectId); }
  };
}

// In-memory fake Drive. `header` spells the cost header for each request, and
// `get()` answers null when a header is absent. The throttle is passed explicitly
// so the shared singleton's `Date.now()` budget cannot leak between tests.
function makeHarness(build: Build, options: {
  drive?: FakeFile[];
  shelf?: FakeFile[];
  header?: (url: URL) => string | null;
} = {}) {
  const store = makeFakeStore();
  const files = options.drive ?? SEED;
  const shelf = options.shelf ?? [];
  const calls: URL[] = [];
  const auth: GoogleAuthProvider = {
    connect: async () => {},
    disconnect: async () => {},
    getConnectionState: async () => "connected",
    isConfigured: () => true,
    getAccessToken: async () => "drive-token"
  };
  const rawFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const body = respond(url, files, shelf);
    const reported = options.header?.(url) ?? null;
    return {
      status: 200,
      ok: true,
      headers: { get: (name: string) => name === COST_HEADER ? reported : null },
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  };
  const fetcher = build.counters.instrumentFetcher(rawFetch as unknown as typeof fetch);
  const transport = build.drive.createDrivePermissionTransport(
    auth,
    fetcher,
    build.quota.createDriveQuotaThrottle({ sleep: async () => {} })
  );
  const service = build.drive.createDrivePermissionService({
    transport,
    sharedProjects: store,
    readSnapshot: async (projectId) => JSON.stringify({ projectId })
  });
  return { service, store, calls, fetcher, rawFetch };
}

function respond(url: URL, files: FakeFile[], shelf: FakeFile[]): unknown {
  const fields = url.searchParams.get("fields") ?? "";
  if (url.pathname.endsWith("/files")) {
    const q = (url.searchParams.get("q") ?? "").replaceAll("\\", "");
    const name = /name = '([^']*)'/.exec(q)?.[1];
    const mimeType = /mimeType = '([^']*)'/.exec(q)?.[1];
    const parent = /'([^']*)' in parents/.exec(q)?.[1];
    const shared = q.includes("sharedWithMe");
    const matched = (shared ? shelf : files).filter((file) =>
      (name === undefined || file.name === name) &&
      (mimeType === undefined || file.mimeType === mimeType) &&
      (parent === undefined || file.parents.includes(parent)));
    return { files: matched.map((file) => ({ ...file, sharedWithMe: shared })) };
  }
  const file = files.find((entry) => entry.id === url.pathname.split("/").pop());
  if (!file) return null;
  return fields === "parents" ? { id: file.id, parents: file.parents } : file;
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers(); });

it("misses, hits the real 60-second cache, then misses again after invalidation", async () => {
  const build = await loadBuild(true);
  const harness = makeHarness(build);
  vi.useFakeTimers({ toFake: ["Date"] });

  const first = await harness.service.discoverSharedProjects();
  expect(first).toEqual([
    { projectId: "board-a", name: "board-a", fileId: "file-a" },
    { projectId: "board-b", name: "board-b", fileId: "file-b" }
  ]);
  expect(harness.calls).toHaveLength(4);   // name search, two folder lookups, shared-with-me shelf
  expect(build.counters.snapshot().sharedDiscovery).toEqual({ listings: 1, cached: 0 });
  expect(build.counters.snapshot().driveCost).toEqual({
    requests: 4, projected: PASS_PROJECTED, reported: 0, reportedRequests: 0, byResource: PASS_BY_RESOURCE
  });

  expect(await harness.service.discoverSharedProjects()).toEqual(first);
  expect(build.counters.snapshot().sharedDiscovery).toEqual({ listings: 2, cached: 1 });
  expect(harness.calls).toHaveLength(4);   // the hit was served from `discovered`: no Drive request

  harness.service.invalidateSharedDiscovery();
  expect(await harness.service.discoverSharedProjects()).toEqual(first);
  expect(build.counters.snapshot().sharedDiscovery).toEqual({ listings: 3, cached: 1 });
  expect(harness.calls).toHaveLength(8);   // invalidation re-listed the same four requests
  expect(build.counters.snapshot().driveCost).toEqual({
    requests: 8, projected: PASS_PROJECTED * 2, reported: 0, reportedRequests: 0,
    byResource: { search: PASS_BY_RESOURCE.search * 2, get: PASS_BY_RESOURCE.get * 2 }
  });

  // Still inside the window: a hit, then the TTL boundary forces a real listing.
  await harness.service.discoverSharedProjects();
  expect(build.counters.snapshot().sharedDiscovery).toEqual({ listings: 4, cached: 2 });
  vi.setSystemTime(Date.now() + DISCOVERY_TTL_MS + 1);
  await harness.service.discoverSharedProjects();
  expect(build.counters.snapshot().sharedDiscovery).toEqual({ listings: 5, cached: 2 });
  expect(harness.calls).toHaveLength(12);
});

it("lets the reported cost outrank the URL estimate, per resource", async () => {
  const build = await loadBuild(true);
  const harness = makeHarness(build, { header: () => "7" });
  await harness.service.discoverSharedProjects();
  // The URL estimate is still recorded; `byResource` holds the charged number.
  expect(build.counters.snapshot().driveCost).toEqual({
    requests: 4, projected: PASS_PROJECTED, reported: 28, reportedRequests: 4,
    byResource: { search: 14, get: 14 }
  });
});

it("prices an absent header by Google's documented per-method cost, not zero", async () => {
  const build = await loadBuild(true);
  const harness = makeHarness(build, { header: () => null });
  await harness.service.discoverSharedProjects();
  expect(harness.calls.some((url) => url.searchParams.get("q")?.includes("sharedWithMe"))).toBe(true);
  expect(build.counters.snapshot().driveCost).toEqual({
    requests: 4, projected: PASS_PROJECTED, reported: 0, reportedRequests: 0, byResource: PASS_BY_RESOURCE
  });
});

it("prices each request separately, so a garbled header falls back without erasing the ones that reported", async () => {
  const build = await loadBuild(true);
  const harness = makeHarness(build, { header: (url) => url.pathname.endsWith("/files") ? "not-a-cost" : "3" });
  await harness.service.discoverSharedProjects();
  // The two listings carried a garbled header and fell back to Google's list
  // price; the two file-reference gets each reported 3 units.
  expect(build.counters.snapshot().driveCost).toEqual({
    requests: 4, projected: PASS_PROJECTED, reported: 6, reportedRequests: 2,
    byResource: { search: PASS_BY_RESOURCE.search, get: 3 + 3 }
  });
});

it("falls back to the documented per-method cost for a blank header instead of booking a reported zero", async () => {
  const build = await loadBuild(true);
  const harness = makeHarness(build, { header: () => "" });
  await harness.service.discoverSharedProjects();
  // `Number("")` is 0 and finite, so the guard has to test the header itself, not
  // just for absence: an empty value is not a measurement and the projection stands.
  expect(build.counters.snapshot().driveCost).toEqual({
    requests: 4, projected: PASS_PROJECTED, reported: 0, reportedRequests: 0,
    byResource: PASS_BY_RESOURCE
  });
});

it("keeps snapshot() a read-only copy of the ledger", async () => {
  const build = await loadBuild(true);
  const harness = makeHarness(build, { header: () => "7" });
  const pristine = build.counters.snapshot();   // nothing counted yet
  await harness.service.discoverSharedProjects();
  expect(await build.counters.timed("probe", async () => 1)).toBe(1);

  const first = build.counters.snapshot();
  const second = build.counters.snapshot();
  expect(second).toEqual(first);   // snapshot() does not move state

  first.driveCost.byResource.search = 999;
  first.driveCost.reportedRequests = 0;
  first.sharedDiscovery.cached = 0;
  first.timings.probe.runs = 0;    // a nested entry, so this only lands on the copy
  first.events.injected = 1;
  expect(build.counters.snapshot()).toEqual(second);

  build.counters.clear();
  expect(build.counters.snapshot()).toEqual(pristine);
});

it("stays a no-op in a production build and hands the fetcher back unchanged", async () => {
  const build = await loadBuild(false);
  const harness = makeHarness(build);
  const pristine = build.counters.snapshot();
  expect(build.counters.enabled).toBe(false);
  expect(harness.fetcher).toBe(harness.rawFetch);

  const entries = await harness.service.discoverSharedProjects();
  expect(entries).toHaveLength(2);
  expect(harness.calls).toHaveLength(4);   // the service still ran through the fetcher
  expect(build.counters.snapshot()).toEqual(pristine);
  expect(await build.counters.timed("probe", async () => "value")).toBe("value");
});

it("prices only Drive endpoints and attributes them to the active purpose", async () => {
  const build = await loadBuild(true);
  const harness = makeHarness(build);
  await harness.service.discoverSharedProjects();   // discovery itself labels no purpose
  expect(build.counters.snapshot().driveRequests).toEqual({ sync: 0, reconcile: 0, discovery: 0, identity: 0, other: 4 });

  harness.service.invalidateSharedDiscovery();
  await build.counters.withDrivePurpose("discovery", () => harness.service.discoverSharedProjects());
  await harness.fetcher("https://www.googleapis.com/oauth2/v1/userinfo");

  const snapshot = build.counters.snapshot();
  expect(snapshot.driveRequests).toEqual({ sync: 0, reconcile: 0, discovery: 4, identity: 1, other: 4 });
  expect(snapshot.driveCost).toEqual({
    requests: 8, projected: PASS_PROJECTED * 2, reported: 0, reportedRequests: 0,
    byResource: { search: PASS_BY_RESOURCE.search * 2, get: PASS_BY_RESOURCE.get * 2 }
  });
});
