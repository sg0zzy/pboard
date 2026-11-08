/**
 * Presence lifetime for Drive-hosted signaling records.
 *
 * Kept in its own leaf module so the constant can be read by code that must
 * not pull the peer transport (the runtime's diagnostics gate) while
 * `src/collab/signaling.ts` keeps exporting it for its own users.
 */
export const DRIVE_PRESENCE_TTL_MS = 60_000;
