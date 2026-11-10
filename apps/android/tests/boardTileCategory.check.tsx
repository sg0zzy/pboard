import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardTile } from '../src/components/BoardTile';
import { categoryOf, BOARD_CATEGORIES } from '../src/data/categories';
import type { BoardOverview } from '../src/data/boards';

let root: Root; let host: HTMLDivElement;
const board = (patch: Partial<BoardOverview>): BoardOverview => ({ id: 'b', name: 'Board', ...patch });
async function render(value: BoardOverview) {
  await act(async () => root.render(<BoardTile board={value} onOpen={vi.fn()} />));
  const tile = host.querySelector<HTMLElement>('.board-tile')!;
  // Read now: React reuses the same node across renders in this root.
  return { tile, accent: tile.style.getPropertyValue('--category-accent') };
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('board tile category colour', () => {
  it('gives each category its own accent and shares one hue between project templates', async () => {
    const notes = await render(board({ template: 'brainstorming' }));
    const ideas = await render(board({ template: 'idea' }));
    const project = await render(board({ template: 'project' }));
    const software = await render(board({ template: 'software_project' }));
    const accents = [notes.accent, ideas.accent, project.accent, software.accent];
    expect(accents[0]).toBe(BOARD_CATEGORIES.brainstorming.color);
    expect(accents[1]).toBe(BOARD_CATEGORIES.idea.color);
    expect(accents[2]).toBe(BOARD_CATEGORIES.project.color);
    // Both project templates are the "Project" category, so one hue.
    expect(accents[3]).toBe(accents[2]);
    expect(new Set([accents[0], accents[1], accents[2]]).size).toBe(3);
  });
  it('keeps the colour when the preview text changes', async () => {
    const before = (await render(board({ template: 'software_project', firstCard: 'Fix the sync loop' }))).accent;
    const after = (await render(board({ template: 'software_project', firstCard: 'Different card' }))).accent;
    expect(after).toBe(before);
    // The preview no longer drives the accent at all.
    expect(before).toBe(BOARD_CATEGORIES.software_project.color);
  });
  it('uses the colour the overview resolved, and falls back to the template for hand-built boards', async () => {
    // The production path: overviewBoards supplies both fields together.
    const resolved = await render(board({ template: 'idea', category: 'Ideas', categoryColor: BOARD_CATEGORIES.idea.color }));
    expect(resolved.accent).toBe(BOARD_CATEGORIES.idea.color);
    expect(resolved.tile.querySelector('.board-category')?.textContent).toBe('Ideas');
    // A hand-built overview without categoryColor still gets a sane accent.
    const fallback = await render(board({ template: 'software_project' }));
    expect(fallback.accent).toBe(BOARD_CATEGORIES.software_project.color);
    // Unknown or missing template: Notes colour and label.
    for (const template of [undefined, 'legacy', 42, null]) {
      const { tile, accent } = await render(board({ template }));
      expect(accent).toBe(BOARD_CATEGORIES.brainstorming.color);
      expect(tile.querySelector('.board-category')?.textContent).toBe('Notes');
    }
    expect(categoryOf('project').label).toBe('Project');
  });
});
