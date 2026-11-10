export const DRIVE_SYNC_MESSAGE = "DRIVE_SYNC_PROJECT" as const;
export const DRIVE_RECONCILE_MESSAGE = "DRIVE_RECONCILE_ALL" as const;

/**
 * Durable marker the background worker stamps on every cold start. An MV3
 * worker dies on idle and comes back for reasons that have nothing to do with
 * the boards it serves; the sidebar watches this key and runs the conditional
 * relay heal leg for the open board when it changes — reconnect only when the
 * channel is not synced, courier only when the key looks wrong, consolidation
 * only when there is something to consolidate. A healthy board answers the
 * epoch change with no relay traffic at all, which is what keeps an ordinary
 * browsing session free of reconnect churn. The same key doubles as "the
 * worker answered again after refusing to answer" (see `sync/client.ts`),
 * which is another moment where state may have moved without the sidebar
 * seeing it.
 */
export const WORKER_EPOCH_KEY = "pboardWorkerEpoch";

export type DriveSyncProjectMessage = {
  type: typeof DRIVE_SYNC_MESSAGE;
  projectId: string;
  force?: boolean;
};

export function isDriveSyncProjectMessage(value: unknown): value is DriveSyncProjectMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<DriveSyncProjectMessage>;
  return message.type === DRIVE_SYNC_MESSAGE && typeof message.projectId === "string" && Boolean(message.projectId)
    && (message.force === undefined || typeof message.force === 'boolean');
}

/**
 * A reconcile round request from a page to the worker.
 *
 * `force: true` is an explicit user action (Sync now, connect, an erasure
 * retry): it must not be served by the coalescing stamp and it must ask Drive
 * for a fresh shared-board listing. `force: false` is a *background* refresh —
 * startup, an account change — where the worker's own last round may already
 * answer the question, exactly as the sidebar's own discovery effect used to
 * coalesce against it before the round moved into the worker.
 */
export type DriveReconcileMessage = { type: typeof DRIVE_RECONCILE_MESSAGE; force?: boolean };

export function isDriveReconcileMessage(value: unknown): value is DriveReconcileMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<DriveReconcileMessage>;
  return message.type === DRIVE_RECONCILE_MESSAGE && (message.force === undefined || typeof message.force === 'boolean');
}

export const DRIVE_CLEAR_ERROR_MESSAGE = "DRIVE_CLEAR_PROJECT_ERROR" as const;

export type DriveClearErrorMessage = {
  type: typeof DRIVE_CLEAR_ERROR_MESSAGE;
  projectId: string;
};

/** Dismiss a stored Drive failure in the background context, where the failed
 * request and its quota cooldown actually live. */
export function isDriveClearErrorMessage(value: unknown): value is DriveClearErrorMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<DriveClearErrorMessage>;
  return message.type === DRIVE_CLEAR_ERROR_MESSAGE && typeof message.projectId === "string" && Boolean(message.projectId);
}
