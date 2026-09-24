export const BOARD_ITEM_TYPES = [
  "note",
  "core_idea",
  "opportunity",
  "idea",
  "goal",
  "decision",
  "task",
  "issue",
  "feature",
  "main_goal",
  "main_description",
  "constraint",
  "question",
  "risk",
  "reference"
] as const;

export const BOARD_ITEM_STATUS_ROWS = [
  ["candidate", "confirmed"],
  ["started", "to validate"],
  ["done", "rejected"]
] as const;
export const BOARD_ITEM_WORKFLOW_STATUSES = BOARD_ITEM_STATUS_ROWS.flat();
export const BOARD_ITEM_STATUSES = [
  "candidate",
  "confirmed",
  "started",
  "to validate",
  "done",
  "trash",
  "rejected"
] as const;
export const BOARD_ITEM_STATUS_CYCLE = BOARD_ITEM_STATUSES;
export const BOARD_TEMPLATES = ["brainstorming", "idea", "project", "software_project"] as const;
export const CARD_DISPLAY_MODES = ["compact", "standard", "expanded"] as const;
export const PINNED_CARD_FOCUS_KEY = "pinnedCardFocusId";

export type BoardItemType = (typeof BOARD_ITEM_TYPES)[number];
export type BoardItemStatus = (typeof BOARD_ITEM_STATUSES)[number];
export type BoardTemplate = (typeof BOARD_TEMPLATES)[number];
export type CardDisplayMode = (typeof CARD_DISPLAY_MODES)[number];

export type BoardImage = {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
};

export type Project = {
  id: string;
  name: string;
  template: BoardTemplate;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type BoardItem = {
  id: string;
  projectId: string;
  type: BoardItemType;
  title?: string;
  content: string;
  image?: BoardImage;
  status: BoardItemStatus;
  displayMode?: CardDisplayMode;
  order: number;
  source?: {
    provider?: string;
    conversationUrl?: string;
    sourceText?: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type AppState = {
  version: 3;
  projects: Project[];
  boardItems: BoardItem[];
  currentProjectId: string | null;
};
