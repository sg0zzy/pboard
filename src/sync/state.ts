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
  firstDirtyAt?: string;
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

/**
 * Two state records are equal when every stored field matches. An absent
 * field and an explicit `undefined` field are the same, because the record is
 * stored as JSON and the field is then absent.
 */
export function sameSyncState(left: DriveProjectSyncState | undefined, right: DriveProjectSyncState | undefined): boolean {
  if (!left || !right) return left === right;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = (left as Record<string, unknown>)[key];
    const b = (right as Record<string, unknown>)[key];
    if (a === b) continue;
    if (a === undefined && b === undefined) continue;
    return false;
  }
  return true;
}

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

  /**
   * Write the record only when it actually differs from what is stored.
   *
   * Firefox fires `storage.onChanged` for a write whose value is identical to
   * the stored one, while Chromium does not. A write that changes nothing is
   * therefore not free: the background worker watches this key and would treat
   * the worker's own state transitions as new work, so a board whose sync
   * cannot settle would keep the worker busy. Skipping the no-op write
   * removes that trigger on every browser.
   *
   * The caller holds the per-board lock; this helper must not take it again.
   */
  async function write(projectId: string, next: DriveProjectSyncState): Promise<void> {
    const current = await load(projectId);
    if (sameSyncState(current, next)) return;
    await storage.set({ [projectSyncStorageKey(projectId)]: next });
  }

  async function set(state: DriveProjectSyncState): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(state.projectId), async () => {
      await write(state.projectId, state);
    });
  }

  async function markDirty(projectId: string, permanentDeletion = false): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await write(projectId, {
        ...current,
        ...(permanentDeletion ? { permanentDeletion: true } : {}),
        projectId,
        dirty: true,
        changeToken: (current.changeToken ?? 0) + 1,
        status: "pending",
        firstDirtyAt: current.dirty ? current.firstDirtyAt ?? current.dirtyAt ?? new Date().toISOString() : new Date().toISOString(),
        dirtyAt: new Date().toISOString(),
        error: undefined
      });
    });
  }

  async function markSyncing(projectId: string): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await write(projectId, { ...current, status: "syncing", error: undefined });
    });
  }

  async function markSynced(projectId: string, revision: number, remoteFileId: string, expectedChangeToken?: number): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      const changedDuringSync = expectedChangeToken !== undefined && (current.changeToken ?? 0) !== expectedChangeToken;
      await write(projectId, {
        ...current,
        projectId,
        dirty: changedDuringSync,
        status: changedDuringSync ? "pending" : "synced",
        firstDirtyAt: changedDuringSync ? current.firstDirtyAt : undefined,
        lastSyncedAt: new Date().toISOString(),
        lastSyncedRevision: revision,
        remoteFileId,
        error: undefined
      });
    });
  }

  async function markUploadStale(projectId: string, remoteFileId: string): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await write(projectId, {
        ...current,
        projectId,
        remoteFileId,
        dirty: true,
        status: "pending",
        // The upload was superseded by a newer local change. The change token
        // moves so the next sync is a new attempt: without it the background
        // worker would reschedule the same superseded upload forever.
        changeToken: (current.changeToken ?? 0) + 1,
        error: undefined
      });
    });
  }

  async function markError(projectId: string, message: string): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      await write(projectId, { ...current, dirty: true, status: "error", error: message });
    });
  }

  /**
   * Dismiss a recorded failure without touching the pending change: the board is
   * still dirty when it was dirty, so the next attempt is a real Drive request
   * and a fresh failure is recorded again. Nothing here resets retry scheduling
   * or the quota cooldown — see `clearDriveQuotaCooldown`.
   */
  async function clearError(projectId: string): Promise<void> {
    await withStorageLock(storage, projectSyncStorageKey(projectId), async () => {
      const current = await load(projectId);
      if (current.status !== "error" && current.error === undefined) return;
      await write(projectId, { ...current, status: current.dirty ? "pending" : "synced", error: undefined });
    });
  }

  async function ensureInitiallyDirty(projectId: string): Promise<void> {
    const current = await get(projectId);
    if (!current.dirty && !current.lastSyncedAt && !current.remoteFileId) await markDirty(projectId);
  }

  async function forget(projectId: string): Promise<void> {
    await set({ projectId, dirty: false, status: "synced" });
  }

  return { get, set, markDirty, markSyncing, markSynced, markUploadStale, markError, clearError, ensureInitiallyDirty, forget };
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
