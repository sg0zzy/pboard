import { describe, expect, it } from "vitest";
import { crossedPointerDragThreshold, pointerDropPosition } from "../src/sidebar/pointerDrag";

describe("crossedPointerDragThreshold", () => {
  it("does not start a drag for ordinary click movement", () => {
    expect(crossedPointerDragThreshold(10, 10, 13, 13)).toBe(false);
  });

  it("starts a drag after five pixels of movement", () => {
    expect(crossedPointerDragThreshold(10, 10, 13, 14)).toBe(true);
  });
});

describe("pointerDropPosition", () => {
  it("selects before in the upper half and after in the lower half", () => {
    expect(pointerDropPosition(119, 100, 40)).toBe("before");
    expect(pointerDropPosition(120, 100, 40)).toBe("after");
  });
});
