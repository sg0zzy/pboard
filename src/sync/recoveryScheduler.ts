/**
 * Bounded durable recovery scheduling (contract R07/R08): exponential ceilings
 * 1, 2, 4, 8, 16, then 30 seconds; the actual delay is uniform between half the
 * ceiling and the ceiling. An explicit service cooldown takes precedence and may
 * exceed the local cap. Progress verified by the caller (not merely opening a
 * connection) resets the schedule; Standalone and platform-offline pause retries.
 */
export const RECOVERY_CEILINGS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export type RecoveryAttemptContext = {
  /** The attempt index after the most recent verified progress (0-based). */
  attempt: number;
  /** Optional explicit service cooldown; takes precedence over the local cap. */
  cooldownUntil?: number;
  /** Seeded uniform in [0,1) so tests are deterministic without sleeping. */
  random: () => number;
};

export function recoveryDelayMs({ attempt, cooldownUntil, random }: RecoveryAttemptContext, now: number): number {
  const ceiling = RECOVERY_CEILINGS_MS[Math.min(Math.max(attempt, 0), RECOVERY_CEILINGS_MS.length - 1)];
  if (cooldownUntil !== undefined && cooldownUntil > now) return Math.max(ceiling, cooldownUntil - now);
  return Math.ceil(ceiling / 2 + random() * (ceiling - ceiling / 2));
}

export type RecoverySchedulerState = { attempt: number };

export function recordProgress(state: RecoverySchedulerState): void {
  state.attempt = 0;
}

export function recordAttempt(state: RecoverySchedulerState): void {
  state.attempt = Math.min(state.attempt + 1, RECOVERY_CEILINGS_MS.length - 1);
}

export type RecoveryGate = {
  standalone(): Promise<boolean>;
  platformOffline(): Promise<boolean>;
};

/** Standalone and a platform-reported offline state pause retries (no tight loop, no silent drops). */
export async function retriesPaused(gate: RecoveryGate): Promise<boolean> {
  return (await gate.standalone()) || (await gate.platformOffline());
}