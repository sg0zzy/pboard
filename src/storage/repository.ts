import { boardTemplates, isTypeSupported } from "../templates/boardTemplates";
import { normalizeCardDisplayMode } from "../cardDisplayModes";
import { withStorageLock } from "./lock";
import type { AppState, BoardImage, BoardItem, BoardItemStatus, BoardItemType, BoardTemplate, Project } from "../types";

export const STORAGE_KEY = "projectBoardState";

export interface KeyValueStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export type RepositoryEvents = {
  /** Local legacy-copy cleanup; must not perform network I/O. */
  projectErased?: (projectId: string) => void | Promise<void>;
  projectChanged?: (projectId: string) => void | Promise<void>;
  projectDeleting?: (project: Project) => void | Promise<void>;
  projectDeleted?: (projectId: string) => void | Promise<void>;
  projectHidden?: (projectId: string) => void | Promise<void>;
};

export const EMPTY_STATE: AppState = {
  version: 3,
  projects: [],
  boardItems: [],
  currentProjectId: null
};

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

export function createRepository(storage: KeyValueStorage, events: RepositoryEvents = {}) {
  function withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withStorageLock(storage, STORAGE_KEY, operation);
  }

  async function load(): Promise<AppState> {
    const result = await storage.get(STORAGE_KEY);
    const saved = result[STORAGE_KEY];
    if (!saved || typeof saved !== "object") return structuredClone(EMPTY_STATE);
    const legacy = saved as Partial<AppState> & { projects?: Array<Partial<Project>> };
    return {
      version: 3,
      projects: (legacy.projects ?? []).map((project) => ({
        ...project,
        template: project.template ?? "project",
        revision: typeof project.revision === "number" ? project.revision : 0,
        createdAt: project.createdAt ?? "1970-01-01T00:00:00.000Z",
        updatedAt: project.updatedAt ?? project.createdAt ?? "1970-01-01T00:00:00.000Z"
      })) as Project[],
      boardItems: (legacy.boardItems ?? []).map((item) => ({
        ...item,
        displayMode: normalizeCardDisplayMode(item.displayMode)
      })),
      currentProjectId: legacy.currentProjectId ?? null
    };
  }

  async function save(state: AppState): Promise<AppState> {
    await storage.set({ [STORAGE_KEY]: state });
    return state;
  }

  async function changed(projectId: string) {
    await events.projectChanged?.(projectId);
  }

  async function createProject(name: string, template: BoardTemplate = "brainstorming"): Promise<Project> {
    return withLock(async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Project name is required");
      const state = await load();
      const timestamp = now();
      const project: Project = { id: newId(), name: trimmed, template, revision: 1, createdAt: timestamp, updatedAt: timestamp };
      state.projects.push(project);
      state.currentProjectId = project.id;
      await save(state);
      await changed(project.id);
      return project;
    });
  }

  async function selectProject(projectId: string): Promise<void> {
    return withLock(async () => {
      const state = await load();
      if (!state.projects.some((project) => project.id === projectId)) throw new Error("Project not found");
      state.currentProjectId = projectId;
      await save(state);
    });
  }

  async function reorderProjects(orderedIds: string[]): Promise<void> {
    return withLock(async () => {
      const state = await load();
      const projectIds = state.projects.map((project) => project.id);
      if (orderedIds.length !== projectIds.length || !projectIds.every((id) => orderedIds.includes(id))) {
        throw new Error("Project list must contain every project exactly once");
      }
      state.projects = orderedIds.map((id) => state.projects.find((project) => project.id === id) as Project);
      await save(state);
    });
  }

  async function renameProject(projectId: string, name: string): Promise<void> {
    return withLock(async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Project name is required");
      const state = await load();
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error("Project not found");
      if (project.name === trimmed) return;
      project.name = trimmed;
      touchProject(project);
      await save(state);
      await changed(projectId);
    });
  }

  async function deleteProject(projectId: string): Promise<void> {
    return withLock(async () => {
      const state = await load();
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) return;
      await events.projectDeleting?.(structuredClone(project));
      state.projects = state.projects.filter((candidate) => candidate.id !== projectId);
      state.boardItems = state.boardItems.filter((item) => item.projectId !== projectId);
      if (state.currentProjectId === projectId) state.currentProjectId = state.projects[0]?.id ?? null;
      await save(state);
      await events.projectDeleted?.(projectId);
    });
  }

  async function changeProjectTemplate(projectId: string, template: BoardTemplate): Promise<number> {
    return withLock(async () => {
      const state = await load();
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error("Project not found");
      if (project.template === template) return 0;
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
      touchProject(project, timestamp);
      await save(state);
      await changed(projectId);
      return remapped;
    });
  }

  async function addItem(input: {
    projectId: string;
    content: string;
    title?: string;
    type?: BoardItemType;
    status?: BoardItemStatus;
    displayMode?: BoardItem["displayMode"];
    source?: BoardItem["source"];
    image?: BoardImage;
    afterItemId?: string;
  }): Promise<BoardItem> {
    return withLock(async () => {
      const content = input.content.trim();
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
        displayMode: normalizeCardDisplayMode(input.displayMode),
        content,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.image ? { image: input.image } : {}),
        order,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.boardItems.push(item);
      touchProject(project, timestamp);
      await save(state);
      await changed(project.id);
      return item;
    });
  }

  async function updateItem(itemId: string, patch: Partial<Pick<BoardItem, "content" | "title" | "type" | "status" | "displayMode">>): Promise<void> {
    return withLock(async () => {
      const state = await load();
      const item = state.boardItems.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error("Card not found");
      const project = state.projects.find((candidate) => candidate.id === item.projectId);
      if (patch.type && project && !isTypeSupported(project.template, patch.type)) {
        throw new Error("Card type is not supported by this board template");
      }
      const changedFields = Object.entries(patch).filter(([key, value]) => item[key as keyof BoardItem] !== value);
      if (changedFields.length === 0) return;
      Object.assign(item, Object.fromEntries(changedFields), { updatedAt: now() });
      if (project) touchProject(project, item.updatedAt);
      await save(state);
      if (project) await changed(project.id);
    });
  }

  async function deleteItem(itemId: string): Promise<void> {
    return withLock(async () => {
      const state = await load();
      const item = state.boardItems.find((candidate) => candidate.id === itemId);
      state.boardItems = state.boardItems.filter((candidate) => candidate.id !== itemId);
      if (item) {
        normalizeOrder(state, item.projectId);
        const project = state.projects.find((candidate) => candidate.id === item.projectId);
        if (project) touchProject(project);
      }
      await save(state);
      if (item) await changed(item.projectId);
    });
  }

  async function emptyTrash(projectId: string): Promise<number> {
    return withLock(async () => {
      const state = await load();
      const trashIds = new Set(
        state.boardItems
          .filter((item) => item.projectId === projectId && item.status === "trash")
          .map((item) => item.id)
      );
      if (trashIds.size) {
        state.boardItems = state.boardItems.filter((item) => !trashIds.has(item.id));
        normalizeOrder(state, projectId);
        const project = state.projects.find((candidate) => candidate.id === projectId);
        if (project) touchProject(project);
      }
      await save(state);
      if (trashIds.size) await changed(projectId);
      return trashIds.size;
    });
  }

  async function duplicateItem(itemId: string): Promise<BoardItem> {
    return withLock(async () => {
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
      const project = state.projects.find((candidate) => candidate.id === source.projectId);
      if (project) touchProject(project, timestamp);
      await save(state);
      await changed(source.projectId);
      return duplicate;
    });
  }

  async function mergeItems(sourceId: string, targetId: string): Promise<void> {
    return withLock(async () => {
      if (sourceId === targetId) throw new Error("A card cannot be merged into itself");
      const state = await load();
      const source = state.boardItems.find((item) => item.id === sourceId);
      const target = state.boardItems.find((item) => item.id === targetId);
      if (!source || !target) throw new Error("Card not found");
      if (source.projectId !== target.projectId) throw new Error("Cards must belong to the same project");
      if (source.image) throw new Error("Image cards cannot be merged without losing the image");

      const appended = [source.title?.trim(), source.content.trim()].filter(Boolean).join("\n");
      target.content = [target.content.trimEnd(), appended].filter(Boolean).join("\n\n");
      target.updatedAt = now();
      state.boardItems = state.boardItems.filter((item) => item.id !== sourceId);
      normalizeOrder(state, source.projectId);
      const project = state.projects.find((candidate) => candidate.id === source.projectId);
      if (project) touchProject(project, target.updatedAt);
      await save(state);
      await changed(source.projectId);
    });
  }

  async function reorderItems(projectId: string, orderedIds: string[]): Promise<void> {
    return withLock(async () => {
      const state = await load();
      const projectIds = state.boardItems.filter((item) => item.projectId === projectId).map((item) => item.id);
      if (orderedIds.length !== projectIds.length || !projectIds.every((id) => orderedIds.includes(id))) {
        throw new Error("Reorder list must contain every project card exactly once");
      }
      if (orderedIds.every((id, index) => projectIds[index] === id)) return;
      orderedIds.forEach((id, index) => {
        const item = state.boardItems.find((candidate) => candidate.id === id);
        if (item) {
          item.order = index;
          item.updatedAt = now();
        }
      });
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (project) touchProject(project);
      await save(state);
      await changed(projectId);
    });
  }

  return { load, createProject, selectProject, reorderProjects, renameProject, deleteProject, changeProjectTemplate, addItem, updateItem, deleteItem, duplicateItem, emptyTrash, mergeItems, reorderItems };
}

function normalizeOrder(state: AppState, projectId: string) {
  state.boardItems
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => a.order - b.order)
    .forEach((item, index) => { item.order = index; });
}

function touchProject(project: Project, timestamp = now()) {
  project.revision += 1;
  const previous = Date.parse(project.updatedAt);
  const candidate = Date.parse(timestamp);
  project.updatedAt = Number.isFinite(previous) && (!Number.isFinite(candidate) || candidate <= previous)
    ? new Date(previous + 1).toISOString()
    : timestamp;
}
