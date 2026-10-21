import { browser } from "../platform/browser";
import { googleDrive, driveSyncState } from "./browser";
import { isDriveReconcileMessage, isDriveSyncProjectMessage } from "./messages";
import { DRIVE_PROJECT_STATE_PREFIX, type DriveProjectSyncState } from "./state";
import { recoveryDelayMs } from "./recoveryScheduler";

const IDLE_SYNC_DELAY_MS = 25_000;
const ALARM_PREFIX = "pboard-drive-sync:";

export function registerDriveBackgroundSync() {
  const attempts = recoveryAttempts();
  browser.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local") return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(DRIVE_PROJECT_STATE_PREFIX)) continue;
      const next = change.newValue as DriveProjectSyncState | undefined;
      if (!next?.dirty || next.status !== "pending") continue;
      void scheduleIdleSync(next.projectId);
    }
  });

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const projectId = alarm.name.slice(ALARM_PREFIX.length);
    if (!projectId) return;
    void (async () => {
      try {
        await googleDrive.syncProject(projectId);
        const state = await driveSyncState.get(projectId);
        if (state.dirty || state.status !== "synced") throw new Error("Private recovery is still pending");
        await attempts.clear(projectId);
      } catch {
        // Bounded exponential backoff; the durable attempt count survives restart.
        const attempt = await attempts.get(projectId);
        await attempts.set(projectId, attempt + 1);
        await scheduleIdleSync(projectId, recoveryDelayMs({ attempt, random: Math.random }, Date.now()));
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

async function scheduleIdleSync(projectId: string, delayMs = IDLE_SYNC_DELAY_MS) {
  if (await googleDrive.getConnectionState() !== "connected" && !(await driveSyncState.get(projectId)).permanentDeletion) return;
  await browser.alarms.create(`${ALARM_PREFIX}${projectId}`, { when: Date.now() + delayMs });
}

export function handleDriveSyncMessage(message: unknown): Promise<unknown> | undefined {
  if (isDriveReconcileMessage(message)) {
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
