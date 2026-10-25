# Jobs 11 and 12 implementation status

20 October 2026. Local implementation and validation; no deployment or release.
The [approved behavior contract](synchronization-contract.md) remains the target.

## Job 11: two operating modes and unified recovery

Implemented so far, without changing existing defaults or removing the legacy
path:

- **Account binding and enrollment (M05/M07, policy updated 2026-10).** A
  connected Google Drive *is* the consent: every local board auto-enrolls for
  private persistence under the connected account — no per-board prompt — and
  connecting immediately reconciles so a fresh profile of the same account
  restores its boards unattended. The earlier per-board disclosure
  (`authorizePrivatePersistence`) still records its account-scoped receipt but
  is no longer required to upload. Established board bindings stay with their
  original account. Consequence of the 2026-10 decision: a board that was
  created under account A and never uploaded can be enrolled by a later-
  connected account B on the same device. Local data is retained on every
  denied/failed operation.
- **Unified Sync v2 storage and automatic legacy migration (2026-10-24).**
  Under the websocket provider every board — private or shared — persists to
  `My Drive/pboard/<boardId>/board.json.gz` (+ `attachments/`); AppData plays
  no role in normal v2 persistence. The legacy migration runs automatically
  on reconcile without prompting (connect is consent): AppData copies and
  legacy shared `Pboard/` folders relocate after a read-back verification,
  sources delete only after the 90-day window, shared ACLs are copied before
  the flip. Account ordering preferences intentionally remain AppData-backed
  account metadata. The `drive` OAuth scope is unchanged. See
  [`docs/collaboration.md`](../collaboration.md) "Sync v2 components".
- **Contract status resolver (S01).** `src/sync/boardStatus.ts` derives the four
  contract labels with the approved precedence (Local only → Conflict requires
  resolution → Synchronization pending → Synced), including the no-Synced rule
  under a known channel failure and the inactive-account Local-only scope.
- **Bounded durable recovery scheduling (R07/R08).** `src/sync/recoveryScheduler.ts`
  implements the approved exponential ceilings (1/2/4/8/16/30 s), jitter within
  [half, ceiling], explicit-cooldown precedence, attempt clamping, progress reset
  and the Standalone/platform-offline pause. The Drive background worker applies
  it with a durable per-board attempt counter that survives restarts and is
  cleared only after the durable board state is clean and synced. A resolved call that leaves pending work retains backoff and schedules another attempt.

Login/logout still never delete local data; temporary failures still do not
interrupt permitted editing. Remaining before Job 11 closes: mode generation
lifecycle (M02–M04/M08 account/mode switching and duplicate-pool prevention),
sidebar wiring of the new status resolver, and the standalone remote-activity
boundary in the production UI.

## Job 12: final compatibility and security matrix — local validation

Matrix validated on this checkout with simulated Google HTTP (no live accounts);
no tag or release:

| Gate | Result |
| --- | --- |
| Full TypeScript suite (root) | 768 passed, 106 files, 0 failures |
| Android TypeScript suite | 98 passed, 15 files |
| Rust protocol/security suites admission/hardening/protocol | 37 passed |
| Recovery harness (component + fixture binary + Rust) + native Chromium stages | all 7 stages pass |
| Typecheck (root + Android), Firefox/Chromium builds, lint, package verification | pass |
| Strict inventory gate | correctly stays closed: partial=45, gap=10, known-gap=0 |

Remaining scenario gaps are platform/live-boundary claims the local harness
cannot honestly make: full account/mode UI lifecycle (M02–M04, M08), live Google
verification, Firefox native recovery, Android onboarding/attachment validation,
per-account socket binding at the public relay, upstream proxy/TCP quotas and
measured VPS capacity. Release tagging remains blocked by the
[standards migration blockers](../../STANDARDS_MIGRATION_REPORT.md) (unreviewed
production Android signing history and repository protections).