import { browser } from "../platform/browser";
import { DRIVE_CLEAR_ERROR_MESSAGE, DRIVE_RECONCILE_MESSAGE, DRIVE_SYNC_MESSAGE } from "./messages";

export async function requestProjectSync(projectId: string): Promise<{ ok: boolean; reason?: string; pending?: boolean }> {
  try {
    return await browser.runtime.sendMessage({ type: DRIVE_SYNC_MESSAGE, projectId, force: true }) as { ok: boolean; reason?: string; pending?: boolean };
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

/** Ask the background worker to dismiss a stored Drive failure and let its next
 * request go out instead of replaying its own quota cooldown. */
export async function requestDriveErrorClear(projectId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    return await browser.runtime.sendMessage({ type: DRIVE_CLEAR_ERROR_MESSAGE, projectId }) as { ok: boolean; reason?: string };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Google Drive error could not be cleared" };
  }
}
