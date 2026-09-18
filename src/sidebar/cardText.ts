import type { BoardItem } from "../types";

export function cardTextForClipboard(item: Pick<BoardItem, "title" | "content">): string {
  return [item.title?.trim(), item.content.trim()].filter(Boolean).join("\n");
}
