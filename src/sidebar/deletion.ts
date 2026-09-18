import type { BoardItemStatus } from "../types";

export function cardDeletionNeedsConfirmation(status: BoardItemStatus): boolean {
  return status === "confirmed";
}
