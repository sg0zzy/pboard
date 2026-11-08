/**
 * The grant-absence cache answers two different questions people actually
 * ask — "may I ask again yet?" and "is this board's grant expired or was it
 * never published?" — and only the second one distinguishes a fixable wait
 * (the owner will open the board) from a hopeless poll (no authority browser
 * is coming).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllGrantAbsences, grantAbsenceReason, grantAbsenceSnapshot, noteGrantAbsent, noteGrantServed,
} from '../../src/collab/grantAbsence';

const scope = 'pboard-board-grants-key-1', other = 'pboard-board-grants-key-2', board = '11111111-2222-4333-8444-555555555555';

beforeEach(() => { clearAllGrantAbsences(); });

describe('grant absence cache', () => {
  it('lets an untouched scope through and bounds repeated misses', () => {
    expect(grantAbsenceReason(scope, board)).toBeNull();
    expect(noteGrantAbsent(scope, board)).toContain('Board grant expired. The original authority browser must be online to renew it.');
    expect(grantAbsenceReason(scope, board)).toContain('re-checking in at most');
    // Every attempt doubles the window; it must never fall off the top.
    for (let attempt = 0; attempt < 10; attempt++) noteGrantAbsent(scope, board);
    expect(grantAbsenceSnapshot()[scope].retryInMs).toBeLessThanOrEqual(60_000);
  });

  it('reports never-published only until this context has been served a grant for the board', () => {
    noteGrantAbsent(scope, board);
    expect(grantAbsenceSnapshot()[scope].reason).toBe('never-published');
    // The authority browser came and the read succeeded — the read paths
    // record that this context has now seen a grant for this key.
    noteGrantServed(board);
    // The owner closed the browser; the five-minute lifetime lapsed; 404 again.
    noteGrantAbsent(scope, board);
    expect(grantAbsenceSnapshot()[scope].reason).toBe('expired');
    // The split belongs to the board that was served: a different board this
    // context has never been granted stays honestly `never-published`.
    noteGrantAbsent(other, '99999999-2222-4333-8444-555555555555');
    expect(grantAbsenceSnapshot()[other].reason).toBe('never-published');
  });
});
