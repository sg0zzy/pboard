import type { CSSProperties } from 'react';
import type { BoardTemplate } from '../../../../src/types';
import type { BoardOverview } from './boards';

/**
 * A board's category is derived from its template, and each category owns one
 * accent colour so the home grid can be scanned by kind at a glance. The colour
 * comes from the template's own palette (its card types), so a board never
 * shows a hue that does not exist inside it. Both the display name and the
 * colour live here, so the tile label and the tile accent cannot drift apart.
 */
export const BOARD_CATEGORIES: Record<BoardTemplate, { label: string; color: string }> = {
  brainstorming: { label: 'Notes', color: '#73766f' },
  idea: { label: 'Ideas', color: '#3974c1' },
  project: { label: 'Project', color: '#22827d' },
  software_project: { label: 'Project', color: '#22827d' },
};

export const FALLBACK_CATEGORY = BOARD_CATEGORIES.brainstorming;

export function categoryOf(template: unknown): { label: string; color: string } {
  return typeof template === 'string' && template in BOARD_CATEGORIES
    ? BOARD_CATEGORIES[template as BoardTemplate]
    : FALLBACK_CATEGORY;
}

/** Tile accent only. The tile's own surface tint stays theme-derived so the
 * dark theme does not need a second palette. `overviewBoards` already resolved
 * the colour; the template lookup is only a fallback for callers that build an
 * overview by hand. */
export function categoryColors(board: Pick<BoardOverview, 'categoryColor' | 'template'>): CSSProperties {
  const color = typeof board.categoryColor === 'string' ? board.categoryColor : categoryOf(board.template).color;
  return { '--category-accent': color } as CSSProperties;
}
