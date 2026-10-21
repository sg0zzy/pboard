import { afterEach, expect, it, vi } from 'vitest';

/**
 * The background service worker schedules an idle sync for a board whose sync
 * state is pending. A sync that leaves the board pending writes the state
 * again, so the worker must not schedule a second sync for the same board: the
 * board would then sync in a tight loop, using a full CPU and a steady stream
 * of Drive requests.
 */
const mocks = vi.hoisted(() => ({
  storageListeners: [] as ((changes: Record<string, unknown>, area: string) => void)[],
  alarmListeners: [] as ((alarm: { name: string }) => void)[],
  alarms: [] as { name: string; when: number }[],
  state: new Map<string, { projectId: string; dirty: boolean; status: string; changeToken?: number }>(),
  synced: [] as string[]
}));

vi.mock("../../src/platform/browser", () => ({
  browser: {
    storage: {
      onChanged: { addListener: (listener: (changes: Record<string, unknown>, area: string) => void) => { mocks.storageListeners.push(listener); } },
      local: {
        get: async (key: string) => ({ [key]: mocks.state.get(key) }),
        set: async (values: Record<string, unknown>) => {
          const changes: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { newValue: value };
            mocks.state.set(key, value as never);
          }
          for (const listener of mocks.storageListeners) listener(changes, "local");
        },
        remove: async (key: string) => { mocks.state.delete(key); }
      }
    },
    alarms: {
      create: async (name: string, options: { when: number }) => { mocks.alarms.push({ name, when: options.when }); },
      onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => { mocks.alarmListeners.push(listener); } }
    },
    runtime: { onMessage: { addListener: () => {} } }
  }
}));

vi.mock("../../src/sync/browser", () => ({
  googleDrive: {
    getConnectionState: async () => "connected",
    syncProject: async (projectId: string) => { mocks.synced.push(projectId); return "pushed"; },
    reconcileAll: async () => ({ status: "reconciled", imported: 0, pulled: 0, pushed: 0, deleted: 0 })
  },
  driveSyncState: {
    get: async (projectId: string) => mocks.state.get(`pboardDriveProject:${projectId}`) as never,
    set: async (state: { projectId: string }) => { mocks.state.set(`pboardDriveProject:${state.projectId}`, state as never); }
  }
}));

import { registerDriveBackgroundSync } from "../../src/sync/background";

afterEach(() => {
  mocks.storageListeners.length = 0;
  mocks.alarmListeners.length = 0;
  mocks.alarms.length = 0;
  mocks.state.clear();
  mocks.synced.length = 0;
});

it('does not schedule a second sync for a board that already has one', async () => {
  registerDriveBackgroundSync();
  const projectId = 'board';
  // The board has a pending local change.
  mocks.state.set(`pboardDriveProject:${projectId}`, { projectId, dirty: true, status: 'pending', changeToken: 1 });
  mocks.storageListeners[0]({ [`pboardDriveProject:${projectId}`]: { newValue: mocks.state.get(`pboardDriveProject:${projectId}`) } }, "local");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(mocks.alarms.length).toBe(1);

  // The scheduled sync runs and leaves the board pending.
  mocks.state.set(`pboardDriveProject:${projectId}`, { projectId, dirty: true, status: 'pending', changeToken: 1 });
  mocks.storageListeners[0]({ [`pboardDriveProject:${projectId}`]: { newValue: mocks.state.get(`pboardDriveProject:${projectId}`) } }, "local");
  await new Promise(resolve => setTimeout(resolve, 20));
  // The board already had a sync scheduled, so it did not get another one.
  expect(mocks.alarms.length).toBe(1);
});

it('lets the board sync again after the scheduled sync ran', async () => {
  registerDriveBackgroundSync();
  const projectId = 'board';
  mocks.state.set(`pboardDriveProject:${projectId}`, { projectId, dirty: true, status: 'pending', changeToken: 1 });
  mocks.storageListeners[0]({ [`pboardDriveProject:${projectId}`]: { newValue: mocks.state.get(`pboardDriveProject:${projectId}`) } }, "local");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(mocks.alarms.length).toBe(1);

  // The alarm fires: the board's sync runs.
  mocks.alarmListeners[0]({ name: `pboard-drive-sync:${projectId}` });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(mocks.synced).toEqual([projectId]);

  // The sync left the board pending, so it is scheduled again — with a delay,
  // not immediately.
  expect(mocks.alarms.length).toBe(2);
  expect(mocks.alarms[1].when).toBeGreaterThan(Date.now());
});
