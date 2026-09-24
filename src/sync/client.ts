import { browser } from "../platform/browser";
import { DRIVE_RECONCILE_MESSAGE, DRIVE_SYNC_MESSAGE } from "./messages";

export async function requestProjectSync(projectId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    return await browser.runtime.sendMessage({ type: DRIVE_SYNC_MESSAGE, projectId }) as { ok: boolean; reason?: string };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Google Drive sync could not start" };
  }
}

export async function requestDriveReconciliation(): Promise<{ ok: boolean; reason?: string }> {
  try {
    return await browser.runtime.sendMessage({ type: DRIVE_RECONCILE_MESSAGE }) as { ok: boolean; reason?: string };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Google Drive reconciliation could not start" };
  }
}
