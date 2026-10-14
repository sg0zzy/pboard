import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { note, type CardTypeDefinition } from "../../templates/boardTemplates";
import type { BoardItemType } from "../../types";
import { ChevronDownIcon } from "./icons";

type Props = {
  cardTypes: readonly CardTypeDefinition[];
  value: BoardItemType;
  onChange: (type: BoardItemType) => void;
};

export function CategoryPicker({ cardTypes, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const isLegacy = !cardTypes.some((definition) => definition.id === value);
  const options = isLegacy
    ? [
        { id: value, label: `LEGACY: ${value.replaceAll("_", " ").toUpperCase()}`, color: note.color },
        ...cardTypes
      ]
    : cardTypes;
  const currentDefinition = cardTypes.find((definition) => definition.id === value) ?? note;
  const triggerLabel = isLegacy ? options[0].label : currentDefinition.label;

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
      const target = options.find((definition) => definition.id === targetId) ?? options[0];
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
      openAndFocus(event.key === "ArrowUp" ? options.at(-1)?.id : options[0]?.id);
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
      const target = options[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) optionRefs.current.get(target.id)?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = options[0];
      if (first) optionRefs.current.get(first.id)?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const last = options.at(-1);
      if (last) optionRefs.current.get(last.id)?.focus();
    }
  }

  return (
    <div className="type-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="type-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? closeAndFocusTrigger() : openAndFocus())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{triggerLabel}</span>
        <span className="type-picker-chevron" aria-hidden="true"><ChevronDownIcon /></span>
      </button>
      {open && (
        <div className="type-picker-menu" role="listbox" aria-label="Card type">
          {options.map((definition, index) => (
            <button
              key={definition.id}
              ref={(element) => {
                if (element) optionRefs.current.set(definition.id, element);
                else optionRefs.current.delete(definition.id);
              }}
              type="button"
              role="option"
              aria-selected={definition.id === value}
              className={`type-picker-option${definition.id === value ? " selected" : ""}`}
              onClick={() => {
                if (definition.id !== value) void onChange(definition.id);
                closeAndFocusTrigger();
              }}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span className="type-picker-swatch" style={{ backgroundColor: definition.color }} aria-hidden="true" />
              <span>{definition.label}</span>
              {definition.id === value && <span className="type-picker-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
