/**
 * Controlled read-only board-state projection for the Debug Bridge
 * (registered as the snapshot provider in each context's composition).
 *
 * The privacy line: counts, identifiers, states, timestamps — never card
 * contents, images, credentials or key material. Everything here either was
 * already designed to be pasteable into a bug report (the room snapshots
 * behind `pboardCollaboration()`) or is a count/identity.
 */

import type { BoardStateEntry, ClientStateSnapshot } from "./protocol.ts";
import { transportSnapshot } from "../sync/transportDiagnostics";

export interface SnapshotSources {
  /** All known board ids (projects). */
  listBoards: () => Promise<string[]>;
  /** Card count for one board (count only — never contents). */
  countCards: (boardId: string) => Promise<number | undefined>;
  /** Room/transport views captured from `roomSnapshots()` at boot time. */
  rooms: () => RoomView[];
}

/** The slice of `RoomSnapshot` this projection is allowed to read; declaring
 * it structurally keeps this module from importing the diagnostics module's
 * full shape (and from being tempted by fields it should not expose). */
export interface RoomView {
  boardId: string;
  log: { phase?: string; appliedSeq?: number; pending?: number; consolidation?: string | null } | null;
  error: string | null;
  reconnects: { reason: string; delayMs: number }[];
}

/** Pending-operation count per board: the log's own backlog when the board
 * has a live log session, otherwise unknown (omitted, not zero — an unopened
 * board has no observable count). */
export async function collectDebugSnapshot(sources: SnapshotSources): Promise<Omit<ClientStateSnapshot, "clientId" | "sessionId">> {
  const boards: BoardStateEntry[] = [];
  const rooms = new Map(sources.rooms().map((room) => [room.boardId, room]));
  const boardIds = await sources.listBoards();
  // Bounded: a profile can hold many boards; the 12 most recently roomed
  // come first, then the rest as bare entries.
  const ordered = [...boardIds].sort((a, b) => Number(rooms.has(b)) - Number(rooms.has(a)));
  for (const boardId of ordered.slice(0, 16)) {
    const room = rooms.get(boardId);
    const entry: BoardStateEntry = {
      boardId,
      open: room !== undefined,
      ...(room?.log ? {
        syncState: room.log.phase ?? (room.error ? "error" : undefined),
        ...(room.log.appliedSeq !== undefined || room.log.pending !== undefined
          ? { oplog: { appliedSeq: room.log.appliedSeq, pending: room.log.pending } }
          : {}),
        ...(room.log.consolidation ? { snapshot: { phase: room.log.consolidation } } : {}),
      } : {}),
    };
    if (room?.error) entry.syncState = entry.syncState ?? "error";
    try {
      entry.cardCount = await sources.countCards(boardId);
    } catch {
      // A count that cannot run is omitted; the bridge prefers honest gaps.
    }
    boards.push(entry);
  }
  const transport = transportSnapshot();
  return {
    kind: "board-state",
    capturedAt: new Date().toISOString(),
    boards,
    connections: transport.history
      .filter((entry) => entry.open)
      .map((entry) => ({
        connectionId: `local-${entry.id}`,
        state: entry.open ? "open" : "closed",
        trigger: entry.trigger,
        ...(entry.room ? { room: entry.room } : {}),
      })),
    sync: { transportEnabled: transport.enabled, open: transport.open, dials: transport.dials, closed: transport.closed },
    restricted: "counts, states and identities only by design; card contents are never included",
  } satisfies Omit<ClientStateSnapshot, "clientId" | "sessionId">;
}
