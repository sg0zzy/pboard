import { describe, expect, it } from 'vitest';
import { readLegacyMigrationWindow } from '../../src/sync/operations/legacyMigrationWindow';

const row = (seq: number) => ({ seq, opId: `actor:${seq}`, payload: `payload-${seq}` });
const window = (operations: unknown[]) => ({ action: 'window', synced: true, operations });

describe('fenced migration replay', () => {
  it('reads every bounded page without skipping sequence numbers', async () => {
    const cursors: number[] = [];
    const result = await readLegacyMigrationWindow(async after => {
      cursors.push(after); return window(after === 4 ? [row(5), row(6)] : [row(7)]);
    }, 4, 7);
    expect(cursors).toEqual([4, 6]);
    expect(result).toEqual([row(5), row(6), row(7)]);
  });

  it('does not read for an empty window', async () => {
    expect(await readLegacyMigrationWindow(async () => { throw new Error('unexpected request'); }, 5, 5)).toEqual([]);
  });

  it.each([
    { action: 'snapshotRequired', synced: false, operations: [] },
    window([]), window([row(2)]), window([row(1), row(3)]), window([row(1), row(2), row(3)])
  ])('refuses incomplete, gapped, or changed history', async response => {
    await expect(readLegacyMigrationWindow(async () => response, 0, 2)).rejects.toThrow();
  });
});
