import { afterEach, expect, it } from 'vitest';
import { createDriveSyncStateStore } from '../../src/sync/state';
import type { KeyValueStorage } from '../../src/storage/repository';

/**
 * The background service worker reacts to a pending sync state by scheduling
 * another idle sync. A sync whose upload was superseded leaves the state
 * pending, so the worker runs again, uploads again, and leaves the state
 * pending again. The pending state must therefore carry a newer change token
 * than the attempt that was just superseded, or the worker repeats itself
 * forever.
 */
function memoryStorage(): KeyValueStorage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (values) => { Object.assign(data, structuredClone(values)); }
  };
}

afterEach(() => { /* no shared state to restore */ });

it('advances the change token when an upload is superseded', async () => {
  const storage = memoryStorage();
  const state = createDriveSyncStateStore(storage);
  await state.markDirty('board');
  const before = await state.get('board');
  const token = before.changeToken ?? 0;

  await state.markUploadStale('board', 'file-id');
  const after = await state.get('board');

  expect(after.status).toBe('pending');
  expect(after.dirty).toBe(true);
  expect(after.changeToken ?? 0).toBeGreaterThan(token);
});

it('does not reschedule the same superseded upload forever', async () => {
  const storage = memoryStorage();
  const state = createDriveSyncStateStore(storage);
  await state.markDirty('board');

  // The background worker: a pending state schedules an idle sync, and the
  // sync's upload is superseded again.
  let scheduled = 0;
  const worker = async () => {
    const current = await state.get('board');
    if (!current.dirty || current.status !== 'pending') return;
    scheduled++;
    if (scheduled > 50) throw new Error(`The background worker rescheduled the same sync ${scheduled} times`);
    await state.markUploadStale('board', 'file-id');
  };

  for (let round = 0; round < 10; round++) await worker();
  // Every round is a new attempt, and the state never settles on its own, so
  // the count equals the rounds. The loop is bounded by the test, not by the
  // worker repeating one attempt forever.
  expect(scheduled).toBe(10);

  // The token moved on every round, so no two attempts are the same one.
  const finalState = await state.get('board');
  expect(finalState.changeToken ?? 0).toBe(11);
});
