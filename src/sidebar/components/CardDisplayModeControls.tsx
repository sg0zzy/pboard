import { CARD_DISPLAY_MODE_DEFINITIONS } from "../../cardDisplayModes";
import type { CardDisplayMode } from "../../types";

type Props = {
  value: CardDisplayMode;
  onChange: (mode: CardDisplayMode) => void;
};

export function CardDisplayModeControls({ value, onChange }: Props) {
  return (
    <div className="display-mode-controls" role="group" aria-label="Card display mode">
      {CARD_DISPLAY_MODE_DEFINITIONS.map((mode) => (
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
          <span aria-hidden="true">{mode.icon}</span>
        </button>
      ))}
    </div>
  );
}
