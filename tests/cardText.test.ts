import { describe, expect, it } from "vitest";
import { cardTextForClipboard } from "../src/sidebar/cardText";

describe("cardTextForClipboard", () => {
  it("copies content alone when no title exists", () => {
    expect(cardTextForClipboard({ content: "  A useful point  " })).toBe("A useful point");
  });

  it("includes an optional title without card metadata", () => {
    expect(cardTextForClipboard({ title: " Decision ", content: " Use local storage. " })).toBe(
      "Decision\nUse local storage."
    );
  });
});
