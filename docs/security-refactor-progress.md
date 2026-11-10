# Authorization and storage refactor: implementation checklist

Last updated: 2026-11-09. **The refactor is incomplete; the opt-in Drive authorization relay is deployed for Firefox testing.** This file is a continuation record, not a release approval. Read it together with [security-refactor-audit.md](security-refactor-audit.md) and the user's architecture and deployment requirements in the conversation.

## Resume here

- Work in this checkout and branch, `feature/drive-first-collaboration`; the observed HEAD is `44fd45e479ebdce68922207b9580ab361fe9764e`. The refactor is in **uncommitted tracked and untracked files**. Inspect `git status`, branch and top level before work and preserve all pre-existing work. Do not switch worktrees or assume HEAD alone contains the changes.
- Read `DEVELOPMENT_STANDARDS.md` and verify the pinned standards with `python3 scripts/verify-standards.py /tmp/pboard-standards-rebase` (or a different verified checkout at the pinned revision). The previous verification succeeded.
- **Firefox runtime update:** the board operation-service realtime factory now selects the Drive-authorized v3 operation log for Firefox when the relay is configured. It uses a distinct Drive-folder room and cursor, and does not use the legacy board manifest or key courier. The synthetic multi-browser test exercises same-account and editor delivery, refusal, renewal revocation, reconnect, offline outbox and board switching. Real Google accounts and the deployed relay have not been tested. The old relay history is not migrated by this change. Review security and compatibility before enabling this experimental path in any real build.
- Integrate the corresponding browser and Android identity flows: existing `GoogleAuthProvider` supplies a Drive access token only. The verifier requires a Google ID token and an access token whose OpenID userinfo subject matches. Obtain them correctly for each platform and explicitly configure accepted OAuth audiences; do not trust an email or a client-provided role. Do not assume Google login currently supplies an ID token.
- Continue through the remaining checklist and deploy only once the new authorization, format boundary, migration and tests operate together. The user explicitly authorized coordinated deployment to the existing OVH relay, backup and restart, and accepts pre-alpha service interruption; that authorization does not make an incomplete protocol safe to deploy.

## Implementation status

- [x] Pinned standards and existing architecture audited. The current Drive operation snapshots and segments are structured, integrity-checked data; relay history contains separately encrypted rows which may not yet be covered by Drive.
- [x] Relay migration fence in `sync_log.rs`: schema version 4, atomic sequence capture, rejection of new writes, duplicate acknowledgment, preservation of fenced rows from pruning, restart persistence and generation-bound cancellation. `sync_api.rs` has begin/cancel actions using the **legacy manifest-based** owner role. This is not the requested Google/Drive authorization or a format cutover.
- [x] Legacy room role plumbing restricts manifest-backed editor consolidation; role-less operator grants retain legacy behavior. This part was deployed on 2026-11-08, but it does not remove device authority.
- [x] Client operation-log methods send fence/cancel and page legacy history through the existing socket, without advancing the normal replay cursor. Strict recovery, a versioned plaintext codec, snapshot preparation/readback checks and a fenced preparation coordinator exist. They are not connected to the normal board-open path or a final migration transaction.
- [x] `LocalOperationStore.legacyMigrationJournal` reserves a generation and stores an immutable intent in IndexedDB; tests cover concurrent reservations and restart. It has not yet been wired to a real Drive/relay migration adapter.
- [x] Firefox OAuth requests OpenID with Drive and exposes a paired ID token and access token; refresh obtains both together and never reuses an earlier ID token. Existing authorizations may need reconnection for OpenID consent. Android implements the same pair (`apps/android/src/sync/auth.ts`). **Chromium remains unimplemented**: `src/sync/googleChromeAuth.ts` exposes only `getAccessToken`, so the side panel supplies no Drive identity and therefore opens no live room (see `docs/collaboration.md`, gap 1).
- [x] The shared v3 session schedules bounded Drive grant renewal, updates room roles, and detaches a room on renewal failure. Firefox selects Drive admission in the real board runtime without resolving a manifest. This path does not migrate legacy relay history. The scheduler and cancellation are covered by fake-socket tests.
- [x] Local v3 relay authentication reports the initial room role. Google grant renewal updates the primary RTC signaling roster expiry to match the renewed grant, including a shorter expiry; tested for both extension and shortening. This does not yet authorize RTC data channels or disconnect existing peer channels on revocation.
- [x] The isolated `googleDriveAdmission.ts` client sends credentials and the socket binding to the relay, rejects insecure remote URLs and redirects, and validates the bounded ticket response. It is wired into the Firefox board runtime and its OpenID credentials. A synthetic Google HTTP-to-WebSocket test covers subject mismatch and role downgrade.
- [x] `google_identity.rs` contains local RS256 ID-token signature/claim validation and `GoogleDriveVerifier`, which fetches Google's JWKS, matches the delegated token's userinfo subject, checks Drive folder metadata/capabilities and derives a room including the folder ID. The opt-in local `/drive/admit` endpoint issues bounded, one-use challenge/session/room-bound tickets; version-3 sockets can consume those without a device manifest, refuse attachments for a different Google subject, and renew role/expiry in place with `renewGoogle`. Admission expires after at most 120 seconds unless a new Google/Drive check succeeds. `PBOARD_SIGNALING_GOOGLE_AUDIENCES` configures the opt-in verifier. The opt-in relay and Firefox audience were deployed on 2026-11-09, and the Firefox board runtime selects this path; the legacy authorization path remains active for older clients. It needs threat review and end-to-end tests, including the full HTTP-to-socket flow, real OAuth audiences, key rotation, inherited permissions, trusted folder binding, caching and revocation.

## Required work remaining

- [ ] Complete Google Identity authentication and delegated Drive verification on the relay, including secure one-use session binding, actual Drive-folder identity verification, effective owner/editor/viewer capabilities, bounded cache and explicit fail-closed revalidation/revocation. Never log or persist access tokens unnecessarily; do not use email as the immutable user ID.
- [ ] Wire Firefox, Chromium and Android credentials and one multiplexed WebSocket session to the new relay authorization. Same-user and invited-user access must not depend on an owner browser, a signed device manifest, key enrollment or an authoritative peer. Replace the account-room discovery mechanism without relying on appDataFolder.
- [ ] Define and implement a durable storage/protocol version and server-enforced cutover. New clients must use plaintext operation envelopes with validation; old clients must be refused safely and retain their outboxes. Ensure an old reader cannot silently skip plaintext rows and advance its cursor. Confirm fence generation, exact watermark, checkpoint and verified durable readback atomically at completion; cancellation must never undo a completed cutover.
- [ ] Wire the migration preparation coordinator, IndexedDB journal, strict replay, legacy key lookup and immutable Drive snapshot publication/readback into the actual board runtime. Handle empty history, pruned history, unavailable/wrong key, invalid ciphertext, retries, interrupted uploads, concurrent attempts, offline local edits and unknown operations without data loss. Keep legacy key material and encrypted data until independently verified coverage and recovery are proven. Never create replacement keys for existing encrypted history.
- [ ] Remove obsolete device authority, enrollment and encryption from the active new path; retain only legacy recovery until it is safe to retire. Preserve Drive ACL sharing, owner-only compaction and gardening, owner tombstone/Trash deletion, editor leave semantics, local RxDB and operation convergence.
- [ ] Complete required unit, integration, migration, cross-browser, Android, permission-change, revocation, role, replay and single-WebSocket tests; measure Drive request rate and relevant performance. Run the complete applicable suites after integration, not only component tests.
- [ ] Update Pboard documentation and `../vps-maint` where needed. Inspect that repository's status and instructions before changing it; preserve unrelated services and user work.
- [ ] Before OVH activation, inspect current binary, database schema and configuration; create timestamped matching database, executable and configuration backups; validate restore on copies; and document rollback. Schema 4 cannot be opened by the old schema-3 binary: restoring that binary requires restoring its matching database too, which loses relay events after the backup unless recovered from clients/Drive. Never discard Drive content or legacy keys.
- [ ] Deploy only the complete, validated coordinated server/client protocol, then test the real relay with specifically created test boards and authorized accounts. Verify health, WSS, logs without credentials/content, Firefox and Chrome, same-user sessions, a second authorized user, unauthorized/revoked access, owner offline, migration, replay, deletion and request/socket rates. Record binary/source hashes, tests and rollback evidence.

## Connected-recipient invitation notification — 2026-11-09

A successful Pboard Drive invitation now publishes an inbox hint from the
Drive-authorized board room. The connected recipient's Google account room
receives the hint on its existing v3 socket, retries Drive discovery while a
permission propagates, and imports only after Drive verifies access. The relay
retains hints for reconnect replay. The account inbox is addressed by a hash of
the primary email returned by Drive for the same token whose Google subject was
verified; account-room identity remains the verified subject. Hints are not
authority and no email or token is logged or retained by this routing change.

Synthetic real-server Google admission and inbox delivery/replay tests passed;
the Firefox runtime test verified a two-account invitation through the real
sharing API and a reconnect replay with one socket per session. Full relay tests,
Clippy, focused client tests, TypeScript checks and managed Firefox build/package
passed. Deployed relay SHA-256
`d328195e595ec1ddfc810c999fce315235798208d7f53188c1af3b81762585bc`;
the previous binary and database snapshot are in
`/var/backups/pboard-signaling/20261109-account-inbox/`. Live health and invalid
credential rejection passed. Real-account invitation delivery has not yet been
verified. Invitations created directly in Google Drive rather than Pboard still
rely on Drive discovery; an invite addressed to an alias rather than the primary
Drive email may not match the inbox key.

## Firefox board lifecycle and subscriptions — 2026-11-09

The Google account channel carries board creation and deletion to other sessions
of the same account. A Drive share discovered on one session is announced to
the other sessions of that account; the receiver verifies Drive access and
resolves shared-with-me before importing. Incoming tombstones are ignored for a
board the device never subscribed to, while a restore can update a previously
deleted subscription. An editor leaving synchronizes within the editor account
without deleting the owner's board. Synthetic runtime tests cover these cases,
including an owner deletion arriving at an editor with the board room open.

Pboard invitations now wake connected recipients as described above. A share
created directly in Drive still relies on discovery, and a subscribed editor
whose board room is closed does not yet receive an owner deletion over the
account room. Do not claim those cases are realtime.
The new Firefox build has been prepared; no server update was needed for this
client change.

## Firefox account room and board order — 2026-11-09

The legacy account room was disabled in the Drive-authorized Firefox path, so
sidebar board sorting did not propagate over WebSocket. The relay now admits a
separate account room using a Google ID token and matching delegated token;
the room is derived from the verified subject and shares the existing socket
with board rooms. Firefox uses that room without a device manifest or content
key, with a new isolated cursor/outbox namespace. The previous account room and
its stored data remain untouched. A synthetic two-browser runtime test verifies
board order propagation; the relay test verifies simultaneous account and board
admission on one connection, and mismatched credentials fail closed.

Full relay tests, Clippy, TypeScript checks, focused account/runtime tests, and
the managed Firefox build/package passed. Deployed relay SHA-256
`3516a3bbeaed3a1b273dcf44d708aef37afe18d9f15c9cb48345225a2c0ddd29`;
prior binary and database snapshot are in
`/var/backups/pboard-signaling/20261109-google-account-room/`. The live service
remained schema 4 and passed integrity and public invalid-credential checks.
Real Firefox account-room synchronization requires reloading the new build and
has not yet been verified.

## Relay fan-out repair — 2026-11-09

A live test showed Firefox A at sequence 26 and B at 18 for the same board ID and
Drive folder. The relay's four-frame outbound queue silently removed slow/full
subscribers without closing their sockets; one 18-operation batch could fill it
before the task drained. The relay now allows 64 queued frames and closes an
overflowed connection so the client replays from its cursor. A full relay test
run, Clippy, a two-WebSocket 18-operation burst and next-operation test, and
client session/realtime tests passed. Deployed SHA-256
`2ea8f08e184c9acb1d894dcd741c5df645a18ce413c92add2598054c7eed1ee5`;
previous schema-4-compatible binary and live database snapshot are retained at
`/var/backups/pboard-signaling/20261109-fanout-replay/`. Health and anonymous
admission checks passed; live browser convergence needs user confirmation. A
separate client fix now refuses to advance a replay cursor if a realtime
operation is interrupted before application; that client change is not deployed.

## Relay activation — 2026-11-09

The user explicitly requested the relay update and VPS inventory changes. Deployed binary SHA-256 `4fe765eb4876caf6ccae3d6a9d76a2df640c914e873e2a689cb0050d8e68406a`; HAProxy now allows `/drive/admit` and systemd configures the public Firefox OAuth audience. Schema upgraded from 3 to 4 with 671 operations before and after, and integrity passed. Matching prior binary, unit/drop-ins, proxy and pre-upgrade database are backed up under `/var/backups/pboard-signaling/20261109-drive-authority/`. Isolated schema upgrade and old-binary restore were tested. Public health returned 200, incomplete admission 422, invalid credentials 403, and anonymous v3 authentication was refused. Real Google-account admission, editor sharing and live synchronization remain untested. A schema-3 rollback requires restoring the matching database, and post-backup relay events must be preserved and recovered. See `../vps-maint/SERVICES.md` and `../vps-maint/OPERATIONS.md`.

## Validation actually performed

- Full relay tests passed after the RTC roster renewal change. After the subsequent v3 role-response change, the synthetic HTTP admission test, multiplex integration tests, and relay Clippy passed.
- Full relay `cargo test --locked --manifest-path services/pboard-signaling/Cargo.toml` and `cargo clippy --locked --manifest-path services/pboard-signaling/Cargo.toml --all-targets -- -D warnings` passed after the local opt-in admission and renewal changes. The tests include synthetic ID-token signature/claims, Google/Drive subject matching, one-use ticket binding, a manifest-free local WebSocket handshake, role downgrade on renewal and expiry detachment. A subsequent focused test covers synthetic Google HTTP admission through WebSocket authentication and renewal; these tests do not validate a real Google login or the browser client flow.
- Firefox runtime synthetic multi-browser coverage passed for same-user/editor live operations, unauthorized access, revocation, replay, offline outbox, owner-offline editing and one socket across board switches. Operation-session tests verify that an outbox larger than 512 operations drains after reconnection. Real OAuth and live relay execution remain untested.
- `npm run typecheck` passed using Node from `/home/ste2/.nvm/versions/node/v24.22.2/bin` on `PATH`.
- The focused Vitest run of local-store, migration preparation/window/recovery/snapshot, plaintext codec and log-sync tests passed (52 tests). These tests do not establish integrated migration or Google/Drive authorization.
- Live relay observation on 2026-11-09: service active, deployed binary SHA-256 `78f8b7b36b7366cb2fd8e962345802e899cad948c8a77f69724d9ea2245ef0d7`, database schema 3, integrity check passed. The user's new-board test exercised the old architecture. Live state may have changed since; re-inspect before deployment.

## Blockers and limits

There is **no known user-authorization blocker** for implementation or the specified coordinated deployment. Full implementation and verification are unfinished; an execution or context limit is not architectural completion. Real authenticated two-user/browser/Android smoke tests may require appropriate Google accounts, consent and installed clients; establish exactly what is unavailable when reaching that step rather than assuming their credentials or asking for secrets. The pre-upgrade schema-3 backup and isolated restore were tested; recovery of relay events written after that backup remains necessary for any rollback.


### Android v3 integration — work in progress

Android now requests a Credential Manager Google ID token for a configured web client and retains its native Drive access token. The bridge compares the selected identity to the pinned Drive account and rechecks the Drive account on authorization. The Android auth provider exposes the credential pair to the shared Drive-authorized v3 runtime. Foreground lifecycle starts sync; background closes board and account rooms and stops Android polling timers. This work requires a Google Web OAuth client ID accepted by the relay and remains unverified on a real Android device. Existing shared-runtime tests do not establish Android native token acquisition or end-to-end Android interoperability.

Validation: Android typecheck and 102 unit tests passed; the Android lifecycle integration test passed using the actual shared runtime with simulated Drive/relay. Shared v3 integration and log tests passed independently; one lifecycle/tombstone test timed out under concurrent build load and passed on an independent rerun. A debug APK compiled without a configured Web client ID, so it cannot authenticate until rebuilt with one accepted by the relay. No ADB device was attached. Native Credential Manager, actual relay audience configuration, account matching, process restart, background socket teardown, and real cross-account interoperability have not been verified on a device.

Android audience configuration: the public Google Web client ID is now the Android build default, and the relay was configured to accept it alongside its existing Firefox audience. A debug APK was installed on the Pixel 8a; actual Google sign-in and cross-device synchronization still require user verification.

Android WebView admission: the live HAProxy configuration now returns CORS preflight and response headers only for `https://localhost` on `/drive/admit`; the repository HAProxy fragment records the same rule. Untrusted origins receive no CORS grant. The prior HAProxy configuration is backed up at `/var/backups/pboard-signaling/20261109-android-cors/haproxy.cfg.previous`. Google Drive and identity tokens remain required. The account channel no longer displays the legacy authority report for Google Drive admission.

Android account admission: Google issued an ID token with the configured Web client as `aud` and the Android OAuth client as `azp`. The relay's existing verifier requires both values in its accepted client list, so the Android OAuth client was added to the deployment's existing audience list. A live account admission probe using the connected Android session returned HTTP 200; a complete board synchronization test remains outstanding.

Android Home lifecycle: fixed a case where foreground reconciliation with no selected board called the collaboration stop method and released the shared account socket. The Android lifecycle test and shared-runtime integration test pass; a debug update was installed on the Pixel. Initial discovery and full board import on the user's account still need confirmation.

Board discovery across Android and Firefox: locally created boards now trigger their initial Drive publication promptly, so the account-room announcement can be verified without waiting for the edit batching interval. A forced reconnect also publishes unbound local boards. Android resumes account discovery independently on foreground, and closing a board no longer tears down a live Drive-authorized account room. Automated shared-runtime tests cover bidirectional creation without manual sync and leaving a board with the account room still connected; Android lifecycle tests cover foreground restart and creation. Physical-device verification remains pending.
