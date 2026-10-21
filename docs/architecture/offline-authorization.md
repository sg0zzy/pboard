# Job 8: offline authorization and service admission

20 October 2026. Local implementation and validation; no deployment or release.
The [approved behavior contract](synchronization-contract.md) remains the target.
**Job 8 is not complete:** structural pending commands and transferable historical
admission evidence remain open below. Owner-authorized authority recovery is now
implemented and natively tested (A09 partial); roster revocation/rollback and
legacy-client treatment for the restored roster remain.

## Audit and implemented changes

| Boundary | Before this job | Current implementation |
| --- | --- | --- |
| Cached viewer | In-memory role disappeared on manager stop/restart | Device-local permission records survive both; stopping a transport cannot clear permission |
| Recovered signed board | No durable editing entitlement | Signed content is readable/exportable; it supplies no editing entitlement or replacement authority |
| Expired editor grant | Signed hooks reject a local save | Existing-card field edits become durable pending work outside replicated documents |
| Reauthorization | No pending-work admission | The original device can issue a new authorized operation against the saved base; concurrent branches remain |
| Confirmed removal/downgrade | Grant rejection did not persist an offline restriction | Verified monotonic manifests persist Viewer/Revoked before rejecting access; unavailable HTTP is not evidence of removal |
| Historic author removed | Reverification only considered current membership | Exact previously verified bytes retain local admission evidence; new timestamp claims still fail |
| Public board-grant socket | Device/board proof did not independently require Google | Google service admission and board-device authorization are independently required |
| Public configuration | A TLS service could start without Google | Binary startup rejects missing verifier/identity configuration for the public independent-board path |
| Recovery upsert | Mutation guard cloned RxDB write responses | Response identity is preserved, including RxDB's generated-revision metadata |

No OAuth scope, Drive folder, RxDB document schema, authority key, board ID or
production signaling default changes. Local journal version 3 adds independent
`permissions`, `pendingEdits` and `admissions` stores; entries, receipts and drafts
remain intact. Permissions and local admission receipts are never replicated or
imported from private Drive. Browser and Android use the same TypeScript runtime.

## Files changed in this job

| Area | Files |
| --- | --- |
| Durable local state and pending admission | [changeJournal.ts](../../src/storage/changeJournal.ts), [rxdbRepository.ts](../../src/storage/rxdbRepository.ts), [conflictResolution.ts](../../src/storage/conflictResolution.ts) |
| Local signing, receipts and recovery write guard | [liveMutations.ts](../../src/collab/security/liveMutations.ts), [journalProof.ts](../../src/collab/security/journalProof.ts), [mutation.ts](../../src/collab/security/mutation.ts) |
| Grant observation and Google service proof | [boardGrants.ts](../../src/collab/boardGrants.ts), [googleIdentitySharing.ts](../../src/collab/googleIdentitySharing.ts) |
| Existing transport/runtime integration | [experimentalWebSocketSignaling.ts](../../src/collab/experimentalWebSocketSignaling.ts), [signalingSelection.ts](../../src/collab/signalingSelection.ts), [manager.ts](../../src/collab/manager.ts), [peerHistory.ts](../../src/collab/peerHistory.ts), [runtime.ts](../../src/sync/runtime.ts), [snapshot.ts](../../src/sync/snapshot.ts) |
| Rust service | [lib.rs](../../services/pboard-signaling/src/lib.rs), [main.rs](../../services/pboard-signaling/src/main.rs), [identity_enrollment.rs](../../services/pboard-signaling/src/identity_enrollment.rs) |
| New regression files | [offlineAuthorization.test.ts](../../tests/recovery/offlineAuthorization.test.ts), [serviceAdmission.test.ts](../../tests/serviceAdmission.test.ts) |
| Existing regression updates | [recovery.test.ts](../../tests/recovery/recovery.test.ts), [recoveryInventory.test.mjs](../../tests/recovery/recoveryInventory.test.mjs), [conflictResolution.test.ts](../../tests/recovery/conflictResolution.test.ts), [boardGrants.test.ts](../../tests/boardGrants.test.ts), [liveMutationSigning.test.ts](../../tests/liveMutationSigning.test.ts), [collaborationAdmission.test.ts](../../tests/collaborationAdmission.test.ts), [collaborationRecovery.test.ts](../../tests/collaborationRecovery.test.ts) |
| Harness and deployment example | [run.mjs](../../scripts/recovery/run.mjs), [scenarios.json](../../scripts/recovery/scenarios.json), [secure-browser-smoke.mjs](../../services/pboard-signaling/secure-browser-smoke.mjs), [service example](../../services/pboard-signaling/deploy/pboard-signaling.service) |

This new document accompanies updates to the existing collaboration/recovery/contract
notes, service README/protocol, documentation index and standards migration report.
Pre-existing changes from earlier jobs are retained in the same worktree.

## Local work and authorization

`createRxRepository` checks durable permissions for repository mutations.
`installLiveBoardMutations` records the trusted device/authority and role after
installing the existing signature guards. A viewer, confirmed removed device or
fresh recovered device without established editing entitlement cannot become an
editor through logout, restart or transport cancellation. Removing a board from
one account's list does not delete shared content without current owner authority.
Standalone unsigned boards keep their existing local editing behavior.

For an expired/stopped editor context, `updateItem` saves a separate `PendingEdit`:
original causal base and signed source, original author-device/authority IDs,
unsigned proposed value, and superseded draft IDs. Pending work does not alter
RxDB's signed source document, generate a peer proof, or enter legacy Drive
snapshots. Local card reads/subscriptions and explicit board export show a sole
pending head. Every superseded version remains stored. Parallel draft heads remain
retained; the next edit requires explicit review rather than selecting by clock.
`exportPendingWork(boardId)` exports all retained versions, including hidden-board
work. An explicit private/collaborative copy still uses new board/card identities.

`admitPendingWork`, called when an editor/owner manager starts with current guards,
requires the same original device and authority. It creates a new signed operation
under current authorization and an author proof, referencing the saved base rather
than the latest remote document. The journal and existing guarded materializer
reconcile it. A concurrent remote head remains a conflict. A stable operation ID
allows recovery after journal acceptance but before pending acknowledgement without
re-signing. Projection completion is tracked separately: a crash after admission
acknowledgement still finishes the RxDB projection on retry. Backup intent is
persisted before admission; board revision metadata is advanced after projection
for compatibility snapshot readers. Superseded drafts cannot resurrect after
acknowledgement/restart.

An expired grant is never extended. Confirmed Viewer/Revoked blocks admission and
further edits; held work stays exportable. Losing access does not erase cached
content or evidence. Unavailable authorization keeps the last known entitlement
for local pending work only, never for remote admission.

## Previously admitted history

`recordLiveBoardAdmission` verifies original mutation bytes against the installed
trusted context before storing a device-local content hash, board, authority and
epoch. Local signing, guarded writes and authenticated peer-history receipt use
this path. Receipt persistence failure fails the operation closed.

Under current authorization, conflict review can verify an unchanged historical
variant against that local evidence even if its author was later removed. Exact
journal materialization can also restore those bytes. Ordinary network writes do
not receive this exception. A signature plus a claimed old timestamp does not
create an admission receipt; neither Drive imports nor incoming receipt-shaped
data can do so. Another authority cannot reuse the receipt namespace.

This evidence is **local**, not a transferable revocation certificate. A fresh
receiver still rejects newly presented work from a currently removed author,
including its historical causal parents. Full transitive historical forwarding and
resolution to fresh devices after revocation remains incomplete. This job does
not infer admission from a device clock, a private backup or an author signature
alone, and does not delete the original journal variants.

## Google service gate and resource bounds

The existing `/identity/challenge` and `/identity/exchange` flow now supports an
`admit` operation. The client signs the operation with the actual board-device key
and supplies its existing access token only over HTTP/WSS's HTTPS origin. Google
verifies identity; the operation creates no board policy, member or grant. The
server stores no token or new persistent user record.

The receipt is bound to the actual socket challenge, connection ID, derived room
and device fingerprint. It is consumed once within 30 seconds and caps the admitted
socket to five minutes. Authentication still independently verifies the original
board grant, root, device possession, current cache and room binding. A receipt
for another socket, room or device fails; a successful Google check with no board
grant fails. Challenges/receipts are volatile and disappear on restart.

The new welcome flag and authentication field are documented in the
[protocol](../../services/pboard-signaling/PROTOCOL.md#google-service-admission-job-8).
The selected runtime passes the Google admission callback; there is no anonymous
fallback. Public binary startup with `PBOARD_SIGNALING_REQUIRE_TLS_PROXY=1` requires
a Google verifier, and independent board grants additionally require identity
enrollment. Local loopback cryptographic-only fixtures remain available. The
legacy Google/Drive broker retains its own Google-verified manifest admission.

Existing limits are reused: 128 WebSockets including pre-authentication sockets,
10-second authentication deadline, 45-second idle deadline, 16 peers/room,
128 rooms, 96 KiB message ceiling, 60 messages/second per socket, cumulative byte
and signal quotas, global traffic limits, four concurrent HTTP handlers and 64
HTTP requests/second. Receipts use the existing replay-entry quota (8192 default)
and cleanup expired entries before allocation. Operator settings remain bounded
and invalid values fail closed. Tests exercise limits; these are not measured
capacity guarantees for a 2 GB VPS or protection against arbitrary upstream TCP
flooding. Proxy/OS limits and production capacity measurements remain necessary.

Root manifests normally last five minutes. Local origin signing, pending admission
and rendezvous sessions enforce actual expiry. Existing protocol receive/session
checks retain up to 30 seconds of clock tolerance; this is not permission to sign
new work after expiry. Revocation of an isolated peer cannot be instantaneous.
No freshness guarantee survives indefinitely without a verifiable current grant.

Headers, Origin and application names remain defense in depth, never identity.
Operational logs contain static reasons/correlation metadata, not tokens, receipts,
SDP, board documents or image data. Google identity proves service admission only.

## Validation on this checkout

- 19 new TypeScript tests: 12 offline/authorization recovery, six service admission,
  and one grant-observation regression. A04/A08 are ordinary passing tests now.
- Full TypeScript suite: **730 passed, one expected failure (M07), two pre-existing
  failures** in release metadata and standards-policy expectations; 97 files.
- Rust: **37 passed**, including one-use/expiry/cross-binding/receipt-quota tests,
  real HTTP Google-proof/key-possession checks, Google-only room denial and public
  configuration rejection. Existing pre-authentication/flood/forwarding tests pass.
- All seven `npm run test:recovery -- --browser` stages passed: component tests,
  Rust, isolated fixture binary, permanent-source-loss private recovery, native
  different/same-account WebRTC recovery, and legacy Drive signaling/images.
- Rerun on 20 October after the harness fix: the same-account stage also exercises
  native owner-authorized authority recovery (A09) after a real Chromium process
  kill, full profile/key-store deletion and Rust restart; the recovered root
  resumes replication with the previously authorized peer.
- Root typecheck and Firefox/Chromium managed builds/package verification passed.
- Native browser evidence is Chromium with simulated Google HTTP, not a live
  Google account, Firefox native recovery or Android device validation.
- No VPS load measurements, remote configuration, deployment, tags or release.

Native conflict review can correctly reject a moving projection. Its fixture now
re-reads and confirms the identical reviewed heads before retrying only that
specific rejection. Production stale-review checks remain unchanged.

## Remaining work before closing Job 8

1. **Delegation/recovery:** only the original root-authority key can renew grants
   and sign email policies. Permanent loss with no previously authorized recovery
   mechanism cannot be fixed by Google login. Data recovery works independently.
   An explicit, owner-authorized recovery path is implemented and natively tested:
   the owner seals the original root key with a passphrase-encrypted recovery
   file, and a reviewed device restores the same authority (never a replacement
   root), merging current grant history and rejecting stale rosters, forks and
   wrong pins. Remaining before A09 closes: revocation/rollback coverage for the
   restored roster and legacy-client treatment. No private key export beyond the
   sealed owner-created file, and no replacement authority, is introduced.
2. **Other pending commands:** adding/deleting/moving cards, images, board/template
   changes and resolutions still need current authority. Existing-card fields use
   pending work; a scratchpad `draftCommand` buffers structural commands locally
   with the same strict review/admission path, and private Drive backup/restore of
   held pending work (including referenced image bytes, duplicate suppression and
   fresh-device fail-closed admission) is component-tested in
   `tests/recovery/pendingWorkBackup.test.ts`. Shared structural admission against a
   live remote head and full per-command type coverage still need broader
   tests; private unsigned boards remain fully editable.
3. **Historical portability:** local receipts preserve admitted variants; portable
   admission evidence and transitive peer recovery after revocation remain open.
4. **Lifecycle/UI:** Job 11 must expose held/parallel pending work and blocked reasons,
   provide UI export/review, include pending work in synchronization status, and
   coalesce renewal/recovery without manager restart. Legacy unsigned shared-board
classification and the explicitly selected legacy storage backend need their
separate migration/lifecycle coverage; missing signatures alone cannot identify
old shared copies. Until then use the repository
   APIs for full pending-work inspection; do not claim all recovery scenarios pass.
5. **Platform/operations:** Firefox/Android interruption tests, real Google verification,
   sleep/suspend, per-account lifecycle binding, upstream quotas and measured capacity
   remain open. Old clients fail closed on a new Google-required public service;
   coordinate client/server updates in a separately authorized deployment.

## Removal and initial-bootstrap races — 20 October 2026 follow-up

Signed-board owner deletion now writes its signed card/project tombstones before
removing the list handle. Previously the handle disappeared first; sidebar
selection teardown could uninstall its signer before deletion finished. Existing
unsigned/legacy ownership discovery still commits the local removal before remote
permission lookup. Viewer/editor/fresh recovery copies remove only their account
handle. A signed board's deletion role comes from its verified grant, never from
Drive ACLs. Removal/reorder retains existing restore metadata.

Initial authorization now runs through `RxRepository.installBoardSecurity`, on
the same local mutation queue as snapshot import, private recovery and normal
commands. Guard teardown waits for in-flight repository writes. This prevents a
collection-wide untrusted-import scope from suppressing initial signatures or
racing a board switch. Initial attestation additionally re-verifies the stored
bytes before declaring success: even direct/misordered calls fail closed rather
than leaving unsigned documents marked as bootstrapped.

Regression tests cover removal with sidebar-style signer teardown, independent
board deletion without Drive ACL access, restore-marker retention, an empty-note
bootstrap held behind another board's snapshot import, direct overlapping
attestation rejection, and teardown during a signed edit. The native same- and
different-account scenarios also start with an existing empty note and require
its signed replication. No schema, keys, grants or OAuth configuration are reset.

### Pending authorization and local responsiveness (20 October 2026)

“Verify board access and reconcile now” identifies retained local pending work;
it does not diagnose a WebRTC authentication failure. The runtime previously
returned `current` whenever a guard was installed, even if that grant had expired,
and skipped pending admission altogether. Managed guards now refresh through the
collaboration manager, reject expired/unavailable authorization, and reconcile
under the current verified editor/owner grant. Healthy transports stay running.
Viewer/revoked access never publishes held work.

Pending command scratchpads now seed exact source values without re-journaling
every copied document. These are isolated in-memory copies of existing local
versions; command changes still become durable pending work on the real journal
before the command completes. A regression with thirteen existing cards requires
only two scratch journal preparations for a new card and board ordering metadata,
and checks that held content survives reopening the real database.

Recovery metadata is read once per board per refresh, and uses history only if
the board document is absent. Query/journal subscribers allow one read in flight
plus a trailing refresh, avoiding parallel full reads on each signing/WAL update.
Pending review submits only the selected document's versions, rather than every
pending document on the board. Existing signed-data validation and the serialized
mutation/import/bootstrap boundary remain in place.

The native two-profile harness additionally creates cards under a current grant,
stops collaboration, retains unsigned offline card commands, renews authorization,
and requires their signed replication after reconnection. It reports local
IndexedDB command timings separately from UI latency. Google HTTP is simulated;
these measurements do not establish performance in an existing user's profile.

The new native pending-edit scenario also exposed a restored-receipt defect:
append-only private archives retain pre-admission drafts while their delivery
flags are deliberately not trusted on restore. A fresh device could therefore
block editing on a draft already represented by signed history. Pending admission
now reconstructs a receipt only when the exact original operation, author,
authority, document, payload, parents, content identity and cryptographic history
proof verify under current board trust. Historical author removal additionally
requires the existing root-signed history certificate. No original draft or
history is deleted; changed or unverifiable variants remain held for review.
Tests reject mismatched draft content and require fresh-profile recovery to resume
editing after permanent original-device loss.

Private backup must also retain the entire pending supersession chain, including
admitted descendants with their local delivery flags stripped. Previously a
backup taken after admission could upload only an older unadmitted ancestor;
on restore its missing superseding descendants made it appear to be new pending
work. The native failure showed precisely such an orphaned board-metadata draft
with no matching signed operation. New syncs append missing chain evidence using
the existing version-1 layout; no files are rewritten or deleted. Existing devices
can backfill this evidence on their next sync. A recovered older archive with no
surviving supersession or signed-operation evidence still requires explicit
review; authority or Google identity alone must not discard that retained work.

Validation after these fixes: 809 application tests, 98 Android tests, 37 Rust
tests, root/Android typechecks and both managed browser builds/package checks
passed. All seven stages of `npm run test:recovery -- --browser` passed, including
same/different-account native replication, restored pending work, permanent owner
profile loss with explicit root recovery, revocation and preserved legacy Drive.
In the final small Chromium fixtures, new-board commands took 12–13 ms, signed
card commands 11–45 ms, and pending-card commands 18–23 ms (three cards per state
per account scenario). These are command timings, not existing-profile UI latency
measurements. Google identity/Drive HTTP is synthetic; live Google, Firefox runtime
and physical Android lifecycle were not exercised. The broader 55-scenario full
architecture acceptance gate remains incomplete, independently of these fixes.

### Explicit permanent board erasure

**Permanently delete board** replaces the earlier pending-only disposal action.
It is available below restore in the pending-work panel and in the conflict panel,
including for boards that reappeared after the earlier implementation. Confirmation
covers the board, cards, pending versions, conflict drafts/history and private
Google Drive backup. Other users' copies and board membership are unaffected.

A board-level erasure intent and reviewed pending-head validation commit together
in the existing local receipt/pending transaction. The repository scrubs card and
board payloads into minimal RxDB tombstones, deletes journal history, drafts,
permissions, public grants, admission evidence and delivery receipts, and removes
images unreferenced by other boards. Browser legacy/rollback copies are pruned for
this board only. The local erasure marker blocks restoration, mutation, journal
re-admission and peer writes; partial local purges resume when the repository is
reopened. Explicit permanent deletion is the user-confirmed exception to ordinary
conflict/history retention. It never generates an unsigned shared-board deletion.

The recorded private account binding pins cloud cleanup; an explicit online action
can also identify the current account for legacy unbound copies. A minimal private
`erased-<board>.pboard` marker is published before deleting snapshots and history
archives, so updated stale/fresh devices cannot restore or upload that board again.
Only files whose actual board identity matches are removed. Private image assets
are removed only if no other account-private history or snapshot references them.
The marker carries only a board ID and image hashes needed for resumable cleanup;
it contains no board text, images, credentials or authorization grant.

Cloud deletion retries through the existing bounded background backoff, including
while disconnected, and survives restart. Local editing of other boards is
independent of cloud availability. A different Google account cannot complete the
queued deletion. No OAuth scope, shared Drive folder, server or journal schema
version changes are needed. Unbound legacy copies erased while offline have no
verified remote account; the client must not guess an account and delete its data.
Older clients do not understand erasure markers and may recreate private files;
updated clients reject those files as live board data and retry cleanup. Copies
held by other users or manually exported files remain outside this operation.

Tests cover conflict disappearance, scrubbed RxDB rows, image sharing, legacy
copies, restart/offline/failure retry, account isolation and stale/fresh-device
recovery. The native Chromium scenario additionally erases an actual signed board
after authority recovery and verifies that two existing profiles plus a fresh
profile do not recover its data or conflicts. Google HTTP is simulated.

Erasure validation: 818 application tests, 98 Android tests, both typechecks and
both managed browser packages pass. All seven native recovery stages pass, plus
a final Chromium erasure scenario covering a signed owner-recovered board, stale
and fresh profiles. Google HTTP is simulated; live Google deletion, Firefox UI and
physical Android lifecycle were not exercised. The full architecture acceptance
gate remains incomplete independently of this targeted fix.

### Immediate manual Drive synchronization

Manual progress is tracked per board. Switching to another board leaves the
original request running and allows an independent request for the selected
board; switching back shows its pending request. Duplicate clicks for that same
board are suppressed. Completion/errors and asynchronous status reads from
another board cannot replace the selected board's feedback or unlock its button.
Concurrent explicit enrollment updates serialize their account-scoped disclosure
write, preserving both board IDs and the existing account-change check.

The selected-board **Sync now** action is available even when cached status says
clean or syncing. It immediately displays progress through account verification
and the request, prevents repeated clicks, and displays success, still-pending or
error results. The extension message carries a validated optional boolean `force`
flag; older messages retain their existing behavior. This flag requests a fresh
pass through ordinary reconciliation, never an overwrite or an authorization
exception. Multiple explicit requests coalesce; an older in-flight upload finishes
before one new pass reads the latest local state.

An explicit selected-board pass does not wait for unrelated account-order work
or global deletion maintenance. The board's own erasure, account binding, snapshot
and signed-history checks remain mandatory. Its private-history inventory downloads
only that board's candidate files; account-wide discovery and image reference
checks still use the full inventory. Scheduled synchronization retains its existing
idle delay and retry behavior. A result with durable pending work is reported as
pending rather than synchronized.

Manual-sync validation: 828 root tests, 98 Android tests, both typechecks and both
managed browser build/package checks pass. All seven native recovery stages pass;
the same- and different-account Chromium scenarios include explicit manual sync
after a Drive outage. Google HTTP is simulated. Tests also cover a blocked unrelated
account-preference sync, clean/stale status, an older upload, duplicate clicks,
visible pending/failure feedback, scoped history downloads and erased-board
protection. Live Google and Firefox UI interaction were not exercised.
