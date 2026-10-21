# Staged synchronization recovery validation

Job 2, 19 October 2026. The user approved the
[behavior contract](synchronization-contract.md) and authorized incremental
implementation/testing. This harness establishes reproducible boundaries and
explicit gaps; it does not certify that the target architecture is implemented.
The application defaults, OAuth configuration, existing data and authority keys
are unchanged. No service is deployed, tagged or released by these checks.

Jobs 3/4 add the [durable journal and causal reconciliation foundation](causal-change-journal.md),
including incremental tests in this runner. [Job 6](private-drive-history.md) adds
private Drive history persistence/recovery; [Job 7](peer-causal-history.md) adds authenticated peer history and native
offline-branch/resolution/reversed-clock checks. [Job 8](offline-authorization.md)
adds durable permissions, pending card work, historical local admission evidence
and the Google service gate. Account-binding enforcement (M07) is now an ordinary
passing component test: established durable bindings are honored and an unbound
local board is never uploaded into another connected account through
reconciliation; full account/mode-generation lifecycle remains Job 11.
[Job 5](conflict-resolution.md) adds local conflict review/signing tests and a native
Chromium draft/process-restart/resolution probe to the private-recovery scenario.

## Run locally

Use Node 24 from `.nvmrc`, installed project dependencies, and Rust stable.

```sh
npm run test:recovery -- --inventory
npm run test:recovery
npm run test:recovery -- --browser
npm run test:recovery -- --inventory --strict
```

The default run executes focused Vitest recovery/storage/security tests and the
real local Rust protocol/security suite. The browser option additionally requires
Chromium (or `PBOARD_CHROMIUM_BIN`) and runs fresh-device recovery, same/different
Google-identity fixtures with independent outages and a process crash, and the
preserved legacy Drive-signaling regression. It makes no request to the public
rendezvous and uses no actual Google account or installed browser profile.

The test-only Google verifier binary builds under
`services/pboard-signaling/target/recovery-fixture/` and is copied to a disposable
run directory before use. Default/release binaries are not replaced with the
fixture build. Never deploy a binary built with `test-google-fixture`. The runner
removes inherited `PBOARD_*`/`VITE_PBOARD_*` settings, selects only local fixtures,
limits each subprocess to ten minutes and terminates only its own process group
on interruption. Chromium profiles are created in per-run temporary directories.
The destructive test removes only its generated source profile, never a real one.
No real key, token, board snapshot or raw source diff is included in the summary.

`--strict` returns a failure while required acceptance evidence is incomplete,
even when all harness checks pass. `--inventory --strict` inspects this gate
without launching tests. No release path may treat a successful non-strict harness
run as full acceptance. The existing release-readiness blockers remain in force.

## Component fault controls

`tests/recovery/harness.ts` uses the real RxDB repository, blob store, snapshot
adapter and Drive provider against a synthetic account-private Drive transport.
It can fail before processing, commit then lose the acknowledgement, or hold a
request until the test releases it. File creation allows duplicates like the real
Drive API; the fixture does not hide duplicate-create errors through an upsert.
Separate accounts cannot read one another's files.

Tests retain local IDs, text, image bytes, signatures and dirty markers around
interruptions. Repository close/reopen demonstrates persistence within the test's
fake IndexedDB implementation; it is deliberately not claimed as real process or
browser-disk evidence. The native scenarios below test those additional boundaries.
A seeded random value and controlled Vitest clock test bounded request retry
behavior without wall-clock sleeps. The new durable scheduler and its approved
backoff defaults remain later work.

## Native recovery scenarios

The existing `secure-browser-smoke.mjs` harness gains two local-only switches:

```sh
# Requires an appropriate local binary; prefer the runner above for isolation.
PBOARD_BOARD_GRANTS=1 PBOARD_PRIVATE_RECOVERY=1 \
  node services/pboard-signaling/secure-browser-smoke.mjs

PBOARD_BOARD_GRANTS=1 PBOARD_GOOGLE_IDENTITY_SHARING=1 PBOARD_RECOVERY_FAULTS=1 \
  node services/pboard-signaling/secure-browser-smoke.mjs
```

PR01/PR02 first save a signed board with an image to synthetic private Drive.
They kill the source Chromium process, delete its entire disposable profile/key
stores, stop Rust and only then start the receiving browser in a fresh profile.
The receiving runtime restores the original content, image bytes and signatures
with no peer or rendezvous request. It has no board grant, pinned authority or
ownership of the original root. Component coverage also restores multiple boards
while excluding another account's private data. Google identity/OAuth HTTP is
simulated; no live-Google recovery claim is made.

Job 6's independent private path now asserts that recovery makes no legacy
shared-file discovery request. The default Drive collaboration discovery remains
unchanged; other legacy UI entry points still need Job 10 separation. The native
probe also backs up conflicts, a manual draft and a resolution, deletes the source
profile and restores their history on a fresh device without transferring authority.
See [private Drive history](private-drive-history.md) for scope and limits.

The Google-identity native flows additionally interrupt private Drive storage
while signed WebRTC edits continue, then stop signaling while private uploads
continue. They crash and reopen the receiving browser with its same profile, prove
its existing grant/keys and RxDB data persist, and check signed peer catch-up.
These are real Chromium/WebRTC/process tests with synthetic Google HTTP; they are
not proof of actual OS sleep, MV3 suspension, Firefox/Android recovery or live
Google identity verification. Signaling/authorization HTTP and frames are audited
for the fixture's private-content markers; intentionally permitted private Drive
content is not mislabeled as a signaling leak.

## Known failures remain visible

The following tests use Vitest's expected-failure facility. Their desired target
assertions currently fail against the existing implementation. They reproduce
real gaps; **they are not passing acceptance tests**. A future fix must convert
its test to an ordinary passing test and update the coverage inventory together.
If an expected failure unexpectedly passes, Vitest fails that check until the
transition is reviewed rather than silently ignoring the change.

| ID | Reproduced gap | Implementation stage |
| --- | --- | --- |
| (none) | M07 was converted to an ordinary passing test when account-binding enforcement landed. | Account generation/lifecycle UI remains Job 11. |

A04/A08 are now ordinary passing component tests: durable pending card edits and
permissions survive restart. [Job 8](offline-authorization.md) records the narrower
coverage and remaining structural/delegation/historical portability gaps.

C03 and the specific M06 held-download/logout regression are now ordinary passing
tests. Complete account/mode-generation isolation remains Job 11. The 17 new
private-history component tests also cover concurrent uploads, tombstones, drafts,
resolution recovery, invalid input and edits racing with transfer.

A component test identifies a specific boundary; for example, the M07 test is not
claiming to exercise Google's account-picker UI. Its provider/storage boundary
still needs an account binding before that UI can be considered safe.

## Resource-exhaustion evidence and remaining security work

The Rust suite uses real local sockets and bounded limits. Additional tests fill
the WebSocket cap with unauthenticated sessions, reject bursts of extra upgrades,
verify health remains available, wait for authentication deadlines, and reclaim
slots across repeated rounds and abrupt disconnects. Existing tests exercise
HTTP body concurrency/size/time limits, strict JSON, rate/byte/session budgets,
room scoping, signatures/replay and restricted DataChannel SDP/ICE payloads.
No server authentication check is disabled for a test.

This is evidence for the existing pre-authentication WebSocket cap, not a new
capacity claim or a complete network-exhaustion audit. Raw TCP/incomplete-header
admission before the router, public reverse-proxy limits, per-source fairness,
Google-verifier overload and measured VPS capacity need explicit Job 8/12 review.
The target Google-required WebSocket service-admission gate is also incomplete:
the current grant-only path is cryptographically authenticated but can operate
without Google verification. Neither Origin nor application identifiers can fill
that gap. The public service was not flooded or modified by Job 2.

## Coverage and evidence rules

`scripts/recovery/scenarios.json` maps all 53 approved scenario IDs plus PR01/PR02
to an owning job, evidence files and a precise remaining gap. Its status is either
partial, known-gap or gap. It intentionally contains no full-acceptance claims.
The runner validates the exact ID sequence against the approved contract; tests
also ensure expected failures and inventory entries cannot silently diverge.
Coverage is a source-controlled assessment, not an inference from subprocess exit
codes. The final JSON records which groups actually ran in that invocation and
always reports `fullAcceptance: false` at this stage.

Private bytes stay in synthetic fixture storage or disposable browser profiles.
No current user data, account credentials, source-device authority keys or live
shared-board grants are copied between devices by the harness. Existing source
signatures are preserved during private restore, not reassigned to the recipient.

Job 2 supplies the test foundation and gap inventory. Job 3 must introduce durable
change/causal metadata with crash-window tests before replacing conflict behavior
or enabling the target modes by default. Jobs 4–12 retain their independent tests
and acceptance gates; a transport test cannot discharge a conflict or recovery
requirement it does not exercise.

## Validation recorded for Job 2

19 October 2026, current dirty `main` worktree:

- `npm run test:recovery -- --browser`: passed all seven harness steps. Focused
  Vitest: 105 passing checks and 5 explicitly expected target failures. Rust:
  36 passing tests. Native private restore, both Google-account relationships,
  independent outages, process crash/reopen and legacy Drive regression passed.
- Complete `npm test`: 609 passed, 5 expected failures and 2 pre-existing failures
  in releaseMetadata/standardsPolicy. The pre-existing version-mirror and policy
  error-message mismatches were left unchanged; this is not a green release gate.
- Root and Android TypeScript checks, Rust fmt, strict clippy, inventory/link
  validation and `git diff --check` passed.
- Inventory: 55 scenarios, 20 partial, 5 known gaps, 30 gaps; zero full-acceptance
  claims. `--inventory --strict` returns exit 1 as intended.
- All 11 production Rust source/config hashes still match the existing feature-free
  artifact from `20261019T142032Z`. Only server tests changed in this job; no new
  server binary/configuration was deployed and no application transport default,
  OAuth scope, production version, grant, key or user data was changed.

Google is simulated in the positive automation. Real-Google recovery, actual OS
sleep/MV3 suspension, Firefox/Android recovery and public VPS exhaustion/load
measurements remain explicit gaps. A passing local pre-auth cap test does not
certify the whole public reverse-proxy/TCP boundary.
