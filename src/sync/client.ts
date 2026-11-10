import { browser } from "../platform/browser";
import { DRIVE_CLEAR_ERROR_MESSAGE, DRIVE_RECONCILE_MESSAGE, DRIVE_SYNC_MESSAGE, WORKER_EPOCH_KEY } from "./messages";
import type { DriveReconcileResult } from "./googleDriveProvider";

/** Whether the last worker message failed to reach a worker. An MV3 worker is
 * routinely dead when the sidebar first asks it something, and the failed
 * message is the moment the sidebar learns the worker's answers may be stale —
 * the first one that arrives back is therefore a state-change worth healing
 * from, the same way the worker's own cold-start stamp is. */
let workerUnreachable = false;
function noteWorkerReplied() {
  if (!workerUnreachable) return;
  workerUnreachable = false;
  // The bump runs every sidebar's conditional relay heal leg through the one
  // storage watch the sidebar already has; a healthy board ignores it. A
  // platform without local storage (a bare message-channel test harness)
  // simply has nothing to stamp.
  try { void browser.storage.local.set({ [WORKER_EPOCH_KEY]: Date.now() }).catch(() => undefined); } catch { /* no local storage to stamp */ }
}

export async function requestProjectSync(projectId: string): Promise<{ ok: boolean; reason?: string; pending?: boolean }> {
  try {
    const reply = await browser.runtime.sendMessage({ type: DRIVE_SYNC_MESSAGE, projectId, force: true }) as { ok: boolean; reason?: string; pending?: boolean };
    noteWorkerReplied();
    return reply;
  } catch (error) {
    workerUnreachable = true;
    return { ok: false, reason: error instanceof Error ? error.message : "Google Drive sync could not start" };
  }
}

/**
 * Ask the worker for a Drive reconcile round.
 *
 * `force` defaults to true — a request from a control the person pressed must
 * do real work. The one caller that passes false is the sidebar's startup
 * discovery, which is a *background* refresh: the worker's cold start runs the
 * same round at the same moment, so a second one over the same account and the
 * same local database costs time and can find nothing.
 */
export async function requestDriveReconciliation(options: { force?: boolean } = {}): Promise<{ ok: boolean; reason?: string; result?: DriveReconcileResult }> {
  try {
    const reply = await browser.runtime.sendMessage({ type: DRIVE_RECONCILE_MESSAGE, force: options.force ?? true }) as { ok: boolean; reason?: string; result?: DriveReconcileResult };
    noteWorkerReplied();
    return reply;
  } catch (error) {
    workerUnreachable = true;
    return { ok: false, reason: error instanceof Error ? error.message : "Google Drive reconciliation could not start" };
  }
}

/** Ask the background worker to dismiss a stored Drive failure and let its next
 * request go out instead of replaying its own quota cooldown. */
export async function requestDriveErrorClear(projectId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const reply = await browser.runtime.sendMessage({ type: DRIVE_CLEAR_ERROR_MESSAGE, projectId }) as { ok: boolean; reason?: string };
    noteWorkerReplied();
    return reply;
  } catch (error) {
    workerUnreachable = true;
    return { ok: false, reason: error instanceof Error ? error.message : "Google Drive error could not be cleared" };
  }
}
