import { describe, expect, it } from 'vitest';
import { boardSyncStatus } from '../src/sync/boardStatus';
import { recoveryDelayMs, recordProgress, recordAttempt, retriesPaused, RECOVERY_CEILINGS_MS } from '../src/sync/recoveryScheduler';
import type { DriveProjectSyncState } from '../src/sync/state';
import type { ConflictRecord } from '../src/storage/conflictResolution';

const state = (patch: Partial<DriveProjectSyncState> = {}): DriveProjectSyncState => ({ projectId: 'b', dirty: false, status: 'synced', ...patch });
const conflict = (id = 'c1') => ({ id, boardId: 'b', collection: 'cards', documentId: 'd', heads: [], variants: [] }) as unknown as ConflictRecord;

describe('contract board status', () => {
  it('applies the approved precedence: local only, then conflicts, then pending, then synced', () => {
    expect(boardSyncStatus({ remoteScope: false, state: state({ dirty: true }), conflicts: [conflict()] })).toMatchObject({ label: 'Local only' });
    expect(boardSyncStatus({ remoteScope: true, state: state(), conflicts: [conflict(), conflict('c2')], boundAccountInactive: false })).toEqual({ label: 'Conflict requires resolution', conflicts: 2 });
    expect(boardSyncStatus({ remoteScope: true, state: state({ dirty: true, status: 'pending' }), conflicts: [] })).toMatchObject({ label: 'Synchronization pending' });
    expect(boardSyncStatus({ remoteScope: true, state: state(), conflicts: [] })).toEqual({ label: 'Synced' });
    expect(boardSyncStatus({ remoteScope: true, state: state({ status: 'syncing' }), conflicts: [] })).toMatchObject({ label: 'Synchronization pending' });
    // A known channel failure prevents a fresh Synced claim even without dirty work.
    expect(boardSyncStatus({ remoteScope: true, state: state({ status: 'error', error: 'Drive unavailable' }), conflicts: [] })).toMatchObject({ label: 'Synchronization pending', detail: 'Drive unavailable' });
    // Inactive remote scope still reports Local only; conflicts remain accessible separately.
    expect(boardSyncStatus({ remoteScope: true, state: state(), conflicts: [], boundAccountInactive: true })).toEqual({ label: 'Local only' });
    // Pending reason is explained; logout never clears the conflict itself.
    expect(boardSyncStatus({ remoteScope: true, state: state({ dirty: true, status: 'pending' }), conflicts: [conflict()] })).toEqual({ label: 'Conflict requires resolution', conflicts: 1 });
  });
});

describe('bounded recovery scheduling', () => {
  it('uses the approved exponential ceilings with jitter in [half, ceiling], deterministically', () => {
    let seed = 0.42;
    const random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const delays: number[] = RECOVERY_CEILINGS_MS.map((_: number, i: number) => recoveryDelayMs({ attempt: i, random }, 0));
    for (const [index, delay] of delays.entries()) {
      const ceiling = RECOVERY_CEILINGS_MS[index];
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2); expect(delay).toBeLessThanOrEqual(ceiling);
    }
    // An identically seeded repeat reproduces the same delay (no wall-clock dependency).
    let seed2 = 0.42;
    const random2 = () => { seed2 = (seed2 * 9301 + 49297) % 233280; return seed2 / 233280; };
    expect(RECOVERY_CEILINGS_MS.map((_: number, i: number) => recoveryDelayMs({ attempt: i, random: random2 }, 0))).toEqual(delays);
  });
  it('respects an explicit service cooldown above the local cap and clamps the attempt index', () => {
    expect(recoveryDelayMs({ attempt: 0, cooldownUntil: 45_000, random: () => 0 }, 0)).toBe(45_000);
    // attempt clamps to the 30s ceiling; the value stays within [half, ceiling].
    const clamped = recoveryDelayMs({ attempt: 99, random: () => 0.999 }, 0);
    expect(clamped).toBeGreaterThanOrEqual(15_000); expect(clamped).toBeLessThanOrEqual(30_000);
    // attempt 0 ceiling 1s; jitter within [0.5,1].
    expect(recoveryDelayMs({ attempt: 0, random: () => 0.999 }, 0)).toBe(1_000);
  });
  it('progress resets the schedule while plain attempts advance it, bounded', () => {
    const scheduler = { attempt: 0 };
    for (let i = 0; i < 10; i++) recordAttempt(scheduler);
    expect(scheduler.attempt).toBe(RECOVERY_CEILINGS_MS.length - 1);
    recordProgress(scheduler); expect(scheduler.attempt).toBe(0);
  });
  it('pauses retries in standalone and when the platform reports offline', async () => {
    expect(await retriesPaused({ standalone: async () => true, platformOffline: async () => false })).toBe(true);
    expect(await retriesPaused({ standalone: async () => false, platformOffline: async () => true })).toBe(true);
    expect(await retriesPaused({ standalone: async () => false, platformOffline: async () => false })).toBe(false);
  });
});