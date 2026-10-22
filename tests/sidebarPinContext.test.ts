// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { samePinContext } from "../src/sidebar/pinContext";
import type { ToolbarPinContext } from "../src/messaging/messages";

/**
 * The toolbar pin context is polled every 1.5 seconds and every answer is a
 * fresh object. Storing it unchanged re-rendered the whole board, and every
 * card re-parsed its markdown, which made the board feel slow.
 */
describe("samePinContext", () => {
  const base: ToolbarPinContext = { page: true, selection: false, link: false, accessible: true };

  it("treats an unchanged answer as equal", () => {
    expect(samePinContext(base, { page: true, selection: false, link: false, accessible: true })).toBe(true);
  });

  it("reports a changed page state", () => {
    expect(samePinContext(base, { ...base, selection: true })).toBe(false);
    expect(samePinContext(base, { ...base, link: true })).toBe(false);
    expect(samePinContext(base, { ...base, page: false })).toBe(false);
    expect(samePinContext(base, { ...base, accessible: false })).toBe(false);
  });
});
