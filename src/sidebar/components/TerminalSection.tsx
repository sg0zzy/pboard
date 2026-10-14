import type { MouseEvent, ReactNode } from "react";
import type { BoardItemStatus } from "../../types";
import { CopyIcon, TrashIcon } from "./icons";

type TerminalStatus = Extract<BoardItemStatus, "done" | "rejected" | "trash">;

export type TerminalSectionDefinition = {
  status: TerminalStatus;
  label: string;
};

export const TERMINAL_SECTION_DEFINITIONS: readonly TerminalSectionDefinition[] = [
  { status: "done", label: "Done" },
  { status: "rejected", label: "Rejected" },
  { status: "trash", label: "Trash" }
];

type Props = {
  definition: TerminalSectionDefinition;
  count: number;
  children: ReactNode;
  onCopy?: () => void;
  onTrash: () => void;
};

function runHeaderAction(event: MouseEvent<HTMLButtonElement>, action: () => void) {
  event.preventDefault();
  event.stopPropagation();
  action();
}

export function TerminalSection({ definition, count, children, onCopy, onTrash }: Props) {
  const { status, label } = definition;
  const isTrash = status === "trash";
  const copyLabel = `Copy ${label.toLowerCase()} cards`;
  const trashLabel = isTrash ? "Empty trash" : `Trash ${label.toLowerCase()} cards`;

  return (
    <details className={`terminal-section terminal-section--${status}`} data-section-status={status}>
      <summary>
        <span className="terminal-section-chevron" aria-hidden="true" />
        <span className="terminal-section-title">{label} ({count})</span>
        <span className="terminal-section-actions">
          {onCopy && (
            <button
              type="button"
              className="copy-section-button"
              title={copyLabel}
              aria-label={copyLabel}
              onClick={(event) => runHeaderAction(event, onCopy)}
            >
              <CopyIcon />
            </button>
          )}
          <button
            type="button"
            className="empty-trash-button"
            title={trashLabel}
            aria-label={trashLabel}
            onClick={(event) => runHeaderAction(event, onTrash)}
          >
            <TrashIcon />
          </button>
        </span>
      </summary>
      {children}
    </details>
  );
}
