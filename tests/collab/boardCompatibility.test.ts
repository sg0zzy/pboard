/** D6 compatibility boundary matrix: the marker gates writes, never reads. */
import { expect, it } from 'vitest';
import { BOARD_FORMAT_VERSION, MIN_COMPATIBLE_CLIENT_VERSION, assertNoSilentDowngrade, evaluateBoardCompatibility, type BoardFormatMarker } from '../../src/collab/security/boardCompatibility';

const marker = (overrides: Partial<BoardFormatMarker> = {}): BoardFormatMarker =>
  ({ formatVersion: BOARD_FORMAT_VERSION, minClientVersion: MIN_COMPATIBLE_CLIENT_VERSION, migratedAt: 1, ...overrides });

it('treats unmarked legacy boards as writable by every current client', () => {
  expect(evaluateBoardCompatibility(null, MIN_COMPATIBLE_CLIENT_VERSION)).toEqual({ compatible: true });
});

it('refuses writers below the marker minimum and reports the requirement', () => {
  expect(evaluateBoardCompatibility(marker({ minClientVersion: 3 }), 2)).toEqual({ compatible: false, reason: "client-too-old", required: 3 });
  expect(evaluateBoardCompatibility(marker({ minClientVersion: 3 }), 3)).toEqual({ compatible: true });
});

it('refuses an unknown older format generation rather than guessing', () => {
  expect(evaluateBoardCompatibility(marker({ formatVersion: BOARD_FORMAT_VERSION - 1 }), 99)).toEqual({ compatible: false, reason: "client-too-old", required: BOARD_FORMAT_VERSION });
});

it('never lets a format marker move backwards', () => {
  const next = marker({ formatVersion: BOARD_FORMAT_VERSION + 1, minClientVersion: 4 });
  expect(assertNoSilentDowngrade(null, next)).toBe(next);
  expect(assertNoSilentDowngrade(marker(), next)).toBe(next);
  expect(() => assertNoSilentDowngrade(next, marker())).toThrow(/cannot move backwards/);
  expect(() => assertNoSilentDowngrade(marker({ minClientVersion: 5 }), marker({ minClientVersion: 4 }))).toThrow(/cannot move backwards/);
});
