import { browser } from "../platform/browser";
import { googleDrive } from "./browser";
import { isDriveReconcileMessage, isDriveSyncProjectMessage } from "./messages";
import { DRIVE_PROJECT_STATE_PREFIX, type DriveProjectSyncState } from "./state";

const IDLE_SYNC_DELAY_MS = 25_000;
const ALARM_PREFIX = "pboard-drive-sync:";

export function registerDriveBackgroundSync() {
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
    if (projectId) void googleDrive.syncProject(projectId).catch(() => undefined);
  });

  void googleDrive.reconcileAll().catch(() => undefined);
}

async function scheduleIdleSync(projectId: string) {
  if (await googleDrive.getConnectionState() !== "connected") return;
  await browser.alarms.create(`${ALARM_PREFIX}${projectId}`, { when: Date.now() + IDLE_SYNC_DELAY_MS });
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
      return { ok: true, result: await googleDrive.syncProject(message.projectId) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Google Drive sync failed" };
    }
  })();
}
