import type { BoardItem, Project } from "../types";
import { cardTextForClipboard } from "./cardText";

function serializeCards(items: BoardItem[]): string[] {
  return [...items]
    .sort((a, b) => a.order - b.order)
    .map((item) => cardTextForClipboard(item));
}

export function serializeProject(project: Project, items: BoardItem[]): string {
  return [`PROJECT: ${project.name}`, ...serializeCards(items)].join("\n\n");
}

export function hasCopyableBoardItems(items: BoardItem[]): boolean {
  return items.some((item) => item.status !== "trash");
}

export function serializeBoard(project: Project, items: BoardItem[]): string {
  const ongoing = items.filter((item) => item.status !== "done" && item.status !== "rejected" && item.status !== "trash");
  const done = items.filter((item) => item.status === "done");
  const rejected = items.filter((item) => item.status === "rejected");
  return [`PROJECT: ${project.name}`, ...serializeCards(ongoing), ...serializeCards(done), ...serializeCards(rejected)].join("\n\n");
}
