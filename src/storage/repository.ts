import { boardTemplates, isTypeSupported } from "../templates/boardTemplates";
import type { AppState, BoardItem, BoardItemStatus, BoardItemType, BoardTemplate, Project } from "../types";

export const STORAGE_KEY = "projectBoardState";

export interface KeyValueStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export const EMPTY_STATE: AppState = {
  version: 2,
  projects: [],
  boardItems: [],
  currentProjectId: null
};

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

export function createRepository(storage: KeyValueStorage) {
  async function load(): Promise<AppState> {
    const result = await storage.get(STORAGE_KEY);
    const saved = result[STORAGE_KEY];
    if (!saved || typeof saved !== "object") return structuredClone(EMPTY_STATE);
    const legacy = saved as Partial<AppState> & { projects?: Array<Partial<Project>> };
    return {
      version: 2,
      projects: (legacy.projects ?? []).map((project) => ({ ...project, template: project.template ?? "project" })) as Project[],
      boardItems: legacy.boardItems ?? [],
      currentProjectId: legacy.currentProjectId ?? null
    };
  }

  async function save(state: AppState): Promise<AppState> {
    await storage.set({ [STORAGE_KEY]: state });
    return state;
  }

  async function createProject(name: string, template: BoardTemplate = "brainstorming"): Promise<Project> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    const state = await load();
    const timestamp = now();
    const project: Project = { id: newId(), name: trimmed, template, createdAt: timestamp, updatedAt: timestamp };
    state.projects.push(project);
    state.currentProjectId = project.id;
    await save(state);
    return project;
  }

  async function selectProject(projectId: string): Promise<void> {
    const state = await load();
    if (!state.projects.some((project) => project.id === projectId)) throw new Error("Project not found");
    state.currentProjectId = projectId;
    await save(state);
  }

  async function renameProject(projectId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    const state = await load();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found");
    project.name = trimmed;
    project.updatedAt = now();
    await save(state);
  }

  async function deleteProject(projectId: string): Promise<void> {
    const state = await load();
    state.projects = state.projects.filter((project) => project.id !== projectId);
    state.boardItems = state.boardItems.filter((item) => item.projectId !== projectId);
    if (state.currentProjectId === projectId) state.currentProjectId = state.projects[0]?.id ?? null;
    await save(state);
  }

  async function changeProjectTemplate(projectId: string, template: BoardTemplate): Promise<number> {
    const state = await load();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found");
    const timestamp = now();
    let remapped = 0;
    state.boardItems.forEach((item) => {
      if (item.projectId === projectId && !isTypeSupported(template, item.type)) {
        item.type = "note";
        item.updatedAt = timestamp;
        remapped += 1;
      }
    });
    project.template = template;
    project.updatedAt = timestamp;
    await save(state);
    return remapped;
  }

  async function addItem(input: {
    projectId: string;
    content: string;
    title?: string;
    type?: BoardItemType;
    status?: BoardItemStatus;
    source?: BoardItem["source"];
    afterItemId?: string;
  }): Promise<BoardItem> {
    const content = input.content.trim();
    if (!content) throw new Error("Card content is required");
    const state = await load();
    const timestamp = now();
    const project = state.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) throw new Error("Project not found");
    const projectItems = state.boardItems.filter((item) => item.projectId === input.projectId);
    const afterItem = input.afterItemId
      ? projectItems.find((item) => item.id === input.afterItemId)
      : undefined;
    const order = afterItem ? afterItem.order + 1 : projectItems.length;
    if (afterItem) {
      projectItems.forEach((item) => {
        if (item.order >= order) item.order += 1;
      });
    }
    const item: BoardItem = {
      id: newId(),
      projectId: input.projectId,
      type: input.type && isTypeSupported(project.template, input.type)
        ? input.type
        : boardTemplates[project.template].defaultCardType,
      status: input.status ?? "candidate",
      content,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.source ? { source: input.source } : {}),
      order,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.boardItems.push(item);
    await save(state);
    return item;
  }

  async function updateItem(itemId: string, patch: Partial<Pick<BoardItem, "content" | "title" | "type" | "status">>): Promise<void> {
    const state = await load();
    const item = state.boardItems.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error("Card not found");
    if (patch.content !== undefined && !patch.content.trim()) throw new Error("Card content is required");
    const project = state.projects.find((candidate) => candidate.id === item.projectId);
    if (patch.type && project && !isTypeSupported(project.template, patch.type)) {
      throw new Error("Card type is not supported by this board template");
    }
    Object.assign(item, patch, { updatedAt: now() });
    await save(state);
  }

  async function deleteItem(itemId: string): Promise<void> {
    const state = await load();
    const item = state.boardItems.find((candidate) => candidate.id === itemId);
    state.boardItems = state.boardItems.filter((candidate) => candidate.id !== itemId);
    if (item) normalizeOrder(state, item.projectId);
    await save(state);
  }

  async function duplicateItem(itemId: string): Promise<BoardItem> {
    const state = await load();
    const source = state.boardItems.find((item) => item.id === itemId);
    if (!source) throw new Error("Card not found");
    const timestamp = now();
    const order = source.order + 1;
    state.boardItems.forEach((item) => {
      if (item.projectId === source.projectId && item.order >= order) item.order += 1;
    });
    const duplicate: BoardItem = {
      ...source,
      id: newId(),
      status: "candidate",
      order,
      ...(source.source ? { source: structuredClone(source.source) } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.boardItems.push(duplicate);
    await save(state);
    return duplicate;
  }

  async function reorderItems(projectId: string, orderedIds: string[]): Promise<void> {
    const state = await load();
    const projectIds = state.boardItems.filter((item) => item.projectId === projectId).map((item) => item.id);
    if (orderedIds.length !== projectIds.length || !projectIds.every((id) => orderedIds.includes(id))) {
      throw new Error("Reorder list must contain every project card exactly once");
    }
    orderedIds.forEach((id, index) => {
      const item = state.boardItems.find((candidate) => candidate.id === id);
      if (item) {
        item.order = index;
        item.updatedAt = now();
      }
    });
    await save(state);
  }

  return { load, createProject, selectProject, renameProject, deleteProject, changeProjectTemplate, addItem, updateItem, deleteItem, duplicateItem, reorderItems };
}

function normalizeOrder(state: AppState, projectId: string) {
  state.boardItems
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => a.order - b.order)
    .forEach((item, index) => { item.order = index; });
}
