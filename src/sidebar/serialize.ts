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

export function serializeBoard(project: Project, items: BoardItem[]): string {
  const sections = items.filter((item) => item.status !== "rejected" && item.status !== "trash");
  return serializeProject(project, sections);
}
