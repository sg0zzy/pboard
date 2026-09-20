import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { BoardItemStatus } from "../../types";

type StatusDefinition = {
  id: BoardItemStatus;
  label: string;
  color: string;
};

const statusDefinitions: readonly StatusDefinition[] = [
  { id: "candidate", label: "○ Candidate", color: "#62645d" },
  { id: "confirmed", label: "● Confirmed", color: "#3e6c46" },
  { id: "rejected", label: "× Rejected", color: "#944740" },
  { id: "started", label: "▶ Started", color: "#6a5112" },
  { id: "done", label: "✓ Done", color: "#2c5c38" },
  { id: "trash", label: "– Trash", color: "#62645d" }
];

type Props = {
  value: BoardItemStatus;
  onChange: (status: BoardItemStatus) => void;
  disabled?: boolean;
};

export function StatusPicker({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const current = statusDefinitions.find((definition) => definition.id === value) ?? statusDefinitions[0];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open]);

  function openAndFocus(targetId?: string) {
    setOpen(true);
    window.requestAnimationFrame(() => {
      const target =
        statusDefinitions.find((definition) => definition.id === (targetId ?? value)) ?? statusDefinitions[0];
      if (target) optionRefs.current.get(target.id)?.focus();
    });
  }

  function closeAndFocusTrigger() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openAndFocus(event.key === "ArrowUp" ? statusDefinitions.at(-1)?.id : statusDefinitions[0]?.id);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const target = statusDefinitions[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) optionRefs.current.get(target.id)?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      optionRefs.current.get(statusDefinitions[0].id)?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const lastId = statusDefinitions.at(-1)?.id;
      if (lastId) optionRefs.current.get(lastId)?.focus();
    }
  }

  return (
    <div className="status-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        className="card-status status-picker-trigger"
        aria-label="Card status"
        aria-haspopup={open ? "listbox" : undefined}
        aria-expanded={open}
        onClick={() => (open ? closeAndFocusTrigger() : openAndFocus(value))}
        onKeyDown={handleTriggerKeyDown}
      >
        <span aria-hidden={!open}>{current.label}</span>
        <span aria-hidden="true" className="status-picker-chevron">
          {open ? "∧" : "⌄"}
        </span>
      </button>
      {open && (
        <ul className="status-picker-menu" role="listbox">
          {statusDefinitions.map((definition, index) => {
            const selected = definition.id === value;
            return (
              <li key={definition.id} role="none">
                <button
                  type="button"
                  className={`status-picker-option status-picker-option--${definition.id}${selected ? " selected" : ""}`}
                  aria-selected={selected}
                  ref={(element) => {
                    if (element) optionRefs.current.set(definition.id, element);
                  }}
                  onClick={() => {
                    if (!selected) void onChange(definition.id);
                    closeAndFocusTrigger();
                  }}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                >
                  <span
                    aria-hidden="true"
                    className="status-picker-swatch"
                    style={{ backgroundColor: definition.color }}
                  />
                  <span>{definition.label}</span>
                  <span aria-hidden="true" className="status-picker-check">
                    {selected ? "✓" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
