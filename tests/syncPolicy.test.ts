import { expect, it } from 'vitest';
import { dirtyFlushAt, driveFlushAt, drivePollDelay, DRIVE_MAX_UNPUBLISHED_MS, DRIVE_POLL_MS, DRIVE_POLL_MAX_MS } from '../src/sync/syncPolicy';

it('uses the earlier of 30 minutes idle and 25 minutes since the oldest pending edit', () => {
  const minute = 60_000, first = Date.parse('2026-10-30T10:00:00Z');
  expect(driveFlushAt(first, first)).toBe(first + 25 * minute);
  expect(driveFlushAt(first, first + 24 * minute)).toBe(first + 25 * minute);
  expect(dirtyFlushAt({ firstDirtyAt: new Date(first).toISOString(), dirtyAt: new Date(first + 20 * minute).toISOString() })).toBe(first + DRIVE_MAX_UNPUBLISHED_MS);
  // The idle branch remains a debounce when a longer maximum is configured.
  expect(driveFlushAt(first, first + 5 * minute, 30 * minute, 60 * minute)).toBe(first + 35 * minute);
});

it('starts fallback polling at ten minutes, doubles retries, jitters and caps at one hour', () => {
  expect(drivePollDelay(0, 0)).toBe(DRIVE_POLL_MS);
  expect(drivePollDelay(0, 1)).toBe(12 * 60_000);
  expect(drivePollDelay(1, 0)).toBe(2 * DRIVE_POLL_MS);
  expect(drivePollDelay(2, 0)).toBe(4 * DRIVE_POLL_MS);
  expect(drivePollDelay(99, 1)).toBe(DRIVE_POLL_MAX_MS);
});
