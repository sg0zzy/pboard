/** Presentation fields only; category, color and preview are not persistence fields. */
export type BoardOverview = {
  id: string;
  name?: unknown;
  updatedAt?: unknown;
  category?: unknown;
  color?: unknown;
  template?: unknown;
  firstCardType?: unknown;
  firstCard?: unknown;
};

export function displayText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function editedAt(board: BoardOverview): number {
  const timestamp = typeof board.updatedAt === 'string' ? Date.parse(board.updatedAt) : NaN;
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

/** Input must already be in desktop sidebar order (repository.listProjects()).
 * Equal/invalid timestamps retain that order. First occurrence of each ID wins.
 * Pure: opening, rendering and syncing cannot change any timestamp here.
 */
export function sortBoards<T extends BoardOverview>(sidebarOrdered: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique = sidebarOrdered.filter(board => {
    if (seen.has(board.id)) return false;
    seen.add(board.id);
    return true;
  });
  const recent = [...unique].sort((a, b) => {
    const left = editedAt(a);
    const right = editedAt(b);
    return left === right ? 0 : left > right ? -1 : 1;
  }).slice(0, 4);
  const recentIds = new Set(recent.map(board => board.id));
  return [...recent, ...unique.filter(board => !recentIds.has(board.id))];
}
