import { describe, expect, it } from "vitest";
import type { BoardItem, BoardItemStatus } from "../src/types";
import { focusTargetAfterStatusMove, shouldRestoreStatusFocus } from "../src/sidebar/statusFocus";

function item(id: string, status: BoardItemStatus, order: number): BoardItem {
  return {
    id,
    projectId: "project-one",
    type: "note",
    content: id,
    status,
    order,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("focus after a status move", () => {
  const items = [
    item("first", "confirmed", 0),
    item("middle", "started", 1),
    item("last", "candidate", 2),
    item("completed", "done", 3)
  ];

  it("focuses the next card in the source container", () => {
    expect(focusTargetAfterStatusMove(items, "middle", "started", "done")).toBe("last");
  });

  it("falls back to the previous card when the moved card was last", () => {
    expect(focusTargetAfterStatusMove(items, "last", "candidate", "trash")).toBe("middle");
  });

  it("keeps focus on the card for a status change within the same container", () => {
    expect(focusTargetAfterStatusMove(items, "middle", "started", "confirmed")).toBe("middle");
  });

  it("does not pull focus back after keyboard navigation during a pending status save", () => {
    expect(shouldRestoreStatusFocus("middle", "last")).toBe(false);
    expect(shouldRestoreStatusFocus("middle", null)).toBe(false);
    expect(shouldRestoreStatusFocus("middle", "middle")).toBe(true);
  });
});
