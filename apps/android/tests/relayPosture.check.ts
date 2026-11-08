import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('../../../src/sync/runtime', () => ({
  createDriveRuntime: () => ({
    googleDrive: { reconcileAll: vi.fn(), syncProject: vi.fn() },
    authorizePrivatePersistence: vi.fn(async () => {}),
    collaborationManager: { start: mocks.start, stop: mocks.stop, refreshRole: vi.fn(), state: () => ({ role: 'private', connectedPeers: [], error: null }) },
    driveSyncState: { markDirty: vi.fn(), get: async () => ({}) },
    driveTombstones: { add: vi.fn() },
    drivePermissions: { invite: vi.fn(), myRole: vi.fn() },
    sharedProjects: { get: async () => ({}) },
  }),
}));
import '../src/sync/service';
import { webrtcDisabledForTesting } from '../../../src/collab/liveTransport';
import { createBoardGrantService, DEFAULT_RENDEZVOUS } from '../../../src/collab/boardGrants';

describe('android relay posture', () => {
  it('adopts the extension websocket posture so the account channel resolves the rendezvous', async () => {
    expect(webrtcDisabledForTesting()).toBe(true);
    const values: Record<string, unknown> = {};
    const storage = {
      get: async (id: string) => ({ [id]: structuredClone(values[id]) }),
      set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); },
    };
    expect(await createBoardGrantService({ storage }).settings()).toEqual({ provider: 'websocket', url: DEFAULT_RENDEZVOUS });
  });
});
