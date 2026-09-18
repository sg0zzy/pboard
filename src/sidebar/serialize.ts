import type { BoardItem, Project } from "../types";
import { getCardTypeDefinition, getTemplateDefinition } from "../templates/boardTemplates";

export function serializeBoard(project: Project, items: BoardItem[]): string {
  const template = getTemplateDefinition(project.template);
  const sections = items
    .filter((item) => item.status !== "rejected")
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const title = item.title?.trim();
      const typeLabel = template.includeTypeInPrompt
        ? getCardTypeDefinition(project.template, item.type).label.toUpperCase()
        : undefined;
      return [typeLabel, title, item.content.trim()].filter(Boolean).join("\n");
    });
  return [`PROJECT: ${project.name}`, ...sections].join("\n\n");
}
