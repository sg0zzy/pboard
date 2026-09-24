import { describe, expect, it } from "vitest";
import {
  CARD_DISPLAY_MODE_DEFINITIONS,
  DEFAULT_CARD_DISPLAY_MODE,
  nextCardDisplayMode,
  normalizeCardDisplayMode
} from "../src/cardDisplayModes";

describe("card display modes", () => {
  it("defaults missing and invalid values to standard", () => {
    expect(normalizeCardDisplayMode(undefined)).toBe(DEFAULT_CARD_DISPLAY_MODE);
    expect(normalizeCardDisplayMode("unknown")).toBe("standard");
  });

  it("cycles compact, standard, expanded, then compact", () => {
    expect(nextCardDisplayMode("compact")).toBe("standard");
    expect(nextCardDisplayMode("standard")).toBe("expanded");
    expect(nextCardDisplayMode("expanded")).toBe("compact");
  });

  it("uses height-oriented icons with accessible labels", () => {
    expect(CARD_DISPLAY_MODE_DEFINITIONS).toEqual([
      { id: "compact", icon: "─", label: "Compact" },
      { id: "standard", icon: "▫", label: "Standard" },
      { id: "expanded", icon: "□", label: "Expanded" }
    ]);
  });
});
