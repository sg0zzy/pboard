import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pencilCellPath } from '../src/sidebar/components/ProjectFingerprint';

const source = readFileSync(join(import.meta.dirname, '../src/sidebar/components/ProjectFingerprint.tsx'), 'utf8');

describe('fingerprint repaint cost', () => {
  // Deleting one card shifted every later dot, because the dot's position was
  // baked into its path data and its position is the card's index in the row.
  // Measured on a 300-card board, one delete rewrote 599 `path.d` attributes —
  // and setting `d` re-parses the path, unlike a transform.
  it('draws each dot at the origin so a positional shift does not rewrite its path', () => {
    // the cell draws its paths from (0,0) and is placed with `transform`
    expect(source).toContain('transform={`translate(${x} ${y})`}');
    expect(source).toContain('pencilCellPath(0, 0, CELL_SIZE');
    // no path may be built from the cell's position any more
    expect(source).not.toContain('pencilCellPath(x, y, CELL_SIZE');
  });

  it('produces the same outline for the same seed regardless of position', () => {
    // the path carries no position, so moving a dot is a transform, not new data
    expect(pencilCellPath(0, 0, 7, 12345)).toBe(pencilCellPath(0, 0, 7, 12345));
    expect(pencilCellPath(0, 0, 7, 12345)).not.toBe(pencilCellPath(0, 0, 7, 54321));
  });
});
