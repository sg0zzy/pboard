import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storageListeners: [] as ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[],
  writes: [] as string[],
  data: new Map<string, unknown>()
}));

vi.mock("../../src/platform/browser", () => ({
  browser: {
    storage: {
      onChanged: {
        addListener: (l: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => { mocks.storageListeners.push(l); }
      },
      local: {
        get: async (key: string) => ({ [key]: mocks.data.get(key) }),
        set: async (values: Record<string, unknown>) => {
          const changes: Record<string, { newValue?: unknown }> = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { newValue: value };
            mocks.data.set(key, value);
            mocks.writes.push(key);
          }
          for (const l of mocks.storageListeners) l(changes, "local");
        },
        remove: async (key: string) => { mocks.data.delete(key); }
      }
    },
    runtime: { onMessage: { addListener: () => {} } },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } }
  }
}));

vi.mock("../../src/sync/browser", () => ({
  googleDrive: {
    getConnectionState: async () => "connected",
    syncProject: async () => "not-dirty",
    reconcileAll: async () => ({ status: "reconciled", imported: 0, pulled: 0, pushed: 0, deleted: 0 })
  },
  driveSyncState: { get: async () => ({ projectId: 'x', dirty: false, status: 'synced' }), set: async () => {} }
}));

import { createDriveRuntime } from "../../src/sync/runtime";
import { createGoogleAuthProvider } from "../../src/sync/googleAuth";

/**
 * The shared-project layout is re-recorded on every discovery pass and on
 * every signaling round trip. Writing it when nothing changed is not free: the
 * sidebar watches the key and restarts its Drive reconciliation and its
 * collaboration session on every write, so an unchanged layout would keep both
 * running. Firefox fires the change event for an identical value as well, so
 * the write must be skipped here.
 */
afterEach(() => {
  mocks.storageListeners.length = 0;
  mocks.writes.length = 0;
  mocks.data.clear();
});

function runtimeWithStorage(storage: {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}) {
  const auth = createGoogleAuthProvider({
    clientId: "id", identity: { getRedirectURL: () => "", launchWebAuthFlow: async () => undefined },
    storage, now: () => Date.now()
  });
  return createDriveRuntime({ auth, storage, getRepository: async () => null, hasSignalingHostPermission: async () => false });
}

it("does not rewrite a shared-project layout that did not change", async () => {
  const storage = {
    get: async (key: string) => ({ [key]: mocks.data.get(key) }),
    set: async (values: Record<string, unknown>) => {
      const changes: Record<string, { newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { newValue: value };
        mocks.data.set(key, value);
        mocks.writes.push(key);
      }
      for (const l of mocks.storageListeners) l(changes, "local");
    }
  };
  const runtime = runtimeWithStorage(storage);

  // A shared board is already known with a complete layout.
  mocks.data.set("pboardDriveSharedProjects", {
    board: { folderId: "f1", projectFileId: "p1", realtimeFolderId: "r1" }
  });

  const before = mocks.writes.length;
  const layout = await runtime.sharedProjects.get("board");
  console.log("layout:", JSON.stringify(layout));
  expect(mocks.writes.length - before).toBe(0);

  // The discovery path re-records the layout it just read.
  const afterGet = mocks.writes.length;
  await runtime.sharedProjects.set("board", { folderId: "f1", projectFileId: "p1" });
  console.log("writes caused by re-recording an unchanged layout:", mocks.writes.length - afterGet);
  expect(mocks.writes.length - afterGet).toBe(0);

  // A changed layout is still recorded.
  const afterUnchanged = mocks.writes.length;
  await runtime.sharedProjects.set("board", { realtimeFolderId: "r2" });
  console.log("writes caused by recording a changed layout:", mocks.writes.length - afterUnchanged);
  expect(mocks.writes.length - afterUnchanged).toBe(1);
  expect((await runtime.sharedProjects.get("board")).realtimeFolderId).toBe("r2");
});

it("does not rewrite the layout when a board is deleted twice", async () => {
  const storage = {
    get: async (key: string) => ({ [key]: mocks.data.get(key) }),
    set: async (values: Record<string, unknown>) => {
      const changes: Record<string, { newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { newValue: value };
        mocks.data.set(key, value);
        mocks.writes.push(key);
      }
      for (const l of mocks.storageListeners) l(changes, "local");
    }
  };
  const runtime = runtimeWithStorage(storage);
  mocks.data.set("pboardDriveSharedProjects", { board: { folderId: "f1", projectFileId: "p1", realtimeFolderId: "r1" } });

  await runtime.sharedProjects.delete("board");
  const afterDelete = mocks.writes.length;
  await runtime.sharedProjects.delete("board");
  console.log("writes caused by deleting an unknown board:", mocks.writes.length - afterDelete);
  expect(mocks.writes.length - afterDelete).toBe(0);
});
