import { describe, expect, it } from "vitest";
import { adjacentItemId, reorderAtTarget } from "../src/sidebar/reorder";

describe("adjacentItemId", () => {
  it("finds the cards immediately above and below the current card", () => {
    expect(adjacentItemId(["a", "b", "c"], "b", -1)).toBe("a");
    expect(adjacentItemId(["a", "b", "c"], "b", 1)).toBe("c");
  });

  it("returns null at a boundary or for an unknown card", () => {
    expect(adjacentItemId(["a", "b"], "a", -1)).toBeNull();
    expect(adjacentItemId(["a", "b"], "b", 1)).toBeNull();
    expect(adjacentItemId(["a", "b"], "missing", 1)).toBeNull();
  });
});

describe("reorderAtTarget", () => {
  it("places a dragged card before the preview target", () => {
    expect(reorderAtTarget(["a", "b", "c", "d"], "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
  });

  it("places a dragged card after the preview target", () => {
    expect(reorderAtTarget(["a", "b", "c", "d"], "d", "a", "after")).toEqual(["a", "d", "b", "c"]);
  });

  it("does not mutate the input or reorder invalid targets", () => {
    const ids = ["a", "b"];
    expect(reorderAtTarget(ids, "a", "a", "before")).toBe(ids);
    expect(ids).toEqual(["a", "b"]);
  });
});
