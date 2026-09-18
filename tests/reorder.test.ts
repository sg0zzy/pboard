import { describe, expect, it } from "vitest";
import { reorderAtTarget } from "../src/sidebar/reorder";

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
