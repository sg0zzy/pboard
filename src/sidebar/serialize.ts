import type { BoardItem, Project } from "../types";
import { cardTextForClipboard } from "./cardText";

export function serializeBoard(project: Project, items: BoardItem[]): string {
  const sections = items
    .filter((item) => item.status !== "rejected" && item.status !== "trash")
    .sort((a, b) => a.order - b.order)
    .map((item) => cardTextForClipboard(item));
  return [`PROJECT: ${project.name}`, ...sections].join("\n\n");
}
