import type { BoardItem } from "../types";

export function cardTextForClipboard(item: Pick<BoardItem, "title" | "content" | "type">): string {
  const tag = `[${item.type === "idea" ? "core_idea" : item.type}]`;
  const text = [item.title?.trim(), item.content.trim()].filter(Boolean).join("\n");
  return text ? `${tag} ${text}` : "";
}
