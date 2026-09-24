import type { KeyValueStorage } from "../storage/repository";

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
  async function get(projectId: string): Promise<DriveProjectSyncState> {
    const key = projectSyncStorageKey(projectId);
    const result = await storage.get(key);
    const saved = result[key];
    if (!saved || typeof saved !== "object") return { projectId, dirty: false, status: "synced" };
    return { projectId, dirty: false, status: "synced", ...(saved as Partial<DriveProjectSyncState>) };
  }

  async function set(state: DriveProjectSyncState): Promise<void> {
    await storage.set({ [projectSyncStorageKey(state.projectId)]: state });
  }

  async function markDirty(projectId: string): Promise<void> {
    const current = await get(projectId);
    await set({
      ...current,
      projectId,
      dirty: true,
      changeToken: (current.changeToken ?? 0) + 1,
      status: "pending",
      dirtyAt: new Date().toISOString(),
      error: undefined
    });
  }

  async function markSyncing(projectId: string): Promise<void> {
    const current = await get(projectId);
    await set({ ...current, status: "syncing", error: undefined });
  }

  async function markSynced(projectId: string, revision: number, remoteFileId: string, expectedChangeToken?: number): Promise<void> {
    const current = await get(projectId);
    const changedDuringSync = expectedChangeToken !== undefined && (current.changeToken ?? 0) !== expectedChangeToken;
    await set({
      ...current,
      projectId,
      dirty: changedDuringSync,
      status: changedDuringSync ? "pending" : "synced",
      lastSyncedAt: new Date().toISOString(),
      lastSyncedRevision: revision,
      remoteFileId,
      error: undefined
    });
  }

  async function markError(projectId: string, message: string): Promise<void> {
    const current = await get(projectId);
    await set({ ...current, dirty: true, status: "error", error: message });
  }

  async function ensureInitiallyDirty(projectId: string): Promise<void> {
    const current = await get(projectId);
    if (!current.dirty && !current.lastSyncedAt && !current.remoteFileId) await markDirty(projectId);
  }

  async function forget(projectId: string): Promise<void> {
    await set({ projectId, dirty: false, status: "synced" });
  }

  return { get, set, markDirty, markSyncing, markSynced, markError, ensureInitiallyDirty, forget };
}

export type DriveSyncStateStore = ReturnType<typeof createDriveSyncStateStore>;

export function createDriveTombstoneStore(storage: KeyValueStorage) {
  async function getAll(): Promise<DriveProjectTombstone[]> {
    const result = await storage.get(DRIVE_TOMBSTONES_STORAGE_KEY);
    const saved = result[DRIVE_TOMBSTONES_STORAGE_KEY];
    if (!saved || typeof saved !== "object") return [];
    return Object.values(saved as Record<string, DriveProjectTombstone>)
      .filter((entry) => entry && typeof entry.projectId === "string");
  }

  async function get(projectId: string): Promise<DriveProjectTombstone | null> {
    return (await getAll()).find((entry) => entry.projectId === projectId) ?? null;
  }

  async function add(tombstone: DriveProjectTombstone): Promise<void> {
    const entries = Object.fromEntries((await getAll()).map((entry) => [entry.projectId, entry]));
    const existing = entries[tombstone.projectId];
    entries[tombstone.projectId] = {
      ...tombstone,
      deletedAt: existing?.deletedAt ?? tombstone.deletedAt,
      remoteFileId: tombstone.remoteFileId ?? existing?.remoteFileId
    };
    await storage.set({ [DRIVE_TOMBSTONES_STORAGE_KEY]: entries });
  }

  async function clear(projectId: string): Promise<void> {
    const entries = Object.fromEntries((await getAll()).map((entry) => [entry.projectId, entry]));
    if (!(projectId in entries)) return;
    delete entries[projectId];
    await storage.set({ [DRIVE_TOMBSTONES_STORAGE_KEY]: entries });
  }

  return { getAll, get, add, clear };
}

export type DriveTombstoneStore = ReturnType<typeof createDriveTombstoneStore>;
