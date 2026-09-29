import { EMPTY_STATE, STORAGE_KEY, type KeyValueStorage } from "../storage/repository";
import { normalizeCardDisplayMode } from "../cardDisplayModes";
import { withStorageLock } from "../storage/lock";
import type { AppState, BoardItem, Project } from "../types";

export const PROJECT_SNAPSHOT_VERSION = 1;

export type ProjectSnapshot = {
  format: "pboard-project";
  version: typeof PROJECT_SNAPSHOT_VERSION;
  exportedAt: string;
  project: Project;
  items: BoardItem[];
};

export type SnapshotApplyResult = "applied" | "local-newer" | "equal" | "blocked";
export type SnapshotApplyGuard = () => boolean | Promise<boolean>;

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function compareProjectTimestamps(left: Project, right: Project): number {
  return Math.sign(timestampValue(left.updatedAt) - timestampValue(right.updatedAt));
}

export function serializeProjectSnapshot(project: Project, items: BoardItem[], exportedAt = new Date().toISOString()): string {
  const snapshot: ProjectSnapshot = {
    format: "pboard-project",
    version: PROJECT_SNAPSHOT_VERSION,
    exportedAt,
    project: structuredClone(project),
    items: structuredClone(items)
      .map((item) => ({ ...item, displayMode: normalizeCardDisplayMode(item.displayMode) }))
      .sort((left, right) => left.order - right.order)
  };
  return JSON.stringify(snapshot);
}

export function deserializeProjectSnapshot(value: string): ProjectSnapshot {
  const parsed = JSON.parse(value) as Partial<ProjectSnapshot>;
  if (
    parsed.format !== "pboard-project" ||
    parsed.version !== PROJECT_SNAPSHOT_VERSION ||
    !parsed.project ||
    typeof parsed.project.id !== "string" ||
    typeof parsed.project.revision !== "number" ||
    typeof parsed.project.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.project.updatedAt)) ||
    !Array.isArray(parsed.items) ||
    parsed.items.some((item) => item.projectId !== parsed.project?.id)
  ) {
    throw new Error("The Google Drive project snapshot is invalid or unsupported");
  }
  return {
    ...parsed,
    items: parsed.items.map((item) => ({
      ...item,
      displayMode: normalizeCardDisplayMode(item.displayMode)
    }))
  } as ProjectSnapshot;
}

export function createProjectSnapshotStore(storage: KeyValueStorage) {
  async function loadState(): Promise<AppState> {
    const result = await storage.get(STORAGE_KEY);
    const saved = result[STORAGE_KEY];
    if (!saved || typeof saved !== "object") return structuredClone(EMPTY_STATE);
    return structuredClone(saved) as AppState;
  }

  async function read(projectId: string): Promise<ProjectSnapshot> {
    const state = await loadState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found");
    return deserializeProjectSnapshot(serializeProjectSnapshot(
      project,
      state.boardItems.filter((item) => item.projectId === projectId)
    ));
  }

  async function list(): Promise<ProjectSnapshot[]> {
    const state = await loadState();
    return state.projects.map((project) => deserializeProjectSnapshot(serializeProjectSnapshot(
      project,
      state.boardItems.filter((item) => item.projectId === project.id)
    )));
  }

  function replaceProject(state: AppState, snapshot: ProjectSnapshot): AppState {
    const projectIndex = state.projects.findIndex((candidate) => candidate.id === snapshot.project.id);
    if (projectIndex >= 0) state.projects[projectIndex] = structuredClone(snapshot.project);
    else state.projects.push(structuredClone(snapshot.project));
    state.boardItems = [
      ...state.boardItems.filter((item) => item.projectId !== snapshot.project.id),
      ...structuredClone(snapshot.items).map((item) => ({
        ...item,
        displayMode: normalizeCardDisplayMode(item.displayMode)
      }))
    ];
    if (!state.currentProjectId || !state.projects.some((project) => project.id === state.currentProjectId)) {
      state.currentProjectId = snapshot.project.id;
    }
    return { ...state, version: 3 };
  }

  async function apply(snapshot: ProjectSnapshot, canApply?: SnapshotApplyGuard): Promise<boolean> {
    return withStorageLock(storage, STORAGE_KEY, async () => {
      if (canApply && !(await canApply())) return false;
      const state = await loadState();
      await storage.set({ [STORAGE_KEY]: replaceProject(state, snapshot) });
      return true;
    });
  }

  async function applyIfNewer(snapshot: ProjectSnapshot, canApply?: SnapshotApplyGuard): Promise<SnapshotApplyResult> {
    return withStorageLock(storage, STORAGE_KEY, async () => {
      if (canApply && !(await canApply())) return "blocked";
      const state = await loadState();
      const local = state.projects.find((project) => project.id === snapshot.project.id);
      if (local) {
        const comparison = compareProjectTimestamps(snapshot.project, local);
        if (comparison < 0) return "local-newer";
        if (comparison === 0) return "equal";
      }
      await storage.set({ [STORAGE_KEY]: replaceProject(state, snapshot) });
      return "applied";
    });
  }

  async function remove(projectId: string): Promise<void> {
    return withStorageLock(storage, STORAGE_KEY, async () => {
      const state = await loadState();
      const hadProject = state.projects.some((project) => project.id === projectId);
      const hadItems = state.boardItems.some((item) => item.projectId === projectId);
      if (!hadProject && !hadItems) return;
      state.projects = state.projects.filter((project) => project.id !== projectId);
      state.boardItems = state.boardItems.filter((item) => item.projectId !== projectId);
      if (state.currentProjectId === projectId) state.currentProjectId = state.projects[0]?.id ?? null;
      await storage.set({ [STORAGE_KEY]: { ...state, version: 3 } satisfies AppState });
    });
  }

  return { read, list, apply, applyIfNewer, remove };
}

export type ProjectSnapshotStore = ReturnType<typeof createProjectSnapshotStore>;

/** Keeps Drive's v1 wire format while RxDB stores cards/blobs separately. */
export function createBackendProjectSnapshotStore(storage: KeyValueStorage, getRx: () => Promise<import("../storage/rxdbRepository").RxRepository | null>): ProjectSnapshotStore {
  const legacy = createProjectSnapshotStore(storage);
  async function read(projectId: string): Promise<ProjectSnapshot> {
    const rx = await getRx();
    if (!rx) return legacy.read(projectId);
    const { project, items } = await rx.exportProject(projectId);
    return deserializeProjectSnapshot(serializeProjectSnapshot(project, items));
  }
  async function list(): Promise<ProjectSnapshot[]> {
    const rx = await getRx();
    if (!rx) return legacy.list();
    return Promise.all((await rx.listProjects()).map((project) => read(project.id)));
  }
  async function apply(snapshot: ProjectSnapshot, canApply?: SnapshotApplyGuard): Promise<boolean> {
    const rx = await getRx();
    if (!rx) return legacy.apply(snapshot, canApply);
    if (canApply && !(await canApply())) return false;
    await rx.importProject(snapshot.project, snapshot.items);
    return true;
  }
  async function applyIfNewer(snapshot: ProjectSnapshot, canApply?: SnapshotApplyGuard): Promise<SnapshotApplyResult> {
    const rx = await getRx();
    if (!rx) return legacy.applyIfNewer(snapshot, canApply);
    if (canApply && !(await canApply())) return "blocked";
    const local = await rx.getProject(snapshot.project.id);
    if (local) {
      const comparison = compareProjectTimestamps(snapshot.project, local);
      if (comparison < 0) return "local-newer";
      if (comparison === 0) return "equal";
    }
    await rx.importProject(snapshot.project, snapshot.items);
    return "applied";
  }
  async function remove(projectId: string) {
    const rx = await getRx();
    if (!rx) return legacy.remove(projectId);
    await rx.removeProject(projectId);
  }
  return { read, list, apply, applyIfNewer, remove };
}
