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

// A long history used to be an unbounded cost: the page cursor was discarded on
// a denial and on the per-round page cap, so every retry re-walked the pages it
// had already applied (100 quota units each) and the failure path additionally
// marked every board for a full listing. One account reached 175,525 of Google's
// 325,000 units per minute this way and stayed denied.
it('resumes a quota-denied change backlog at the page it reached, not from the start', async () => {
  const f = await fixture(), full = vi.fn(async () => []);
  f.pages.set('start', { changes: [{ fileId: 'a', file: { id: 'a', name: 'operations-a.json', parents: ['folder-one'] } }], nextPageToken: 'p2' });
  f.pages.set('p2', { changes: [{ fileId: 'b', file: { id: 'b', name: 'operations-b.json', parents: ['folder-one'] } }], nextPageToken: 'p3' });
  f.pages.set('p3', { changes: [], newStartPageToken: 'terminal' });
  let deny = true;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    f.requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('startPageToken')) return Response.json({ startPageToken: 'start' });
    const token = url.searchParams.get('pageToken')!;
    if (token === 'p3' && deny) {
      deny = false;
      return Response.json({ error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded' }],
        message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'" } }, { status: 403 });
    }
    return Response.json(f.pages.get(token) ?? { changes: [], newStartPageToken: 'next' });
  });
  const changes = createDriveChanges({ ...f.options, fetcher });

  await changes.inventory('one', 'folder-one', full); // fetches the account cursor, lists the board once
  const listings = full.mock.calls.length;
  f.tick(); // past the 15-second Changes poll gate
  await expect(changes.inventory('one', 'folder-one', full)).rejects.toBeInstanceOf(DriveQuotaExceededError);
  const asked = () => f.requests.map(url => new URL(`http://x${url}`).searchParams.get('pageToken')).filter(Boolean);
  expect(asked()).toEqual(['start', 'p2', 'p3']);

  // The cooldown passes; the backlog continues where it stopped. Re-walking
  // 'start' and 'p2' would charge those two pages a second time, forever.
  f.tick(60_000);
  expect(await changes.inventory('one', 'folder-one', full)).toEqual([
    { id: 'a', name: 'operations-a.json', size: undefined, createdTime: undefined },
    { id: 'b', name: 'operations-b.json', size: undefined, createdTime: undefined }
  ]);
  expect(asked()).toEqual(['start', 'p2', 'p3', 'p3']);
  // Neither the denial nor the resume turned the backlog into a board listing.
  expect(full).toHaveBeenCalledTimes(listings);
});

it('leaves a backlog longer than one round to the next round instead of forcing full inventories', async () => {
  const f = await fixture(), full = vi.fn(async () => []);
  // 120 pages of history: more than one round of 100, so the first round has to
  // stop with the cursor kept rather than give up on the feed.
  for (let page = 1; page <= 120; page++) {
    f.pages.set(`p${page}`, page === 120
      ? { changes: [], newStartPageToken: 'terminal' }
      : { changes: [], nextPageToken: `p${page + 1}` });
  }
  const changes = createDriveChanges({ ...f.options, fetcher: async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    f.requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('startPageToken')) return Response.json({ startPageToken: 'p1' });
    return Response.json(f.pages.get(url.searchParams.get('pageToken')!) ?? { changes: [], newStartPageToken: 'next' });
  } });

  await changes.inventory('one', 'folder-one', full);
  const asked = () => f.requests.filter(url => url.includes('pageToken=')).length;
  expect(asked()).toBe(0); // the first call only fetches the account cursor
  f.tick();
  await changes.inventory('one', 'folder-one', full);
  expect(asked()).toBe(100); // exactly one round of pages, then it stops on the cursor
  f.tick();
  await changes.inventory('one', 'folder-one', full);
  expect(asked()).toBe(120); // the remainder, and the terminal cursor
  // Only the initial listing of the board; the 100-page cap did not force more.
  expect(full).toHaveBeenCalledTimes(1);
});
