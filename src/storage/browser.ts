import { importLocalBoard, type ImportedCard } from './importBoard';
import { createRepository, STORAGE_KEY } from "./repository";
import { browser } from "../platform/browser";
import { drivePermissions, driveSyncState, driveTombstones, googleAuth, googleDrive, sharedProjects, registerRxRepositoryResolver, syncAccountPreferences, collaborationManager, privateErasureAccount, leaveSharedBoard } from "../sync/browser";
import { createProjectDeletionRoleResolver } from "../sync/projectDeletion";
import { createRxRepository, type RxRepository } from "./rxdbRepository";
import type { AppState, BoardItem, BoardItemStatus, Project } from "../types";
import type { ConflictRecord } from "./conflictResolution";
import { eraseLegacyBoardCopies } from './boardErasure';

export const STORAGE_BACKEND_KEY = "pboardStorageBackend";
export const RXDB_MIGRATION_ERROR_KEY = "pboardRxMigrationError";
export const PRE_ROLLBACK_BACKUP_KEY = "pboardStateBeforeRxRollback";
export type StorageBackend = "legacy" | "rxdb";

export const legacyRepository = createRepository(browser.storage.local, {
  projectChanged: (projectId) => driveSyncState.markDirty(projectId),
  projectDeleting: async (project) => {
    const syncState = await driveSyncState.get(project.id);
    await driveTombstones.add({
      projectId: project.id,
      ...(syncState.remoteFileId ? { remoteFileId: syncState.remoteFileId } : {}),
      deletedAt: new Date().toISOString(),
      projectUpdatedAt: project.updatedAt,
      revision: project.revision
    });
  },
  projectDeleted: (projectId) => { void googleDrive.deleteProject(projectId); }
});

let rxRepositoryPromise: Promise<RxRepository> | null = null;
let migrationPromise: Promise<RxRepository> | null = null;
const resolveDeletionRole = createProjectDeletionRoleResolver({ sharedProjects, permissions: drivePermissions,
  connected: async () => await googleAuth.getConnectionState() === "connected" });
async function openRxRepository(): Promise<RxRepository> {
  if (!rxRepositoryPromise) rxRepositoryPromise = createRxRepository({ resolveDeletionRole,
    reverifySharedDeletionRole: async (projectId) => await googleAuth.getConnectionState() === "connected" ? await drivePermissions.myRole(projectId) : null,
    events: {
    projectErased: projectId => eraseLegacyBoardCopies(browser.storage.local, projectId),
    // A non-owner "delete" is a leave: hide locally, drop the account
    // ordering slot, and revoke our own collaborator permission (pending
    // marker + reconcile-time retry keep this honest across transports).
    projectHidden: async (projectId) => {
      await syncAccountPreferences();
      void leaveSharedBoard(projectId).catch(() => undefined);
    },
    projectChanged: (projectId) => driveSyncState.markDirty(projectId),
    projectDeleting: async (project) => {
      const syncState = await driveSyncState.get(project.id);
      await driveTombstones.add({ projectId: project.id,
        ...(syncState.remoteFileId ? { remoteFileId: syncState.remoteFileId } : {}),
        deletedAt: new Date().toISOString(), projectUpdatedAt: project.updatedAt, revision: project.revision });
    },
    projectDeleted: async (projectId) => {
      await syncAccountPreferences();
      await googleDrive.deleteProject(projectId);
    }
  } }).catch((error) => { rxRepositoryPromise = null; throw error; });
  return rxRepositoryPromise;
}

export async function configuredBackend(): Promise<StorageBackend> {
  const result = await browser.storage.local.get(STORAGE_BACKEND_KEY);
  return result[STORAGE_BACKEND_KEY] === "legacy" ? "legacy" : "rxdb";
}

/** RxDB is the default. The legacy AppState is never deleted. Reload extension views after changing. */
export async function setStorageBackend(backend: StorageBackend): Promise<void> {
  if (backend === "legacy" && (await configuredBackend()) === "rxdb") return rollbackRxToLegacy();
  if (backend === "rxdb") await getRxRepository();
  await browser.storage.local.set({ [STORAGE_BACKEND_KEY]: backend });
}

/** Explicit recovery, not a background dual-write. Leaves the RxDB copy intact. */
export async function rollbackRxToLegacy(): Promise<void> {
  const rx = await getRxRepository();
  const recovered = await rx.exportAll();
  const before = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  await browser.storage.local.set({
    [PRE_ROLLBACK_BACKUP_KEY]: before ?? null,
    [STORAGE_KEY]: recovered,
    [STORAGE_BACKEND_KEY]: "legacy"
  });
  await rx.markMigrationIncomplete();
  migrationPromise = null;
}

export async function getRxRepository(): Promise<RxRepository> {
  return migrationPromise ??= (async () => {
    const rx = await openRxRepository();
    const migrate = async () => {
      if (await rx.migrationComplete()) return rx;
      try {
        const state = await legacyRepository.load();
        await rx.importState(state);
        await rx.markMigrationComplete();
        await browser.storage.local.set({ [RXDB_MIGRATION_ERROR_KEY]: null });
        return rx;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await browser.storage.local.set({ [RXDB_MIGRATION_ERROR_KEY]: message });
        throw new Error(`RxDB migration failed; legacy data remains available: ${message}`);
      }
    };
    return globalThis.navigator?.locks ? navigator.locks.request("pboard:rxdb-migration", migrate) : migrate();
  })().catch((error) => { migrationPromise = null; throw error; });
}

export async function selectedRxRepository(): Promise<RxRepository | null> {
  if ((await configuredBackend()) !== "rxdb") return null;
  try { return await getRxRepository(); }
  catch (error) {
    console.error("RxDB unavailable; using untouched legacy storage", error);
    return null;
  }
}

async function chosen() { return await selectedRxRepository() ?? legacyRepository; }

function legacySubscribe<T>(read: () => Promise<T>, listener: (value: T) => void) {
  let active = true;
  const emit = () => { void read().then((value) => { if (active) listener(value); }); };
  const onChange = (changes: Record<string, unknown>, area: string) => {
    if (area === "local" && "projectBoardState" in changes) emit();
  };
  browser.storage.onChanged.addListener(onChange);
  emit();
  return () => { active = false; browser.storage.onChanged.removeListener(onChange); };
}

export const repository = {
  async importLocalBoard(name: string, template: Project['template'], cards: ImportedCard[]) {
    const rx = await selectedRxRepository();
    if (!rx) throw new Error('Board import requires the RxDB storage backend. Existing boards are unchanged.');
    const project = await importLocalBoard(rx, name, template, cards);
    await driveSyncState.markDirty(project.id);
    return project;
  },
  load: async (): Promise<AppState> => (await chosen()).load(),
  createProject: async (...args: Parameters<typeof legacyRepository.createProject>) => (await chosen()).createProject(...args),
  selectProject: async (...args: Parameters<typeof legacyRepository.selectProject>) => (await chosen()).selectProject(...args),
  reorderProjects: async (...args: Parameters<typeof legacyRepository.reorderProjects>) => {
    await (await chosen()).reorderProjects(...args);
    await syncAccountPreferences();
  },
  renameProject: async (...args: Parameters<typeof legacyRepository.renameProject>) => (await chosen()).renameProject(...args),
  deleteProject: async (...args: Parameters<typeof legacyRepository.deleteProject>) => (await chosen()).deleteProject(...args),
  unhideProject: async (...args: Parameters<RxRepository["unhideProject"]>) => { const rx = await selectedRxRepository(); if (!rx) throw new Error("This storage backend does not retain hidden boards; nothing to restore"); return rx.unhideProject(...args); },
  changeProjectTemplate: async (...args: Parameters<typeof legacyRepository.changeProjectTemplate>) => (await chosen()).changeProjectTemplate(...args),
  addItem: async (...args: Parameters<typeof legacyRepository.addItem>) => (await chosen()).addItem(...args),
  updateItem: async (...args: Parameters<typeof legacyRepository.updateItem>) => (await chosen()).updateItem(...args),
  deleteItem: async (...args: Parameters<typeof legacyRepository.deleteItem>) => (await chosen()).deleteItem(...args),
  duplicateItem: async (...args: Parameters<typeof legacyRepository.duplicateItem>) => (await chosen()).duplicateItem(...args),
  mergeItems: async (...args: Parameters<typeof legacyRepository.mergeItems>) => (await chosen()).mergeItems(...args),
  reorderItems: async (...args: Parameters<typeof legacyRepository.reorderItems>) => (await chosen()).reorderItems(...args),
  moveItem: async (projectId: string, itemId: string, orderedIds: string[]) => {
    const rx = await selectedRxRepository();
    return rx ? rx.moveItem(projectId, itemId, orderedIds) : legacyRepository.reorderItems(projectId, orderedIds);
  },
  emptyTrash: async (...args: Parameters<typeof legacyRepository.emptyTrash>) => (await chosen()).emptyTrash(...args),
  getCurrentProject: async (): Promise<Project | null> => {
    const rx = await selectedRxRepository();
    if (rx) return rx.getCurrentProject();
    const state = await legacyRepository.load();
    return state.projects.find((project) => project.id === state.currentProjectId) ?? null;
  },
  getProject: async (id: string): Promise<Project | null> => {
    const rx = await selectedRxRepository();
    return rx ? rx.getProject(id) : (await legacyRepository.load()).projects.find((project) => project.id === id) ?? null;
  },
  listConflicts: async () => (await selectedRxRepository())?.listConflicts() ?? [],
  saveConflictDraft: async (...args: Parameters<RxRepository["saveConflictDraft"]>) => {
    const rx = await selectedRxRepository(); if (!rx) throw new Error("Conflict recovery requires local RxDB storage");
    return rx.saveConflictDraft(...args);
  },
  resolveConflict: async (...args: Parameters<RxRepository["resolveConflict"]>) => {
    const rx = await selectedRxRepository(); if (!rx) throw new Error("Conflict recovery requires local RxDB storage");
    return rx.resolveConflict(...args);
  },
  subscribeConflicts: async (listener: (records: ConflictRecord[]) => void, onError: (error: unknown) => void) => {
    const rx = await selectedRxRepository(); if (!rx) { listener([]); return () => {}; }
    let active = true, generation = 0;
    const refresh = () => {
      const current = ++generation;
      void rx.listConflicts().then(records => { if (active && current === generation) listener(records); })
        .catch(error => { if (active && current === generation) onError(error); });
    };
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = rx.journal.subscribe(() => {
      clearTimeout(scheduled); scheduled = setTimeout(refresh, 125);
    });
    const timer = setInterval(refresh, 10_000); // Access/grant expiry can change without a document write.
    refresh();
    return () => { active = false; clearTimeout(scheduled); clearInterval(timer); unsubscribe(); };
  },
  listProjects: async (): Promise<Project[]> => {
    const rx = await selectedRxRepository();
    return rx ? rx.listProjects() : (await legacyRepository.load()).projects;
  },
  listCards: async (projectId: string): Promise<BoardItem[]> => {
    const rx = await selectedRxRepository();
    return rx ? rx.listCards(projectId) : (await legacyRepository.load()).boardItems.filter((card) => card.projectId === projectId).sort((a, b) => a.order - b.order);
  },
  listCardsByStatus: async (projectId: string, status: BoardItemStatus): Promise<BoardItem[]> => {
    const cards = await repository.listCards(projectId);
    return cards.filter((card) => card.status === status);
  },
  getCard: async (id: string): Promise<BoardItem | null> => {
    const rx = await selectedRxRepository();
    return rx ? rx.getCard(id) : (await legacyRepository.load()).boardItems.find((card) => card.id === id) ?? null;
  },
  subscribeProjects: async (listener: (projects: Project[]) => void) => {
    const rx = await selectedRxRepository();
    return rx ? rx.subscribeProjects(listener) : legacySubscribe(() => repository.listProjects(), listener);
  },
  subscribeCurrentProject: async (listener: (project: Project | null) => void) => {
    const rx = await selectedRxRepository();
    return rx ? rx.subscribeCurrentProject(listener) : legacySubscribe(() => repository.getCurrentProject(), listener);
  },
  subscribeCards: async (projectId: string, listener: (cards: BoardItem[]) => void) => {
    const rx = await selectedRxRepository();
    return rx ? rx.subscribeCards(projectId, listener) : legacySubscribe(() => repository.listCards(projectId), listener);
  },
  subscribeCard: async (id: string, listener: (card: BoardItem | null) => void) => {
    const rx = await selectedRxRepository();
    return rx ? rx.subscribeCard(id, listener) : legacySubscribe(() => repository.getCard(id), listener);
  },
  exportProject: async (projectId: string) => {
    const rx = await selectedRxRepository();
    if (rx) return rx.exportProject(projectId);
    const state = await legacyRepository.load();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found");
    return { project, items: state.boardItems.filter((card) => card.projectId === projectId) };
  },
  exportAll: async () => { const rx = await selectedRxRepository(); return rx ? rx.exportAll() : legacyRepository.load(); },
  listPendingWork: async () => (await selectedRxRepository())?.listPendingWork() ?? [],
  subscribePendingWork: async (listener: Parameters<RxRepository['subscribePendingWork']>[0]) => (await getRxRepository()).subscribePendingWork(listener),
  reviewPendingWork: async (...args: Parameters<RxRepository['reviewPendingWork']>) => (await getRxRepository()).reviewPendingWork(...args),
  discardRemovedBoardWork: async (...args: Parameters<RxRepository['discardRemovedBoardWork']>) => {
    const account = await privateErasureAccount(args[0]).catch(() => null);
    await (await getRxRepository()).discardRemovedBoardWork(args[0], args[1], account ?? undefined);
    if ((await (await getRxRepository()).journal.boardErasure(args[0]))?.cloudPending) await driveSyncState.markDirty(args[0], true);
    else await driveSyncState.forget(args[0]);
    void googleDrive.reconcileAll().catch(() => {}); // Durable erasure queue retries while offline.
  },
  permanentlyDeleteBoard: async (boardId: string) => {
    const rx = await getRxRepository();
    if ((await rx.getCurrentProject())?.id === boardId) await collaborationManager.stop();
    const account = await privateErasureAccount(boardId).catch(() => null);
    await rx.permanentlyDeleteBoard(boardId, account ?? undefined);
    if ((await rx.journal.boardErasure(boardId))?.cloudPending) await driveSyncState.markDirty(boardId, true);
    else await driveSyncState.forget(boardId);
    void googleDrive.reconcileAll().catch(() => {});
  },
  exportPendingWork: async (boardId: string) => (await getRxRepository()).exportPendingWork(boardId),
  putImage: async (image: BoardItem["image"]) => { if (!image) throw new Error("Image required"); return (await getRxRepository()).putImage(image); },
  getImage: async (imageId: string) => (await getRxRepository()).getImage(imageId),
  subscribeImage: async (imageId: string, listener: () => void) =>
    (await getRxRepository()).subscribeImages((changedId) => { if (changedId === imageId) listener(); }),
  hasImage: async (imageId: string) => (await getRxRepository()).hasImage(imageId),
  imageAvailability: async (imageId: string) => (await getRxRepository()).imageAvailability(imageId),
  deleteImage: async (imageId: string) => (await getRxRepository()).deleteImage(imageId)
};

registerRxRepositoryResolver(selectedRxRepository);
