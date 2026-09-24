import type { BoardItem, BoardItemStatus } from "../types";

function statusContainer(status: BoardItemStatus): "active" | "rejected" | "done" | "trash" {
  if (status === "rejected" || status === "done" || status === "trash") return status;
  return "active";
}

export function focusTargetAfterStatusMove(
  items: BoardItem[],
  itemId: string,
  beforeStatus: BoardItemStatus,
  afterStatus: BoardItemStatus
): string | null {
  if (statusContainer(beforeStatus) === statusContainer(afterStatus)) return itemId;

  const sourceItems = items.filter((item) => statusContainer(item.status) === statusContainer(beforeStatus));
  const index = sourceItems.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  return sourceItems[index + 1]?.id ?? sourceItems[index - 1]?.id ?? null;
}
