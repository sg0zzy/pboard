/**
 * A presence file Drive lists but cannot describe is asked about once.
 *
 * When a browser dies, its `sig-*.json` stays in the board's `realtime/` folder;
 * Drive then goes on naming the file in the folder listing while its metadata is
 * no longer served. The realtime room resolves every listed peer's role before
 * admitting it, so each pass paid a 404 for the same unreadable id for as long as
 * the board stayed open — the request pattern that filled the network log during
 * the quota incident, and the one that looked like a collaboration failure
 * because the ghosts crowded the room's budget.
 *
 * Integration exception to the no-wall-clock-timers rule (the same one
 * `idleSessionRequestRate.test.ts` documents): the presence poll is real-time
 * cadence with no injectable clock at this layer, and the role cache that bounds
 * the re-ask is a ten-second TTL, so the window has to outlast two of them.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createDriveRuntime } from '../src/sync/runtime';
import { createRxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../src/storage/blobStore';
import { createDriveIdentityCache } from '../src/sync/driveIdentity';
import { clearRoomDiagnostics, roomSnapshots } from '../src/sync/realtimeDiagnostics';
import type { GoogleAuthProvider } from '../src/sync/googleAuth';
import { MemoryStorage } from './recovery/harness';
import { DriveStub } from './sync/driveStub';

const auth: GoogleAuthProvider = {
  getAccessToken: async () => 'profile-token',
  getConnectionState: async () => 'connected',
  connect: async () => { }, disconnect: async () => { }, isConfigured: () => true
};

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); clearRoomDiagnostics(); });

it('asks Drive once about a listed presence file it cannot describe, and reports the peer as unresolved', { timeout: 90_000 }, async () => {
  const server = new DriveStub();
  server.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const name = `ghostpresence${crypto.randomUUID().replaceAll('-', '')}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const storage = new MemoryStorage();
  await rx.createProject('Ghost board', 'project');
  const boardId = (await rx.listProjects())[0].id;
  const runtime = createDriveRuntime({ storage, getRepository: async () => rx, auth, fetcher: server.fetch as typeof fetch, identity: createDriveIdentityCache() });
  closes.push(async () => { await runtime.collaborationManager.stop(); await rx.db.close(); });

  await runtime.googleDrive.reconcileAll({ force: true });
  await runtime.collaborationManager.setEnabled(true);
  await runtime.collaborationManager.start(boardId);
  // The room creates its folder and writes this session's presence file first.
  await new Promise<void>(done => setTimeout(done, 2_500));
  const folder = server.files.find(file => file.mimeType === 'application/vnd.google-apps.folder' && file.name === 'realtime');
  expect(folder, 'the board created its realtime presence folder').toBeTruthy();

  // A peer that left without deleting its file, in the shape Drive actually
  // returns: still named by the listing, still downloadable, no metadata. Fresh
  // timestamps, so the poll treats it as a session that might be alive.
  const now = new Date().toISOString();
  const ghost = server.addFile(`sig-pboard-operations-${boardId}-ghost.json`, folder!.id, JSON.stringify({ updatedAt: Date.now(), peers: [], outbox: [] }));
  ghost.modifiedTime = now; ghost.createdTime = now;
  server.unavailable.add(ghost.id);

  const asked = () => server.requests.filter(url => url.includes(ghost.id) && !url.includes('alt=media')).length;
  const listed = () => server.requests.filter(url => url.includes('/files?') && url.includes(folder!.id)).length;
  const listings = listed();
  await new Promise<void>(done => setTimeout(done, 22_000));

  // The window has to contain several passes, or "asked once" would only prove
  // the room was idle.
  expect(listed() - listings, 'the presence folder was polled repeatedly').toBeGreaterThanOrEqual(3);
  // The file was planted after the room started, so every ask for it falls in
  // this window: ten seconds of role cache plus permanent memory means one.
  expect(asked(), 'metadata asks for a presence file Drive cannot describe').toBe(1);
  const room = roomSnapshots().find(snapshot => snapshot.boardId === boardId);
  expect(room?.listed).toContain('ghost');
  expect(room?.roles.ghost).toBe('unresolved');
  expect(room?.connected).toEqual([]);
});
