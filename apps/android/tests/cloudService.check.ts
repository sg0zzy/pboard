import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RxRepository } from '../src/storage/repository';
import { createSyncStorage } from '../src/sync/storage';
const mocks = vi.hoisted(() => {
  const live = { role: 'editor', connectedPeers: ['peer'], error: null as string | null };
  return { reconcile: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), live, dirty: vi.fn(), tombstone: vi.fn(), invite: vi.fn() };
});
vi.mock('../../../src/sync/runtime', () => ({
  createDriveRuntime: () => ({
    googleDrive: { reconcileAll: mocks.reconcile },
    collaborationManager: { start: mocks.start, stop: mocks.stop, refreshRole: mocks.refresh, state: () => mocks.live },
    driveSyncState: { markDirty: mocks.dirty, get: async () => ({ remoteFileId: 'backup' }) },
    driveTombstones: { add: mocks.tombstone },
    drivePermissions: { invite: mocks.invite, myRole: vi.fn() },
    sharedProjects: { get: async () => ({}) },
  }),
}));
import { createAndroidSync, type AndroidSync } from '../src/sync/service';
let service: AndroidSync;
let connected: boolean;
const repository = { setMutatorRole: vi.fn() } as unknown as RxRepository;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear(); connected = true;
  mocks.live.role = 'editor'; mocks.live.error = null;
  mocks.reconcile.mockResolvedValue(undefined); mocks.start.mockResolvedValue(undefined); mocks.stop.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined); mocks.invite.mockResolvedValue(undefined);
  service = createAndroidSync(async () => repository, {
    isConfigured: () => true, getConnectionState: async () => connected ? 'connected' : 'disconnected',
    connect: async () => { connected = true; }, disconnect: async () => { connected = false; }, getAccessToken: async () => 'token',
  }, createSyncStorage());
});
afterEach(async () => { await service.dispose(); vi.useRealTimers(); });
describe('Android foreground sync lifecycle', () => {
  it('stays offline until connected and foreground, coalesces edits and stops timers/pools when backgrounded', async () => {
    connected = false;
    await service.initialize(); await service.setForeground(true); await service.selectProject('board');
    expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    await service.connect();
    expect(mocks.reconcile).toHaveBeenCalledTimes(1); expect(mocks.start).toHaveBeenCalledWith('board');
    await service.events.projectChanged?.('board'); await service.events.projectChanged?.('board');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.reconcile).toHaveBeenCalledTimes(2); expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalled();
    await service.setForeground(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.reconcile).toHaveBeenCalledTimes(2); expect(mocks.stop).toHaveBeenCalled();
  });
  it('keeps failed sync visible and retries on the next foreground interval', async () => {
    await service.initialize(); mocks.reconcile.mockRejectedValueOnce(new Error('Network unavailable'));
    await service.setForeground(true);
    expect(service.state().error).toBe('Network unavailable');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(service.state().error).toBe(''); expect(service.state().lastSynced).not.toBe('');
  });
  it('clears a recovered live error without clearing a separate backup failure', async () => {
    await service.initialize(); await service.setForeground(true);
    mocks.live.error = 'Connection failed';
    service.pollLive();
    expect(service.state().error).toBe('Connection failed');
    mocks.live.error = null;
    service.pollLive();
    expect(service.state().error).toBe('');
    mocks.live.error = 'Connection failed';
    service.pollLive();
    mocks.reconcile.mockRejectedValueOnce(new Error('Backup unavailable'));
    await service.sync();
    mocks.live.error = null;
    service.pollLive();
    expect(service.state().error).toBe('Backup unavailable');
  });
  it('does not start collaboration after a late reconciliation returns from the background', async () => {
    await service.initialize();
    let complete!: () => void;
    mocks.reconcile.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const foreground = service.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    await service.setForeground(false);
    await service.selectProject('board');
    complete(); await foreground;
    expect(mocks.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });
  it('records deletion before a local delete and preserves viewer protection after leaving the live room', async () => {
    await service.initialize(); await service.setForeground(true); await service.selectProject('board');
    const project = { id: 'board', revision: 7, updatedAt: '2026-10-14T12:00:00Z' };
    await service.events.projectDeleting?.(project as Parameters<NonNullable<typeof service.events.projectDeleting>>[0]);
    expect(mocks.tombstone).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'board', revision: 7, remoteFileId: 'backup' }));
    mocks.live.role = 'viewer';
    await service.selectProject(null);
    expect(repository.setMutatorRole).toHaveBeenCalledWith('board', 'viewer');
  });
  it('restores the cached viewer gate when a board is opened while disconnected', async () => {
    mocks.live.role = 'viewer';
    await service.initialize(); await service.setForeground(true); await service.selectProject('board');
    await service.disconnect(); await service.selectProject(null);
    mocks.start.mockClear();
    await service.selectProject('board');
    expect(service.state().role).toBe('viewer');
    expect(repository.setMutatorRole).toHaveBeenLastCalledWith('board', 'viewer');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('fails closed when role discovery fails and allows an explicit retry', async () => {
    await service.initialize(); await service.setForeground(true);
    mocks.start.mockRejectedValueOnce(new Error('Permission check unavailable'));
    await service.selectProject('board');
    expect(service.state().role).toBe('viewer'); expect(service.state().error).toContain('Permission check');
    await service.sync();
    expect(service.state().role).toBe('editor'); expect(service.state().error).toBe('');
  });
});
