import { afterEach, expect, it } from "vitest";
import { createDriveSyncStateStore, sameSyncState, type DriveProjectSyncState } from "../../src/sync/state";
import type { KeyValueStorage } from "../../src/storage/repository";

/**
 * The board's sync state is watched by the background worker, which schedules
 * a sync whenever the state says a board is pending. Firefox fires
 * `storage.onChanged` for a write whose value is identical to the stored one,
 * so a write that changes nothing would make the worker repeat the sync.
 */
const stores: { writes: number; data: Map<string, unknown> }[] = [];

afterEach(() => {
  stores.length = 0;
});

function memoryStorage() {
  const data = new Map<string, unknown>();
  const counter = { writes: 0, data };
  stores.push(counter);
  const storage: KeyValueStorage = {
    async get(key) { return { [key]: data.get(key) }; },
    async set(values) {
      counter.writes++;
      for (const [key, value] of Object.entries(values)) data.set(key, value);
    }
  };
  return { storage, counter };
}

it("does not write a sync state that did not change", async () => {
  const { storage, counter } = memoryStorage();
  const state = createDriveSyncStateStore(storage);

  await state.markSyncing("board");
  expect(counter.writes).toBe(1);
  expect((await state.get("board")).status).toBe("syncing");

  // The board is already syncing: the same transition must not be written.
  await state.markSyncing("board");
  console.log("writes after two identical markSyncing calls:", counter.writes);
  expect(counter.writes).toBe(1);

  // The same error must not be written twice either.
  await state.markError("board", "Drive is offline");
  const afterError = counter.writes;
  await state.markError("board", "Drive is offline");
  console.log("writes after two identical markError calls:", counter.writes - afterError);
  expect(counter.writes - afterError).toBe(0);

  // A different error is a change and is written.
  await state.markError("board", "Drive is unreachable");
  expect(counter.writes).toBe(afterError + 1);
});

it("writes a changed sync state", async () => {
  const { storage, counter } = memoryStorage();
  const state = createDriveSyncStateStore(storage);

  await state.markDirty("board");
  expect(counter.writes).toBe(1);
  expect((await state.get("board")).status).toBe("pending");
  expect((await state.get("board")).changeToken).toBe(1);

  // A new local change advances the change token, so the state differs.
  await state.markDirty("board");
  expect(counter.writes).toBe(2);
  expect((await state.get("board")).changeToken).toBe(2);
});

it("compares two sync states by their stored fields", () => {
  const left: DriveProjectSyncState = { projectId: "board", dirty: true, status: "pending" };
  const right: DriveProjectSyncState = { projectId: "board", dirty: true, status: "pending" };
  expect(sameSyncState(left, right)).toBe(true);

  // An absent field and an explicit undefined field are the same.
  expect(sameSyncState(left, { ...right, error: undefined })).toBe(true);
  expect(sameSyncState(left, { ...right, changeToken: 1 })).toBe(false);
  expect(sameSyncState(left, { ...right, status: "synced" })).toBe(false);
});

it("dismisses a stored failure without forgiving the pending change", async () => {
  const { storage, counter } = memoryStorage();
  const state = createDriveSyncStateStore(storage);

  await state.markDirty("board");
  await state.markError("board", "Google Drive request failed (403): rateLimitExceeded");
  expect((await state.get("board")).status).toBe("error");

  const writesBeforeClear = counter.writes;
  await state.clearError("board");
  const cleared = await state.get("board");
  expect(cleared.error).toBeUndefined();
  // The unsynchronized change survives, so the next attempt is a real Drive
  // request that reports the failure again if it recurs.
  expect(cleared.dirty).toBe(true);
  expect(cleared.status).toBe("pending");
  expect(counter.writes).toBe(writesBeforeClear + 1);

  // Nothing left to dismiss: the worker watches these writes, and a write that
  // changed nothing schedules a sync it was never asked for.
  const writesAfterClear = counter.writes;
  await state.clearError("board");
  expect(counter.writes).toBe(writesAfterClear);
});
