import type { BoardItemStatus } from '../../../../src/types';

export const SWIPE_STATUSES: readonly BoardItemStatus[] = ['candidate', 'confirmed', 'started', 'to validate', 'done'];
/** Swipe progress stays within the active workflow; terminal/manual statuses are untouched. */
export function swipeStatus(status: BoardItemStatus, direction: -1 | 1): BoardItemStatus {
  const index = SWIPE_STATUSES.indexOf(status);
  return index < 0 ? status : SWIPE_STATUSES[Math.max(0, Math.min(SWIPE_STATUSES.length - 1, index + direction))];
}
