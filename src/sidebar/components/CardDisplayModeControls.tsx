import type { ReactElement } from "react";
import { CARD_DISPLAY_MODE_DEFINITIONS } from "../../cardDisplayModes";
import { CompactViewIcon, ExpandedViewIcon, StandardViewIcon } from "./icons";
import type { CardDisplayMode } from "../../types";

type Props = {
  value: CardDisplayMode;
  onChange: (mode: CardDisplayMode) => void;
};

const MODE_ICONS: Record<CardDisplayMode, () => ReactElement> = {
  compact: CompactViewIcon,
  standard: StandardViewIcon,
  expanded: ExpandedViewIcon
};

export function CardDisplayModeControls({ value, onChange }: Props) {
  return (
    <div className="display-mode-controls" role="group" aria-label="Card display mode">
      {CARD_DISPLAY_MODE_DEFINITIONS.map((mode) => {
        const ModeIcon = MODE_ICONS[mode.id];
        return (
          <button
            key={mode.id}
            type="button"
            className={`display-mode-button${mode.id === value ? " selected" : ""}`}
            aria-label={mode.label}
            aria-pressed={mode.id === value}
            title={mode.label}
            onClick={() => {
              if (mode.id !== value) onChange(mode.id);
            }}
          >
            <ModeIcon />
          </button>
        );
      })}
    </div>
  );
}