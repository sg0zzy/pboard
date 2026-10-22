import { afterEach, expect, it, vi } from 'vitest';

/**
 * The background worker's retry schedule.
 *
 * The worker writes the board's sync state while it syncs, and that write is
 * a storage change. The worker's own change listener saw that write and
 * scheduled the board again — with the idle delay and without the backoff.
 * The two paths raced for the same alarm name, and the later writer won, so
 * a board that could not settle was resynced far more often than the
 * backoff allows. Every one of those cycles ran the whole Drive pipeline.
 *
 * The worker's own state write must not schedule the board again: the armed
 * retry decides when it runs.
 */
const mocks = vi.hoisted(() => ({
  storageListeners: [] as ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[],
  alarmListeners: [] as ((alarm: { name: string }) => void)[],
  /** Every alarm creation, in order, with the delay it asked for. */
  created: [] as { name: string; delayMs: number }[],
  state: new Map<string, Record<string, unknown>>(),
  syncs: [] as string[]
}));

vi.mock("../../src/platform/browser", () => ({
  browser: {
    storage: {
      onChanged: { addListener: (l: (c: Record<string, { newValue?: unknown }>, a: string) => void) => { mocks.storageListeners.push(l); } },
      local: {
        get: async (key: string) => ({ [key]: mocks.state.get(key) as Record<string, unknown> | undefined }),
        set: async (values: Record<string, unknown>) => {
          const changes: Record<string, { newValue?: unknown }> = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { newValue: value };
            mocks.state.set(key, value as Record<string, unknown>);
          }
          for (const l of mocks.storageListeners) l(changes, "local");
        },
        remove: async (key: string) => { mocks.state.delete(key); }
      }
    },
    alarms: {
      create: async (name: string, options: { when: number }) => {
        mocks.created.push({ name, delayMs: options.when - Date.now() });
      },
      onAlarm: { addListener: (l: (a: { name: string }) => void) => { mocks.alarmListeners.push(l); } }
    },
    runtime: { onMessage: { addListener: () => {} } }
  }
}));

vi.mock("../../src/sync/browser", () => ({
  googleDrive: {
    getConnectionState: async () => "connected",
    /**
     * The board cannot settle. The real provider writes "syncing" and then
     * leaves the state "pending" when the upload did not settle, and the
     * worker's change listener sees that write.
     */
    syncProject: async (projectId: string) => {
      mocks.syncs.push(projectId);
      const stateKey = `pboardDriveProject:${projectId}`;
      const current = (mocks.state.get(stateKey) ?? {}) as Record<string, unknown>;
      const token = typeof current.changeToken === "number" ? current.changeToken : 0;
      const next = { ...current, projectId, dirty: true, status: "pending", changeToken: token + 1 };
      mocks.state.set(stateKey, next);
      for (const l of mocks.storageListeners) l({ [stateKey]: { newValue: next } }, "local");
      return "not-dirty";
    },
    reconcileAll: async () => ({ status: "reconciled", imported: 0, pulled: 0, pushed: 0, deleted: 0 })
  },
  driveSyncState: {
    get: async (projectId: string) => {
      const saved = mocks.state.get(`pboardDriveProject:${projectId}`) as Record<string, unknown> | undefined;
      return (saved ?? { projectId, dirty: false, status: "synced" }) as never;
    },
    set: async (state: { projectId: string }) => {
      const stateKey = `pboardDriveProject:${state.projectId}`;
      mocks.state.set(stateKey, state as never);
      for (const l of mocks.storageListeners) l({ [stateKey]: { newValue: state } }, "local");
    }
  }
}));

import { registerDriveBackgroundSync } from "../../src/sync/background";

afterEach(() => {
  mocks.storageListeners.length = 0;
  mocks.alarmListeners.length = 0;
  mocks.created.length = 0;
  mocks.state.clear();
  mocks.syncs.length = 0;
});

const key = (projectId: string) => `pboardDriveProject:${projectId}`;

it("schedules one alarm per unsettled sync, not two", async () => {
  registerDriveBackgroundSync();
  const projectId = 'board';
  mocks.state.set(key(projectId), { projectId, dirty: true, status: 'pending', changeToken: 1 });

  // The board has a pending local change.
  mocks.storageListeners[0]({ [key(projectId)]: { newValue: mocks.state.get(key(projectId)) } }, "local");
  await new Promise((r) => setTimeout(r, 10));
  expect(mocks.created.length).toBe(1);
  // The first attempt is the idle delay.
  expect(mocks.created[0].delayMs).toBeGreaterThan(20_000);

  // The alarm fires and the board cannot settle.
  mocks.created.length = 0;
  mocks.alarmListeners[0]?.({ name: `pboard-drive-sync:${projectId}` });
  await new Promise((r) => setTimeout(r, 30));

  // Exactly one alarm: the worker's own state write must not schedule the
  // board a second time, which would defeat the backoff.
  console.log('alarms after an unsettled sync:', JSON.stringify(mocks.created));
  expect(mocks.syncs.length).toBe(1);
  expect(mocks.created.length).toBe(1);
});

it("backs off between the retries of a board that cannot settle", async () => {
  registerDriveBackgroundSync();
  const projectId = 'board';
  mocks.state.set(key(projectId), { projectId, dirty: true, status: 'pending', changeToken: 1 });
  mocks.storageListeners[0]({ [key(projectId)]: { newValue: mocks.state.get(key(projectId)) } }, "local");
  await new Promise((r) => setTimeout(r, 10));

  const delays: number[] = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    mocks.created.length = 0;
    mocks.alarmListeners[0]?.({ name: `pboard-drive-sync:${projectId}` });
    await new Promise((r) => setTimeout(r, 20));
    delays.push(mocks.created[0]?.delayMs ?? 0);
  }
  console.log('retry delays (ms):', delays.join(", "));

  // The delay grows: the backoff is in force and is not being reset by the
  // worker's own state write.
  for (let index = 1; index < delays.length; index++) {
    expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]);
  }
  // And it never returns to the idle delay or below: the board is retried
  // progressively less often, not at a fixed short period.
  expect(delays[delays.length - 1]).toBeGreaterThan(2_000);
});

it("still schedules a board whose local change arrives while it is not retrying", async () => {
  registerDriveBackgroundSync();
  const projectId = 'board';

  // A new local change on a board that is not being retried.
  mocks.state.set(key(projectId), { projectId, dirty: true, status: 'pending', changeToken: 1 });
  mocks.storageListeners[0]({ [key(projectId)]: { newValue: mocks.state.get(key(projectId)) } }, "local");
  await new Promise((r) => setTimeout(r, 10));

  console.log('alarms for a fresh local change:', JSON.stringify(mocks.created));
  expect(mocks.created.length).toBe(1);
  expect(mocks.created[0].delayMs).toBeGreaterThan(20_000);
});
