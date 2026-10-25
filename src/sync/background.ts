import { browser } from "../platform/browser";
import { drivePermissions, googleDrive, driveSyncState } from "./browser";
import { isDriveReconcileMessage, isDriveSyncProjectMessage } from "./messages";
import { DRIVE_PROJECT_STATE_PREFIX, type DriveProjectSyncState } from "./state";
import { recoveryDelayMs } from "./recoveryScheduler";
import { collaborationCounters } from "../collab/counters";

const IDLE_SYNC_DELAY_MS = 25_000;
const ALARM_PREFIX = "pboard-drive-sync:";

export function registerDriveBackgroundSync() {
  const attempts = recoveryAttempts();
  // The boards that already have an idle sync scheduled. A sync that leaves
  // the board pending writes the state again, and scheduling another one for
  // it would make the board sync in a tight loop.
  const scheduled = new Set<string>();
  /**
   * The boards the worker is currently retrying.
   *
   * The worker writes the board's sync state while it syncs, and that write is
   * a storage change. The change listener below sees the worker's own write
   * and would schedule the board again, with the idle delay and without the
   * backoff. The two paths then race for the same alarm name, so the later
   * writer wins and the board is resynced far more often than the backoff
   * allows.
   *
   * A board in this set is already being retried, so its own state writes are
   * not a reason to schedule it again. The set is held for the whole attempt,
   * which is why the sync itself is not delayed by reading the attempt count.
   */
  const retrying = new Set<string>();
  const schedule = async (projectId: string, delayMs = IDLE_SYNC_DELAY_MS) => {
    if (await googleDrive.getConnectionState() !== "connected" && !(await driveSyncState.get(projectId)).permanentDeletion) return;
    scheduled.add(projectId);
    await browser.alarms.create(`${ALARM_PREFIX}${projectId}`, { when: Date.now() + delayMs });
  };
  browser.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local") return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(DRIVE_PROJECT_STATE_PREFIX)) continue;
      const next = change.newValue as DriveProjectSyncState | undefined;
      if (!next?.dirty || next.status !== "pending") continue;
      // A board that is already scheduled must not get another one: the sync
      // that is already pending is the one that will pick this change up.
      if (scheduled.has(next.projectId)) continue;
      // A board the worker is already retrying is not rescheduled by the
      // worker's own state write. The retry that is already armed decides when
      // it runs, so the backoff is not defeated.
      if (retrying.has(next.projectId)) continue;
      void schedule(next.projectId);
    }
  });

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const projectId = alarm.name.slice(ALARM_PREFIX.length);
    if (!projectId) return;
    scheduled.delete(projectId);
    // The board is being retried from this moment, so the state writes the
    // sync makes are not a reason to schedule it again.
    retrying.add(projectId);
    collaborationCounters.countBackgroundSync("attempts");
    collaborationCounters.setRetryingBoards(retrying.size);
    void (async () => {
      try {
        await googleDrive.syncProject(projectId);
        const state = await driveSyncState.get(projectId);
        if (state.dirty || state.status !== "synced") {
          // The sync did not settle the board. Back off like a failed attempt,
          // so a board that stays pending does not reschedule itself in a
          // tight loop. The durable attempt count survives a restart.
          const attempt = await attempts.get(projectId);
          await attempts.set(projectId, attempt + 1);
          collaborationCounters.countBackgroundSync("unsettled");
          await schedule(projectId, recoveryDelayMs({ attempt, random: Math.random }, Date.now()));
          return;
        }
        await attempts.clear(projectId);
        retrying.delete(projectId);
        collaborationCounters.countBackgroundSync("settled");
        collaborationCounters.setRetryingBoards(retrying.size);
      } catch {
        // Bounded exponential backoff; the durable attempt count survives restart.
        const attempt = await attempts.get(projectId);
        await attempts.set(projectId, attempt + 1);
        collaborationCounters.countBackgroundSync("failed");
        await schedule(projectId, recoveryDelayMs({ attempt, random: Math.random }, Date.now()));
      }
    })();
  });

  void googleDrive.reconcileAll().catch(() => undefined);
}

type RecoveryAttempts = { get(projectId: string): Promise<number>; set(projectId: string, attempt: number): Promise<void>; clear(projectId: string): Promise<void> };

/** Durable per-board retry attempt counts; survive background restarts. */
function recoveryAttempts(): RecoveryAttempts {
  const key = (projectId: string) => `pboard-drive-retry:${projectId}`;
  const attempt = async (projectId: string) => {
    const saved = (await browser.storage.local.get(key(projectId)))[key(projectId)] as number | undefined;
    return Number.isInteger(saved) ? Math.max(0, saved!) : 0;
  };
  return {
    get: attempt,
    async set(projectId, value) { await browser.storage.local.set({ [key(projectId)]: Math.min(value, 5) }); },
    async clear(projectId) { await browser.storage.local.remove(key(projectId)); }
  };
}

export function handleDriveSyncMessage(message: unknown): Promise<unknown> | undefined {
  if (isDriveReconcileMessage(message)) {
    // An explicit user action must not serve the 60-second discovery cache.
    drivePermissions.invalidateSharedDiscovery();
    return googleDrive.reconcileAll()
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, reason: error instanceof Error ? error.message : "Google Drive reconciliation failed" }));
  }
  if (!isDriveSyncProjectMessage(message)) return undefined;
  return (async () => {
    if (await googleDrive.getConnectionState() !== "connected") {
      return { ok: false, reason: "Google Drive is not connected" };
    }
    try {
      const result = await (message.force ? googleDrive.syncProject(message.projectId, { force: true }) : googleDrive.syncProject(message.projectId));
      if (!message.force) return { ok: true, result };
      const state = await driveSyncState.get(message.projectId);
      return { ok: true, result, pending: state.dirty || state.status === 'pending' || state.status === 'error' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Google Drive sync failed" };
    }
  })();
}
