import type { DropPosition } from "./reorder";

export const POINTER_DRAG_THRESHOLD = 5;

export function crossedPointerDragThreshold(startX: number, startY: number, currentX: number, currentY: number) {
  return Math.hypot(currentX - startX, currentY - startY) >= POINTER_DRAG_THRESHOLD;
}

export function pointerDropPosition(clientY: number, top: number, height: number): DropPosition {
  return clientY < top + height / 2 ? "before" : "after";
}
