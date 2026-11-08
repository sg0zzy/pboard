/**
 * The driver's whole contract is *which calls happen in which order under
 * which conditions*: the planning rules themselves are covered by
 * `assets.test.ts`, so these tests assert the call sequence, the zero-deletion
 * guarantees, and that the audit records observed results rather than intent.
 */
import { describe, expect, it } from 'vitest';
import { runAssetReclamation, type AssetDriveListing, type AssetReclamationAudit, type AssetReclamationCycle } from '../../src/sync/operations/assetReclaim';
import { planAssetReclamation } from '../../src/sync/operations/assets';
import type { LogLease } from '../../src/sync/operations/logSync';

const lease: LogLease = { holder: 'device-1', epoch: 4, expiresAt: 1 };
const NOW = Date.parse('2026-11-02T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';    // far outside the seven-day grace window
const RECENT = '2026-11-01T00:00:00.000Z'; // created yesterday: inside it
const hash = (digit: string) => digit.repeat(64);

/** A complete listing holding exactly two eligible files — `a` and `b` — plus
 * one per retention rule: recent (`c`), live-referenced (`d`), covered by a
 * retained snapshot (`e`), and an unparseable name that is not an asset at all
 * (`junk`). */
const listing: AssetDriveListing = { complete: true, files: [
  { driveFileId: 'a', name: `asset-${hash('1')}.png`, createdTime: OLD },
  { driveFileId: 'b', name: `asset-${hash('2')}.png`, createdTime: OLD },
  { driveFileId: 'c', name: `asset-${hash('3')}.png`, createdTime: RECENT },
  { driveFileId: 'd', name: `asset-${hash('4')}.png`, createdTime: OLD },
  { driveFileId: 'e', name: `asset-${hash('5')}.png`, createdTime: OLD },
  { driveFileId: 'junk', name: 'meeting-notes.txt', createdTime: OLD },
] };

/** Records the *order* of port calls. `failRemove`/`throwRemove` make one
 * deletion fail in each of the two ways a Drive call fails (a refusal and an
 * exception) so "one failure does not abort the rest" is observable, and
 * `listing` replaces the listing port when a test needs an incomplete index
 * instead of a throwing one. */
function harness(overrides: Partial<AssetReclamationCycle> = {}, options: {
  busy?: boolean; nonOwner?: boolean; listingThrows?: boolean;
  failRemove?: Set<string>; throwRemove?: Set<string>;
} = {}) {
  const calls: string[] = [];
  const audits: AssetReclamationAudit[] = [];
  const removed: string[] = [];
  const cycle: AssetReclamationCycle = {
    async owner() { calls.push('owner'); return options.nonOwner !== true; },
    async lease() { calls.push('lease'); return options.busy ? null : lease; },
    async release() { calls.push('release'); },
    async listing() {
      calls.push('listing');
      if (options.listingThrows) throw new Error('Drive listed 403');
      return listing;
    },
    async referenced() { calls.push('referenced'); return ['d']; },
    async retainedSnapshotCoverage() { calls.push('coverage'); return { 'snap-1': ['e'] }; },
    async remove(driveFileId) {
      calls.push(`remove:${driveFileId}`);
      if (options.throwRemove?.has(driveFileId)) throw new Error('drive request failed');
      if (options.failRemove?.has(driveFileId)) return 'failed';
      removed.push(driveFileId);
      return 'deleted';
    },
    async audit(record) { calls.push('audit'); audits.push(record); },
    now() { return NOW; },
    ...overrides
  };
  return { calls, audits, removed, cycle };
}

describe('asset reclamation pass', () => {
  it('is forbidden and leaves no trace for a non-owner', async () => {
    const { calls, cycle } = harness({}, { nonOwner: true });
    expect(await runAssetReclamation(cycle)).toEqual({ status: 'forbidden' });
    // Not even the lease: acquiring one is a write to shared board state, so
    // a non-owner pass must be indistinguishable from a pass that never ran.
    expect(calls).toEqual(['owner']);
  });

  it('does nothing while another device holds the lease, and never releases a lease it does not hold', async () => {
    const { calls, cycle } = harness({}, { busy: true });
    expect(await runAssetReclamation(cycle)).toEqual({ status: 'idle', reason: 'lease-busy' });
    expect(calls).toEqual(['owner', 'lease']); // no 'release': freeing another device's lease would defeat it
  });

  it('reclaims nothing when the listing is incomplete, and reports the plan as the blocked reason', async () => {
    const { calls, removed, audits, cycle } = harness({
      listing: async () => { calls.push('listing'); return { ...listing, complete: false }; }
    });
    const outcome = await runAssetReclamation(cycle);
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    // The wording is the planner's, not the driver's: deletion safety has one
    // decision point.
    const expected = planAssetReclamation({ listing: { ...listing, complete: false }, referenced: [], retainedSnapshotCoverage: {}, now: NOW });
    expect(outcome.reason).toBe(expected.blocked);
    // Zero deletions, zero audit, and not even a reference read: against a
    // partial index every read is worthless, and the pass must be a no-op.
    expect(calls).toEqual(['owner', 'lease', 'listing', 'release']);
    expect(removed).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('reclaims nothing when the listing call fails', async () => {
    const { calls, removed, audits, cycle } = harness({}, { listingThrows: true });
    const outcome = await runAssetReclamation(cycle);
    expect(outcome.status).toBe('blocked');
    expect(calls).toEqual(['owner', 'lease', 'listing', 'release']);
    expect(removed).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('deletes only plan-eligible ids, survives one failed delete, and separates deleted from failed and skipped', async () => {
    const { calls, removed, cycle } = harness({}, { failRemove: new Set(['a']) });
    // `a` is refused first, and the pass must still try `b`.
    expect(await runAssetReclamation(cycle)).toEqual({ status: 'reclaimed', deleted: ['b'], failed: ['a'], skipped: 4 });
    expect(calls.filter(call => call.startsWith('remove'))).toEqual(['remove:a', 'remove:b']); // only the eligible pair, nothing aborted
    expect(removed).toEqual(['b']); // c (recent), d (referenced), e (covered) and junk (unparseable) were never touched
  });

  it('survives a delete that throws, not just one that reports failure', async () => {
    const { removed, cycle } = harness({}, { throwRemove: new Set(['a']) });
    expect(await runAssetReclamation(cycle)).toEqual({ status: 'reclaimed', deleted: ['b'], failed: ['a'], skipped: 4 });
    expect(removed).toEqual(['b']);
  });

  it('audits what actually happened when a delete fails, not what was intended', async () => {
    const { audits, cycle } = harness({}, { throwRemove: new Set(['b']) });
    expect(await runAssetReclamation(cycle)).toEqual({ status: 'reclaimed', deleted: ['a'], failed: ['b'], skipped: 4 });
    expect(audits).toHaveLength(1);
    const plan = planAssetReclamation({ listing, referenced: ['d'], retainedSnapshotCoverage: { 'snap-1': ['e'] }, now: NOW });
    // `b` was planned but survives, and the record says so — otherwise a later
    // reader would treat `b` as gone. The `policy` is the planner's own words
    // for why these files were eligible: the audit carries its justification.
    expect(audits[0]).toEqual({ at: NOW, policy: plan.policy, deleted: ['a'], failed: ['b'] });
  });

  it('is idle when the plan is empty, and still releases the lease', async () => {
    const { calls, removed, audits, cycle } = harness({
      referenced: async () => { calls.push('referenced'); return ['a', 'b', 'c', 'd', 'e']; }
    });
    expect(await runAssetReclamation(cycle)).toEqual({ status: 'idle', reason: 'nothing-eligible' });
    // The lease is given back even when the pass finds nothing to do, exactly
    // as it is on every early return.
    expect(calls).toEqual(['owner', 'lease', 'listing', 'referenced', 'coverage', 'release']);
    expect(removed).toEqual([]);
    expect(audits).toEqual([]);
  });
});
