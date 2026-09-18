export type DropPosition = "before" | "after";

export function adjacentItemId(
  orderedIds: string[],
  currentId: string,
  direction: -1 | 1
): string | null {
  const currentIndex = orderedIds.indexOf(currentId);
  if (currentIndex < 0) return null;
  return orderedIds[currentIndex + direction] ?? null;
}

export function reorderAtTarget(
  orderedIds: string[],
  draggedId: string,
  targetId: string,
  position: DropPosition
): string[] {
  if (draggedId === targetId || !orderedIds.includes(draggedId) || !orderedIds.includes(targetId)) {
    return orderedIds;
  }

  const next = orderedIds.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  next.splice(insertionIndex, 0, draggedId);
  return next;
}
