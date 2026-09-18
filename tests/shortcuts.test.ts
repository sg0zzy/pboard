import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import {
  firstSelectedText,
  PIN_PAGE_COMMAND,
  PIN_PAGE_SHORTCUT,
  PIN_SELECTION_COMMAND,
  PIN_SELECTION_SHORTCUT
} from "../src/background/shortcuts";

describe("Pboard keyboard shortcuts", () => {
  it("defines the left-hand selection and page shortcuts", () => {
    expect(manifest.commands[PIN_SELECTION_COMMAND].suggested_key.default).toBe(PIN_SELECTION_SHORTCUT);
    expect(manifest.commands[PIN_PAGE_COMMAND].suggested_key.default).toBe(PIN_PAGE_SHORTCUT);
    expect(manifest.permissions).toEqual(expect.arrayContaining(["activeTab", "scripting"]));
  });

  it("uses the first non-empty selection returned from the active tab frames", () => {
    expect(firstSelectedText([
      { result: "  " },
      { result: " Selected in a frame " },
      { result: "Later" }
    ])).toBe("Selected in a frame");
    expect(firstSelectedText([{ result: null }, { result: "" }])).toBeUndefined();
  });
});
