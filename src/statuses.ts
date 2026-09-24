import {
  BOARD_ITEM_STATUSES,
  BOARD_ITEM_STATUS_ROWS,
  BOARD_ITEM_WORKFLOW_STATUSES,
  type BoardItemStatus
} from "./types";

export type StatusDefinition = {
  id: BoardItemStatus;
  label: string;
  symbol: string;
  color: string;
};

const STATUS_METADATA: Record<BoardItemStatus, Omit<StatusDefinition, "id">> = {
  candidate: { label: "Candidate", symbol: "○", color: "#62645d" },
  confirmed: { label: "Confirmed", symbol: "●", color: "#3e6c46" },
  started: { label: "Started", symbol: "▶", color: "#6a5112" },
  "to validate": { label: "To validate", symbol: "◐", color: "#3974c1" },
  done: { label: "Done", symbol: "✓", color: "#2c5c38" },
  rejected: { label: "Rejected", symbol: "×", color: "#944740" },
  trash: { label: "Trashed", symbol: "–", color: "#62645d" }
};

function definition(status: BoardItemStatus): StatusDefinition {
  return { id: status, ...STATUS_METADATA[status] };
}

export const WORKFLOW_STATUS_ROWS = BOARD_ITEM_STATUS_ROWS.map((row) => row.map(definition));
export const WORKFLOW_STATUS_DEFINITIONS = BOARD_ITEM_WORKFLOW_STATUSES.map(definition);
export const STATUS_DEFINITIONS = BOARD_ITEM_STATUSES.map(definition);

export function statusClassName(status: BoardItemStatus): string {
  return status.replaceAll(" ", "-");
}
