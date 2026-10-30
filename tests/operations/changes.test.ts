import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { createDriveChanges } from '../../src/sync/operations/changes';
import { createDriveQuotaThrottle, DriveQuotaExceededError } from '../../src/sync/driveQuota';
import type { RxRepository } from '../../src/storage/rxdbRepository';
const journals: ChangeJournal[] = []; afterEach(() => journals.splice(0).forEach(journal => journal.close()));
async function fixture() {
  const journal = new ChangeJournal(`changes${crypto.randomUUID()}`); await journal.open(); journals.push(journal);
  let now = 10000, account = 'one', expired = false;
  const requests: string[] = [], pages = new Map<string, any>();
  const auth = { getAccessToken: async () => 'token' } as any;
  const options = { auth, quota: createDriveQuotaThrottle({ now: () => now }), getAccountId: async () => account, getRepository: async () => ({ journal } as RxRepository), now: () => now,
    fetcher: async (input: RequestInfo | URL) => { const url = new URL(String(input)); requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('startPageToken')) return Response.json({ startPageToken: 'start' });
      if (expired) return new Response('', { status: 410 });
      return Response.json(pages.get(url.searchParams.get('pageToken')!) ?? { changes: [], newStartPageToken: 'next' });
    } };
  return { journal, options, pages, requests, tick: (ms = 16000) => { now += ms; }, account: (value: string) => { account = value; }, expire: () => { expired = true; } };
}
it('persists a scoped durable inbox with its Changes cursor before downloads, including pages and removals', async () => {
  const f = await fixture(), full = vi.fn(async () => [{ id: 'old', name: 'operations-old.json' }]);
  await createDriveChanges(f.options).inventory('board', 'folder', full); f.tick();
  f.pages.set('start', { changes: [{ fileId: 'new', file: { id: 'new', name: 'operations-new.json', parents: ['folder'] } }, { fileId: 'unrelated', file: { name: 'operations-other.json', parents: ['elsewhere'] } }], nextPageToken: 'second' });
  f.pages.set('second', { changes: [{ fileId: 'old', removed: true }], newStartPageToken: 'terminal' });
  expect(await createDriveChanges(f.options).inventory('board', 'folder', full)).toEqual([{ id: 'new', name: 'operations-new.json', size: undefined, createdTime: undefined }]);
  expect(full).toHaveBeenCalledTimes(1); f.tick();
  // Restart before the new operation file is downloaded. Its ID remains queued.
  expect((await createDriveChanges(f.options).inventory('board', 'folder', full)).map(file=>file.id)).toEqual(['new']);
  expect(f.requests.some(url => url.includes('pageToken=terminal'))).toBe(true);
});
it('recovers expired cursors with a fresh inventory and manual sync always inventories the board', async () => {
  const f = await fixture(), full = vi.fn(async () => [{ id: 'old', name: 'operations-old.json' }]), changes = createDriveChanges(f.options);
  await changes.inventory('board', 'folder', full); f.tick(); f.expire();
  full.mockResolvedValue([{ id: 'recovered', name: 'operations-recovered.json' }]);
  expect((await changes.inventory('board', 'folder', full)).map(file=>file.id)).toEqual(['recovered']);
  expect(full).toHaveBeenCalledTimes(2);
  await changes.inventory('board', 'folder', full, true); expect(full).toHaveBeenCalledTimes(3);
});
it('never reuses one Google account cursor or file inbox for another account', async () => {
  const f = await fixture(), changes = createDriveChanges(f.options), full = vi.fn(async () => [{ id: 'first', name: 'snapshot-first.json' }]);
  await changes.inventory('board', 'folder', full); f.account('two');
  full.mockResolvedValue([{ id: 'second', name: 'snapshot-second.json' }]);
  expect((await changes.inventory('board', 'folder', full)).map(file=>file.id)).toEqual(['second']);
  f.account('one'); expect((await changes.inventory('board', 'folder', full)).map(file=>file.id)).toEqual(['first']);
});

it('shares automatic Changes polls across boards for 15 seconds while manual sync stays fresh', async () => {
  const f = await fixture(), changes = createDriveChanges(f.options), full = vi.fn(async () => []);
  await changes.inventory('one', 'folder-one', full);
  for (let i = 0; i < 5; i++) {
    f.tick(2000);
    await changes.inventory(`board-${i}`, `folder-${i}`, full);
  }
  expect(f.requests).toHaveLength(1);
  expect(f.options.quota.snapshot().requests).toBe(1);
  await changes.inventory('one', 'folder-one', full, true);
  expect(f.requests).toHaveLength(2);
  f.tick(16000);
  await changes.inventory('one', 'folder-one', full);
  expect(f.requests).toHaveLength(3);
});

it('does not amplify a quota-denied feed into full inventories, including manual retries', async () => {
  const f = await fixture(), full = vi.fn(async () => []);
  const denied = vi.fn(async () => Response.json({ error: {
    status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded' }],
    message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"
  } }, { status: 403 }));
  const changes = createDriveChanges({ ...f.options, fetcher: denied });
  await expect(changes.inventory('one', 'folder-one', full)).rejects.toBeInstanceOf(DriveQuotaExceededError);
  await expect(changes.inventory('two', 'folder-two', full, true)).rejects.toBeInstanceOf(DriveQuotaExceededError);
  expect(denied).toHaveBeenCalledTimes(1);
  expect(full).not.toHaveBeenCalled();
  expect(f.options.quota.snapshot().requests).toBe(1);
  f.tick(60000);
  denied.mockImplementationOnce(async () => Response.json({ startPageToken: 'recovered' }));
  await expect(changes.inventory('one', 'folder-one', full)).resolves.toEqual([]);
  expect(full).toHaveBeenCalledTimes(1);
});
