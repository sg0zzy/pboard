/**
 * Thrown when a board holds signed collaboration data but this device has no
 * collaboration authority for it, so automatic initialization must not run.
 * The condition is deterministic for the board and device — it clears only
 * when authority is restored (pairing, recovery file, or a matching grant) —
 * so the collaboration manager may answer repeat refreshes from its failure
 * memo instead of repeating the identity-service round trips.
 */
export class BoardExistingSignedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardExistingSignedDataError";
  }
}
