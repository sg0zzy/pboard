/**
 * D6 compatibility boundary (Phase 2): an explicit format/min-version marker
 * that must exist BEFORE any new on-disk format (journal-first board format)
 * becomes authoritative.
 *
 * Semantics:
 *  - `null` marker = legacy board; every current client reads and writes it.
 *  - A marker is written only at (future) migration time and records the
 *    format version plus the minimum client version allowed to WRITE it.
 *  - A client evaluates its own version before every write attempt; refusing
 *    to write is the whole contract — reads and exports stay available.
 *  - Silent downgrade is impossible by construction: the marker never moves
 *    backwards, and old clients cannot write migrated boards because the
 *    migrated snapshot carries an unknown `schemaVersion`, which
 *    `deserializeBoardSnapshotV2` rejects fail-closed — `performSync` then
 *    dies before it serializes or pushes anything. The board file is never
 *    rewritten by an incompatible client, and legacy data stays intact.
 *
 * Phase 2 lands the mechanism; the format bump that activates it is Phase 3.
 */

/** Current board storage format generation. 1 = legacy whole-snapshot board.json.gz. */
export const BOARD_FORMAT_VERSION = 1;
/** Client version allowed to write every current format. */
export const MIN_COMPATIBLE_CLIENT_VERSION = 1;

export type BoardFormatMarker = {
  /** Storage format generation the board was migrated to. */
  formatVersion: number;
  /** Lowest client version permitted to write this board. */
  minClientVersion: number;
  /** Clock time the migration stamped the marker. */
  migratedAt: number;
};

export type BoardCompatibility = { compatible: true } | { compatible: false; reason: "client-too-old"; required: number };

/** Decide whether `clientVersion` may write a board carrying `marker`. */
export function evaluateBoardCompatibility(marker: BoardFormatMarker | null, clientVersion: number): BoardCompatibility {
  if (!marker) return { compatible: true };
  if (!Number.isSafeInteger(marker.formatVersion) || marker.formatVersion < BOARD_FORMAT_VERSION) return { compatible: false, reason: "client-too-old", required: marker.minClientVersion };
  if (!Number.isSafeInteger(clientVersion) || clientVersion < marker.minClientVersion) return { compatible: false, reason: "client-too-old", required: marker.minClientVersion };
  return { compatible: true };
}

/** Migration markers only ever move forward; refuse anything else. */
export function assertNoSilentDowngrade(current: BoardFormatMarker | null, next: BoardFormatMarker): BoardFormatMarker {
  if (current && (next.formatVersion < current.formatVersion || next.minClientVersion < current.minClientVersion))
    throw new Error("Board format cannot move backwards; this client is older than the board's format");
  return next;
}
