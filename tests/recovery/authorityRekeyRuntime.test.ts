/**
 * End-to-end regression for the reported block: a Drive-owned board whose
 * authority record is lost must UNBLOCK itself when the sharing view asks the
 * runtime for its role — a live authenticated ACL read re-establishes the
 * authority (D1/D4) instead of surfacing "existing signed collaboration data".
 * A verified non-owner keeps the block, now stating the refusal reason.
 * Real runtime + grant service + Drive transport; stubbed fetcher and auth.
 */
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import type { RxRepository } from '../../src/storage/rxdbRepository';
import { createDriveRuntime } from '../../src/sync/runtime';
import type { GoogleAuthProvider } from '../../src/sync/googleAuth';
import { BoardExistingSignedDataError } from '../../src/collab/authorityErrors';

const BOARD = 'boardrekey';
const EMAIL = 'owner@example.com';

const json = (value: unknown) => new Response(JSON.stringify(value));

function makeStorage() {
  const data = new Map<string, unknown>();
  data.set('pboardCollaborationSettings', { provider: 'websocket', url: 'wss://pboard.cecosl.ovh/ws' });
  return { data, get: async (key: string) => ({ [key]: structuredClone(data.get(key)) }), set: async (patch: Record<string, unknown>) => { for (const [key, value] of Object.entries(patch)) data.set(key, structuredClone(value)); } };
}

function makeFetcher(acl: unknown[], layout: 'legacy' | 'unified' | 'missing' | 'unavailable' = 'legacy') {
  let published: unknown;
  const fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pboard.cecosl.ovh' && url.hostname !== 'www.googleapis.com') return new Response('{}', { status: 404 });
    if (url.pathname === '/identity/challenge') return json({ version: 1, challenge: 'a'.repeat(43) });
    if (url.pathname === '/identity/exchange') return json({ version: 1, email: EMAIL, boards: [] });
    if (url.pathname === '/grants/challenge') return json({ version: 2, challenge: 'b'.repeat(43) });
    if (url.pathname === '/grants/publish') { published = structuredClone(JSON.parse(String(init?.body)).bundle); return new Response(null, { status: 204 }); }
    if (url.pathname.startsWith('/grants/')) return published ? json(published) : new Response('{}', { status: 404 });
    if (url.pathname === '/drive/v3/about') return json({ user: { emailAddress: EMAIL, displayName: 'Owner' } });
    if (url.pathname.endsWith('/permissions')) return json({ permissions: acl });
    if (url.pathname === '/drive/v3/files/pj') return json({ parents: ['folder1'] });
    if (url.pathname === '/drive/v3/files/folder1') return json({ id: 'folder1', name: BOARD, mimeType: 'application/vnd.google-apps.folder' });
    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') ?? '';
      if (layout === 'unavailable') return new Response('{}', { status: 403 });
      if (layout === 'unified') {
        const folderMime = 'application/vnd.google-apps.folder';
        if (query.includes("name = 'pboard'")) return json({ files: [{ id: 'root-v2', name: 'pboard', mimeType: folderMime, parents: ['actual-root'] }] });
        if (query.includes(`name = '${BOARD}'`)) return json({ files: [{ id: 'folder-v2', name: BOARD, mimeType: folderMime, parents: ['root-v2'] }] });
        if (query.includes("name = 'board.json.gz'")) return json({ files: [{ id: 'snapshot-v2', name: 'board.json.gz', parents: ['folder-v2'] }] });
        return json({ files: [] });
      }
      if (layout === 'missing') return json({ files: [] });
      if (query.includes('sharedWithMe')) return json({ files: [] });
      if (query.includes("'project.json'")) return json({ files: [{ id: 'pj', name: 'project.json', mimeType: 'application/json' }] });
      return json({ files: [] });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetcher, get published() { return published; } };
}

function makeRepository() {
  const transitions: { boardId: string; record: Record<string, unknown> }[] = [];
  const permissions = new Map<string, { id: string; authorityKeyId?: string }>();
  const emptyQuery = { equals: () => ({ toArray: async () => [] }) };
  const rx = {
    isDeletedProject: async () => false,
    getProject: async (id: string) => ({ id }),
    db: {
      projects: { findOne: () => ({ exec: async () => ({ toJSON: () => ({ id: BOARD, _sec: { provenance: {} } }) }) }) },
      cards: { find: () => ({ exec: async () => [] }) },
      settings: { findOne: () => ({ exec: async () => null }) }
    },
    journal: {
      entries: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
      permissions: { get: async (id: string) => permissions.get(id), put: async (permission: { id: string }) => { permissions.set(permission.id, permission); } },
      authorityTransitions: { put: async (row: { boardId: string; record: Record<string, unknown> }) => { transitions.push(row); }, where: () => ({ equals: () => ({ toArray: async () => transitions }) }) },
      publicGrants: { where: () => emptyQuery },
      hasSignedHistory: async () => true
    }
  } as unknown as RxRepository;
  return { rx, transitions, permissions };
}

const auth: GoogleAuthProvider = {
  connect: async () => {}, disconnect: async () => {}, getConnectionState: async () => 'connected',
  isConfigured: () => true, getAccessToken: async () => 'drive-token'
};

function setup(acl: unknown[], layout: 'legacy' | 'unified' | 'missing' | 'unavailable' = 'legacy') {
  const storage = makeStorage();
  const drive = makeFetcher(acl, layout);
  const { rx, transitions, permissions } = makeRepository();
  const runtime = createDriveRuntime({ operationSync: false, auth, storage, getRepository: async () => rx, fetcher: drive.fetcher, hasSignalingHostPermission: async () => true });
  return { storage, runtime, transitions, permissions, fetcher: drive.fetcher, get published() { return drive.published; } };
}

it('unblocks a Drive-owned board with lost authority when the sharing view asks for the role', async () => {
  const a = setup([{ id: 'p0', type: 'user', role: 'owner', emailAddress: EMAIL }]);
  expect(await a.runtime.sharePermissions.myRole(BOARD)).toBe('owner');

  const record = (a.storage.data.get('pboardBoardGrants') as Record<string, { bundle: { history: { payload: { authorityKeyId: string } }[] }; transition: { newAuthorityKeyId: string; driveFolderFileId: string } }>)[BOARD];
  expect(record.transition.newAuthorityKeyId).toBe(record.bundle.history.at(-1)!.payload.authorityKeyId);
  expect(record.transition.driveFolderFileId).toBe('folder1');
  expect(a.transitions).toHaveLength(1);
  expect(a.transitions[0]!.boardId).toBe(BOARD);
  expect((a.permissions.get(BOARD))?.authorityKeyId).toBe(record.transition.newAuthorityKeyId);
  // The re-keyed chain reached the grant service too.
  expect(a.published).toBeTruthy();
});

it('keeps the block for a verified non-owner and states the re-key refusal reason', async () => {
  const a = setup([
    { id: 'p0', type: 'user', role: 'owner', emailAddress: 'them@example.com' },
    { id: 'p1', type: 'user', role: 'writer', emailAddress: EMAIL }
  ]);
  const error = await a.runtime.sharePermissions.myRole(BOARD).then(() => null, (reason: unknown) => reason as Error);
  expect(error).toBeInstanceOf(BoardExistingSignedDataError);
  expect(error!.message).toContain('Automatic Drive-ownership re-key was refused');
  expect(error!.message).toContain('does not report this account as the board folder owner');
  // Nothing was written: no grant record, no transition audit row.
  expect(a.storage.data.get('pboardBoardGrants')).toBeUndefined();
  expect(a.transitions).toHaveLength(0);
});

it('recovers the owner authority from the unified folder without legacy project.json or sharing metadata', async () => {
  const a = setup([{ id: 'owner', type: 'user', role: 'owner', emailAddress: EMAIL }], 'unified');
  expect(await a.runtime.sharePermissions.myRole(BOARD)).toBe('owner');
  expect(a.transitions).toHaveLength(1);
  expect(a.transitions[0]!.record.driveFolderFileId).toBe('folder-v2');
  expect(a.published).toBeTruthy();
  const calls = vi.mocked(a.fetcher).mock.calls;
  expect(calls.some(([input]) => String(input).includes('/folder-v2/permissions'))).toBe(true);
  expect(calls.filter(([input]) => String(input).includes('googleapis.com')).every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('refuses unified-folder re-key for a writer even with a stale legacy owned-folder record', async () => {
  const a = setup([
    { id: 'owner', type: 'user', role: 'owner', emailAddress: 'them@example.com' },
    { id: 'writer', type: 'user', role: 'writer', emailAddress: EMAIL }
  ], 'unified');
  a.storage.data.set('pboardDriveSharedProjects', { [BOARD]: { folderId: 'legacy-owned', projectFileId: 'old-project' } });
  // Exercise the explicit recovery entry point: legacy trust also blocks auto-init.
  await expect(a.runtime.reestablishAuthorityFromDrive(BOARD)).rejects.toThrow(/does not report this account as the board folder owner/);
  expect(a.storage.data.get('pboardBoardGrants')).toBeUndefined();
  expect(a.transitions).toHaveLength(0);
});

for (const layout of ['missing', 'unavailable'] as const) {
  it(`keeps signed data blocked when Drive discovery is ${layout}, without creating a proof folder`, async () => {
    const a = setup([{ id: 'owner', type: 'user', role: 'owner', emailAddress: EMAIL }], layout);
    await expect(a.runtime.sharePermissions.myRole(BOARD)).rejects.toBeInstanceOf(BoardExistingSignedDataError);
    expect(a.storage.data.get('pboardBoardGrants')).toBeUndefined();
    expect(a.transitions).toHaveLength(0);
    expect(a.published).toBeUndefined();
    expect(vi.mocked(a.fetcher).mock.calls.filter(([input]) => String(input).includes('googleapis.com')).every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
}
