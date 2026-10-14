import { describe, expect, it } from 'vitest';
import { sortBoards, type BoardOverview } from '../src/data/boards';
import { mockBoards } from '../src/data/mockBoards';
const ids = (boards: readonly BoardOverview[]) => boards.map(board => board.id);
describe('board overview ordering', () => {
  it('puts exactly four recent boards first, then follows manual sidebar order', () => {
    expect(ids(sortBoards(mockBoards))).toEqual(['phone', 'film', 'personal', 'website', 'archive', 'ai']);
    expect(ids(sortBoards(mockBoards).slice(4))).toEqual(['archive', 'ai']);
  });
  it('handles fewer than four boards and an empty list', () => {
    expect(ids(sortBoards(mockBoards.slice(0, 2)))).toEqual(['ai', 'archive']);
    expect(sortBoards([])).toEqual([]);
  });
  it('deduplicates before choosing the four recent positions', () => {
    const sorted = ids(sortBoards([mockBoards[5], mockBoards[5], ...mockBoards]));
    expect(sorted).toEqual(['phone', 'film', 'personal', 'website', 'archive', 'ai']);
    expect(new Set(sorted).size).toBe(sorted.length);
  });
  it('keeps deterministic manual order when timestamps tie', () => {
    const tied = mockBoards.map(board => ({ ...board, updatedAt: '2026-10-14T00:00:00Z' }));
    expect(ids(sortBoards(tied))).toEqual(ids(tied));
  });
  it('treats missing and malformed timestamps as oldest', () => {
    expect(ids(sortBoards([{ id: 'missing' }, { id: 'bad', updatedAt: {} }, { id: 'invalid', updatedAt: 'invalid' }, mockBoards[5]]))).toEqual(['phone', 'missing', 'bad', 'invalid']);
  });
  it('never mutates the supplied array or editing timestamps', () => {
    const input = Object.freeze(mockBoards.map(board => Object.freeze({ ...board })));
    const before = JSON.stringify(input);
    sortBoards(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
