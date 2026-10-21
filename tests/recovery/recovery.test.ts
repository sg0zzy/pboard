import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveTransport } from '../../src/sync/driveTransport';
import { installLiveBoardMutations } from '../../src/collab/security/liveMutations';
import { DriveFixture, openDevice, sampleImage, type RecoveryDevice } from './harness';
const devices: RecoveryDevice[] = [];
async function device(cloud: DriveFixture, account?: string) { const d = await openDevice(cloud, account); devices.push(d); return d; }
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const d of devices.splice(0)) await d.destroy(); });

describe('recovery component boundaries (synthetic Google; real RxDB)', () => {
  it('[M01] offline private editing and export do not invoke a remote transport', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud); await a.auth.disconnect();
    const board = await a.repo.createProject('Local only', 'project');
    const card = await a.repo.addItem({ projectId: board.id, content: 'Offline text', image: sampleImage });
    await a.repo.updateItem(card.id, { content: 'Offline revision' });
    await a.restart();
    expect((await a.repo.exportProject(board.id)).items[0]).toMatchObject({ id: card.id, content: 'Offline revision', image: sampleImage });
    expect(cloud.calls).toEqual([]);
  });
  it('[PR01] a fresh device restores private boards and image bytes after the source is permanently removed', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('Recover private board', 'project');
    const card = await a.repo.addItem({ projectId: board.id, content: 'Original text', image: sampleImage });
    const second = await a.repo.createProject('Second private board', 'idea');
    await a.repo.addItem({ projectId: second.id, content: 'Second board text' });
    await a.provider.syncProject(board.id); await a.provider.syncProject(second.id);
    const foreign = await device(cloud, 'account-b'); const hidden = await foreign.repo.createProject('Other account', 'idea'); await foreign.provider.syncProject(hidden.id);
    await a.destroy();
    const restored = await device(cloud);
    expect(await restored.repo.listProjects()).toEqual([]);
    const result = await restored.provider.reconcileAll();
    expect(result.imported).toBe(2);
    expect(await restored.repo.getProject(hidden.id)).toBeNull();
    expect((await restored.repo.listCards(second.id))[0].content).toBe('Second board text');
    expect((await restored.repo.exportProject(board.id)).items[0]).toMatchObject({ id: card.id, content: 'Original text', image: sampleImage });
    await restored.restart();
    expect((await restored.repo.exportProject(board.id)).items[0].image).toEqual(sampleImage);
    expect((await restored.provider.reconcileAll()).imported).toBe(0);
    expect(await restored.repo.listCards(board.id)).toHaveLength(1);
  });
  it('[PR02] restoring a signed private snapshot does not restore or mint shared-board authority', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('Signed board in private persistence', 'project');
    await a.repo.addItem({ projectId: board.id, content: 'Signed source' });
    await a.grants.configure({ provider: 'websocket', url: 'wss://fixture.example.test/ws' });
    await a.grants.initialize(board.id);
    const security = (await a.grants.security(board.id))!;
    const guard = await installLiveBoardMutations({ projectId: board.id, projects: a.repo.db.projects, cards: a.repo.db.cards, security, attestExisting: true, preserveSignedData: true });
    try {
      await a.state.markDirty(board.id); await a.provider.syncProject(board.id);
    } finally { await guard.uninstall(); }
    const signed = (await a.repo.db.projects.findOne(board.id).exec())!.toJSON()._sec;
    expect(signed).toBeDefined(); await a.destroy();
    const b = await device(cloud); await b.provider.reconcileAll();
    expect((await b.repo.db.projects.findOne(board.id).exec())!.toJSON()._sec).toEqual(signed);
    expect(await b.grants.localBundle(board.id)).toBeNull();
    expect(await b.grants.ownsAuthority(board.id)).toBe(false);
    expect(await b.grants.security(board.id)).toBeNull();
    expect(b.storage.data.pboardSecurityPins).toBeUndefined();
    expect(b.storage.data.pboardBoardGrants).toBeUndefined();
  });
  it('[R04] pending private changes survive a repository restart and a failed upload', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('Pending after restart', 'project');
    const card = await a.repo.addItem({ projectId: board.id, content: 'Durable pending text' });
    cloud.available = false;
    await expect(a.provider.syncProject(board.id)).rejects.toThrow('network unavailable');
    await a.restart();
    expect(await a.state.get(board.id)).toMatchObject({ dirty: true });
    expect((await a.repo.getCard(card.id))?.content).toBe('Durable pending text');
    cloud.available = true; await a.provider.syncProject(board.id);
    expect(await a.state.get(board.id)).toMatchObject({ dirty: false });
  });
  it('[R05] a committed private create with a lost acknowledgement is found on retry without a duplicate', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('Lost acknowledgement', 'project');
    cloud.failNext('upload', true);
    await expect(a.provider.syncProject(board.id)).rejects.toThrow('acknowledgement lost');
    expect(cloud.histories('account-a')).toHaveLength(1);
    expect(cloud.snapshots('account-a')).toHaveLength(0);
    expect(await a.state.get(board.id)).toMatchObject({ dirty: true });
    await a.restart(); await a.provider.syncProject(board.id);
    expect(cloud.snapshots('account-a')).toHaveLength(1);
    expect(cloud.histories('account-a')).toHaveLength(1);
    expect(await a.state.get(board.id)).toMatchObject({ dirty: false });
  });
  it('[R06] an edit made while an upload is held remains pending and is sent subsequently', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('In-flight save', 'project');
    const card = await a.repo.addItem({ projectId: board.id, content: 'Before request' });
    const hold = cloud.pauseNext('upload'); const uploading = a.provider.syncProject(board.id);
    await hold.started;
    try { await a.repo.updateItem(card.id, { content: 'After request began' }); }
    finally { hold.release(); }
    await uploading;
    expect(await a.state.get(board.id)).toMatchObject({ dirty: true });
    expect((await a.repo.getCard(card.id))?.content).toBe('After request began');
    await a.provider.syncProject(board.id);
    expect(cloud.snapshots('account-a')[0].items[0].content).toBe('After request began');
  });
  it('[R08] existing request retries are bounded and jitter is controlled without wall-clock sleeps', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ files: [] }), { status: 503 }));
    const transport = createDriveTransport({ getAccessToken: async () => 'synthetic-token', getConnectionState: async () => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} }, fetcher);
    const result = transport.listProjectFiles().catch(error => error);
    await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await result).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('[R09] a failed remote listing preserves existing boards, images and dirty markers', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('Keep local data', 'project');
    await a.repo.addItem({ projectId: board.id, content: 'Keep text', image: sampleImage });
    const before = await a.repo.exportProject(board.id); const state = await a.state.get(board.id);
    cloud.failNext('list');
    await expect(a.provider.reconcileAll()).rejects.toThrow('interrupted');
    expect(await a.repo.exportProject(board.id)).toEqual(before);
    expect(await a.state.get(board.id)).toEqual(state);
  });
});

describe('private reconciliation targets and remaining explicit gaps', () => {
  it('[C03] private reconciliation preserves independent offline edits to different cards', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud); const b = await device(cloud);
    const board = await a.repo.createProject('Independent edits', 'project');
    const first = await a.repo.addItem({ projectId: board.id, content: 'Base one' });
    const second = await a.repo.addItem({ projectId: board.id, content: 'Base two' });
    await a.provider.syncProject(board.id); await b.provider.reconcileAll();
    const clock = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(clock + 1_000);
    await a.repo.updateItem(first.id, { content: 'Device A edit' });
    await b.repo.updateItem(second.id, { content: 'Device B edit' });
    // Make the remote board strictly newer deterministically; clocks must never
    // justify losing A's independent card edit under the approved contract.
    await b.repo.db.projects.findOne(board.id).exec().then(d => d!.incrementalPatch({ updatedAt: new Date(clock + 10_000).toISOString() }));
    await a.provider.syncProject(board.id); await b.provider.syncProject(board.id); await a.provider.reconcileAll();
    expect((await a.repo.getCard(first.id))?.content).toBe('Device A edit');
    expect((await a.repo.getCard(second.id))?.content).toBe('Device B edit');
  });
  it('[M07] changing accounts must not upload an unbound-to-the-new-account board', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    await a.repo.createProject('Account A local work', 'project');
    await a.providerFor('account-b').reconcileAll();
    expect(cloud.snapshots('account-b')).toEqual([]);
  });
  it('[M06] logout invalidates an already downloading private snapshot before applying it', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud); const b = await device(cloud);
    const board = await a.repo.createProject('Late response after logout', 'project'); await a.provider.syncProject(board.id);
    const hold = cloud.pauseNext('download'); const recovering = b.provider.reconcileAll();
    await hold.started;
    try { await b.auth.disconnect(); } finally { hold.release(); }
    await recovering;
    expect(await b.repo.getProject(board.id)).toBeNull();
  });
  it('[A08] a cached viewer must remain unable to mutate a shared board after restart', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('Cached view-only board', 'project');
    const card = await a.repo.addItem({ projectId: board.id, content: 'View only' });
    a.repo.setMutatorRole(board.id, 'viewer');
    await expect(a.repo.updateItem(card.id, { content: 'Blocked before restart' })).rejects.toThrow('view-only');
    await a.restart();
    await expect(a.repo.updateItem(card.id, { content: 'Still must be blocked' })).rejects.toThrow('view-only');
  });
  it('[A04] expired remote membership must preserve an authorized editor local draft save', async () => {
    const cloud = new DriveFixture(); const a = await device(cloud);
    const board = await a.repo.createProject('Expired publication grant', 'project');
    const card = await a.repo.addItem({ projectId: board.id, content: 'Before expiry' });
    await a.grants.configure({ provider: 'websocket', url: 'wss://fixture.example.test/ws' });
    await a.grants.initialize(board.id); const security = (await a.grants.security(board.id))!;
    const guard = await installLiveBoardMutations({ projectId: board.id, projects: a.repo.db.projects, cards: a.repo.db.cards, security, attestExisting: true, preserveSignedData: true });
    try {
      vi.spyOn(Date, 'now').mockReturnValue(security.manifest.expiresAt + 1);
      await expect(a.repo.updateItem(card.id, { content: 'Durable offline draft' })).resolves.toBeUndefined();
      expect((await a.repo.getCard(card.id))?.content).toBe('Durable offline draft');
      expect((await a.repo.db.cards.findOne(card.id).exec())?.content).toBe('Before expiry');
      await a.restart();
      expect((await a.repo.getCard(card.id))?.content).toBe('Durable offline draft');
    } finally { await guard.uninstall(); }
  });
});
