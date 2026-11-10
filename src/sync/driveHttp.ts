/**
 * A Drive HTTP failure that carries the status it came from.
 *
 * Every funnel used to report a failed response as a plain `Error` with the
 * status interpolated into the text. That is enough for a log line and not
 * enough for a caller: "the file is gone" and "the network failed" have to be
 * told apart to react correctly, and matching on a message string breaks the
 * moment the wording changes. `driveHttpError` keeps the message exactly as it
 * was and attaches the status beside it.
 */
export type DriveHttpError = Error & { status: number };

export function driveHttpError(status: number, message: string): DriveHttpError {
  return Object.assign(new Error(message), { status });
}

/**
 * Drive no longer has the resource. The common case is benign and routine: a
 * presence file whose session left and deleted it between the room listing and
 * the read of that file. Treating it as a storage failure turned a peer leaving
 * into a failed room.
 */
export function isDriveGone(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 410;
}

/**
 * Resource ids Drive has reported gone, remembered for the session.
 *
 * Drive never reuses an id, so a 404 for one is terminal, and the callers that
 * ask are periodic: a write barrier re-verified before every sync, a legacy copy
 * protected every time a board is adopted. Without a memory each of those rounds
 * re-asked, turning deleted files into a stream of 404s.
 */
const goneResourceIds = new Set<string>();
const MAX_GONE_RESOURCE_IDS = 4_000;

export function noteDriveResourceGone(resourceId: string): void {
  if (goneResourceIds.size >= MAX_GONE_RESOURCE_IDS) goneResourceIds.delete(goneResourceIds.values().next().value as string);
  goneResourceIds.add(resourceId);
}

export function driveResourceKnownGone(resourceId: string): boolean {
  return goneResourceIds.has(resourceId);
}

/** Test seam: forget the remembered verdicts. */
export function clearDriveResourceGoneMemory(): void { goneResourceIds.clear(); }
