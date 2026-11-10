/**
 * Context-side registration glue: builds the projection's data sources from
 * the modules that own them and attaches the inspector to a transport.
 * Kept separate from `stateSnapshot.ts` so the projection stays dependency-
 * light and testable; this module is the composition seam.
 */

import { registerDebugSnapshotProvider, attachDebugInspector } from "./inspect.ts";
import { collectDebugSnapshot, type RoomView, type SnapshotSources } from "./stateSnapshot.ts";
import type { DebugRuntimeHandle } from "./browser.ts";

export function registerDebugStateInspection(handle: DebugRuntimeHandle, context: "background" | "sidebar", sources: SnapshotSources): void {
  registerDebugSnapshotProvider(async () => collectDebugSnapshot(sources));
  attachDebugInspector(handle.transport, { clientId: handle.clientId, sessionId: handle.sessionId, context });
}

/** Projects the room snapshots through the narrow shape the projection is
 * allowed to see (`RoomSnapshot` from realtimeDiagnostics, narrowed: the
 * consolidation record lives at the top level of the room, next to `log`);
 * nothing else crosses. */
export function roomViewSource(rooms: () => {
  boardId: string;
  log: { phase?: string; appliedSeq?: number; pending?: number } | null;
  consolidation: string | null;
  error: string | null;
  reconnects: { reason: string; delayMs: number }[];
}[]): () => RoomView[] {
  return () => rooms().map((room) => ({
    boardId: room.boardId,
    log: room.log ? { phase: room.log.phase, appliedSeq: room.log.appliedSeq, pending: room.log.pending, consolidation: room.consolidation } : null,
    error: room.error,
    reconnects: room.reconnects,
  }));
}
