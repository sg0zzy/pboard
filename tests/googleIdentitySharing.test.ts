import { expect, it, vi } from 'vitest';
import { createGoogleIdentitySharing } from '../src/collab/googleIdentitySharing';
import { createBoardGrantService } from '../src/collab/boardGrants';
import { generateDeviceKey, publicKeyFingerprint } from '../src/collab/security/keys';
import { toBase64Url } from '../src/collab/security/canonical';

function fixture(ownerLimit = Number.POSITIVE_INFINITY) {
  const policies = new Map<string, any>(), pending = new Map<string, any[]>(), bundles = new Map<string, any>();
  let tamper = false, calls = 0, requests = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); expect(url.origin).toBe('https://relay.example.test'); calls++;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const answer = (value: unknown) => new Response(JSON.stringify(value));
    if (url.pathname.endsWith('/challenge')) return answer({ version: url.pathname.startsWith('/grants') ? 2 : 1, challenge: 'a'.repeat(43) });
    if (url.pathname === '/grants/publish') {
      const bundle = body.bundle;
      const last = JSON.parse(Buffer.from(bundle.history.at(-1).payload, 'base64url').toString());
      const scope = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['pboard-board-grants-v1', await publicKeyFingerprint(bundle.authority), last.boardId])))));
      bundles.set(scope, bundle); return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith('/grants/')) return answer(bundles.get(url.pathname.split('/').at(-1)!));
    expect(url.pathname).toBe('/identity/exchange');
    const email = (init?.headers as Record<string, string>).Authorization.replace('Bearer ', '');
    const operation = body.operation;
    if (operation.publication) {
      const policy = operation.publication.policy;
      if (!policies.has(policy.boardId) && [...policies.values()].filter(p => p.policy.ownerEmail === email).length >= ownerLimit) {
        return new Response(JSON.stringify({ code: 'directory_capacity' }), { status: 403 });
      }
      policies.set(policy.boardId, operation.publication);
    }
    if (operation.type === 'request') {
      requests++;
      const id = operation.request.boardId;
      pending.set(id, [...(pending.get(id) ?? []).filter(p => p.request.deviceKeyId !== operation.request.deviceKeyId), { email, request: operation.request }]);
    }
    const boards = [...policies.values()].filter(p => p.policy.ownerEmail === email || p.policy.members.some((m: any) => m.email === email)).map(p => ({ publication: structuredClone(p), pending: p.policy.ownerEmail === email ? structuredClone(pending.get(p.policy.boardId) ?? []) : [] }));
    if (tamper && boards.length) boards[0].publication.policy.ownerEmail = 'attacker@example.test';
    return answer({ version: 1, email, boards });
  }) as typeof fetch;
  function client(email: string, allowInitialize = true) {
    const state: Record<string, unknown> = {};
    const storage = { get: async (id: string) => ({ [id]: structuredClone(state[id]) }), set: async (patch: Record<string, unknown>) => { Object.assign(state, structuredClone(patch)); } };
    const keys = new Map<string, Awaited<ReturnType<typeof generateDeviceKey>>>();
    const getKey = async (id: string) => { if (!keys.has(id)) keys.set(id, await generateDeviceKey()); return keys.get(id)!; };
    const grants = createBoardGrantService({ storage, fetcher, getKey });
    let connected = true;
    const sharing = createGoogleIdentitySharing({ storage, fetcher, getKey, grants,
      auth: { getAccessToken: async () => email, getConnectionState: async () => connected ? 'connected' : 'disconnected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
      canInitialize: async () => { if (!allowInitialize) throw new Error('Existing signed data cannot change authority'); return true; }, canReceive: async () => true });
    return { grants, sharing, state, disconnect: () => { connected = false; }, enable: () => grants.configure({ provider: 'websocket', url: 'wss://relay.example.test/ws' }) };
  }
  return { client, policies, bundles, requests: () => requests, calls: () => calls, tamper: () => { tamper = true; } };
}
it('avoids repeated trust writes for identical verified grants while still reading fresh membership', async () => {
  const f = fixture(), owner = f.client('owner@example.test'), joining = f.client('owner@example.test');
  await owner.enable(); await joining.enable();
  await owner.sharing.sync('board', true); await joining.sharing.sync(undefined, true);
  await owner.sharing.sync('board', true);
  const trust = vi.spyOn(joining.grants, 'trust');
  await joining.sharing.sync(undefined, true);
  expect(trust).toHaveBeenCalledTimes(1);
  const requests = f.calls();
  await joining.sharing.sync(undefined, true);
  expect(f.calls()).toBeGreaterThan(requests); // no stale directory/HTTP cache
  expect(trust).toHaveBeenCalledTimes(1);
  delete joining.state.pboardBoardGrants;
  await joining.sharing.sync(undefined, true);
  expect(trust).toHaveBeenCalledTimes(2); // removed local permission is not presumed present
  await owner.grants.initialize('board');
  await joining.sharing.sync(undefined, true);
  expect(trust).toHaveBeenCalledTimes(3); // changed signed history gets full validation
});

it('does not cache acceptance of altered history prefixes or expired grants', async () => {
  const f = fixture(), owner = f.client('owner@example.test'), joining = f.client('owner@example.test');
  await owner.enable(); await joining.enable();
  await owner.sharing.sync('board', true); await joining.sharing.sync(undefined, true);
  await owner.sharing.sync('board', true); await joining.sharing.sync(undefined, true);
  const wire = [...f.bundles.values()][0], original = wire.history[0].payload;
  const prefix = JSON.parse(Buffer.from(original, 'base64url').toString());
  wire.history[0].payload = Buffer.from(JSON.stringify({ ...prefix, epoch: 900 })).toString('base64url');
  await expect(joining.sharing.sync(undefined, true)).rejects.toThrow();
  wire.history[0].payload = original;
  expect((await joining.sharing.sync(undefined, true)).ready).toContain('board');
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 301_000);
    await expect(joining.sharing.sync(undefined, true)).rejects.toThrow();
  } finally { vi.useRealTimers(); }
});
it('rechecks persisted rollback and fork protection even for an identical cached bundle', async () => {
  const f = fixture(), owner = f.client('owner@example.test'), joining = f.client('owner@example.test');
  await owner.enable(); await joining.enable();
  await owner.sharing.sync('board', true); await joining.sharing.sync(undefined, true);
  await owner.sharing.sync('board', true); await joining.sharing.sync(undefined, true);
  const records = joining.state.pboardManifestEpochs as Record<string, { epoch: number; hash: string; expiresAt: number }>;
  const record = Object.values(records)[0], original = { ...record };
  record.epoch++;
  await expect(joining.sharing.sync(undefined, true)).rejects.toThrow('rollback');
  Object.assign(record, original);
  await joining.sharing.sync(undefined, true); // restore the successful memo
  Object.values(joining.state.pboardManifestEpochs as typeof records)[0].hash = 'another-accepted-manifest';
  await expect(joining.sharing.sync(undefined, true)).rejects.toThrow('Conflicting manifest');
});
it('keeps Drive default and performs no identity request without opt-in or a connected account', async () => {
  const f = fixture(), owner = f.client('owner@example.test');
  await owner.sharing.sync('board'); expect(f.calls()).toBe(0);
  await owner.enable(); owner.disconnect(); await owner.sharing.sync('board'); expect(f.calls()).toBe(0);
});
it('automates same-account grants and explicit email invitations, preserves viewer access and removes active grants', async () => {
  const f = fixture(), owner = f.client('owner@example.test'), same = f.client('owner@example.test'), invited = f.client('invited@example.test');
  for (const c of [owner, same, invited]) await c.enable();
  await owner.sharing.sync('board', true);
  expect(await owner.grants.ownsAuthority('board')).toBe(true);
  expect((await same.sharing.sync(undefined, true)).ready).toEqual([]);
  expect(await same.grants.security('board')).toBeNull();
  expect((await invited.sharing.sync(undefined, true)).boards).toEqual([]);
  await owner.sharing.sync('board', true); await same.sharing.sync(undefined, true);
  expect(await same.grants.role('board')).toBe('editor');
  await owner.sharing.invite('board', 'INVITED@example.test', 'viewer');
  await invited.sharing.sync(undefined, true);
  expect(await invited.grants.security('board')).toBeNull();
  await owner.sharing.sync('board', true); await invited.sharing.sync(undefined, true);
  expect(await invited.grants.role('board')).toBe('viewer');
  await owner.sharing.remove('board', 'invited@example.test');
  expect((await invited.sharing.sync(undefined, true)).boards).toEqual([]);
  await expect(invited.grants.poll('board')).rejects.toThrow('no owner-approved');
});
it('refuses signed-data authority replacement and tampered directory policies', async () => {
  const f = fixture(), blocked = f.client('owner@example.test', false), owner = f.client('owner@example.test'), joining = f.client('owner@example.test');
  for (const c of [blocked, owner, joining]) await c.enable();
  await expect(blocked.sharing.sync('board')).rejects.toThrow('signed data');
  expect(await blocked.grants.localBundle('board')).toBeNull();
  await owner.sharing.sync('board', true); f.tamper();
  await expect(joining.sharing.sync(undefined, true)).rejects.toThrow('policy');
  expect(await joining.grants.security('board')).toBeNull();
});

it('rejects replayed email invitations after removal, including when another board is selected after a server restart', async () => {
  const f = fixture(), owner = f.client('owner@example.test'); await owner.enable();
  await owner.sharing.sync('board', true);
  await owner.sharing.invite('board', 'invited@example.test', 'editor');
  const captured = structuredClone(f.policies.get('board'));
  await owner.sharing.remove('board', 'invited@example.test');
  f.policies.set('board', captured); // valid old root signature reseeded after restart
  await expect(owner.sharing.sync(undefined, true)).rejects.toThrow('Stale sharing policy');
  expect((await owner.sharing.collaborators('board')).map(m => m.email)).toEqual(['owner@example.test']);
});

it('renews and enrolls an invited device for an unselected owned board after its old grant expires', async () => {
  const f = fixture(), owner = f.client('owner@example.test'), invited = f.client('invited@example.test');
  await owner.enable(); await invited.enable();
  await owner.sharing.sync('board', true);
  await owner.sharing.invite('board', 'invited@example.test', 'editor');
  await invited.sharing.sync(undefined, true);
  const epoch = (await owner.grants.localBundle('board'))!.history.at(-1)!.payload.epoch;
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 6 * 60_000);
  try {
    // Directory policy is still valid, but this unselected board's five-minute
    // device manifest has expired. The owner is viewing another local board.
    await owner.sharing.sync('other-board', true);
    const renewed = (await owner.grants.localBundle('board'))!.history.at(-1)!.payload;
    expect(renewed.epoch).toBeGreaterThan(epoch);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
    expect((await invited.sharing.sync(undefined, true)).ready).toContain('board');
    expect(await invited.grants.role('board')).toBe('editor');
  } finally { vi.useRealTimers(); }
});
it('republishes known owned invitations after directory loss without selecting each board', async () => {
  const f = fixture(), owner = f.client('owner@example.test'), invited = f.client('invited@example.test');
  await owner.enable(); await invited.enable();
  await owner.sharing.sync('board', true);
  await owner.sharing.invite('board', 'invited@example.test', 'viewer');
  f.policies.clear();
  await owner.sharing.sync(undefined, true);
  expect(f.policies.get('board').policy.members).toEqual([{ email: 'invited@example.test', role: 'viewer' }]);
  await invited.sharing.sync(undefined, true);
  await owner.sharing.sync(undefined, true);
  expect((await invited.sharing.sync(undefined, true)).ready).toContain('board');
  expect(await invited.grants.role('board')).toBe('viewer');
});

it('polls for grants without resubmitting the same pending request on every five-second refresh', async () => {
  const f = fixture(), owner = f.client('owner@example.test'), joining = f.client('invited@example.test');
  await owner.enable(); await joining.enable();
  await owner.sharing.sync('board', true); await owner.sharing.invite('board', 'invited@example.test', 'editor');
  await joining.sharing.sync(); expect(f.requests()).toBe(1);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 5_000);
    expect((await joining.sharing.sync()).ready).toEqual([]);
    expect(f.requests()).toBe(1);
    vi.setSystemTime(Date.now() + 30_000);
    await joining.sharing.sync(); expect(f.requests()).toBe(2);
    await joining.sharing.sync(undefined, true); expect(f.requests()).toBe(3);
  } finally { vi.useRealTimers(); }
});

it('isolates a full directory from existing same-account device enrollment and never grants the rejected board', async () => {
  const f = fixture(1), owner = f.client('owner@example.test'), same = f.client('owner@example.test');
  await owner.enable(); await same.enable();
  await owner.sharing.sync('permitted-board', true);
  await same.sharing.sync(undefined, true); // waiting on the original authority
  const result = await owner.sharing.sync('over-quota-board', true);
  expect(result.issues).toEqual([{ boardId: 'over-quota-board', code: 'directory_capacity' }]);
  expect(result.ready).toContain('permitted-board');
  expect(result.ready).not.toContain('over-quota-board');
  const received = await same.sharing.sync(undefined, true);
  expect(received.ready).toContain('permitted-board');
  expect(await same.grants.role('permitted-board')).toBe('editor');
  expect(await same.grants.localBundle('over-quota-board')).toBeNull();
  expect(f.policies.has('over-quota-board')).toBe(false);
  // A subsequent ordinary poll reports the scoped warning and retains readiness.
  const cached = await owner.sharing.sync('over-quota-board');
  expect(cached.issues).toEqual(result.issues); expect(cached.ready).toContain('permitted-board');
});
