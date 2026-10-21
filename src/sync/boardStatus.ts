import type { DriveSyncStateStore, DriveProjectSyncState } from "./state";
import type { ConflictRecord } from "../storage/conflictResolution";

/**
 * The four user-visible board statuses from the approved contract. Precedence:
 * Local only (inactive remote scope, conflicts still accessible) → unresolved
 * content conflicts → Synchronization pending → Synced. Synced is scoped to the
 * current account's private persistence and current peer exchanges; it never
 * claims delivery to offline collaborators.
 */
export type BoardSyncStatus =
  | { label: "Local only"; detail?: string }
  | { label: "Conflict requires resolution"; conflicts: number }
  | { label: "Synchronization pending"; detail?: string }
  | { label: "Synced" };

export type BoardScopeInput = {
  /** Remote delivery is intended for this board in the current mode/account. */
  remoteScope: boolean;
  state: DriveProjectSyncState;
  conflicts: ConflictRecord[];
  /** The board's durable private-account binding exists but the account is inactive. */
  boundAccountInactive?: boolean;
};

const PENDING_DETAIL = (state: DriveProjectSyncState): string | undefined =>
  state.error || (state.status === "pending" && state.dirty ? "Waiting for account-private persistence" : undefined);

export function boardSyncStatus(input: BoardScopeInput): BoardSyncStatus {
  if (!input.remoteScope || input.boundAccountInactive) return { label: "Local only" };
  if (input.conflicts.length) return { label: "Conflict requires resolution", conflicts: input.conflicts.length };
  // A known channel failure prevents a fresh Synced claim.
  if (input.state.status !== "synced" || input.state.dirty) {
    return { label: "Synchronization pending", detail: PENDING_DETAIL(input.state) };
  }
  return { label: "Synced" };
}

export async function boardStatusFor(options: {
  boardId: string;
  remoteScope: boolean;
  syncState: DriveSyncStateStore;
  conflicts: ConflictRecord[];
  boundAccountInactive?: (boardId: string) => Promise<boolean>;
}): Promise<BoardSyncStatus> {
  const state = await options.syncState.get(options.boardId);
  const inactive = options.boundAccountInactive ? await options.boundAccountInactive(options.boardId) : false;
  return boardSyncStatus({ remoteScope: options.remoteScope, state, conflicts: options.conflicts, boundAccountInactive: inactive });
}
