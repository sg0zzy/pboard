import { describe, expect, it } from "vitest";
import { cardTextForClipboard } from "../src/sidebar/cardText";

describe("cardTextForClipboard", () => {
  it("copies content alone with a category tag when no title exists", () => {
    expect(cardTextForClipboard({ type: "issue", content: "  A useful point  " })).toBe("[issue] A useful point");
  });

  it("includes an optional title after the tag without card metadata", () => {
    expect(cardTextForClipboard({ title: " Decision ", type: "decision", content: " Use local storage. " })).toBe(
      "[decision] Decision\nUse local storage."
    );
  });

  it("maps legacy idea types to core_idea in the tag", () => {
    expect(cardTextForClipboard({ type: "idea", content: "Legacy card" })).toBe("[core_idea] Legacy card");
  });

  it("returns an empty string for a card with no text", () => {
    expect(cardTextForClipboard({ type: "note", title: "   ", content: "   " })).toBe("");
  });
});
