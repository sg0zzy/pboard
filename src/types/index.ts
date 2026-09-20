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

export const BOARD_ITEM_STATUSES = ["candidate", "confirmed", "rejected", "started", "done", "trash"] as const;
export const BOARD_TEMPLATES = ["brainstorming", "idea", "project", "software_project"] as const;
export const PINNED_CARD_FOCUS_KEY = "pinnedCardFocusId";

export type BoardItemType = (typeof BOARD_ITEM_TYPES)[number];
export type BoardItemStatus = (typeof BOARD_ITEM_STATUSES)[number];
export type BoardTemplate = (typeof BOARD_TEMPLATES)[number];

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
  version: 2;
  projects: Project[];
  boardItems: BoardItem[];
  currentProjectId: string | null;
};
