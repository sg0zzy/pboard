/**
 * Sustained Drive request rate for one open shared board.
 *
 * Startup is a burst; the number that trips `403 rateLimitExceeded / Units per
 * minute per user` during ordinary editing is the *recurring* rate, and that is
 * Drive-hosted presence: every open board polls its `realtime/` folder for
 * peers. This file measures that steady state in the same harness as
 * `startupRequestProfile.test.ts` — real Drive REST shapes through `DriveStub`,
 * priced at Google's documented per-method quota units
 * (<https://developers.google.com/workspace/drive/api/guides/limits>) — and
 * budgets it, because the same window used to cost roughly an order of magnitude
 * more and the regression is invisible to every other test in the suite.
 *
 * Integration exception to the no-wall-clock-timers rule (the same one
 * `startupRequestProfile.test.ts` documents): the signaling poll is real-time
 * cadence with no injectable clock at this layer, and the measured quantity is
 * requests per real minute.
 */
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { createDriveRuntime } from '../src/sync/runtime';
import { createRxRepository, type RxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../src/storage/blobStore';
import { driveRequestCost } from '../src/sync/driveQuota';
import { createDriveIdentityCache } from '../src/sync/driveIdentity';
import type { GoogleAuthProvider } from '../src/sync/googleAuth';
import { MemoryStorage } from './recovery/harness';
import { DriveStub } from './sync/driveStub';

/** Minutes of Drive traffic observed by this file. */
const WINDOW_MS = 12_000;

const auth: GoogleAuthProvider = {
  getAccessToken: async () => 'profile-token',
  getConnectionState: async () => 'connected',
  connect: async () => { }, disconnect: async () => { }, isConfigured: () => true
};

const METRIC: Record<string, string> = {
  list: 'DriveFiles.List', get: 'DriveFiles.Get', download: 'DriveFiles.Get (media)', edit: 'DriveFiles.Update', about: 'DriveAbout.Get'
};

/** Documented quota units per request, by the Google metric it belongs to. */
function documented(url: string, method: string): { metric: string; units: number } {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const cost = driveRequestCost(url, method);
  if (path.includes('/about')) return { metric: 'DriveAbout.Get', units: cost };
  if (parsed.searchParams.get('alt') === 'media') return { metric: METRIC.download, units: cost };
  if (path.endsWith('/files') && method === 'GET') return { metric: METRIC.list, units: cost };
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase())) return { metric: METRIC.edit, units: cost };
  return { metric: METRIC.get, units: cost };
}

it('keeps one idle shared board inside a presence-poll Drive budget', async () => {
  const server = new DriveStub();
  const storage = new MemoryStorage();
  const rx: RxRepository = await createRxRepository({ name: `idlerate${crypto.randomUUID().replaceAll('-', '')}`, blobs: createIndexedDbBlobStore(`idleblobs${crypto.randomUUID()}`) });
  await rx.createProject('Idle board', 'project');
  const boardId = (await rx.listProjects())[0].id;

  const rows: { metric: string; units: number; url: string }[] = [];
  const probe = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const response = await server.fetch(url, init);
    if (response.status < 400) {
      const { metric, units } = documented(url, method);
      rows.push({ metric, units, url });
    }
    return response;
  };
  const runtime = createDriveRuntime({ storage, getRepository: async () => rx, auth, fetcher: probe, identity: createDriveIdentityCache() });

  // Create the board's Drive protocol first: the budget is about the traffic
  // that repeats while the board is merely open.
  await runtime.googleDrive.reconcileAll({ force: true });
  await runtime.collaborationManager.setEnabled(true);
  await runtime.collaborationManager.start(boardId);

  rows.length = 0;
  const startedAt = Date.now();
  await new Promise<void>((done) => setTimeout(done, WINDOW_MS));
  const elapsedMs = Date.now() - startedAt;
  await runtime.collaborationManager.stop();

  const byMetric = new Map<string, { count: number; units: number }>();
  for (const row of rows) {
    const entry = byMetric.get(row.metric) ?? { count: 0, units: 0 };
    entry.count += 1;
    entry.units += row.units;
    byMetric.set(row.metric, entry);
  }
  const units = rows.reduce((sum, row) => sum + row.units, 0);
  const perMinute = (value: number) => Math.round((value * 60_000) / elapsedMs);
  const table = [...byMetric.entries()]
    .map(([metric, entry]) => `| ${metric} | ${entry.count} | ${entry.units} | ${perMinute(entry.units)} |`)
    .join('\n');
  console.log(`\n### idle shared board, Drive signaling enabled (${Math.round(elapsedMs / 1000)} s window)\n`
    + `| google method | requests | units | units/minute |\n| --- | --- | --- | --- |\n${table}\n`
    + `| TOTAL | ${rows.length} | ${units} | ${perMinute(units)} |\n`
    + `  presence downloads in window: ${byMetric.get(METRIC.download)?.count ?? 0}`);

  // The poll still reads the room — that is how a second browser is found — so
  // exactly the roster listings should be visible, nothing more.
  const lists = byMetric.get(METRIC.list)?.count ?? 0;
  expect(lists).toBeGreaterThanOrEqual(2);
  // An unchanged room downloads nothing: not the session's own record, and not
  // a peer record whose modification time has not moved. Each download is 200
  // units, six times a listing, and used to be paid every two seconds.
  expect(byMetric.get(METRIC.download)?.count ?? 0).toBe(0);
  // Budget: one room's listings at the fast cadence (≤30/min × 100) plus the
  // heartbeat rewrites and the incidental per-board traffic this window shares.
  // The same window cost ≈28,500 units/minute per room before presence records
  // were cached by modification time and heartbeated at a quarter of their TTL.
  expect(perMinute(units)).toBeLessThanOrEqual(6_000);

  await rx.db.close();
}, 120_000);
