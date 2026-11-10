# Jobs 11 and 12 implementation status

20 October 2026. Local implementation and validation; no deployment or release.
The [approved behavior contract](synchronization-contract.md) remains the target.

> **State at 6 November 2026 — read this before the record below.** The
> validation figures in this document are the 20 October measurements and are kept
> as a record, not as current claims. Measured on 10 November 2026: client `tsc`
> clean, full suite **1 870 tests in 257 files**, multiBrowser **172 in 18 files**,
> Android **106 in 18 files**, build 0 errors; the extension sidebar chunk is
> **637 kB** (183 kB gzip) against a 600 kB advisory, background 839 kB (247 kB
> gzip); `services/pboard-signaling` **169 tests**, `cargo clippy --all-targets`
> 0 warnings. Nothing in either repository is committed.
>
> Two of the "remaining" items below did not move, and are still the honest answer:
> the contract status resolver `boardSyncStatus`
> (`src/sync/boardStatus.ts:29`) has **no caller in `src/`** — only its test imports
> it, so the sidebar's status line still comes from the Drive sync state
> (`src/sidebar/components/DriveSyncControls.tsx:139-144`), not from the four
> contract labels — and the mode-generation lifecycle for M02–M04/M08 is still
> unimplemented. The transport picture did change: WebRTC is off in every
> composition root (`src/sync/browser.ts:17` and
> `apps/android/src/sync/service.ts:15`), and a board uses the multiplexed operation
> log where the auth provider supplies Drive identity credentials (Firefox, Android)
> or Drive polling everywhere else ([operation log](websocket-operation-log.md)).

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
- **Contract status resolver (S01) — implemented, not wired.** `src/sync/boardStatus.ts`
  derives the four contract labels with the approved precedence (Local only →
  Conflict requires resolution → Synchronization pending → Synced), including the
  no-Synced rule under a known channel failure and the inactive-account
  Local-only scope. As of 6 November 2026 **no `src/` caller imports it**; only
  `tests/boardStatus.test.ts` does. The sidebar still renders the Drive sync state
  (`src/sidebar/components/DriveSyncControls.tsx:139-144`), so the S01 requirement
  is satisfied at the resolver, not in the interface — exactly the remaining Job 11
  item listed at the end of this section.
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
no tag or release. **These are the 20 October figures and are retained as the
record of that gate.** On 10 November 2026 the same gates measured: client full
suite 1 870 tests / 257 files, multiBrowser 172 in 18 files, Android 106 in 18 files,
`tsc` clean, build 0 errors; `services/pboard-signaling` 169 tests with clippy at
0 warnings. The inventory
counts below still match `scripts/recovery/scenarios.json` (45 partial, 10 gap, 0
known-gap), which `tests/recovery/recoveryInventory.test.mjs` re-checks against the
contract's 55 scenario rows.

| Gate | Result (20 October 2026) |
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
measured VPS capacity. To that list, add what the transport actually does not do:
live rooms exist only where the auth provider supplies Google identity credentials
(Firefox and Android, not the Chromium side panel), "Sync now" does not rediscover,
only the displayed board receives edits passively, and a cross-account invitation
travels the inbox as a hint that buys a Drive read rather than board traffic.
Release tagging remains blocked by the
[standards migration blockers](../../STANDARDS_MIGRATION_REPORT.md) (unreviewed
production Android signing history and repository protections).