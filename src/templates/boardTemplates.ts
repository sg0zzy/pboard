import type { BoardItemType, BoardTemplate } from "../types";

export type CardTypeDefinition = {
  id: BoardItemType;
  label: string;
  color: string;
  tint: string;
};

export type BoardTemplateDefinition = {
  id: BoardTemplate;
  displayName: string;
  description: string;
  cardTypes: readonly CardTypeDefinition[];
  defaultCardType: BoardItemType;
  showTypeSelector: boolean;
  includeTypeInPrompt: boolean;
};

export const note: CardTypeDefinition = {
  id: "note",
  label: "Uncategorized",
  color: "#73766f",
  tint: "#f0f1ed"
};

export const boardTemplates: Record<BoardTemplate, BoardTemplateDefinition> = {
  brainstorming: {
    id: "brainstorming",
    displayName: "Brainstorming",
    description: "Free-form notes, no categories.",
    cardTypes: [{ ...note, label: "Note" }],
    defaultCardType: "note",
    showTypeSelector: false,
    includeTypeInPrompt: false
  },
  idea: {
    id: "idea",
    displayName: "Idea",
    description: "Light structure for exploring and refining ideas.",
    cardTypes: [
      { id: "core_idea", label: "Core Idea", color: "#3974c1", tint: "#e9f2ff" },
      { id: "opportunity", label: "Opportunity", color: "#398458", tint: "#eaf7ee" },
      { id: "question", label: "Question", color: "#9a7714", tint: "#fff7d9" },
      { id: "risk", label: "Risk", color: "#b6504b", tint: "#fdecea" },
      { id: "constraint", label: "Constraint", color: "#745e99", tint: "#f1edf8" },
      { id: "reference", label: "Reference", color: "#59758d", tint: "#edf3f7" },
      note
    ],
    defaultCardType: "note",
    showTypeSelector: true,
    includeTypeInPrompt: true
  },
  project: {
    id: "project",
    displayName: "Project",
    description: "Structured board for goals, decisions, risks and next steps.",
    cardTypes: [
      { id: "goal", label: "Goal", color: "#3974c1", tint: "#e9f2ff" },
      { id: "decision", label: "Decision", color: "#398458", tint: "#eaf7ee" },
      { id: "task", label: "Task / Next Step", color: "#22827d", tint: "#e4f6f4" },
      { id: "constraint", label: "Constraint", color: "#745e99", tint: "#f1edf8" },
      { id: "question", label: "Open Question", color: "#9a7714", tint: "#fff7d9" },
      { id: "risk", label: "Risk / Blocker", color: "#b6504b", tint: "#fdecea" },
      { id: "reference", label: "Reference", color: "#59758d", tint: "#edf3f7" },
      note
    ],
    defaultCardType: "note",
    showTypeSelector: true,
    includeTypeInPrompt: true
  },
  software_project: {
    id: "software_project",
    displayName: "SW Project",
    description: "Software goals, product work, issues and implementation tasks.",
    cardTypes: [
      { id: "issue", label: "Issue", color: "#b6504b", tint: "#fdecea" },
      { id: "feature", label: "Feature", color: "#398458", tint: "#eaf7ee" },
      { id: "decision", label: "Decision", color: "#745e99", tint: "#f1edf8" },
      { id: "task", label: "Task", color: "#22827d", tint: "#e4f6f4" },
      { id: "main_goal", label: "Main Goal", color: "#3974c1", tint: "#e9f2ff" },
      { id: "main_description", label: "Main Description", color: "#59758d", tint: "#edf3f7" },
      note
    ],
    defaultCardType: "task",
    showTypeSelector: true,
    includeTypeInPrompt: true
  }
};

export function getTemplateDefinition(template: BoardTemplate): BoardTemplateDefinition {
  return boardTemplates[template];
}

export function getCardTypeDefinition(template: BoardTemplate, type: BoardItemType): CardTypeDefinition {
  return boardTemplates[template].cardTypes.find((candidate) => candidate.id === type) ?? note;
}

export function isTypeSupported(template: BoardTemplate, type: BoardItemType): boolean {
  return boardTemplates[template].cardTypes.some((candidate) => candidate.id === type);
}
