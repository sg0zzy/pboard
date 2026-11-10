# Drive snapshots, OVH operation log, WebSocket transport

2 November 2026, revised 6 November 2026. This is the document that owns the
transport protocol. Since the first draft the client transport, Drive
consolidation and the key courier were implemented, the protocol grew a
multiplexed version 3, and retention, publication evidence and a server-side
account inbox were added. The design narrative below is kept as history; **the
current protocol is described in ["State at this revision"](#state-at-this-revision-6-november-2026),
and `services/pboard-signaling/PROTOCOL.md` remains the wire reference.**

Deployment status, stated plainly: the service is deployed with the operation log
enabled and the host reports it active, but **nothing in this tree is committed
and the 6 November work is not deployed** — multiplexing, per-room byte
accounting, the retention sweep as described here, the account inbox and
attach-time device keys all run only under the test harness. Rollout order and
why it is fixed are in [Rollout order](#rollout-order-server-first).

## State at this revision (6 November 2026)

Wire truth lives in [`PROTOCOL.md`](../../services/pboard-signaling/PROTOCOL.md)
("Sync v3", "Protocol 3", "The per-account hint inbox", "`--check-config` is a dry
run"). This section is the architecture-level summary and its citations; where the
two disagree, `PROTOCOL.md` and the code win.

### One socket per browser context, many rooms

**One socket carries every room, including the account room.** One WebSocket per
browser context per relay URL, regardless of board count: one board is one socket,
twenty boards are one socket. `logSession.ts` owns that socket; each board is a
*room attached to it*, and `logSync.ts` is the per-room handle that picks a mode.
Board switching is `detach(old)` + `attach(new)` on the connection that is already
up — **no dial, no re-authentication, zero new sockets** (`logSession.ts` header and
`attach`/`detach`; measured at the relay in
`tests/multiBrowser/singleSocket.test.ts`, which asserts the relay's own socket
list, not a client self-report).

The account channel is **one more room on the same socket**, opened under the
account device key while boards use their own `board-device:<board>` keys — which
is exactly why the session registry is keyed by relay URL alone rather than by
URL plus device key (`logSession.ts:880`). A second socket appears only in the
**v2 fallback** (one socket per room, when the relay does not advertise version 3)
and transiently while a key-courier exchange is in flight. The account room is still inert in
production, but for an unrelated reason: it needs an `account:<hash>` pin that only
an unmounted panel creates (see [Known gaps](#known-gaps-at-this-revision)).

Two limits shape the multiplexing claim, and both are deliberate:

- **The attach set is one board.** A context attaches the board it displays.
  `tests/multiBrowser/attachSetBound.test.ts` pins the bound at 1 and asserts that
  a reconcile round which merely *lists* other boards attaches none of them
  (`healRelay` answers `idle:not-attached`). The earlier behaviour — a room per
  listed board — is what leaked sockets.
- **32 rooms per connection** is a fan-out cap, not an authorization cap
  (`services/pboard-signaling/src/sync_api.rs:755`, `rooms_per_connection`). Every room still passes its own
  admission, and the attach path draws on the same automatic-auth budget as
  `authenticate`, so an authenticated socket cannot become an unthrottled verifier.

The account channel is the same socket's other room (above), not a second
connection. What blocks it in production is the missing pin, not the transport —
see [Known gaps](#known-gaps-at-this-revision).

### v3 attach/detach, and what each frame is authorized by

`welcome` carries `version: 1` (the envelope version, unchanged since v1) and a
`supportedVersions` list; `[1,2,3]` is what enables multiplexing. A client that
finds 3 negotiates `"version": 3` on `authenticate` and the server echoes the
negotiated version on `authenticated`.

- `authenticate` opens the **first** room and is the only frame that writes the
  connection's device.
- `attach {room, deviceKeyId?, signature, authorization, serviceAdmission?}` opens
  every further room **with its own complete authorization**: the signed manifest
  proof, the device signature over
  `["pboard-ws-auth-v2", challenge, session, room, deviceKeyId, digest]`, and — when
  `requiresServiceAdmission` — a Google service receipt consumed for that exact
  `(challenge, session, room, device)` tuple. There is no "trust the connection"
  shortcut.
- `detach {room}` closes one room; `detached {room, code?}` is its answer, and also
  the server's own announcement when a room ends for a reason (see revocation).
- `attach` is **idempotent**: attaching a held room answers `attached` with that
  room's role and does not double-subscribe. `detach` of a room that is not
  attached answers `detached` with `code: "not_attached"`, so a client retrying
  after a lost reply is not punished.
- Refusals are `refused {code, room?}` and **never close the socket**. A refusal
  for one room leaves every other attached room, the socket and its cursors
  untouched — the property that makes holding many boards on one connection safe.
  The deployed alternative (close the connection) turns one bad board into a full
  outage for that tab.

**`deviceKeyId` on `attach`** is what makes multiplexing reachable at all. A device
is a *per-board* identity in the manifest model (`board-device:<board>`), so a
second board on one socket signs with a different key than the connection
authenticated with. Before the field existed the relay could only verify an
attachment against the connection's device and answered `service_auth_required`.
The field is optional — absent means the connection's own device, byte-for-byte
today's frame — and it is strictly bounded (base64url and `-`/`_`, at most 200
bytes). The server verifies the signature against the named key, requires that key
to appear in the room's signed manifest, and then runs the unchanged
`admit_room` checks (owner presence, epoch, expiry, digest, scope). Possession and
authorization are both required and neither implies the other: naming a device is
not becoming one. Attribution follows the **attachment**, so `submit`, `lease`,
`release`, `commit`, `publishDeviceKey`, `publishKeyGrants`, `fetchKeyGrants` and
`publishAccountHint` all record the room's verified device as `actorId` — a
multiplexed socket cannot launder three devices' writes into one identity
(`services/pboard-signaling/src/lib.rs:1065`, `services/pboard-signaling/tests/attach_device.rs`).

### A receipt belongs to one attach

`serviceAdmission` is **single-use**. The service deletes a receipt the moment it
consumes one (`services/pboard-signaling/src/identity_enrollment.rs` `consume`), and the binding it checks is
`(challenge, session, room, device)` — the connection's welcome, this attach's
room, and the device this attach presents. So the v3 `attach` frame must carry a
receipt minted for *itself*, exactly as `authenticate` does, and the client mints
one per frame through the same `admitService` call the private path uses.

The client once cached receipts for a minute per binding. That is safe only for
two *concurrent* callers of one binding; handing a settled receipt to a later
attach presents one the relay already consumed, and the answer is
`service_auth_required` — terminal by the list in `logPolicy.ts`. A board
switched away and back on one socket therefore went to `error#18`
(`detached:service_auth_required`) permanently while its sibling stayed `synced`.
The cache now holds only in-flight pairs and is dropped when they settle.

Failures are scoped the way the frame is: a receipt that cannot be obtained is
that room's stated cause (`service_auth_required` when terminal,
`attach:service_admission` while retrying) and never rebuilds the connection,
because re-dialling cannot mint a credential faster than the budget allows and
would cost every sibling its socket. The room retries on its own backoff,
through the same budget and 429 pause; a welcome with
`requiresServiceAdmission: false` mints nothing.

### Roles are per room

The v2 connection carried one `writer` flag because it held one room; a
multiplexed connection cannot. The role is resolved per attachment from that
room's manifest and consulted per frame: `submit`, `lease` and `commit` are
refused `read_only` in a viewer room and accepted in an editor room, on the same
connection, in either order. The courier actions are gated by admission rather
than by write role, because a courier frame mutates no operation log — refusing
one would deny a device the board's content key without protecting anything.

### Revocation and expiry are per room

`services/pboard-signaling/src/admission.rs` publishes a revocation watch per authorization scope. A scope change
— epoch bump, republished manifest, pruned grant — ends **only the rooms whose
scope moved**:

```json
{"type":"detached","room":"…","code":"authorization_changed"}
```

Per-room proof expiry is scoped the same way (`grant_expired`). The connection,
its other rooms and their cursors survive. For v1/v2 the same event still closes
the connection, because for those versions the connection *is* the room; the
asymmetry is deliberate. A per-room detach is not a `refused` — it is something
that happened to the room, not an answer to a request.

**This is also the mechanism behind a real defect.** Grant renewal bumps the
manifest epoch, and the watch compares manifest digests, so every renewal looks
like a revocation: the journal shows `reason="authorization_changed"` roughly every
three minutes per room (300 s grant lifetime, 120 s renew window:
`boardGrants.ts:50-51`). Each such cut tears down and rebuilds the room, which is
part of why an open costs ~13 s in a two-browser scenario. See
[Known gaps](#known-gaps-at-this-revision).

### Byte accounting

`Limits::session_bytes` was a **lifetime** total that never reset: one socket died
permanently at 4 MiB. Correct for a socket reopened on every board switch, fatal
for the long-lived socket v3 asks a client to hold. It is replaced by rolling
windows, renewed rather than accumulated (`services/pboard-signaling/src/lib.rs:175-181`):

| Budget | Default | Renews | Scope |
| --- | --- | --- | --- |
| `bytes_per_window` | 4 MiB | every 60 s | the whole connection |
| `room_bytes_per_window` | 2 MiB | every 60 s | per attached room |
| `bytes_per_second` | 128 KiB | every second | burst ceiling |
| `global_bytes_per_second` | 2 MiB | every second | whole service |

4 MiB per 60 s is ≈ 68 KiB/s sustained, above a board under active editing. The
per-room share means one busy board exhausts *its own* budget instead of starving
its siblings: in v3 that detaches the room (`{"type":"detached","code":"budget"}`,
`services/pboard-signaling/src/lib.rs:1011-1012`) and in v1/v2 it remains `traffic_limit` followed by a close.
Operator knobs are `PBOARD_SIGNALING_MAX_SESSION_WINDOW_BYTES` and
`PBOARD_SIGNALING_MAX_ROOM_WINDOW_BYTES` (`services/pboard-signaling/src/policy.rs:34-35`);
`PBOARD_SIGNALING_MAX_SESSION_BYTES` is **retired** — no code reads it and it is
ignored if it survives in an environment file, because a drop-in silently keeping a
4 MiB *lifetime* cap is the bug being fixed.

### Replay, gaps and cursors

`subscribe {board, afterSeq}` answers `window` with operations ascending,
`liveFromSeq`, `checkpointSeq` and `synced`, or `snapshotRequired` when the
requested point predates the log. `gap.reason` is:

- `snapshot_required` (with `checkpointSeq`, `checkpointEpoch`, `snapshotSeq`) —
  the operations the client needed were pruned because a published snapshot covers
  them; and
- `history_unavailable` (with `oldestRetainedSeq`) — the log simply does not go
  back that far.

A short list is never offered in place of a gap. On the client, `logRoom.ts` holds
per-room state (cursor, `appliedSeq`, unacked queue, phase, error) and **advances
the cursor only over contiguous sequences**: an out-of-order or duplicate row waits
in a durable set until the hole is filled, an acknowledged sequence with a hole
below it triggers a re-subscribe, and an operation the engine rejects keeps the
cursor below it so it is seen again on reconnect. Replay is 512 rows per frame
(`services/pboard-signaling/src/sync_api.rs:751`).

Recovery from a pruned history is automatic: the runtime treats a gap as "read the
board from Drive, then resume above the committed checkpoint"
(`runtime.ts` gap handler → `session.sync` + `log.resumeFrom(checkpoint)`), pinned
by `adopts a checkpoint and resumes above it when the log pruned the history`. A
consolidated board therefore does not stick in a "needs a snapshot" state.

### Retention sweep and publication-receipt evidence

`commit` takes `driveEtag`, which is a **publication receipt** — the Drive file id
of the immutable snapshot the writer says it uploaded — and never an entity tag.
The name is kept for wire compatibility. The relay holds no Drive credential and
**cannot** verify the upload; the protocol says so rather than implying otherwise.
What the service does enforce at the commit boundary
(`services/pboard-signaling/src/sync_log.rs:228-245`): evidence present, ≤256 bytes, `[A-Za-z0-9_-]` with at
least 4 bytes, and `snapshotSeq` non-zero; each failure is `evidence_rejected` and
**writes nothing** — no checkpoint row, no coverage row. Shape is not provenance, so
the checkpoint row also carries `evidence_kind`, written to `1` only by this commit
path (`services/pboard-signaling/src/sync_log.rs:868-870`); a row from before schema v3 keeps `0` and is never a
pruning licence.

The sweeper runs in the service process, not on a client request: one pass per
hour, ≤16 boards, ≤20 000 rows per board (`services/pboard-signaling/src/sync_log.rs:341-344`, started by
`services/pboard-signaling/src/main.rs:704`, journal line `operation log retention sweep started`). Its guarantee
is the conjunction of two server-side conditions:

1. a checkpoint row this build wrote (`evidence_kind = 1`) whose stored evidence
   still parses as a receipt; and
2. the covering segment was published more than `retention_ms` (7 days) ago —
   coverage is recorded per committed prefix with the time that prefix was first
   committed, so the window ages out per segment rather than refreshing one anchor
   forever.

The cutoff is `MAX(upto_seq) FROM coverage WHERE covered_at <= now - retention_ms`
and `eligible = seq <= min(cutoff, board.checkpoint_seq)` (`services/pboard-signaling/src/sync_log.rs:949-950`,
`:1024-1037`). The `checkpoint_seq` term is the hard barrier answering "can this
delete un-snapshotted data": **no** — a row older than the whole window but above
the checkpoint is kept, because the log holds its only copy. Coverage rows for
deleted prefixes are retired in the same pass (`:1079`). Pruning is idempotent and
optional: if the sweeper never runs, nothing becomes incorrect; the log simply
keeps more until capacity refuses a write.

**The account room has no committer.** `account:<hash>` rooms carry lifecycle
records and never consolidate — no session takes a lease there and no Drive folder
corresponds to the room — so retention for such a room is zero and it grows until
its per-board cap refuses appends. Enabling retention there requires a committer,
which is a product decision, not a code change.

### The per-account inbox: server-side only

Cross-account discovery had two structural blockers: an `account:<hash>` room is
writable only by that account's own manifest, and the relay discards the verified
email once the service ticket is consumed, so it cannot enumerate another
account's sessions. The missing primitive is a durable, bounded store addressed by
**account hash** (SHA-256 of the lowercased verified email, lowercase hex — the
same value the account-room scope already uses):

- `publishAccountHint {board, to, hintId, payload}` — written by a connection
  holding a verified board room; the board id is taken from that room's manifest,
  never from the frame, and an `account:` id is refused at the storage boundary
  too. A viewer seat is refused `read_only`.
- `replayAccountHints {board: "account:<hash>", afterSeq}` — readable only from
  the caller's own verified account room. There is deliberately no target field on
  the read path, so "read somebody else's inbox" has no wire shape in which to be
  expressed.

Bounds (`services/pboard-signaling/src/account_inbox.rs:101-124`): payload 4 KiB decoded, 64 hints per inbox,
1024 inboxes service-wide, 7-day TTL. Over capacity the answer is **eviction, never
refusal** — refusal at the cap would let any device holding any board deny
share-notification delivery to every future account. Lost hints degrade to Drive
polling. Hints live in the operation log's SQLite file with the same WAL /
`synchronous = FULL`, so a restart preserves undelivered hints.

**The client half is wired, both directions.** `sharePermissions.invite` publishes
one `publishAccountHint` frame addressed to the invitee's account hash
(`src/sync/runtime.ts`), and the account channel replays its own inbox on every
`synced` edge (`replayAccountHints`, `src/sync/operations/accountChannel.ts`) and
hands each hint to the create-free Drive verification path. Lost hints degrade to
Drive polling rather than failing the invitation.
`tests/multiBrowser/driveAuthorityRuntime.test.ts` covers delivery to an
already-connected invitee, non-delivery to an outsider, and replay after the
recipient reconnects.

What the hint buys is a Drive read, not board traffic: the shared board's own
operations never cross accounts, so its later changes reach the other account
through Drive synchronization.

### Rollout order: server first

The order is fixed by what a *rollback* does, not by preference:

- **v3 server, v2 client** — works, unchanged: same frames, same codes, an unknown
  frame is still fatal, `board_mismatch` still refuses a foreign board.
- **v2 server, v3 client** — the client's `authenticate` with `version: 3` is
  refused `version_unsupported` and the socket closes; `attach` never gets a
  chance to run, because in v2 an unknown frame closes the socket.
- **v3 client, v3 server** — attach/detach, per-room role and revocation, windowed
  byte budget.

So the server ships first and a client must negotiate v3 **by capability**
(`supportedVersions` on the welcome), never by assumption. Rolling the server back
only breaks clients that already speak v3, which is why the client cutover is
gated on verifying a v3 server in front of it. The same reasoning applies again at
the storage layer: schema v3 is additive, but a build that predates it refuses the
file outright, so the rollback target must be a build that already understands
schema v3 — ship the v3-aware binary one release before turning retention on.

The client keeps a **v2 fallback** for a relay that does not offer 3: it probes the
welcome once per context and, when `supportedVersions` lacks 3, opens one socket
per room byte-compatibly with the deployed server (`logSync.ts` probe →
`openPrivateRoom`). That path is deliberate compatibility, and a real regression
risk if a v3 server is rolled back.

### Known gaps at this revision

These are gaps, not plans. A sentence elsewhere in this repository that promises
any of them is wrong.

1. **The account channel is a Firefox-and-Android path.** A Drive-authorized room
   needs the auth provider to supply paired Google ID/access credentials. Firefox
   (`src/sync/googleAuth.ts`) and Android (`apps/android/src/sync/auth.ts`) do; the
   Chromium provider (`src/sync/googleChromeAuth.ts`) supplies only a Drive access
   token, so a Chromium board opens no account room and no board room, and a newly
   created board reaches another browser only after the Drive publication flush
   (25–30 min) plus a poll — or a reload. The `account:<hash>` pin the channel used
   to need survives only on the retained signed-authority tooling, where its sole
   creator is the unmounted `ExperimentalEnrollment.tsx`.
2. **"Sync now" reconciles only boards already known**; it does not rediscover, so
   it cannot find a board the client has never heard of.
3. **Edits to a board this context does not have open are not delivered
   passively** — the attach set is exactly one board (see above). Delivery happens
   by reopening (relay replay) or by the Drive poll.
4. **Grant renewals cut live sockets on the signed path only**
   (`authorization_changed` every ~3 min per room there), doubling re-attach cost;
   a board open on that path costs ~13 s in a two-browser scenario, about two-thirds
   of it budget pacing (~15 identity exchanges ≈ 30 tokens at 2.5/s). A
   Drive-authorized room renews in place with `renewGoogle` and pays neither.
5. **Add/delete are not atomic in the UI**: the entity is published on creation, so
   a peer renders an empty card and fills it as keystrokes arrive.
6. **`projectOrder` (board sorting) is realtime through the account room** — a
   settling reorder publishes one `board.order` record (ordered ids plus the
   preference document's clock), and a receiver merges it into the list it
   holds without importing or resurrecting a board and without publishing a
   record back. The Drive preference file remains the durable copy, so a device
   that cannot join the account room still converges at the next reconcile.
7. **Grants live only in service memory**: a restart drops every published grant,
   and an expired grant returns 404 indistinguishable from never-published (the
   client now labels `expired` vs `never-published`). Grant lifetime is capped at
   360 s by the protocol (`services/pboard-signaling/src/admission.rs:113`), so an owner-chosen 15 minutes needs
   a coordinated client+server change.
8. **The inbox carries a hint, not board traffic** (above), so cross-account discovery is
   still Drive polling.
9. **The extension sidebar chunk is 637 kB** against a 600 kB advisory.

## Why the architecture changes

The following three sections record the 2 November design argument. They still
explain *why* Drive stopped being the real-time transport; the transport itself is
described above.

Collaboration today has two real-time transports and neither one is the
synchronisation layer it appears to be:

- **WebRTC data channels** deliver operations peer-to-peer. They need presence to
  discover peers, ICE to reach them, and both browsers to be online at the same
  moment. Two browsers of one account have never completed ICE in this project's
  own testing; the failure mode is a healthy-looking room with `connected 0`.
- **Google Drive as the operation log** makes every operation a file write and
  every peer a poll. It has produced `403 rateLimitExceeded` on ordinary editing,
  and — because a Drive listing keeps naming files the account cannot serve —
  streams of 404s and polls that stop applying anything (see
  [collaboration.md](../collaboration.md)).

Both problems are the same mistake: Drive is a good store for things that are
large, immutable and shareable, and a bad one for a high-frequency append log.
The transport that replaces them is a plain authenticated WebSocket connection to
the existing Pboard service, which already verifies Google identity and board
grants.

## Target layers

| Layer | Store | Holds | Never holds |
| --- | --- | --- | --- |
| A — consolidated state | Google Drive | Immutable board snapshots, checkpoint metadata, images and future attachments, sharing ACLs | Operations in flight, presence, locks |
| B — unconsolidated operations | OVH `pboard-signaling` (SQLite/WAL) | Per-board operation log, server sequences, checkpoints, consolidation leases and fencing epochs | Operation semantics, binaries, board structure |
| C — local state | RxDB (IndexedDB) + blob store | Board state, pending local operations, last applied sequence, last known checkpoint, cached and pending assets | Trust decisions the server has not verified |

Drive stops being the real-time transport. The WebSocket log stops being
semantically empty-but-useless by carrying opaque operations; it stays ignorant
of what a card is, and enforces only identity, permission, order and durability.

## Components

| Component | Disposition |
| --- | --- |
| `services/pboard-signaling/src/sync_log.rs` | **New.** Durable SQLite operation log: per-board sequences, dedupe, replay windows, checkpoints, leases, pruning. |
| `services/pboard-signaling/src/sync_api.rs` | **New.** WebSocket request/reply protocol on the already-admitted connection. |
| `src/sync/operations/logSync.ts` | **New.** Client transport: bootstrap from a persisted cursor, live application, sealed payloads, per-batch acknowledgment, resubmission, lease and commit. |
| `src/sync/operations/logConsolidation.ts` | **New.** One consolidation cycle: the order and failure semantics of lease → catch up → build → upload → commit, testable without Drive or timers. |
| `src/sync/logConsolidationRuntime.ts` | **New.** The same cycle wired to a board's session, Drive folder, log connection and storage, plus the owner-only policy. |
| `services/pboard-signaling/src/leader.rs` | **Retained.** In-memory lease arbiter for the legacy HTTP buffer; the SQLite lease supersedes it for the new path. |
| `services/pboard-signaling/src/op_buffer.rs`, `services/pboard-signaling/src/buffer_api.rs` | **Legacy.** Kept for clients in the field; retired once no client calls them. |
| `src/collab/manager.ts`, `webrtcHandler.ts`, `signaling.ts`, `experimentalWebSocketSignaling.ts`, `signalingSelection.ts`, `security/ice.ts`, `scopedPull.ts`, `peerHistory.ts`, `boardPairing.ts` | **To remove** with the client cutover. Peer connections, ICE, STUN/TURN configuration, SDP exchange and Drive presence exist only to serve WebRTC. |
| `src/collab/security/{keys,manifest,enrollment,checkpoint}.ts`, `boardGrants.ts`, `googleIdentitySharing.ts` | **Retained.** Client-side trust roots and the relay's authorization vocabulary survive the transport change. |
| `src/sync/operations/engine.ts`, `protocol.ts`, `localStore.ts` | **Retained.** The CRDT-style merge model and the local journal are the reconciliation layer the new transport needs. |
| `src/sync/operations/driveStore.ts` segment/snapshot publishing | **Reduced to snapshots and assets.** Operation segments leave Drive. |

## Invariants and where each one lives

| # | Invariant | Mechanism | Tested by |
| --- | --- | --- | --- |
| 1 | A committed local edit is never silently discarded | Client journal before submit; server never rewrites history | `keeps an operation pending across a disconnect and resubmits the same identifier`, `answers a resubmission with the original sequence and delivers it only once` |
| 2 | Acknowledgment only after durability | `synchronous = FULL`, commit returns before the reply is queued | `an_acknowledged_operation_survives_the_service_being_replaced` |
| 3 | Stable id and sequence per operation | `(board_id, op_id)` unique; sequence assigned in the append transaction | `assigns_per_board_sequences_from_one` |
| 4 | Duplicate delivery never duplicates effect | Dedupe before sequence allocation; duplicates are answered, not rebroadcast | `a_retry_is_answered_with_the_original_sequence_and_rebroadcast_nothing` |
| 5 | A reconnecting client cannot silently skip | `sync_from` reports `Pruned`/`Unavailable` gaps instead of a short list; the client's cursor advances only over contiguous sequences, and an acknowledged sequence with a hole below it triggers a re-subscribe | `asks_for_a_snapshot_when_the_history_a_client_needs_is_gone`, `never settles the cursor over a sequence it was never shown` |
| 6 | Convergent clients | Browser-side deterministic merge (unchanged engine); a client drops any row at or below the sequence it has applied, which is what makes the author's own echo and a replayed window both harmless | engine tests, `delivers an edit to the other device and does not apply the author a second time`, `replays what a device missed while it was closed, from its own cursor, in order` |
| 7 | A snapshot is one complete checkpoint | The cycle applies the log up to the sequence it commits *before* building, so a snapshot can never cover less than it claims; over-coverage is harmless because the engine deduplicates | `publishes only after catching up, and commits the sequence it caught up to`, `stops at a gap instead of publishing a snapshot that covers less than it claims` |
| 8 | Not consolidated before published | Checkpoint advances only on a commit carrying a Drive file reference; the intent to publish is journaled before the upload and resumed after a crash | `one_lease_per_board_and_a_stale_writer_is_refused`, `finishes an interrupted cycle by committing the file Drive already has`, `forgets an intent whose bytes cannot be reproduced and publishes the current state instead` |
| 9 | Pruning never removes the only copy | Only operations at or below the checkpoint sequence, and only after the post-publication retention window | `never_prunes_an_operation_a_snapshot_does_not_cover` |
| 10 | An expired lease cannot overwrite | Epoch must equal the epoch the board issued **and** belong to the writer that holds it | `a_fencing_epoch_is_a_lease_reference_not_a_bearer_token` |
| 14 | Read-only clients cannot mutate | Role checked once per request in `sync_api::handle` | `a_read_only_client_subscribes_and_is_refused_every_mutation` |
| 15 | Sessions of one user are independent | Hub subscriptions keyed by connection, never by device key or account | `two_sessions_of_one_device_both_stay_connected_and_converge` |
| 18 | Drive is not the real-time transport | On the log path a snapshot is built from the log's own sequences and Drive stops being read for operations; legacy segment publication remains reachable on the Drive path, so this is enforced per board by the cutover, not globally | `consolidating through the log covers history that only ever travelled through Drive segments` |

Invariant 10 deserves the detail, because a lease is not a lock. Google Drive has
no hook for our epoch, so an upload already in flight cannot be blocked. What the
server *can* do is refuse to believe a writer that no longer holds the right —
which is what changed during implementation: an epoch is a small per-board
integer, and accepting any number a client typed let one device commit as another.
`commit_checkpoint` now requires the presented epoch to be the one the board
issued **and** the writer to be the device it was issued to. Detection of the
residual race is preserved the way `services/pboard-signaling/src/leader.rs` documented it: a commit whose
snapshot generation is not strictly newer is accepted and flagged `stale`, and the
next leader watermark-merges before publishing.

## Protocol (the original single-room shape, kept for history)

**Superseded by ["State at this revision"](#state-at-this-revision-6-november-2026).**
This is the frame set as first implemented, when one connection carried exactly one
board. The request/reply shapes and error codes below are still current; what is
*not* current is "one connection, one board" — a v3 connection carries up to 32
rooms and `board` selects which attachment the frame applies to. A frame naming a
room the connection did not attach is refused `board_mismatch` and is not
re-scoped, which is the same code and meaning it had here.

Requests are nested under `{"type":"sync","request":{…}}` so a single authorization
check can refuse every frame that names a foreign board.

| Request | Reply | Notes |
| --- | --- | --- |
| `subscribe {board, afterSeq}` | `window` / `snapshotRequired` | `operations` ascending, `liveFromSeq` to subscribe live, `checkpointSeq`, `synced` |
| `submit {board, operations[]}` | `accepted` | `results[]` per operation with `seq` and `duplicate` |
| `lease {board, leaseMs?}` | `lease` | `epoch`, `expiresAt`, `holder` |
| `release {board}` | `released` | holder only |
| `commit {board, epoch, seq, snapshotSeq, driveEtag}` | `committed` | `stale` when the generation did not advance |
| `status {board}` | `status` | console diagnostics |

Broadcast: `{"type":"sync","action":"operation", …}` to every subscriber of the
board, **including the author**, which must tolerate its own operation arriving
by broadcast. Replies are always queued before the broadcast is published, so no
peer can hear about an operation its author has not been told is durable.

Error codes: `board_mismatch`, `read_only`, `batch_too_large`, `op_too_large`,
`protocol_version_unsupported`, `lease_busy`, `lease_expired`,
`checkpoint_rejected`, `log_full`, `invalid_request`, `server_error`.

Unknown request fields are tolerated (a newer client is not an attack); unknown
fields inside a submitted operation envelope are rejected, where a silently
ignored field would change what an operation means.

## Storage

`sync-log.db` (SQLite, WAL, `synchronous = FULL`), one file per service, in the
state directory:

| Table | Purpose | Key/index |
| --- | --- | --- |
| `board` | per-board `next_seq`, checkpoint watermark, monotonic `fence_epoch`, retained op/byte counters | PK `board_id` |
| `operation` | the log: `seq`, `op_id`, `actor_id`, protocol version, logical clock, `enqueued_at`, opaque `payload` | PK `(board_id, seq)`, UNIQUE `(board_id, op_id)` |
| `checkpoint` | last published snapshot per board, `stale` flag, `drive_etag` (the publication receipt) and `evidence_kind` — `1` only for a row this build's commit path wrote | PK `board_id` |
| `coverage` | the sequence prefix each commit covered, with the time that prefix was first committed; the retention window is measured per prefix from here | PK `(board_id, upto_seq)` |
| `lease` | current holder, fencing epoch, expiry | PK `board_id` |
| `device_key`, `key_grant` | the key courier: published ECDH wrap keys and the sealed envelopes addressed to them, keyed by sender and recipient and *replaced*, never appended | per board, per device |
| `account_hint`, `account_hint_cursor` | the per-account inbox: opaque ≤4 KiB hints, 64 per inbox, 7-day TTL, plus per-inbox cursors. Created `IF NOT EXISTS`; the shared `sync_schema` version is deliberately **not** raised | per inbox / global `seq` |
| `sync_schema` | schema version, migrations applied in one transaction. **Version 3** is current; a build that predates it refuses the file outright, so a rollback target must already understand version 3 | — |

Counters live in `board` so capacity checks are O(1) instead of a table scan.
Pruning deletes only checkpoint-covered rows after retention and adjusts the
counters in the same transaction (`services/pboard-signaling/src/sync_log.rs:1024-1082`). The account inbox's
tables were added without raising `sync_schema` on purpose: raising it would make an
older binary refuse a file it can in fact read, which is the opposite of what a
rollback needs.

## Migration of existing boards

Existing Drive folders hold `snapshot-*.json`, append-only `operations-*.json`
segments, `image-*.json` copies, `migration-*.json` markers and a `realtime/`
presence folder. The plan, in order, with no destructive step:

1. **Adopt, do not convert.** A board opened by a client that supports Sync v3
   keeps its Drive files exactly where they are. Its first action is to read the
   current snapshot and segments as a *baseline*, then subscribe from sequence 0.
2. **Backfill the log, once, from the baseline.** The consolidating client
   submits operations that were never published to any snapshot. The log is
   append-only and deduplicates by `op_id`, so a client that dies mid-backfill and
   repeats it cannot create duplicates.
3. **Publish a snapshot under a lease**, exactly as §Protocol describes, and
   record the checkpoint. From this point the Drive snapshot is the baseline and
   segments become eligible for pruning.
4. **Leave legacy files alone.** `operations-*.json` and `snapshot-*.json` are not
   deleted by this project; retention and garbage collection stay a separate,
   explicit decision. The `realtime/` folder simply stops being written once no
   client uses WebRTC.
5. **Mixed versions — no version wall, and one is not needed.** Checked against
   the merge and gardening rules rather than assumed: an older client that appends
   an `operations-*.json` segment to a board that also uses the log does **not**
   lose data and does not break invariant 3. Operations carry transport-independent
   identities (`actorId:seq`, `opId`, causal `deps`), the engine merges by those and
   not by arrival order or sequence, the session's Drive read path still adopts
   Drive segments, and `planGardening` deletes a segment only once a retained
   checkpoint covers both its frontier **and** its per-operation receipts. A log
   sequence is never assigned to a Drive-only operation, so log pruning can never
   collect one either: the two histories cannot prune each other.

   So the mode is recorded where it is already authoritative — the log's own
   checkpoint row (`status.checkpointSeq`/`snapshotSeq`, visible as the `log` column
   in `pboardCollaboration()`) is exactly "this board has consolidated through Sync
   v3" — and no new marker is written. What *is* true is weaker and worth stating
   plainly: a mixed board is slower to converge for the peers that only poll Drive,
   and its history is written by two mechanisms at once. Making the log the *only*
   writer is a rollout question (retire the old clients), not a protocol gate.
   Strict enforcement would require every Drive write to pass through the server,
   which is the trust-model change recorded under approvals — it would put board
   content on the server, and the existing design rejected that deliberately.

   **Correction:** this document previously claimed old clients "must not be able to
   append" because their appends would break invariant 3. That was wrong, and the
   claim is withdrawn: it would have justified an incompatible-version wall that
   breaks older browsers for no safety gain.

## Decisions requiring owner approval

1. **SQLite inside the audited Rust service.** Implementation added
   `rusqlite` (bundled SQLite) to `pboard-signaling`. It is a new native
   dependency in a service with a recorded security audit; the alternative —
   extending the existing hand-rolled journal — avoids the dependency but keeps
   bespoke durability. Chosen: SQLite, for indexed replay/dedupe and a backup
   story that is one file.
2. **Deployment is a separate authorization.** Enabling the log means adding
   `PBOARD_SIGNALING_SYNC_DIR` to the unit and restarting the public relay
   service. No clients can use it until then, and no client can be
   broken by it, because the protocol is inert without the variable.
3. **Retention defaults.** Operation log retention after publication defaults to
   seven days, capacity 200 000 operations / 64 MiB per board, 512 MiB total.
   Numbers are chosen for a small VPS, not measured against real boards.
4. **Fencing cannot be strict.** As above: Drive has no conditional publish that
   our epoch can influence, so prevention is cooperative plus detection.
   Making it strict would mean publishing through the server, which changes the
   trust model — the existing design explicitly rejected that.
5. **WebRTC removal lands after the client path is proven**, not before. The
   deletion is large and irreversible for anyone mid-session; the order is
   server → client behind a flag → remove.

## Status

Measured at this revision (10 November 2026): `services/pboard-signaling` runs
**169 tests** with `cargo clippy --all-targets` at **0 warnings**. Those tests cover
the durable log, replay, dedupe, gaps, leases, fencing, publication evidence and
retention, the protocol frames, hub fan-out, cross-board refusal, role
enforcement, restart durability, the reply-order contract, the key courier, the
per-room byte budget, multiplexed attach/detach and the account inbox
(`services/pboard-signaling/tests/sync.rs` 14, `services/pboard-signaling/tests/multiplex.rs` 9,
`services/pboard-signaling/tests/attach_device.rs` 5, `services/pboard-signaling/tests/inbox.rs` 7).

Implemented on the client: `src/sync/operations/logSync.ts` (transport: bootstrap
from a persisted cursor, live application, sealed payloads through the existing
board content key, per-batch acknowledgment, resubmission of unacknowledged
operations after a reconnect, gap reporting, lease/commit for consolidation, and
repair of a live broadcast the relay dropped) — 17 tests in
`tests/operations/logSync.test.ts`, plus convergence and heal suites (3 and 5).
`logSession.ts` owns the context's single socket and `logRoom.ts` the per-room
cursor; `tests/multiBrowser/singleSocket.test.ts` (9) and `attachSetBound.test.ts`
(8) measure the socket and attach-set claims at the relay itself.

It is selected in `runtime.ts` only when the browser is configured for independent
collaboration **and** the board has a pinned grant **and** a provisioned content
key; otherwise the board takes the Drive-first path described under
[Degrade honestly](#degrade-honestly-the-courier-less-relay-contract) — in the
extension this tree opts out of WebRTC entirely
(`setWebRtcDisabled(true)`, `src/sync/browser.ts:17`), the peer stack is excluded
from the extension bundles by a build-time alias to `src/collab/peerRuntime.stub.ts`,
and `apps/android/src/sync/service.ts:15` calls the same `setWebRtcDisabled(true)`, so
Android opens no peer pool either.

Implemented: consolidation from the log to Drive under a lease
(`runLogConsolidationCycle`; `runLogConsolidation` for the runtime adapters;
`OperationSession.prepareLogSnapshot`/`publishLogSnapshot`/`logSnapshot` over the
existing immutable snapshot-intent journal; owner-only triggers on a five-minute
interval (`runtime.ts:24`, `LOG_CONSOLIDATE_MS`), on backgrounding, on `pagehide`,
on board close, and — via `consolidateBoardLog(boardId)` — from a manual Drive
reconcile round). A snapshot is built from the log's own sequences, so Drive stops
being read for operations on this path. Cycles that do nothing are as visible as cycles that
publish: the last outcome per board lands in the room diagnostics as
`published/<generation>`, `idle:<reason>` or `failed:<message>`
(`RoomSnapshot.consolidation`), where the idle reasons are `not-owner`,
`lease-busy`, `no-watermark`, `clean`, `nothing-to-publish`, `no-room`,
`pending-local-writes` and `drive-<failure>`. `pending-local-writes` is an
actively-editing owner's engine merely busy at trigger time, which retries on the
next trigger instead of faulting the board. Concurrent cycles for one board in a
process coalesce into one; there is no second lease race to lose.

### Snapshot lifecycle, including boards that predate their log

A board enabled for the log after it already existed has updates to cards, and
to the project, with no create operation anywhere in the log — the creates
happened before there was a log to record them. The engine cannot resolve those
entities from operations, so every naive guard refuses to snapshot the board,
and such boards historically sat at `checkpoint_seq = 0` forever: an
unsnapshotted log is a full replay for every joiner and nothing to prune to.

The cycle now bootstraps exactly this case and nothing else. When the log
reports `checkpointSeq = 0` and `snapshotSeq = 0` — nothing committed, hence
nothing pruned, hence the log provably still holds operation 1 — an entity the
engine can only have *observed* through updates is recorded in the published
checkpoint with a `bootstrap: true` marker instead of refusing. The marker
claims only that the entity existed when the receipted history began: every
field it carries is still validated against a receipted operation, so a
bootstrap snapshot manufactures no content, and the marker is written on the
snapshot copy of the engine, never the live one, so no local projection can
adopt it silently. If any checkpoint or generation exists, an unresolved
reference means history really is missing, and the refusal stands —
`engine.checkpoint()` and the `prepareLogSnapshot` guards now guarantee: a
published checkpoint either proves every entity's existence from operations,
or says openly which entities it is taking on trust as the board's pre-log
past, with the proof of that trust (`checkpointSeq = 0` at publish time)
recorded by the cycle that wrote it. The first bootstrap snapshot is the base;
a second device joins from it (`sync` → snapshot → resolved engine) without
replaying the log, and its own snapshots proceed under the normal guard.

Deletion is a different animal and stays manual. Automatic snapshots make
history collectible, but moving segments and superseded snapshots to Google
Drive Trash requires a preview and an explicit confirmation from the Drive
board owner, on a plan that is re-checked against a fresh preview at deletion
time and refused if superseded. That control — "History retention", inside the
collaboration disclosure, owner-only — is the only way history is ever deleted;
there is deliberately no automatic gardening, and the legacy owner
"Maintenance"/"Compact" button is gone with it, because the snapshot half of
it became automatic and the deletion half must not be.

Also resolved by inspection, not code: the "protocol version gate" this document
first called for is unnecessary, and building it would have been harmful — see the
mixed-versions step above.

A pruned history now recovers by itself: the transport reports
`snapshot_required`, the runtime re-reads the board from Drive and resumes the
connection above the committed checkpoint (`resumeFrom`, pinned by
`adopts a checkpoint and resumes above it when the log pruned the history`), so a
consolidated board never sticks in a "needs a snapshot" state.

Not implemented: generic
assets (Phase 5 — specified in [board assets](board-assets.md)). Three modules
exist and are tested (`assets.ts`, `assetQueue.ts`, `assetReclaim.ts`, 33 tests)
but nothing is wired: the operation protocol has no `assets` collection
(`src/sync/operations/protocol.ts:5` is `'projects' | 'cards'`), so asset metadata
cannot reach a board yet.

**WebRTC removal did land, and then stopped half-way.** In the extension the peer
stack is no longer reachable at runtime: `src/sync/browser.ts:17` calls
`setWebRtcDisabled(true)` and both extension bundles alias
`src/collab/peerRuntime.ts` to `peerRuntime.stub.ts` (`scripts/peer-runtime-stub.mjs`,
used by `vite.sidebar.config.ts` and `vite.background.config.ts`), whose exports
throw. Android has no alias, but its composition root calls the same
`setWebRtcDisabled(true)` (`apps/android/src/sync/service.ts:15`), so it opens no peer
pool either. "WebRTC is gone" is therefore true of what runs everywhere and false only
of the source tree: the modules remain and their unit tests still exercise them, but no
shipping path executes them. That is why the extension's sidebar and background chunks
no longer carry the stack while the sources still exist.

**A backfill was examined and rejected as unnecessary.** The plan asked for a
one-time submission of a legacy board's `operations-*.json` history into the log so
nothing would be stranded at the moment a board started using it. The read path makes
that moot: the sync loop reads every `operations-*` file **unconditionally** (no
realtime or transport condition), and a snapshot published on the log path records a
receipt per operation — which is precisely what `planGardening` requires before a
segment may be collected. So legacy history is adopted, is covered by the first
consolidation, and is only ever deleted once that coverage exists; a log sequence is
never assigned to a Drive-only operation, so log pruning cannot reach one either.
Submitting them again would re-attribute them to whichever device ran the backfill
(the server sets the author from the authenticated connection, not from the frame)
while adding nothing durable. Pinned instead by
`consolidating through the log covers history that only ever travelled through Drive
segments`: if a future change makes the log path stop reading Drive history, or makes
a log-path snapshot stop covering it, that migration silently chooses the new log over
the old edits and this test says so at the moment it happens.

**Activated 2 November 2026 at 12:36 UTC** with the owner's authorization: the
service on the relay host now runs the binary containing this protocol with
`PBOARD_SIGNALING_SYNC_DIR` set, the journal reports `operation log enabled`, and
the SQLite log exists with `integrity_check` ok and every table empty. Observed
state, hashes, backup location and rollback are recorded in
[`vps-maint/SERVICES.md`](../../../vps-maint/SERVICES.md) and that repository's
`CHANGELOG.md` (formerly `PBBOARD-COLLABORATION.md`).
No client had connected at the time of that record.

That record covers the 2 November binary. **Everything added since — multiplexing,
per-room byte accounting, attach-time `deviceKeyId`, the retention sweep, the
account inbox, `--check-config` as a true dry run — is in this tree and not
deployed.** Nothing in either repository is committed.

## Extending the log to all boards — what it actually takes

Owner direction, 2 November 2026: try to make the log the transport for every board,
not only granted ones. The server side is already generic — the log is keyed by an
admitted room, and `sync_api::Identity` takes the board from the admitted connection —
so the work is entirely in **admission and keys**. Three sub-problems, in order, none
of them cosmetic:

1. **Authority issuance for ungranted boards.** Authentication today is `version: 2`
   with a signature over `["pboard-ws-auth-v2", challenge, session, room, deviceKeyId,
   digest]`, and the room is derived from an **authority-signed manifest** carrying
   `drive_project_file_id` / `drive_folder_id` (`services/pboard-signaling/src/admission.rs:24-25,67-68,109`).
   A board with no pinned grant has no manifest, so it cannot authenticate — that, not
   the log, is what restricts the transport to granted boards. Extending means the
   host's authority signing a manifest for a board on request. `PBOARD_SIGNALING_
   AUTOMATIC_ADMISSION=1` plus the Google-email allowlist already make the host willing
   to admit an account without an operator grant, so the issuance path is close.
2. **A Drive-side possession proof, which does not exist yet.** The server verifies its
   own signature over client-asserted Drive ids; nothing in it verifies that the caller
   can actually read that folder. If the authority signs whatever a caller claims, any
   allowlisted Google account can obtain a room credential for a board it cannot open.
   That does **not** reveal content — payloads are sealed with the board content key —
   but it does allow appending operations, which is a board-integrity and availability
   problem rather than a confidentiality one. So the extension needs a proof the client
   can produce from Drive access (a signed share, a Drive API-verified token, or a
   key-possession challenge tied to the folder) before issuance is safe.
   `[INFERENCE: I read the admission code's inputs and signature checks, not a live
   authorization trace; verify what the manifest signing path accepts before building
   on this.]`
3. **Content-key provisioning without pairing.** Keys are currently provisioned
   through board pairing, the key courier, and peer exchange (`ensureContentKey`,
   `requestContentKey`). A board where no device has a key cannot seal, and the log
   deliberately refuses a plaintext default — so either every new board generates a
   key at creation and escrows it in a Drive-protected form the owner's other
   devices can unwrap, or unkeyed boards keep using the Drive path. This is the
   piece that decides whether "all boards" is reachable at all, and it needs the
   existing key-wrapping machinery, not a new one.

   *Partially answered since this was written:* the key courier now carries the
   content key to an account's other devices over the relay without pairing (see
   "Key courier"). It removes the manual step **for granted boards with a relay
   that implements the courier**; it does not provision a key for a board that no
   device has ever been authorized to write, so it does not remove this
   sub-problem for ungranted boards.

**A related robustness question the extension made louder — now answered.** If a row
cannot be opened with the board key (rotated key, lost key, one corrupt row),
`logRoom.ts` no longer fails the batch by default. It distinguishes two cases
(`logRoom.ts:145-160`): an `OperationBindingError` — the sealed envelope disagrees
with the identifier the relay delivered it under — throws and holds the cursor
below, because that is an integrity failure on data addressed to this device's own
key; anything else that will not open is treated as *inert wire*, counted
`foreign++`, reported through `options.foreignRow(seq)`, and advanced past. Sealing
can rotate, and an admitted writer waiting for the board key submits a handoff
beacon that is *meant* to look exactly like this, so skipping is what lets the
board re-wrap the key or fetch a rotated one. The remaining risk is not a stuck
cursor but a silently skipped row: **no test drives a real key rotation or a
foreign-sealed row end-to-end**, so treat this as control-flow reading plus the
handoff-beacon path it was written for, not as established behaviour.

**Recommended first step, small and reversible:** implement and test the Drive
possession proof on a single board, with issuance kept behind an explicit server flag,
and measure whether it can be verified server-side at all. If it cannot, the extension
stops here and the honest product shape becomes the other option — live editing as a
granted-board feature, stated plainly in the interface.



## Phase 7 scope correction — "WebRTC" is three different things here

An inventory of every importer, not an assumption: the deletion list this plan first
carried would have broken the default synchronization path for every board, silently.

| Role | Modules | Verdict |
| --- | --- | --- |
| Legacy peer-to-peer replication: RxDB `replicateWebRTC` pools, account-order rooms, peer history sessions, scoped pull | `webrtcHandler.ts`, `scopedPull.ts`, `peerHistory.ts`, `accountSignaling.ts`, `security/replicationRequests.ts`, `types/simple-peer-browser.d.ts` | **Deletable.** The operation engine replaced this; nothing on the surviving path imports them once `manager.ts` loses its pools. |
| Experimental relay signaling (the `provider: "websocket"` room) | `experimentalWebSocketSignaling.ts`, `selectRuntimeSignaling`, `createWebSocketSignaling`, `experiments/collaboration/webrtc-browser-*`, `services/pboard-signaling/browser-probe.ts` | **Deletable.** The log transport opens its own socket and never uses these. `ServiceAdmissionRequest` must move first — natural owner `security/relayAdmission.ts` — including the inline `import('./experimentalWebSocketSignaling')` type import in `googleIdentitySharing.ts`, which a from-clause grep does not find. |
| **Drive-signaled DataChannel live room** | `signaling.ts` (`createDriveSignaling`), `security/ice.ts`, `sync/operations/realtime.ts`, plus `drivePermissions.createDriveSignalStore`, `realtimeFolderId`, `grantRealtimeAccess` | **Not deletable without a product decision.** This is the live-edit channel of *default* boards: `runtime.ts`'s `realtime()` fallback builds `createDriveSignaling(...) + createOperationRealtime({...})`, and `operations/realtime.ts` is an `RTCPeerConnection` with ICE. |

Three consequences need an owner rather than an engineer:

1. **Which boards keep live updates?** The log is reached only when independent
   collaboration, a pinned board grant and a provisioned content key all exist. Boards
   outside that set currently receive live DataChannel edits; with WebRTC gone they get
   Drive polling. Either the log is extended to all boards — which means the server
   authorizing every board, the trust-model change recorded under approvals — or live
   editing becomes a granted-board feature and the interface has to say so plainly.
   Removing the room produces **no type error and no failing test** that says what was
   lost, which is why this is written down instead of discovered later.
2. **`realtimeFolderId` and its Drive ACL grants** exist to host that room. Retiring
   them changes Drive folder layout and per-collaborator ACL side-effects and the
   persisted record shape that several tests pin: a Drive-visible migration, not a
   deletion.
3. **The server is coupled where it is not obvious**: `services/pboard-signaling/src/admission.rs` produces
   `signals::Context` for protocol-2 admission and the *sync* path shares that
   authorization plumbing, so `Context` and `hex` move into `services/pboard-signaling/src/admission.rs` rather than
   being deleted with `Client::Signal`; `Join`/`joined`/`peer_joined` and
   `supportedVersions: [1, 2]` become advertised-but-unused until protocol 1/2 is
   formally retired.

Independent of all three: the legacy pools and the experimental relay signaling can be
removed on their own, and that is the part of Phase 7 that is safe to schedule.

**What actually happened (6 November 2026), because this section otherwise reads as an
open plan.** The extension answered consequence 1 by giving up live editing outside
the log: `setWebRtcDisabled(true)` (`src/sync/browser.ts:17`) plus a build-time alias
of `src/collab/peerRuntime.ts` → `peerRuntime.stub.ts` means no peer pool, DataChannel,
Drive signaling room or ICE attempt can start in a shipped extension. A board that is
not on the log has no live channel and converges through Drive synchronization
(see "Degrade honestly"). The modules were **not** deleted, but they are no longer
reachable from any composition root: `apps/android/src/sync/service.ts:15` calls
`setWebRtcDisabled(true)` as well, so it opens neither `replicateWebRTC` pools nor
operation DataChannels. The Drive-signaled room therefore survives as source and unit
tests, not as a path on any platform — consequences 2 and 3 are historical questions
about a transport nothing runs.

## Development posture: peer pools switched off

Owner decision, 3 November 2026 ("since we are on development, please disable at all
webrtc and keep only websocket for testing purposes, then we'll decide").
`src/collab/liveTransport.ts` holds the posture; `src/sync/browser.ts` opts the
application into it, and nothing else does — so the default in code is the shipped
behaviour, and the automated suite keeps exercising real peer pools.

With the posture on, a board either attaches to the operation log or has no live
channel at all and converges through Drive synchronization. `CollaborationSettings`
resolves an absent or `drive` provider to the relay instead, because Drive signaling
has no transport to signal into; the stored choice is never rewritten, so clearing the
posture restores whatever the person had selected. A board that reaches the peer path
records why in its room diagnostics rather than opening a room that cannot exist.

**This posture exposed a design gap worth recording.** A buffer content key reached a
second device only through the authenticated peer channel, so on the log path the rule
"no key, no attach" was circular: no key, therefore no attach, therefore no peer to
offer the key, therefore the board silently stayed on the peer path — which is why a
granted board with the relay configured produced no `/ws` traffic at all. The sync
runtime provisions a key on the device that may write the board, and the key reaches
the account's other devices through the key courier below. The manual content key
control in the board panel survives as the fallback for a relay that does not run the
courier. Keys still never enter board exports or grant bundles, and viewers never hold
one.

## Key courier: making the log need no setup

- Each device holds an ECDH P-256 wrap keypair next to its existing signing key
  (`src/collab/security/keys.ts`), published to the signaling service per board.
- The writer wraps the board content key for every known peer device —
  ECDH → HKDF-SHA-256(salt = the admitted room id, info = `pboard-key-courier-v1`) →
  AES-256-GCM — and publishes the envelopes. A device with no key fetches the envelopes
  addressed to it and unwraps them before attaching.
- **The service never learns a content key or any board plaintext.** It stores opaque,
  size-capped envelopes and returns only those addressed to the connection's
  authenticated device id; access is gated by room admission, not by write role. A
  received grant always beats generating a new key, so two writers cannot invent two
  keys for one board. Wire shape, caps and refusal codes:
  `services/pboard-signaling/PROTOCOL.md`, section "Key courier".

**One courier exchange per room at a time (`src/sync/operations/keyCourierQueue.ts`).**
Every pass is a self-closing socket, and six call sites run one. Four of them — the
account room (three triggers open that channel), a device approval, the repair leg,
the debounced foreign-row pass — go through the queue. Two deliberately do not: the
board-attach pass and the joiner's handoff ladder keep their own socket, because each
runs *inside* a board open, each must reach the relay on every attempt (the handoff
envelope only exists after the key-holder acts on the beacon), and the attach pass's
lifetime is bound to the board's open/close cycle, which a shared queue has no
business perturbing. Measured on a cold load before the queue existed, the whole set
was **13 short-lived `/ws` upgrades for five boards** — 8 of them the account room
answering the same question once per trigger, sequential and never concurrent — which
is the churn a 40-minute field window showed as a socket created and destroyed every
few seconds with no user action. The queue replaces it with three rules that never
change the exchange:

- **one pass per room at a time, and at most one waiting behind it.** A request joins
  a pass only when that pass would answer it at least as well — same or more attempts,
  at least the same capabilities (`covers`), never the reverse. So a joiner's
  four-attempt ladder never rides an authority's single pass, and a reader never rides
  a writer's. Two requests that would run different exchanges take turns, never two
  sockets.
- **a pass that resolved a key answers another maintenance request for that room
  inside a 5 s quiet window** (`KEY_COURIER_QUIET_MS`), and only one it would itself
  have satisfied. A pass that resolved *no* key is never reused: that caller is a
  device waiting for a grant, and its own bounded ladder must keep asking.
- **the foreign-row trigger is bounded by rate, not by queue** (`FOREIGN_ROW_MIN_GAP_MS`,
  2 s): a burst of unreadable rows is dropped, not queued, and one pass re-wraps the
  board key for every published wrap key at once.

Result, same measurement: **6 dials for five boards** — the five board rooms' own
attach passes, plus **one** for the account room against the eight it used to make —
and zero for a reconcile round inside the window, where it used to cost one. A courier
failure is still an outcome with `error`, never a rejection, so it can never fail a
board open or a sync round. The one latency cost is stated plainly: a device that
joins **and causes no signal of its own** (a reader, which never writes a handoff
beacon) is sealed for by the key-holder's next tick — at most the quiet window beyond
its next trigger — rather than instantly; every writer join, and every reader's own
request, reaches the relay immediately.


**Consent change, deliberate and worth stating plainly:** in the relay posture the
extension adopts a per-board signing authority the first time you open one of
your own editable boards, instead of asking through the panel checkbox. It runs only
when Google is connected, the Drive role is `owner` or `editor`, and nothing else
governs the board. Viewer and revoked boards are untouched, and the explicit panel
path is unchanged.

**One decision point (single-source authority).** `adoptAuthority(board)` in
`src/collab/boardGrants.ts` is the *only* procedure that may create or adopt a board
authority, and in which mode; every caller — `boardSecurityFor` (which attaches
boards), the identity auto-bootstrap, the panel's `initialize`, pairing, and the
explicit Drive-ownership re-key — routes through it, under one exclusive lock. It
answers `adopt` (create / rekey / restore), `already-adopted`, or `refuse` with the
reason. The old gate on `pboardDriveSharedProjects[board].projectFileId` is *not*
an adoption question any more: that record is written by the Drive export itself
for every board, so it marks durability, not rival trust — an exported board adopts
the log and keeps synchronizing through Drive. What still forces a refusal, and is
therefore what "a second authority cannot be created" now means, is enforced inside
this one path: a pinned Drive authority, a live identity-directory advertisement
(this device must *join* the advertised authority, never add one), or a signed
data block the decision cannot explain without a Drive ownership proof. Creating
the board's content key is gated on the same answer — only the authority device
mints; later writers receive the key as a courier grant — so one board holds one
authority, one relay room and one content key.

Out of scope, not implied by any of the above: revoking a departed device's ability to
read *future* keys, and content-key rotation. Both remain separate decisions, which is
why the log should not yet be treated as the sole transport for unattended users.

**Deployment dependency:** the courier requires the service binary containing
`services/pboard-signaling/src/key_courier.rs` (schema version 2). Against an older binary the client records a
courier refusal and falls back to the manual control rather than failing the board.




## Degrade honestly: the courier-less relay contract

Owner-reported symptom pair, November 2026: with the posture on and a relay that
predates the key courier, a confirmed card edit landed **empty** on every device
and its deletion stuck under "Synchronization pending" forever. Both were one
root cause with two faces. The board accepted an *operation-log* commitment it
could never make — no device had a content key (the courier refuses to serve it,
the peer channel that used to carry it is off), so edits entered paths that had
no sink: drafts captured by the offline-authorization gate, which no live board
role exists in this build to admit, while the pending-work overlay rendered them
as saved. Meanwhile the collaboration panel drove Google identity enrolment
against the relay every five seconds per open board, and every ten-second role
pass re-ran the realtime handshake of any board whose factory had ever refused.

The contract the code now enforces, at each layer:

- **Drive-first fallback, always reachable.** An unbound or grant-less board
  with `offlineDrafts: false` (the operation composition roots) writes through
  to the ordinary journal; the operation service takes the board over and
  Drive synchronization carries the edit and the delete. Nothing is captured
  into a queue that no admission path can drain.
- **The realtime factory never re-handshakes per round.** Bootstrap runs once
  per board session, the courier once, and the service retries a *rejecting*
  factory at most once per backoff window (5 s, doubling to 60 s, reset by
  success or disable). `session.setRealtime` is idempotent against the
  established transport, so a healthy room is not closed and re-opened by the
  ten-second role pass.
- **A failure to get a live channel is a returned stub with a reason, not a
  thrown session.** Board security unavailable (no grant published, grant
  service down), the operation log refusing an otherwise-granted board, or a
  missing content key: each returns a no-broadcast transport, records the
  reason on the room and on `operationState.error/note`, and the sidebar's
  status sentence states it. "Waiting for another browser" is reserved for a
  room that actually exists.
- **Enrolment follows attention.** The sharing panel polls its inbox at the
  idle cadence (a minute) and at the five-second cadence only while its
  disclosure is open; window focus refreshes immediately either way. A board
  session asks the relay once, not once per round.
- **One provider question for transport.** Transport decisions ask
  `boardCollaboration.settings()` — the factory, board security selection,
  the sharing mounts — never a raw read of the stored value, so the posture's
  resolution is the same answer everywhere it is asked. Storage-loop routing
  (which reconcile loop, whether shared-shelf discovery runs) deliberately
  follows the *explicit stored* choice instead, so an un-authorized fallback
  deployment keeps the Drive loop it can complete.

What a person sees today on production (posture on, courier-less relay): the
edit lands and stays local; within one Drive synchronization round the other
browser shows the same content, and the delete drains the same way. The live
status line names the missing piece — no content key reached this device, or
the grant service's own refusal — and Drive synchronization continues to
converge boards and content exactly as it did before the posture existed.
