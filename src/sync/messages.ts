export const DRIVE_SYNC_MESSAGE = "DRIVE_SYNC_PROJECT" as const;
export const DRIVE_RECONCILE_MESSAGE = "DRIVE_RECONCILE_ALL" as const;

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

export type DriveReconcileMessage = { type: typeof DRIVE_RECONCILE_MESSAGE };

export function isDriveReconcileMessage(value: unknown): value is DriveReconcileMessage {
  return Boolean(value && typeof value === "object" && (value as Partial<DriveReconcileMessage>).type === DRIVE_RECONCILE_MESSAGE);
}
