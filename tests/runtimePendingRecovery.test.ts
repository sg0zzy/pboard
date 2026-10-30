import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CollaborationManagerOptions } from '../src/collab/manager';
import { createDriveRuntime } from '../src/sync/runtime';
import type { RxRepository } from '../src/storage/rxdbRepository';
import { collaborationSecurityFixture } from './helpers/collaborationSecurity';

const manager = vi.hoisted(() => ({ options: null as CollaborationManagerOptions | null,
  refreshRole: vi.fn(async () => {}), start: vi.fn(async (_board: string) => {}) }));
vi.mock('../src/collab/manager', () => ({ createCollaborationManager: (options: CollaborationManagerOptions) => {
  manager.options = options; return { refreshRole: manager.refreshRole, start: manager.start };
} }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  vi.stubEnv('VITE_PBOARD_SIGNALING_PROVIDER', 'drive');
  const fixture = collaborationSecurityFixture();
  const security = await fixture.boardSecurity('board');
  const repo = { installBoardSecurity: vi.fn(async () => ({ projectId: 'board', uninstall: vi.fn(async () => {}) })),
    admitPendingWork: vi.fn(async (_board: string) => {}) };
  const data: Record<string, unknown> = {};
  const runtime = createDriveRuntime({ operationSync: false, auth: { getAccessToken: async () => { throw new Error('No account connected'); }, getConnectionState: async () => 'disconnected',
    isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
    storage: { get: async key => ({ [key]: data[key] }), set: async values => { Object.assign(data, values); } },
    getRepository: async () => repo as unknown as RxRepository,
    fetcher: vi.fn(async () => { throw new Error('No network expected'); }) });
  await manager.options!.installMutationGuard!('board', security!);
  return { runtime, repo, security: security! };
}
it('reconciles pending work under an existing current managed guard without restarting healthy transports', async () => {
  const f = await setup();
  await expect(f.runtime.renewBoardAuthorization('board')).resolves.toEqual({ role: 'owner' });
  expect(manager.refreshRole).toHaveBeenCalledOnce();
  expect(f.repo.admitPendingWork).toHaveBeenCalledWith('board');
  expect(manager.start).not.toHaveBeenCalled();
});
it('does not treat the continued presence of an expired guard as authorization', async () => {
  const f = await setup(); f.security.manifest.expiresAt = Date.now() - 1;
  await expect(f.runtime.renewBoardAuthorization('board')).rejects.toThrow('No current board authorization');
  expect(manager.start).toHaveBeenCalledWith('board');
  expect(f.repo.admitPendingWork).not.toHaveBeenCalled();
});
it('reconciles after the manager replaces its expired authorization', async () => {
  const f = await setup();
  const renewed = { ...f.security, manifest: { ...f.security.manifest, epoch: 2, expiresAt: Date.now() + 300000 } };
  f.security.manifest.expiresAt = Date.now() - 1;
  manager.start.mockImplementationOnce(async () => {
    await manager.options!.removeMutationGuard!('board');
    await manager.options!.installMutationGuard!('board', renewed);
  });
  await expect(f.runtime.renewBoardAuthorization('board')).resolves.toEqual({ role: 'owner' });
  expect(f.repo.admitPendingWork).toHaveBeenCalledWith('board');
});
it('retains pending work when authorization refresh fails', async () => {
  const f = await setup(); manager.refreshRole.mockRejectedValueOnce(new Error('Authorization unavailable'));
  await expect(f.runtime.renewBoardAuthorization('board')).rejects.toThrow('Authorization unavailable');
  expect(f.repo.admitPendingWork).not.toHaveBeenCalled();
});
it('never admits held edits after the manager reports removal of access', async () => {
  const f = await setup();
  manager.refreshRole.mockImplementationOnce(async () => { await manager.options!.removeMutationGuard!('board'); });
  await expect(f.runtime.renewBoardAuthorization('board')).rejects.toThrow('No current board authorization');
  expect(f.repo.admitPendingWork).not.toHaveBeenCalled();
});
