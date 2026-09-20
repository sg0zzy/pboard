import { describe, expect, it } from "vitest";
import { cardTextForClipboard } from "../src/sidebar/cardText";

describe("cardTextForClipboard", () => {
  it("copies content alone with category and status tags when no title exists", () => {
    expect(cardTextForClipboard({ type: "issue", status: "candidate", content: "  A useful point  " })).toBe(
      "[issue] [candidate] A useful point"
    );
  });

  it("includes an optional title after the tags without card metadata", () => {
    expect(cardTextForClipboard({ title: " Decision ", type: "decision", status: "confirmed", content: " Use local storage. " })).toBe(
      "[decision] [confirmed] Decision\nUse local storage."
    );
  });

  it("maps legacy idea types to core_idea in the tag", () => {
    expect(cardTextForClipboard({ type: "idea", status: "done", content: "Legacy card" })).toBe("[core_idea] [done] Legacy card");
  });

  it("returns an empty string for a card with no text", () => {
    expect(cardTextForClipboard({ type: "note", status: "candidate", title: "   ", content: "   " })).toBe("");
  });
});
