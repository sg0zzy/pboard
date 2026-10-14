import { describe, it, expect } from 'vitest';
import { swipeStatus, SWIPE_STATUSES } from '../src/interactions/cardSwipeStatus';

describe('Android swipe workflow', () => {
  it('advances right and steps back left through the five allowed statuses', () => {
    expect(SWIPE_STATUSES).toEqual(['candidate', 'confirmed', 'started', 'to validate', 'done']);
    for (let index = 0; index < SWIPE_STATUSES.length - 1; index++) {
      expect(swipeStatus(SWIPE_STATUSES[index], 1)).toBe(SWIPE_STATUSES[index + 1]);
      expect(swipeStatus(SWIPE_STATUSES[index + 1], -1)).toBe(SWIPE_STATUSES[index]);
    }
  });
  it('stops at candidate and done', () => {
    expect(swipeStatus('candidate', -1)).toBe('candidate');
    expect(swipeStatus('done', 1)).toBe('done');
  });
  it('leaves rejected and trash untouched in either direction', () => {
    for (const status of ['rejected', 'trash'] as const) {
      expect(swipeStatus(status, 1)).toBe(status);
      expect(swipeStatus(status, -1)).toBe(status);
    }
  });
});
