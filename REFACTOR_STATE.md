# Pboard refactor status

Reviewed against the repository on 6 November 2026; `VERSION` is `0.11.0`. This is a short status and handoff
document: what the current refactor changed, and what is still missing. Architecture detail lives in
[docs/architecture/](docs/architecture/) rather than being repeated here — in particular
[websocket-operation-log.md](docs/architecture/websocket-operation-log.md), which also carries the authoritative
"Known gaps at this revision" list.

At the time of this review the work described here was uncommitted in this tree and the relay build had never run on
a host.

## What changed

- **The live transport is an authenticated WebSocket to the relay, not WebRTC peer pools.** The extension's
  composition root calls `setWebRtcDisabled(true)` (`src/sync/browser.ts:17`), so no peer pool, DataChannel, peer
  history session or Drive signaling poll starts in the browser extension. Android builds the same
  and so does Android (`apps/android/src/sync/service.ts:15`), so no shipped platform runs the peer path.
  The peer stack is now excluded from extension bundles by a build-time stub: every peer import goes through
  `src/collab/peerRuntime.ts`, which `peerRuntimeStub()` (`scripts/peer-runtime-stub.mjs`) resolves to
  `peerRuntime.stub.ts` for the sidebar and background builds. The stub throws rather than returning empty values.
- **One socket per browser context.** Protocol v3 multiplexes rooms on a single connection: `attach`/`detach`,
  per-room role, per-room revocation that detaches only that room, refusals that never close the socket, and at most
  32 rooms per connection. Switching boards is attach/detach — no reconnect, no re-authentication, no new socket.
  The account channel is **one more room on that same socket**, not a second socket: the session registry is keyed
  by relay URL alone (`src/sync/operations/logSession.ts:880`), with the account room attached under the account
  device key and each board room under its own `board-device:<board>` key. A second socket exists only in the v2
  fallback (one socket per room, when the relay does not advertise version 3) or transiently during a key-courier
  exchange.
- **The relay stores a durable operation log.** `services/pboard-signaling` keeps unconsolidated operations in
  SQLite (WAL, `synchronous=FULL`), ordered per board, with a lease and a typed publication receipt for the snapshot
  the operations came from. Payloads are sealed client-side with the board's content key before they reach it; the
  relay stores and replays an opaque string. Drive keeps snapshots, images and the Drive ACL — which remains the
  membership authority.
- **Retention runs.** Schema version 3 added a `coverage` table and an hourly sweep in `services/pboard-signaling/src/main.rs` (≤16 boards and
  ≤20,000 rows per board per pass, on the blocking pool). Only operations behind a validated publication receipt are
  prunable, and only after the seven-day window. Before this, `SyncLog::prune` had no production caller, so a board
  that reached its cap stayed `log_full` permanently.
- **Byte accounting is per window, not per lifetime.** The 4 MiB lifetime socket total is replaced by 4 MiB per
  rolling 60 s per connection plus 2 MiB per rolling 60 s per attached room. `PBOARD_SIGNALING_MAX_SESSION_BYTES` is
  retired and ignored.
- **A per-account hint inbox exists server-side.** `services/pboard-signaling/src/account_inbox.rs` holds bounded, sealed hints addressed by
  account hash (SHA-256 of the lowercased verified email): 4 KiB × 64 per inbox, seven-day TTL, eviction rather than
  refusal at the 1024-inbox cap. Its three tables are additive and do not raise the shared schema version. **The
  client half is wired** — `sharePermissions.invite` publishes into it and the
  account channel replays it — but it carries a hint that buys a Drive read, not
  cross-account board traffic.
- **Local storage is RxDB/Dexie.** Projects and cards are at schema version 1 (v0 → v1 added optional `_sec`
  mutation provenance), settings at version 0; the legacy `browser.storage.local` repository remains for migration,
  fallback and rollback. See [rxdb-storage-refactor.md](docs/rxdb-storage-refactor.md).
- **`--check-config` is a true dry run.** It validates the environment and the filesystems it needs and never opens,
  creates or migrates the database. It previously ran after the `App` was built, so a pre-flight check was an
  activation — and against a production directory that left a schema the deployed binary could not read. `--help`
  exists; exit codes are 0/1/2.

## What remains

These are gaps, not plans. Nothing in this repository should be read as promising them.

1. **The account and board rooms are a Firefox-and-Android path.** They need an auth provider that supplies paired
   Google ID/access credentials. Firefox and Android do; the Chromium provider (`src/sync/googleChromeAuth.ts`)
   supplies only a Drive access token, so a Chromium board opens no live channel and converges through Drive
   synchronization and polling. The `account:<hash>` pin that used to gate this survives only on the retained
   signed-authority tooling, whose sole pin creator is the unmounted `ExperimentalEnrollment.tsx`.
2. **The inbox carries an invitation, not board traffic.** `sharePermissions.invite` publishes a hint into the
   invitee's account inbox and the account channel replays it, so an invited browser need not wait for a Drive poll;
   the shared board's own operations still reach that account only through Drive synchronization.
3. **"Sync now" reconciles only boards already known**; it does not rediscover, so it cannot find a board this client
   has never heard of.
4. **Edits to a board this context does not have open are not delivered passively.** The attach set is exactly one
   board (deliberate: it stopped a socket leak). Delivery happens by reopening (relay replay) or by the Drive poll.
5. **Grant renewals cut live rooms on the signed path only.** The revocation watch compares manifest digests and a
   renewal changes the digest, so there every renewal looks like a revocation: `reason="authorization_changed"` about
   every three minutes per room (300 s lifetime, 120 s renew window). The Drive-authorized rooms Firefox and Android
   open renew in place with `renewGoogle` and never detach.
6. **A board open costs ~13 s in a two-browser scenario**, about two-thirds of it budget pacing: one open issues
   ~15 identity exchanges (≈30 tokens at 2.5/s), doubled when a grant change forces a re-attach.
7. **Add/delete are not atomic in the UI**: the entity is published on creation, so a peer renders an empty card and
   fills it as keystrokes arrive.
8. **`projectOrder` (board sorting) is not realtime** — it is a Drive file applied during reconcile.
9. **Grants live only in service memory.** A restart drops every published grant, and an expired grant returns 404
   indistinguishable from never-published (the client now labels `expired` against `never-published`). The grant
   lifetime is capped at 360 s by the protocol (`services/pboard-signaling/src/admission.rs`), so an owner-chosen
   15 minutes needs a coordinated client and server change.
10. **The extension sidebar chunk is 637 kB** against the owner's 600 kB advisory. The advisory fires on every build
    and is not raised; see [BUILD.md](BUILD.md).
11. **Deployment is unexercised.** The relay build is tested in this repository only. Activating it migrates the
    operation log to schema version 3, after which the currently deployed binary cannot open the file — so the
    rollback artifact is a v3-aware binary, or the archived database plus the old binary. See
    [relay service releases](RELEASE.md#relay-service-releases).
12. **Real-account and real-device validation remains manual.** Authenticated Drive discovery, invitation and
    revocation flows, and Firefox/Android lifecycle paths have not been exercised against Google's real behaviour by
    this refactor.

## Measured at this revision

Client: `tsc` clean; full suite 1 870 tests / 257 files, including the 172 two-browser tests under
`tests/multiBrowser/` and the 106 Android checks; `npm run build:all` with zero errors. Relay: 169 tests,
`cargo clippy --all-targets` with zero warnings. These are measurements of this working tree on 10 November 2026
and are not a release gate.

## Documenting this

The 12 October review removed duplicated phase lists, contradictory test totals and old checkpoint notes from this
handoff. The earlier [storage evaluation](docs/archive/collaboration-storage-evaluation.md) is retained as historical
research, and [collaboration.md](docs/collaboration.md) carries the operational detail this page only summarises.
When behaviour changes, update the architecture record and the gap list there first; a status page that lists a fixed
defect as open is a second source of truth, which is how the previous version of this file went stale.
