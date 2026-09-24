import { type CSSProperties, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { STATUS_DEFINITIONS, statusClassName } from "../../statuses";
import type { BoardItemStatus } from "../../types";

const statusDefinitions = STATUS_DEFINITIONS;
const MENU_GUTTER = 8;
const MENU_GAP = 4;

type MenuPlacement = {
  top: number;
  left: number;
  maxHeight: number;
};

export function placeStatusMenu(
  trigger: Pick<DOMRect, "top" | "right" | "bottom">,
  menu: { width: number; height: number },
  viewport: { width: number; height: number }
): MenuPlacement {
  const availableBelow = Math.max(0, viewport.height - trigger.bottom - MENU_GAP - MENU_GUTTER);
  const availableAbove = Math.max(0, trigger.top - MENU_GAP - MENU_GUTTER);
  const placeBelow = menu.height <= availableBelow || availableBelow >= availableAbove;
  const maxHeight = placeBelow ? availableBelow : availableAbove;
  const visibleHeight = Math.min(menu.height, maxHeight);
  const left = Math.min(
    Math.max(MENU_GUTTER, trigger.right - menu.width),
    Math.max(MENU_GUTTER, viewport.width - MENU_GUTTER - menu.width)
  );
  return {
    top: placeBelow ? trigger.bottom + MENU_GAP : trigger.top - MENU_GAP - visibleHeight,
    left,
    maxHeight
  };
}

type Props = {
  value: BoardItemStatus;
  onChange: (status: BoardItemStatus) => void;
  disabled?: boolean;
};

export function StatusPicker({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [menuPlacement, setMenuPlacement] = useState<MenuPlacement | null>(null);
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

  useLayoutEffect(() => {
    if (!open) {
      setMenuPlacement(null);
      return;
    }
    const positionMenu = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      setMenuPlacement(placeStatusMenu(
        trigger,
        { width: menu.getBoundingClientRect().width, height: menu.scrollHeight },
        { width: window.innerWidth, height: window.innerHeight }
      ));
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
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
      const targetId = event.key === "ArrowUp" ? statusDefinitions.at(-1)?.id : statusDefinitions[0]?.id;
      if (targetId && targetId !== value) onChange(targetId);
      openAndFocus(targetId);
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
      if (target) {
        if (target.id !== value) onChange(target.id);
        optionRefs.current.get(target.id)?.focus();
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      const target = statusDefinitions[0];
      if (target.id !== value) onChange(target.id);
      optionRefs.current.get(target.id)?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const lastId = statusDefinitions.at(-1)?.id;
      if (lastId) {
        if (lastId !== value) onChange(lastId);
        optionRefs.current.get(lastId)?.focus();
      }
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
        <span aria-hidden={!open}>{current.symbol} {current.label}</span>
        <span aria-hidden="true" className="status-picker-chevron">
          {open ? "∧" : "⌄"}
        </span>
      </button>
      {open && (
        <ul
          className="status-picker-menu"
          role="listbox"
          ref={menuRef}
          style={menuPlacement
            ? { top: menuPlacement.top, left: menuPlacement.left, maxHeight: menuPlacement.maxHeight }
            : { visibility: "hidden" } as CSSProperties}
        >
          {statusDefinitions.map((definition, index) => {
            const selected = definition.id === value;
            return (
              <li key={definition.id} role="none">
                <button
                  type="button"
                  className={`status-picker-option status-picker-option--${statusClassName(definition.id)}${selected ? " selected" : ""}`}
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
                  <span>{definition.symbol} {definition.label}</span>
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
