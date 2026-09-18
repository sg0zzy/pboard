export const PIN_SELECTION_COMMAND = "pin-selection-to-pboard";
export const PIN_PAGE_COMMAND = "pin-page-to-pboard";
export const PIN_SELECTION_SHORTCUT = "Alt+Shift+C";
export const PIN_PAGE_SHORTCUT = "Alt+Shift+W";

export function firstSelectedText(results: Array<{ result?: unknown }>): string | undefined {
  for (const { result } of results) {
    if (typeof result !== "string") continue;
    const text = result.trim();
    if (text) return text;
  }
  return undefined;
}
