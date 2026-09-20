import { describe, expect, it } from "vitest";
import { cardDeletionNeedsConfirmation } from "../src/sidebar/deletion";

describe("card deletion confirmation policy", () => {
  it("protects confirmed cards", () => {
    expect(cardDeletionNeedsConfirmation("confirmed")).toBe(true);
  });

  it("allows candidate, rejected, done, and trash cards to be removed immediately", () => {
    expect(cardDeletionNeedsConfirmation("candidate")).toBe(false);
    expect(cardDeletionNeedsConfirmation("rejected")).toBe(false);
    expect(cardDeletionNeedsConfirmation("done")).toBe(false);
    expect(cardDeletionNeedsConfirmation("trash")).toBe(false);
  });
});
