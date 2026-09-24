import { describe, expect, it } from "vitest";
import { placeStatusMenu } from "../src/sidebar/components/StatusPicker";

describe("status picker placement", () => {
  it("keeps the menu inside the horizontal viewport", () => {
    expect(placeStatusMenu(
      { top: 40, right: 252, bottom: 62 },
      { width: 230, height: 120 },
      { width: 260, height: 500 }
    ).left).toBe(22);
  });

  it("flips above the trigger when there is more visible room there", () => {
    const placement = placeStatusMenu(
      { top: 430, right: 252, bottom: 452 },
      { width: 230, height: 150 },
      { width: 260, height: 480 }
    );

    expect(placement.top).toBe(276);
    expect(placement.maxHeight).toBe(418);
  });

  it("caps menu height to the available visible area", () => {
    const placement = placeStatusMenu(
      { top: 180, right: 252, bottom: 202 },
      { width: 230, height: 600 },
      { width: 260, height: 400 }
    );

    expect(placement.top).toBe(206);
    expect(placement.maxHeight).toBe(186);
  });
});
