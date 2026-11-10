import { describe, expect, it } from 'vitest';
import { runLogConsolidationCycle, type LogConsolidationCycle, type LogPendingConsolidation, type LogWatermark } from '../../src/sync/operations/logConsolidation';
import type { LogLease } from '../../src/sync/operations/logSync';

const lease: LogLease = { holder: 'device-1', epoch: 4, expiresAt: 1 };

/**
 * A fake that records the *order* of operations: the cycle's whole contract is
 * that nothing is uploaded before the engine caught up and nothing is committed
 * before Drive has the file, and only the sequence of calls shows that.
 */
function harness(overrides: Partial<LogConsolidationCycle> = {}, options: { busy?: boolean; clean?: boolean } = {}) {
  const calls: string[] = [];
  let pending: LogPendingConsolidation | null = null;
  const drive = new Map<string, string>();
  const cycle: LogConsolidationCycle = {
    async lease() { calls.push('lease'); return options.busy ? null : lease; },
    async watermark(): Promise<LogWatermark | null> { calls.push('watermark'); return options.clean ? { covered: 7, checkpoint: 7, snapshotSeq: 5 } : { covered: 7, checkpoint: 2, snapshotSeq: 2 }; },
    async catchUp(covered) { calls.push(`catch-up:${covered}`); return 'ready'; },
    async build(covered) { calls.push(`build:${covered}`); return { snapshotId: `snap-${covered}`, name: `snapshot-${covered}.json` }; },
    async find(name) { calls.push(`find:${name}`); return drive.get(name) ?? null; },
    async upload(entry) { calls.push(`upload:${entry.name}`); drive.set(entry.name, `etag-${entry.name}`); return { etag: `etag-${entry.name}` }; },
    async commit(_lease, covered, snapshotSeq, etag) { calls.push(`commit:${covered}:${snapshotSeq}:${etag}`); return { stale: false }; },
    async release() { calls.push('release'); },
    pending: {
      async load() { calls.push('pending:load'); return pending; },
      async save(value) { calls.push(`pending:save:${value ? value.name : 'null'}`); pending = value; }
    },
    ...overrides
  };
  return { calls, cycle, drive, pendingOf: () => pending };
}

describe('log consolidation cycle', () => {
  it('does nothing while another device holds the lease, and never releases it', async () => {
    const { calls, cycle } = harness({}, { busy: true });
    expect(await runLogConsolidationCycle(cycle)).toEqual({ status: 'idle', reason: 'lease-busy' });
    expect(calls).toEqual(['lease']);
  });

  it('publishes only after catching up, and commits the sequence it caught up to', async () => {
    const { calls, cycle } = harness();
    expect(await runLogConsolidationCycle(cycle)).toEqual({ status: 'published', snapshotSeq: 3, stale: false });
    expect(calls).toEqual([
      'lease', 'watermark', 'pending:load', 'catch-up:7', 'build:7',
      'pending:save:snapshot-7.json', 'upload:snapshot-7.json',
      'commit:7:3:etag-snapshot-7.json', 'pending:save:null', 'release'
    ]);
  });

  it('stops at a gap instead of publishing a snapshot that covers less than it claims', async () => {
    const { calls, cycle } = harness({ catchUp: async () => 'gap' });
    expect(await runLogConsolidationCycle(cycle)).toEqual({ status: 'gap' });
    expect(calls.filter(call => call.startsWith('build') || call.startsWith('upload') || call.startsWith('commit'))).toEqual([]);
    expect(calls).toContain('release'); // The lease is given back even when the cycle gives up.
  });

  it('is idle when a published snapshot already covers the log', async () => {
    const { calls, cycle } = harness({}, { clean: true });
    expect(await runLogConsolidationCycle(cycle)).toEqual({ status: 'idle', reason: 'clean' });
    expect(calls).toEqual(['lease', 'watermark', 'pending:load', 'release']);
  });

  it('finishes an interrupted cycle by committing the file Drive already has', async () => {
    const { calls, cycle, drive, pendingOf } = harness();
    // Simulate the browser dying between the upload and the commit.
    drive.set('snapshot-7.json', 'etag-snapshot-7.json');
    const interrupted: LogPendingConsolidation = { snapshotId: 'snap-7', name: 'snapshot-7.json', covered: 7, epoch: 4 };
    let first = true;
    const remembered: LogConsolidationCycle = {
      ...cycle,
      async lease() { return lease; },
      pending: {
        async load() { calls.push('pending:load'); if (first) { first = false; return interrupted; } return null; },
        async save(value) { calls.push('pending:save'); await cycle.pending.save(value); }
      }
    };
    expect(await runLogConsolidationCycle(remembered)).toEqual({ status: 'published', snapshotSeq: 3, stale: false });
    // One upload happened: Drive's own file. The cycle never published a second.
    expect(calls.filter(call => call.startsWith('upload'))).toEqual([]);
    expect(calls).toContain('find:snapshot-7.json');
    expect(calls).toContain('commit:7:3:etag-snapshot-7.json');
    expect(pendingOf()).toBeNull();
  });

  it('leaves the intent remembered when the upload fails, and retries it without rebuilding', async () => {
    let attempts = 0;
    const { calls, cycle, pendingOf } = harness({
      async upload(entry) { calls.push(`upload:${entry.name}`); if (++attempts === 1) return { failed: 'error' as const }; return { etag: 'etag-late' }; },
      async find(name) { calls.push(`find:${name}`); return null; }
    });
    expect(await runLogConsolidationCycle(cycle)).toEqual({ status: 'idle', reason: 'drive-error' });
    expect(pendingOf()).toMatchObject({ name: 'snapshot-7.json', covered: 7, epoch: 4 });
    expect(await runLogConsolidationCycle({ ...cycle, async lease() { return { ...lease, epoch: 4 }; } })).toEqual({ status: 'published', snapshotSeq: 3, stale: false });
    expect(calls.filter(call => call.startsWith('build'))).toEqual(['build:7']);   // not rebuilt
    expect(calls).toContain('commit:7:3:etag-late');
  });

  it('discards an intent left by an epoch that no longer holds the board', async () => {
    const { calls, cycle, pendingOf } = harness();
    let loaded = false;
    const outcome = await runLogConsolidationCycle({
      ...cycle,
      pending: {
        async load() { calls.push('pending:load'); if (loaded) return null; loaded = true; return { snapshotId: 'old', name: 'snapshot-old.json', covered: 4, epoch: 3 }; },
        async save(value) { calls.push('pending:save'); await cycle.pending.save(value); }
      }
    });
    expect(outcome).toEqual({ status: 'published', snapshotSeq: 3, stale: false });
    expect(calls).not.toContain('find:snapshot-old.json');
    expect(calls).toContain('build:7');
    expect(pendingOf()).toBeNull();
  });

  it('forgets an intent whose bytes cannot be reproduced and publishes the current state instead', async () => {
    const { calls, cycle, pendingOf } = harness();
    let loaded = false;
    const outcome = await runLogConsolidationCycle({
      ...cycle,
      // The upload of the interrupted attempt cannot be finished: the browser that
      // started it is gone, and Drive never received the file.
      async upload(entry) { calls.push(`upload:${entry.name}`); return entry.name === 'snapshot-old.json' ? { failed: 'missing' as const } : { etag: `etag-${entry.name}` }; },
      pending: {
        async load() { calls.push('pending:load'); if (loaded) return null; loaded = true; return { snapshotId: 'old', name: 'snapshot-old.json', covered: 4, epoch: 4 }; },
        async save(value) { calls.push(`pending:save:${value ? value.name : 'null'}`); await cycle.pending.save(value); }
      }
    });
    expect(outcome).toEqual({ status: 'published', snapshotSeq: 3, stale: false });
    expect(calls.filter(call => call.startsWith('commit'))).toEqual(['commit:7:3:etag-snapshot-7.json']);
    expect(calls).toContain('pending:save:null');
    expect(pendingOf()).toBeNull();
  });

  it('reports a stale publish rather than pretending the newer snapshot was not overwritten', async () => {
    const { cycle } = harness({ commit: async () => ({ stale: true }) });
    expect(await runLogConsolidationCycle(cycle)).toEqual({ status: 'published', snapshotSeq: 3, stale: true });
  });

  it('never commits when the engine has nothing new to checkpoint', async () => {
    const { calls, cycle } = harness({ build: async () => null });
    expect(await runLogConsolidationCycle(cycle)).toEqual({ status: 'idle', reason: 'nothing-to-publish' });
    expect(calls.some(call => call.startsWith('commit') || call.startsWith('upload'))).toBe(false);
  });
});
