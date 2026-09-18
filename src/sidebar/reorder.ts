export type DropPosition = "before" | "after";

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
