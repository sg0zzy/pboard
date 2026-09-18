import { describe, expect, it } from "vitest";
import { adjustUiScale, normalizeUiScale } from "../src/sidebar/uiScale";

describe("board UI scale", () => {
  it("moves through the available size steps", () => {
    expect(adjustUiScale(1, 1)).toBe(1.1);
    expect(adjustUiScale(1, -1)).toBe(0.9);
  });

  it("stops at the minimum and maximum", () => {
    expect(adjustUiScale(0.8, -1)).toBe(0.8);
    expect(adjustUiScale(1.3, 1)).toBe(1.3);
  });

  it("normalizes invalid and non-step persisted values", () => {
    expect(normalizeUiScale("large")).toBe(1);
    expect(normalizeUiScale(1.24)).toBe(1.2);
  });
});
