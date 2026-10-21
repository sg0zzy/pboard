import type { AppState } from '../types';
import type { KeyValueStorage } from './repository';
import { STORAGE_KEY } from './repository';
import { withStorageLock } from './lock';

/** Remove only the confirmed board from preserved legacy/rollback copies. */
export async function eraseLegacyBoardCopies(storage: KeyValueStorage, boardId: string) {
  for (const key of [STORAGE_KEY, 'pboardStateBeforeRxRollback']) await withStorageLock(storage, key, async () => {
    const value = (await storage.get(key))[key] as AppState | undefined;
    if (!value || !Array.isArray(value.projects) || !Array.isArray(value.boardItems)) return;
    const projects = value.projects.filter(project => project.id !== boardId);
    const boardItems = value.boardItems.filter(card => card.projectId !== boardId);
    if (projects.length === value.projects.length && boardItems.length === value.boardItems.length) return;
    await storage.set({ [key]: { ...value, projects, boardItems,
      currentProjectId: value.currentProjectId === boardId ? projects[0]?.id ?? null : value.currentProjectId } });
  });
}
