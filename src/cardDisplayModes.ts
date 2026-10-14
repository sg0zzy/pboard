import { CARD_DISPLAY_MODES, type CardDisplayMode } from "./types";

export const DEFAULT_CARD_DISPLAY_MODE: CardDisplayMode = "standard";

export const CARD_DISPLAY_MODE_DEFINITIONS: ReadonlyArray<{
  id: CardDisplayMode;
  label: string;
}> = [
  { id: "compact", label: "Compact view" },
  { id: "standard", label: "Standard view" },
  { id: "expanded", label: "Expanded view" }
];

export function normalizeCardDisplayMode(value: unknown): CardDisplayMode {
  return CARD_DISPLAY_MODES.includes(value as CardDisplayMode)
    ? value as CardDisplayMode
    : DEFAULT_CARD_DISPLAY_MODE;
}

export function nextCardDisplayMode(value: unknown): CardDisplayMode {
  const current = normalizeCardDisplayMode(value);
  const index = CARD_DISPLAY_MODES.indexOf(current);
  return CARD_DISPLAY_MODES[(index + 1) % CARD_DISPLAY_MODES.length];
}
