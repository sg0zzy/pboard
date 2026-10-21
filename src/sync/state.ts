import type { KeyValueStorage } from "../storage/repository";
import { withStorageLock } from "../storage/lock";

export const DRIVE_AUTH_STORAGE_KEY = "pboardGoogleDriveAuth";
export const DRIVE_PROJECT_STATE_PREFIX = "pboardDriveProject:";
export const DRIVE_TOMBSTONES_STORAGE_KEY = "pboardDriveTombstones";

export type DriveProjectSyncStatus = "synced" | "pending" | "syncing" | "error";

export type DriveProjectSyncState = {
  projectId: string;
  dirty: boolean;
  changeToken?: number;
  status: DriveProjectSyncStatus;
  dirtyAt?: string;
  lastSyncedAt?: string;
  lastSyncedRevision?: number;
  remoteFileId?: string;
  error?: string;
  permanentDeletion?: boolean;
};

export type DriveProjectTombstone = {
  projectId: string;
  remoteFileId?: string;
  deletedAt: string;
  projectUpdatedAt: string;
  revision: number;
};

export const projectSyncStorageKey = (projectId: string) => `${DRIVE_PROJECT_STATE_PREFIX}${projectId}`;

export function createDriveSyncStateStore(storage: KeyValueStorage) {
  async function load(projectId: string): Promise<DriveProjectSyncState> {
    const key = projectSyncStorageKey(projectId);
    const result = await storage.get(key);
    const saved = result[key];
    if (!saved || typeof saved !== "object") return { projectId, dirty: false, status: "synced" };
    return { projectId, dirty: false, status: "synced", ...(saved as Partial<DriveProjectSyncState>) };
  }

  async function get(projectId: string): Promise<DriveProjectSyncState> {
    return load(projectId);
  }

  async function set(state: DriveProjectSyncState): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(state.projectId), async () => {
      await storage.set({ [projectSyncStorageKey(state.projectId)]: state });
    });
  }

  async function markDirty(projectId: string, permanentDeletion = false): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await storage.set({ [projectSyncStorageKey(projectId)]: {
        ...current,
        ...(permanentDeletion ? { permanentDeletion: true } : {}),
        projectId,
        dirty: true,
        changeToken: (current.changeToken ?? 0) + 1,
        status: "pending",
        dirtyAt: new Date().toISOString(),
        error: undefined
      } satisfies DriveProjectSyncState });
    });
  }

  async function markSyncing(projectId: string): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await storage.set({ [projectSyncStorageKey(projectId)]: { ...current, status: "syncing", error: undefined } });
    });
  }

  async function markSynced(projectId: string, revision: number, remoteFileId: string, expectedChangeToken?: number): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      const changedDuringSync = expectedChangeToken !== undefined && (current.changeToken ?? 0) !== expectedChangeToken;
      await storage.set({ [projectSyncStorageKey(projectId)]: {
        ...current,
        projectId,
        dirty: changedDuringSync,
        status: changedDuringSync ? "pending" : "synced",
        lastSyncedAt: new Date().toISOString(),
        lastSyncedRevision: revision,
        remoteFileId,
        error: undefined
      } satisfies DriveProjectSyncState });
    });
  }

  async function markUploadStale(projectId: string, remoteFileId: string): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await storage.set({ [projectSyncStorageKey(projectId)]: {
        ...current,
        projectId,
        remoteFileId,
        dirty: true,
        status: "pending",
        error: undefined
      } satisfies DriveProjectSyncState });
    });
  }

  async function markError(projectId: string, message: string): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await storage.set({ [projectSyncStorageKey(projectId)]: { ...current, dirty: true, status: "error", error: message } });
    });
  }

  async function ensureInitiallyDirty(projectId: string): Promise<void> {
    const current = await get(projectId);
    if (!current.dirty && !current.lastSyncedAt && !current.remoteFileId) await markDirty(projectId);
  }

  async function forget(projectId: string): Promise<void> {
    await set({ projectId, dirty: false, status: "synced" });
  }

  return { get, set, markDirty, markSyncing, markSynced, markUploadStale, markError, ensureInitiallyDirty, forget };
}

export type DriveSyncStateStore = ReturnType<typeof createDriveSyncStateStore>;

export function createDriveTombstoneStore(storage: KeyValueStorage) {
  async function loadAll(): Promise<DriveProjectTombstone[]> {
    const result = await storage.get(DRIVE_TOMBSTONES_STORAGE_KEY);
    const saved = result[DRIVE_TOMBSTONES_STORAGE_KEY];
    if (!saved || typeof saved !== "object") return [];
    return Object.values(saved as Record<string, DriveProjectTombstone>)
      .filter((entry) => entry && typeof entry.projectId === "string");
  }

  async function getAll(): Promise<DriveProjectTombstone[]> {
    return loadAll();
  }

  async function get(projectId: string): Promise<DriveProjectTombstone | null> {
    return (await getAll()).find((entry) => entry.projectId === projectId) ?? null;
  }

  async function add(tombstone: DriveProjectTombstone): Promise<void> {
    await withStorageLock(storage, DRIVE_TOMBSTONES_STORAGE_KEY, async () => {
      const entries = Object.fromEntries((await loadAll()).map((entry) => [entry.projectId, entry]));
      const existing = entries[tombstone.projectId];
      entries[tombstone.projectId] = {
        ...tombstone,
        deletedAt: existing?.deletedAt ?? tombstone.deletedAt,
        remoteFileId: tombstone.remoteFileId ?? existing?.remoteFileId
      };
      await storage.set({ [DRIVE_TOMBSTONES_STORAGE_KEY]: entries });
    });
  }

  async function clear(projectId: string): Promise<void> {
    await withStorageLock(storage, DRIVE_TOMBSTONES_STORAGE_KEY, async () => {
      const entries = Object.fromEntries((await loadAll()).map((entry) => [entry.projectId, entry]));
      if (!(projectId in entries)) return;
      delete entries[projectId];
      await storage.set({ [DRIVE_TOMBSTONES_STORAGE_KEY]: entries });
    });
  }

  return { getAll, get, add, clear };
}

export type DriveTombstoneStore = ReturnType<typeof createDriveTombstoneStore>;
