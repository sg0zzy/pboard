import { CARD_DISPLAY_MODES, type CardDisplayMode } from "./types";

export const DEFAULT_CARD_DISPLAY_MODE: CardDisplayMode = "standard";

export const CARD_DISPLAY_MODE_DEFINITIONS: ReadonlyArray<{
  id: CardDisplayMode;
  icon: string;
  label: string;
}> = [
  { id: "compact", icon: "─", label: "Compact" },
  { id: "standard", icon: "▫", label: "Standard" },
  { id: "expanded", icon: "□", label: "Expanded" }
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
