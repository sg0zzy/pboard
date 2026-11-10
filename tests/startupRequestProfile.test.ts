/**
 * Startup Drive request profile.
 *
 * Measures what one Pboard startup costs on the Google side: every Drive REST
 * request issued while the background worker starts and the sidebar opens,
 * grouped by the Google API method the Cloud console reports
 * (`DriveAbout.Get`, `DriveFiles.List`, …). Reports both the locally projected
 * cost (the old `driveProjectedCost` model) and the documented per-method quota-unit
 * cost Google actually charges, so a
 * local budget number can never be mistaken for Google's accounting again.
 *
 * Two runtime instances model the two JS contexts that both build a Drive
 * runtime from `src/sync/browser.ts`: the background worker and the sidebar
 * page. They share local storage and the same Drive account, exactly as in the
 * extension; their single-flight guards are per-instance and deliberately not
 * shared, which is part of what this profile measures.
 */
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { createDriveRuntime } from '../src/sync/runtime';
import { createRxRepository, type RxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../src/storage/blobStore';
import { driveProjectedCost, driveRequestCost } from '../src/sync/driveQuota';
import { createDriveIdentityCache } from '../src/sync/driveIdentity';
import type { GoogleAuthProvider } from '../src/sync/googleAuth';
import { MemoryStorage } from './recovery/harness';
import { DriveStub } from './sync/driveStub';

const BOARDS = 3;
/** Documented per-method cost in quota units:
 * https://developers.google.com/workspace/drive/api/guides/limits */
const DOCUMENTED = { about: 5, get: 5, list: 100, search: 100, changes: 100, permlist: 100, edit: 50, download: 200, other: 5 };

type Method = keyof typeof DOCUMENTED;
/** The label Google Cloud metrics use for the same traffic. */
const METRIC: Record<Method, string> = {
  about: 'DriveAbout.Get', get: 'DriveFiles.Get', list: 'DriveFiles.List', search: 'DriveFiles.List',
  changes: 'DriveChanges.List',
  permlist: 'DrivePermissions.List', edit: 'DriveFiles.Update', download: 'DriveFiles.Get (media)', other: 'DriveOther'
};

function classify(url: string, method: string): Method {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const upload = path.startsWith('/upload/drive/v3/');
  if (path.includes('/about')) return 'about';
  if (path.endsWith('/changes/startPageToken')) return 'other';
  if (path.endsWith('/changes')) return 'changes';
  if (path.endsWith('/generateIds')) return 'other';
  if (path.endsWith('/permissions')) return method === 'GET' ? 'permlist' : 'edit';
  if (parsed.searchParams.get('alt') === 'media') return 'download';
  if (path.endsWith('/files')) return method === 'GET' ? (parsed.searchParams.get('q') ? 'search' : 'list') : 'edit';
  if (upload || ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return 'edit';
  return 'get';
}

type Row = { context: string; method: Method; status: number; local: number; documented: number; url: string };

/** Recording Drive boundary; also answers the Changes feed, which `DriveStub`
 * does not implement and which the operation inventory consumes. */
class Probe {
  rows: Row[] = [];
  /** Paths whose next response is forced to this status (quota simulation). */
  faults: { matches: (url: string) => boolean; status: number; remaining: number }[] = [];
  private cursor = 1;

  constructor(readonly context: string, private server: DriveStub) {}

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const fault = this.faults.find(entry => entry.remaining > 0 && entry.matches(url));
    if (fault) {
      fault.remaining -= 1;
      const response = Response.json(
        { error: { code: fault.status, message: 'User Rate Limit Exceeded', status: 'RESOURCE_EXHAUSTED', errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }] } },
        { status: fault.status }
      );
      this.rows.push({ context: this.context, method: classify(url, method), status: fault.status, local: driveProjectedCost(url), documented: DOCUMENTED[classify(url, method)], url });
      return response;
    }
    if (new URL(url).pathname.endsWith('/drive/v3/changes/startPageToken')) {
      this.record(url, method, 200);
      return Response.json({ startPageToken: String(this.cursor++) });
    }
    if (new URL(url).pathname.endsWith('/drive/v3/changes')) {
      this.record(url, method, 200);
      return Response.json({ newStartPageToken: String(this.cursor++) });
    }
    const response = await this.server.fetch(String(input), init);
    this.record(url, method, response.status);
    return response;
  };

  private record(url: string, method: string, status: number) {
    const kind = classify(url, method);
    this.rows.push({ context: this.context, method: kind, status, local: driveProjectedCost(url), documented: DOCUMENTED[kind], url });
  }

  reset() { this.rows.length = 0; }
  total(field: 'local' | 'documented') { return this.rows.reduce((sum, row) => sum + row[field], 0); }
  failures() { return this.rows.filter(row => row.status >= 400); }
}

const auth: GoogleAuthProvider = {
  getAccessToken: async () => 'profile-token',
  getConnectionState: async () => 'connected',
  connect: async () => { }, disconnect: async () => { }, isConfigured: () => true
};

/**
 * One browser startup: the worker's start-of-day rounds, then the sidebar's
 * mount fan-out. The two phases run sequentially so each request is attributed
 * to the context that issued it; in the real extension the two contexts also
 * overlap, which the shared storage reconcile stamp absorbs.
 */
async function startup(server: DriveStub, storage: MemoryStorage, rx: RxRepository, boardId: string, webRTC: boolean, fail?: (probe: Probe) => void) {
  const background = new Probe('worker', server);
  const sidebar = new Probe('sidebar', server);
  if (fail) { fail(background); fail(sidebar); }
  // A fresh identity cache per context: in the extension each JS context owns
  // one cache, and this file runs the two contexts inside one process.
  const [worker, view] = [background, sidebar].map(probe => createDriveRuntime({
    storage, getRepository: async () => rx, auth, fetcher: probe.fetch, identity: createDriveIdentityCache()
  }));
  // A browser start does not inherit a reconcile stamp from the previous
  // session; only the round this startup just performed may coalesce a caller.
  delete storage.data.pboardDriveLastReconciledAt;
  const workerPhase = await Promise.allSettled([
    worker.googleDrive.reconcileAll({ force: true }),   // src/sync/background.ts registerDriveBackgroundSync
    worker.googleDrive.reconcileAll({ force: true })    // sidebar mount message → handleDriveSyncMessage
  ]);
  const sidebarPhase = await Promise.allSettled([view.discoverSharedBoards()]); // App.tsx discovery effect
  const errors = [...workerPhase, ...sidebarPhase].filter(entry => entry.status === 'rejected');
  await view.collaborationManager.setEnabled(webRTC);
  await view.collaborationManager.start(boardId).catch(() => undefined);
  // Integration exception to the no-wall-clock-timers rule: the Drive-hosted
  // signaling poll (`signaling.ts` `pollMs = 2000`) is real time-driven cadence
  // with no injectable clock, and observing one tick is the point of the
  // WebRTC-enabled profile. Fake timers would hide exactly what is measured.
  let finishTick!: () => void;
  const tick = new Promise<void>(done => { finishTick = done; });
  setTimeout(finishTick, 2_100);
  await tick;
  await view.collaborationManager.stop().catch(() => undefined);
  return { background, sidebar, errors };
}

function report(probes: Probe[], title: string) {
  const rows = probes.flatMap(probe => probe.rows);
  const table = new Map<string, { count: number; failed: number; local: number; documented: number }>();
  for (const row of rows) {
    const key = `${METRIC[row.method]}${row.status >= 400 ? ' (failed)' : ''}`;
    const entry = table.get(key) ?? { count: 0, failed: 0, local: 0, documented: 0 };
    entry.count += 1;
    entry.local += row.local;
    entry.documented += row.documented;
    if (row.status >= 400) entry.failed += 1;
    table.set(key, entry);
  }
  const byContext = probes.map(probe =>
    `${probe.context}: ${probe.rows.length} req / local ${probe.total('local')} / google ${probe.total('documented')} (${probe.failures().length} failed)`)
    .join('\n  ');
  const lines = [...table.entries()].map(([method, entry]) =>
    `| ${method} | ${entry.count} | ${entry.failed} | ${entry.local} | ${entry.documented} |`)
    .join('\n');
  console.log(`\n### ${title}\n  ${byContext}\n| google method | requests | failed | projected units | documented units |\n| --- | --- | --- | --- | --- |\n${lines}\n| TOTAL | ${rows.length} | ${rows.filter(row => row.status >= 400).length} | ${rows.reduce((sum, row) => sum + row.local, 0)} | ${rows.reduce((sum, row) => sum + row.documented, 0)} |`);
  for (const row of rows.filter(entry => entry.status >= 400)) console.log(`  FAILED ${row.status} ${row.context} ${row.url.slice(0, 190)}`);
  return { rows, total: rows.length, local: rows.reduce((sum, row) => sum + row.local, 0), documented: rows.reduce((sum, row) => sum + row.documented, 0) };
}

const aboutCount = (rows: Row[]) => rows.filter(row => row.method === 'about').length;
const listCount = (rows: Row[]) => rows.filter(row => row.method === 'list' || row.method === 'search').length;

it('profiles Drive requests for one complete startup (WebRTC off, WebRTC on, warm restart)', async () => {
  const storage = new MemoryStorage();
  const rx = await createRxRepository({ name: `profile${crypto.randomUUID().replaceAll('-', '')}`, blobs: createIndexedDbBlobStore(`profileblobs${crypto.randomUUID()}`) });
  const server = new DriveStub();
  for (let index = 0; index < BOARDS; index += 1) await rx.createProject(`Board ${index}`, 'project');
  const boardId = (await rx.listProjects())[0].id;

  // ---- cold start: the operation protocol is created on the wire ----------
  let run = await startup(server, storage, rx, boardId, false);
  const coldOff = report([run.background, run.sidebar], `cold startup, WebRTC disabled (${BOARDS} boards, ${run.errors.length} reconcile rejections)`);

  // ---- warm start, WebRTC disabled ---------------------------------------
  run = await startup(server, storage, rx, boardId, false);
  const warmOff = report([run.background, run.sidebar], `warm startup, WebRTC disabled (${run.errors.length} reconcile rejections)`);

  // ---- warm start, WebRTC enabled ----------------------------------------
  run = await startup(server, storage, rx, boardId, true);
  const rtcOn = report([run.background, run.sidebar], `warm startup, WebRTC enabled (${run.errors.length} reconcile rejections)`);

  // ---- transient quota denial: does startup restart without bound? --------
  const denial = (probe: Probe) => probe.faults.push({
    matches: url => new URL(url).pathname.includes('/drive/v3/about'), status: 403, remaining: 4
  });
  run = await startup(server, storage, rx, boardId, false, denial);
  const deniedReport = report([run.background, run.sidebar], `warm startup, identity lookups denied (${run.errors.length} reconcile rejections)`);

  // ---- invariants ---------------------------------------------------------
  // Identity resolution must not scale with boards or with the number of
  // subsystems that need the account email: one lookup per context at startup.
  expect(aboutCount(warmOff.rows)).toBeLessThanOrEqual(2);
  expect(aboutCount(rtcOn.rows)).toBeLessThanOrEqual(2);
  // A steady-state startup of three boards, worker and sidebar together: a
  // rounding error against Google's 325,000 units/minute per-user budget.
  expect(warmOff.rows.length).toBeLessThanOrEqual(70);
  expect(warmOff.documented).toBeLessThanOrEqual(4_500);
  expect(rtcOn.rows.length).toBeLessThanOrEqual(90);
  expect(warmOff.rows.filter(row => row.context === 'worker').length).toBeGreaterThan(0);
  // Creating the operation protocol is the expensive one-off; steady state is
  // the number that repeats on every browser start.
  expect(coldOff.rows.length).toBeGreaterThan(warmOff.rows.length);
  // A denied identity lookup must not multiply requests.
  expect(deniedReport.rows.length).toBeLessThanOrEqual(warmOff.rows.length);

  await rx.db.close();
}, 180_000);
