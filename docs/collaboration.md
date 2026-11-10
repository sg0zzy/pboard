# Pboard collaboration architecture

Reviewed against the implementation on 6 November 2026.

## What runs now

Collaboration has three layers, and only the first two are authoritative:

| Layer | Store | Holds | Never holds |
| --- | --- | --- | --- |
| Local state | RxDB (Dexie/IndexedDB) + the blob store | Board state, pending operations, the applied cursor | Trust decisions |
| Durable state and authority | Google Drive | Immutable board snapshots, immutable operation-log segments, images, **the sharing ACL** | Operations in flight, presence, locks |
| Live relay | OVH `pboard-signaling` (Rust/Axum, SQLite WAL) | Per-board operation log with server sequences, bounded buffering, replay, consolidation leases | Board semantics, Drive credentials, authorization decisions it cannot verify |

- **RxDB is the local-first store.** Every edit commits locally before anything
  is sent, and the UI reads only local state.
- **Drive is the durable store and the ACL authority.** Membership is the Drive
  folder ACL (`src/sync/drivePermissions.ts:720-738`), not a signed manifest, in
  the deployed configuration. `operationSync` defaults to `true`
  (`src/sync/runtime.ts:174`), and in that mode `usesIdentitySharing()` is false
  (`src/sync/runtime.ts:2559`), so the identity/device-grant path is not the
  authority for access.
- **The relay is a bounded buffer and relay with replay, not a board-state
  engine.** It enforces identity, permission, order and durability; it does not
  know what a card is, and it holds no Drive credential, so it cannot verify a
  Drive write. A commit's evidence is a typed publication receipt with an
  `evidence_kind`, not a free string.
- **No authoritative peer is elected.** Nothing in the running path requires an
  online owner, causal peer ordering, or a single-writer leader to converge.
- The legacy WebRTC peer path is **dead in the extension**:
  `setWebRtcDisabled(true)` (`src/sync/browser.ts:17`), with the peer runtime
  replaced at build time by a stub (`src/collab/peerRuntime.ts` →
  `peerRuntime.stub.ts`, aliased by `vite.sidebar.config.ts` and
  `vite.background.config.ts`). It remains **live on Android**
  (`apps/android/src/sync/service.ts`), which builds the same sources without the
  alias.

## How to read this document

The sections are ordered current-first. Two groups are retained as **history**
because they explain why the current design looks the way it does, and because
compatibility and recovery still depend on some of their machinery:

- **"History: Drive as the live transport"** and **"History: WebRTC peer pools"**
  describe the per-room-socket, peer-replication world that the extension no
  longer runs. They are marked with a banner and must not be read as current
  behaviour.
- **"Verification"** holds the dated investigations that produced today's
  budgets, gauges and caching rules. Most remain valid as method even where the
  transport they measured has since been replaced; where an investigation
  measured a transport that no longer ships, the section says so.

Everything before the first history banner describes code in the tree today.

## Status and known gaps

These are the gaps this build actually has. They are not planned work being
described as done, and no section above should be read as promising any of them.

1. **The account channel is inert in production.** The channel needs an
   `account:<hash>` pin. The only code that creates one is the button in
   `src/sidebar/components/ExperimentalEnrollment.tsx`, which is **not mounted
   anywhere** in the application. In normal use the channel reports
   `absent-pin` / `no account pin` and opens no room
   (`src/sync/operations/accountChannel.ts:646`). A newly created board therefore
   reaches another browser of the same account only after the Drive publication
   flush (`DRIVE_MAX_UNPUBLISHED_MS`, 25 minutes, `src/sync/syncPolicy.ts:4`)
   plus a poll — or a reload. The automated suite calls `initialize('account')`
   explicitly, so it does not catch this.
2. **"Sync now" reconciles only boards already known.** It forces a full
   reconcile round over the local project list, the Drive listing and the shared
   project list (`src/sync/runtime.ts:2283`). It cannot rediscover a board this
   client has never heard of; discovery of an unknown id still comes from a
   Drive listing or the account channel.
3. **Edits to a board this context does not have open are not delivered
   passively.** The attach set is exactly one board, the one the context
   displays: `healRelayWork` answers `idle:not-attached` for anything else
   (`src/sync/runtime.ts:2368-2377`). This is deliberate — it stopped a socket
   leak — and the consequence is delivery by reopening the board (relay replay)
   or by the Drive poll.
4. **Grant renewals cut live sockets.** The service's revocation watch compares
   manifest digests (`services/pboard-signaling/src/lib.rs:201-205`,
   `:1510`), and a renewal changes the digest, so every renewal looks like a
   revocation: the journal records `reason="authorization_changed"` roughly every
   three minutes per room. The cadence is set by the 300 s grant lifetime with a
   120 s renew window (`BOARD_GRANT_LIFETIME_MS` / `BOARD_GRANT_RENEW_WINDOW_MS`,
   `src/collab/boardGrants.ts:50-51`). Re-attaching after the change tears the
   room down and rebuilds it.
5. **A board open costs about 13 s in a two-browser scenario**, about two-thirds
   of it budget pacing: one open issues roughly 15 identity exchanges (~30
   tokens at 2.5/s). The re-attach in gap 4 roughly doubles the open.
6. **Add and delete are not atomic in the UI.** A card (or board) is published as
   an entity on creation, so a peer renders an empty card and fills it as
   keystrokes arrive.
7. **`projectOrder` is realtime over the account room, with the poll as the
   backstop.** Board sorting is a property of the per-account list, so a
   settling reorder (`reorderProjects`, once per drop — never per drag preview)
   publishes one `board.order` record on the account room
   (`src/sync/operations/accountLifecycle.ts`), carrying the ordered board ids
   plus the preference document's own clock. The receiver weaves that total
   order into the list it holds: ids it does not have are dropped (an order
   never imports or resurrects a board — that is `board.created`'s job), and a
   local board the record does not mention keeps its slot relative to its local
   predecessor. The Drive preference file stays the durable record a fresh
   browser reads (`src/sync/accountPreferences.ts`); applying a record never
   publishes one back, so the poll cannot become the realtime path. Covered by
   `tests/multiBrowser/projectOrderRealtime.test.ts` (zero reconcile rounds on
   the receiver) and `tests/operations/accountOrder.test.ts` (merge rule,
   clock, no echo). What still converges only at the next reconcile: a reorder
   made on a device the account room cannot admit (no account pin, or a
   Drive-only posture), and a reorder whose list exceeds the record's bound.
8. **Grants live only in service memory (PB-07).** A relay restart drops every
   published grant, and an expired grant answers `404` indistinguishably from a
   never-published one; the client labels `expired` versus `never-published` from
   its own memory (`src/collab/grantAbsence.ts`). Grant lifetime is also capped at
   **360 s** by the protocol (`services/pboard-signaling/src/admission.rs:113`,
   `:175`), so an owner-chosen 15 minutes needs a coordinated client and server
   change (PB-08).
9. **The extension sidebar chunk is 611 kB against a 600 kB advisory.** The
   advisory is `chunkSizeWarningLimit: 600` in `vite.sidebar.config.ts:39`; it has
   not been raised.

Two more limits are structural rather than defects, and both are stated where
they belong below: cross-account realtime discovery does not exist (the
per-account inbox is server-side only and its client half is unwired), and a
reconcile round's per-board work is gated on a Drive feed revision, so a board
outside the local set waits for the next listing.

## Runtime wiring

`src/sync/browser.ts` is the extension's composition root: it constructs the
Google auth provider, the Drive runtime (`createDriveRuntime`), the permission
service, the operation service, the grant service and the collaboration manager,
and it calls `setWebRtcDisabled(true)` (`:17`). `src/sidebar/App.tsx` starts the
manager for the current project (`:233`) and stops it on unmount (`:275`). A
project change starts the new board; the previous board's transports are retired
in the background rather than stopped first, and start/stop/role-refresh are
serialized.

A reconcile round is one account-wide pass (`reconcileOperations`,
`src/sync/runtime.ts:2231`). In order it: opens the account channel,
re-verifies deferred lifecycle records, lists shared projects, applies erasures,
runs the legacy pass, syncs the account preference, polls the Drive Changes feed
**once**, then iterates the union of local boards, Drive-listed boards and
discovered shared boards. A per-board gate (`roundNeedsWork`) skips boards that
provably owe nothing, so an automatic round over clean boards costs one feed
request rather than one listing per board. **Forced** rounds — the Drive sync
button, the worker's cold start, the account poll alarm, connect, recovery and
erasure retries — never consult the gate.

The sidebar discovers shared boards on load, on focus, and after Drive/sharing
changes; the Drive sync control additionally requests an immediate reconcile
(`requestDriveReconciliation`, `src/sidebar/components/DriveSyncControls.tsx:87`).
Access is refreshed every 10 seconds while a board is open. That round is
**not** a rediscovery pass for board ids this client has never heard of — see
gap 2.

## Transport: one WebSocket per browser context

`src/sync/operations/logSession.ts` owns the socket; `logSync.ts` is the room
handle in front of it; `logRoom.ts` holds the transport-independent per-room
state; `logPolicy.ts` holds the reconnect policy.

- **One socket per relay URL, whatever the board count.** The session registry is
  keyed by relay URL alone (`logSession.ts:880-900`) and the socket outlives
  every room. `tests/multiBrowser/singleSocket.test.ts` asserts this against the
  relay's own socket list: one board → one socket, twenty boards → one socket.
- **Protocol v3 multiplexes rooms on that connection.** `attach`/`detach`, a role
  per room, revocation that detaches only the room it names, refusals that never
  close the socket, and `rooms_per_connection: 32`
  (`services/pboard-signaling/PROTOCOL.md:1009`). The v3 `attach` frame carries
  its own `deviceKeyId`, verified against that room's proof, so rooms signed by
  different device keys share one connection while each keeps its own
  attribution: every operation a room appends is authored by *that room's*
  device. Board switches are `detach(old)` + `attach(new)` — no dial, no
  re-authentication, zero new sockets.
- **The account channel is one more room on the same socket**, not a second one.
  The account room attaches under `account-device:<hash>` while board rooms
  attach under their own `board-device:<board>` keys (`logSession.ts:13`,
  `:880`). A second socket appears only in the v2 fallback or transiently while a
  key-courier exchange is in flight.
- **Per-room state is per room.** Cursor, `appliedSeq`, the unacknowledged queue,
  phase and error live in `logRoom.ts`. A `refused` or a coded `detached` is
  routed to the room it names: siblings keep their phase, cursor and attachment,
  and the failing room reports the code in its own vocabulary
  (`error: "authorization_changed"`). A detach is not a disconnect, and a
  refusal does not spend a re-admission.
- **The per-connection half** — socket, welcome challenge, identity, reply FIFO,
  heartbeat (`LOG_HEARTBEAT_MS`, 15 s), dial ledger and budgets — lives in
  `logSession.ts`.
- **v2 fallback.** If the welcome omits version 3, the probe socket is handed back
  and every room keeps one socket of its own, byte-compatible with the deployed
  server. The mode is settled from the welcome and never assumed: a v2 server
  closes the socket on the first `attach`.

### Budget and reconnect policy

All of this is one policy in two files and is stated as bounds, not tuning:

- **Automatic-auth budget** (`src/collab/authBudget.ts`): sustained
  **2.5 requests/second**, burst **5**, shared by identity, grants, the key
  courier and every relay dial.
- **Relay dials:** at most **8 per 10 s per browser context**
  (`AUTH_BUDGET_RELAY_DIALS`, `:168`; window `:172`). A dial waits for its slot
  and its token *before* the socket is built.
- **Context-wide attempt ceiling:** 8 attempts per 10 s shared by every topic
  (`acquireRelayAttempt`, `authBudget.ts:276`). It queues rather than refuses, so
  a healthy room is never silenced by another board's churn.
- **Per-topic ceiling:** 6 attempts in 30 s
  (`logSync.ts:254`, window `:253`). Exceeding it stops the room at
  `reconnect:throttled`; only an explicit Reconnect clears the ledger, and that
  gesture bypasses the per-topic ceiling exactly once while still waiting for a
  context dial slot.
- **Backoff:** exponential from 1 s with ±25 % jitter to a 30 s ceiling
  (`reconnectDelay`, `logPolicy.ts:46`). A 429 pauses **every** automatic caller
  in the context with full jitter over a 1 s → 30 s bound that doubles while
  refusals keep arriving and decays after 60 clean seconds.
- **Terminal refusals** stop the room until an explicit Reconnect
  (`TERMINAL_REFUSALS`, `logPolicy.ts:29-54`): `unauthorized`, `grant_expired`,
  `authorization_changed`, `authorization_stale`, `service_auth_required`,
  `service_binding_invalid`.

  **Protocol-family refusals** (`protocolRefusal`, `logPolicy.ts:69`) are a
  terminal sub-family — `malformed`, `invalid_state`, `invalid_frame`,
  `unknown_action`, `version_unsupported` — and they stop the **connection**, not
  only the room: the code is a verdict on what this build *sends*, so every
  further dial returns it (`dial` throws it, `recover` reports it and stops
  instead of laddering). They arrive when a browser and a relay disagree about
  the wire — the service parses `authenticate` strictly and only tolerates an
  unknown top-level field once a connection has negotiated v3
  (`lib.rs:1070`, `:1281`), so a first frame it cannot read is
  `{"type":"error","code":"malformed"}` plus a close. Reporting matters as much
  as stopping: a room whose context carries a verdict is told the service's own
  code and `describeLogStatus` says the two sides do not speak the same protocol.
  Latching it is what keeps a person re-opening the board from spending the
  context's dial budget until the per-topic ceiling engaged and replaced the
  cause with `reconnect:throttled`. An explicit Reconnect clears the verdict —
  either side's build may be the thing that changed.

### Measured costs

Measured on the two-browser harness (`tests/multiBrowser/latencyProbe.test.ts`):

| Step | Measured |
| --- | --- |
| Account channel cold start (both browsers) | ~3.9 s, of which ~1.6 s / ~0.4 s is budget wait |
| First board open → log `synced` (one browser) | ~5.2 s, ~5.1 s of it budget wait |
| Second browser: open → admitted + `synced` | ~13.1 s; ~9.2 s budget wait, 16 identity exchanges |
| Edit while both hold the board open | ~35 ms, zero budget wait |

The open cost is dominated by admission rounds, not by the transport. About
two-thirds of the 13 s is the 2.5/s budget pacing ~30 identity tokens; a grant
renewal that re-attaches the room (gap 4) roughly doubles it.


## Drive layout and permissions

The canonical layout is one folder per board, used by every board in the
operation-sync runtime (`src/sync/driveBoardStore.ts:4`):

```text
My Drive/
  pboard/
    <boardId>/
      board.json.gz            immutable consolidated snapshot (checkpoint-bound)
      operations-<segmentId>.json   immutable operation-log segments
      migration-<id>.json      immutable migration marker, when this board was upgraded
      attachments/             immutable assets and images
      project.json             legacy version-1 snapshot, read-only after migration
```

The legacy shared layout (`Pboard/<projectId>/` with `project.json`,
`image-<SHA256>.json` and a `realtime/` folder of `sig-<topic>-<peerId>.json`
records) still exists on Drive and is still created when a board is shared
through the permission service (`ensureSharedProject`,
`src/sync/drivePermissions.ts:548-567`), but the `realtime/` signaling records
inside it are only used by the Drive-signaling peer path, which the extension
does not run.

**Membership is the Drive folder ACL.** `invite` creates one permission on the
board folder (`drivePermissions.ts:720-738`); children inherit it. Viewers get
`reader`, editors `writer`, the folder owner is the board owner. Account identity
comes from Drive's `about?fields=user(emailAddress,displayName)` endpoint, not
the People API, and `src/sync/driveIdentity.ts` resolves it once per JS context
per token and shares the in-flight lookup.

| Role | Board content | Membership | Project removal |
| --- | --- | --- | --- |
| Owner | Read and write | Invite, change roles, remove members | Delete shared content |
| Editor | Read and write | No membership controls in Pboard | Leave: own list, own ACL |
| Viewer | Read | No membership controls in Pboard | Leave: own list, own ACL |

Only the owner's removal deletes shared content. A non-owner "delete" is a
**leave**: the repository hides the board (order entry dropped, `deletedProjectIds`
marker so discovery ignores it unless the owner later re-invites), then
`drivePermissions.removeSelfFromProject` revokes the caller's own permissions so
the owner's member list updates. The revocation is recorded in
`pboardPendingBoardLeaves` and retried after every reconcile round, so an offline
leave still lands; while a marker is pending, a re-appear cannot undo the leave.
A subsequent genuine invitation (permission created after the removal) restores
the board automatically. Because Drive's `Permission` resource exposes no
creation time and its `id` is opaque, re-invitation is recognized by grant
identity — the caller's own permission `id` must differ from the one recorded at
the previous observation — so a grant that predates the leave never restores the
board, and the first observation of a grant only records a baseline.

The deletion-role resolver (`src/sync/projectDeletion.ts`) maps shared-offline or
unknown-role boards to viewer, so a non-owner can never reach the
content-deleting path. Signed independent boards gate deletion on the owner's
authority grant and additionally re-check the Drive ACL
(`reverifySharedDeletionRole`, wired to `drivePermissions.myRole`) immediately
before destroying content: a Drive editor/viewer permission downgrades the delete
to a leave even when the local grant says owner; a Drive failure or an unshared
board keeps the grant's verdict.

Google OAuth requests both `drive.appdata` and full `drive`. The broad Drive
permission supports incoming shared-board discovery and files owned by other
accounts; `drive.file` was not retained for that path. Search calls use `drive`
for shared files and `appDataFolder` for private records. Both transports bypass
HTTP caches for discovery and media reads.

## Snapshots, images and consolidation

`board.json.gz` is a consolidated snapshot bound to a checkpoint. It is built by
applying the log up to the sequence being committed *before* the snapshot is
built, so a snapshot can never cover less than it claims; over-coverage is
harmless because the engine deduplicates. A client that joins from a snapshot
resumes above the committed checkpoint (`resumeFrom`), and a pruned history makes
the transport report `snapshot_required` so the runtime re-reads Drive and
resumes — a consolidated board does not stick in "needs a snapshot".

Images are immutable, hash-addressed Drive files. In the running path the
metadata converges through the operation log while the bytes travel only through
Drive (`src/sync/operations/assets.ts:1-3`); the sweep that publishes and
downloads them runs after each board sync (`syncImages`,
`src/sync/operations/service.ts:126`), reading what this device already uploaded
by content hash so an immutable file is never uploaded twice. Size and SHA-256
checks reject corrupted assets, and image arrival refreshes the card without
replacing newer text.

The legacy `sharedSync.ts` / `collab/imageSync.ts` pair (`image-<SHA256>.json` in
the shared folder, two-second polling while a board is open) belongs to the
Drive-signaling peer path and is not started in the extension build.

## Conflicts and convergence

Operation application is deterministic and order-independent:
`src/sync/operations/engine.ts` merges per-field registers by
`(clock, actorId, seq)` and keeps a frontier of applied operations, so a duplicate
delivery is a no-op rather than a second effect. A client drops any row at or
below the sequence it has already applied, which is what makes the author's own
echo and a replayed window both harmless.

The relay assigns a per-board sequence inside the append transaction, deduplicates
by `(board_id, op_id)`, and acks only after its own durable write
(`synchronous = FULL`). An ack is never Drive durability.

There is no character-level CRDT: two devices editing the same card concurrently
converge on one value per field, and the losing keystrokes are lost rather than
interleaved. Where the legacy document path is still reachable, it resolves by
last write wins on `max(updatedAt, deletedAt)` with master state winning ties.


## History: WebRTC peer pools and Drive signaling

> **Historical — no longer describes the product.** The extension build sets
> `setWebRtcDisabled(true)` in its composition root (`src/sync/browser.ts:17`) and
> replaces the peer runtime with a stub at build time, so no peer pool,
> DataChannel, ICE attempt or Drive presence record can start in a browser
> build. The Android application still builds these modules without the alias.
> What follows is retained because the code is still in the tree, because the
> shared Drive layout it wrote is still on users' Drives, and because the
> investigations later in this document measured it.

The `PboardSignaling` interface in `src/collab/signaling.ts` was the peer
transport's rendezvous:

```typescript
interface PboardSignaling {
  join(onRoster: (peerIds: string[]) => void): Promise<{ peerId: string; peers: string[] }>;
  sendSignal(toPeerId: string, signal: unknown): Promise<void>;
  onSignal(handler: (fromPeerId: string, signal: unknown) => void): void;
  onError?(handler: (error: unknown) => void): void;
  leave(): Promise<void>;
}
```

Three implementations exist: in-memory for tests, a WebSocket one used only for
development, and Drive signaling (one `sig-<topic>-<peerId>.json` presence and
outbox record per peer, two-second polling, 60 s presence expiry, 240 s signal
expiry). `createPboardWebRTCConnectionHandler` built the simple-peer handler,
bundled non-trickle ICE into the offer/answer, and gated stale answers on a JSEP
state check. The simple-peer defaults used public STUN servers and no TURN relay,
so two browsers off the same network had only server-reflexive candidates.

Two consequences are worth keeping in mind when reading older sections:

- The peer path carried **content**, so its failures looked like data loss. In
  the running path a board with no live channel is still correct — Drive is the
  durable half — and the status sentence says which one is missing.
- The Drive signaling room was **per board and per peer**, and every record was a
  Drive write. That is the cost model the relay replaced.

## History: the pre-multiplex per-room socket

Before protocol 3, one relay connection carried exactly one room. That made every
board switch a dial, a `GET /ws` upgrade and a full admission, multiplied by the
number of boards visited — and, on a flaky tunnel, by the number of reconnects.
The relay's byte budget was a *lifetime* cap per socket, which was survivable for
a socket reopened on every switch and fatal for one long-lived socket: a healthy
connection eventually died of the bytes it had already delivered. Protocol 3
replaced both: rooms attach to one authenticated connection, and accounting is per
rolling window (4 MiB per 60 s per connection plus 2 MiB per 60 s per room;
`PBOARD_SIGNALING_MAX_SESSION_BYTES` is retired and ignored).

## Account preferences and deletion

Project ordering belongs to the account, not the board. A normalized Google email
hash selects `projectOrder:<account-hash>` in RxDB settings, and
`src/sync/accountPreferences.ts` persists it as a Drive preference file: on each
pass it uploads the local order when it changed and applies the remote order
otherwise. Selection stays local and is never replicated.

**Order is not realtime** (gap 7): it is a Drive file applied during reconcile, so
a reorder on one browser reaches another on that browser's next round. The
WebRTC-era settings pool and its `account-signal-<hash>-<peer>.pboard` rendezvous
records are not started in the extension.

The deletion is a durable tombstone: one `boardTombstones` record in the local
change journal (schema 11), holding append-only `deleted`/`restored` facts with a
globally unique operation id and the causal context the writer had observed. It is
written before any destructive work and is consulted by every path that can insert
a board, so a stale snapshot, a Drive file, an old `board.created`, an order record
or a replayed segment cannot bring a deleted board back — an old creation carries no
context and therefore loses to the tombstone regardless of its timestamps. The
`deletedProjectIds` preference entry is kept only as a legacy projection; see
[causal-change-journal.md](architecture/causal-change-journal.md) for the ordering
and retention rules.

**Deletion evidence travels with the fact.** A tombstone used to be device-local,
so a peer that had never seen the deletion depended on a `board.deleted` *hint*
plus its Drive verification — a hint it could miss entirely. The fact itself now
crosses the account room as `board.tombstone`, and it is deliberately its own
record kind rather than an extension of `board.deleted`:

- The other kinds are hints under last-write-wins per board. A fact ordered by a
  Lamport clock plus context dominance cannot go through that comparison without
  silently dropping a concurrent or causally later fact the total order says must
  be kept — and the hint vocabulary has no `restored` at all, which would leave a
  peer believing a restored board is still gone.
- The record carries only the ordering-relevant fields: `kind` (`deleted` /
  `restored`), `opId`, `actorId`, `seq`, `clock`, `context`, and `role`.
  `accountId` is filled from the room, never from the record, so a record cannot
  speak for another account's list; `deviceId`, `at` and `evidence` are local
  provenance a receiver records for itself.
- On receipt it is merged into **the same** `boardTombstones` row the direct
  delete/restore path writes, through the same `mergeFacts`/`latestFact` rule
  (`ChangeJournal.mergeBoardTombstone`) — there is no second merge. A duplicate
  (a replayed `opId`, an older fact, or a concurrent fact that lost the tie) is a
  reported no-op that changes nothing. Because the union and the total order are
  commutative and idempotent, two receivers that got the same facts in different
  orders store the same record.
- Nothing else has to change downstream: every import gate already reads that
  store, so a tombstoned board drops out of the active list and is refused from a
  Drive import, an old snapshot, an old `board.created` or an order record. A
  received `restored` fact re-admits the board through the explicit restore's own
  two steps (reflect the list preference, rebuild from retained history).
- Bounds: the context is capped at 1024 actors and the whole record at 4 KiB
  (`MAX_CONTEXT_ACTORS`, `MAX_CANDIDATE_BYTES`), and a fact past either is refused
  at the producer rather than queued — a fact a receiver cannot read back is not
  a fact.
- The bounded outbox protects a tombstone explicitly: eviction drops any non-
  tombstone row first, however new the tombstone is, and only a queue that is
  entirely tombstones drops the oldest (with a diagnostic). A tombstone keeps its
  own slot keyed by `opId`, so a delete and the restore that reverses it both
  survive, and a retried fact stays one queue entry.

Deletion commits the account removal marker and the selection switch first;
ownership resolution and card tombstones continue afterwards. Owners delete
content; editors and viewers remove only their own list entry. If ownership of a
known shared board cannot be verified, the operation is account-only. Errors in
the background work are surfaced without undoing the list removal.

Private Drive deletions can remain pending offline. Tombstones are retained and
reconciliation never deletes a shared Drive folder. Previously downloaded content,
old private backups and collaborators' independent copies are not erased by
removing access or hiding a board. Local image tombstones retain references and
there is no automatic blob garbage collection.


## Account-level board discovery (lifecycle hints)

> **Status: implemented, unwired in production — see gap 1.** The channel below is
> complete and tested, but it needs an `account:<hash>` pin, and the only code
> that creates one is the button in
> `src/sidebar/components/ExperimentalEnrollment.tsx:52`, which is not mounted
> anywhere. In a normal install the channel reports `absent-pin` / `no account
> pin` and opens no room. Everything here is therefore a design that a normal user
> does not exercise; a newly created board reaches a second browser of the same
> account by the Drive publication flush plus a poll, or by a reload.

A board id is a `crypto.randomUUID()` and its Drive path is derived from it, so a
second browser of the same Google account needs only the id to open the board — but
creating one publishes nothing that leaves the device, so without help that browser
learns the id by polling the Drive listing. `src/sync/operations/accountChannel.ts`
closes that window: **one more room on the context's existing socket** (see
"Transport", above), on the already-admissible account room
(`pboard-account-<hash>-order`, pinned as `account:<hash>`, `board_id`
`account:<hash>`, empty Drive bindings), carrying small lifecycle records —
`board.created`, `board.metadata`, `board.deleted`, `board.order`,
`board.tombstone` — defined in `src/sync/operations/accountLifecycle.ts`;
`board.order` is the account list's own total order, described under "Board order
is one more record kind" below, and `board.tombstone` is the deletion *fact*
described under "Deletion evidence travels with the fact" below.
The service is unchanged: the log is
payload-opaque, so a record is an operation whose field name
(`pboardAccountLifecycle`) is outside the current vocabulary, which buys the
transport's structural validation, the `(board, op_id)` idempotency key, seq-cursor
replay, and forward-compatible skipping without touching the board log engine.

**A lifecycle record is a hint, never a grant.** Applying one hands the board id to
the ordinary verification path, and the only thing that path can do is a Drive
read. A forged, replayed or stranger-published record therefore costs a Drive read
and creates nothing. The one exception is `board.tombstone`, which is not a hint
at all: it is a durable deletion *fact* with its own causal identity, merged into
this device's tombstone store (see "Deletion evidence travels with the fact").

- **Publication happens at creation.** `board.created` is queued from
  `projectChanged` → `driveSyncState.markDirty` — the moment the local RxDB row
  exists — and not after the board's first Drive sync. The sequence is local
  write → record on the socket → server buffers/forwards → peers create a local
  representation → Drive persistence asynchronously; the older call site put the
  announcement behind the board's first Drive publication, which in production
  can wait for the 25-minute publication flush (`DRIVE_MAX_UNPUBLISHED_MS`,
  `src/sync/syncPolicy.ts:4`). The publisher never waits on Drive, never fails the
  creation if the relay is down, and never creates a Drive folder as a side
  effect. `board.metadata` is published on the same event for renames;
  `board.deleted` from `googleDrive.deleteProject`. Publishing is fire-and-forget
  with a bounded persisted outbox (`pboardAccountLifecycle:<hash>`) — it can
  neither delay nor fail the user action, and a relay ack is never Drive
  durability.
- **The post-sync call site stays, for two cases it alone covers**: a board that
  predates creation-time announcement, and a record the channel dropped
  unacknowledged (`onRecordExpired` un-marks the board and the next synchronize
  round re-queues it). It also sends the confirmation record described below.
  Every path is gated by an in-memory announced set, so a reconcile round over
  forty boards publishes nothing.
- **Imported boards are not re-announced.** Only the device that created the board
  announces it, so the room carries exactly one `board.created` per board.
- **A receiver may hear about a board before Drive has it.** That answer is
  `deferred`, not a refusal: the channel keeps the record, applies nothing, and
  re-verifies it (a) whenever a newer record for that board arrives — which is why
  the publisher queues one `board.metadata` confirmation once the board is on
  Drive — and (b) on every reconcile round (`retryDeferred`). A record still
  unverifiable after 8 passes is dropped with an
  `account_channel.deferred_expired` diagnostic (`MAX_DEFER_ATTEMPTS`,
  `accountChannel.ts:213`); at most 128 are held, oldest evicted first
  (`MAX_DEFERRED`, `:218`). Both counts appear in `pboardCollaboration()`'s
  `account` field.
- **Verification is create-free.** `boardFolderExists` lists; it never resolves or
  creates a folder (`src/sync/driveBoardStore.ts:289`). Only after Drive names the
  folder is the role read (`operationService.role`) consulted, and it must already
  report owner/editor/viewer. A record for a board absent from Drive causes **no
  Drive write** — this was a real bug: the earlier order probed with the
  find-or-create folder resolver, the "verification" minted `/pboard/<boardId>`,
  its ACL gate then passed on the folder it had just created, and the ghost
  persisted into every later listing (`src/sync/runtime.ts:502-517`).
- **Deletion is verified through the operation log, not folder absence.** A delete
  is durable in Drive as an *operation*, never as a missing folder — removing a
  board never removes its folder, because the log is append-only — so folder
  absence can never verify one and probing for it discarded every delete record
  ever published. A `board.deleted` record therefore pulls the board through the
  Drive-gated synchronize path and lets the board's own projection materialise the
  delete. A failed read keeps the board and defers the record: hiding a board
  because Drive could not be read is the unsafe direction
  (`src/sync/runtime.ts:518-540`). A `board.tombstone` record needs none of this:
  it carries the evidence itself and is applied from the store
  ("Deletion evidence travels with the fact"), so a peer that never had the
  board's log — or whose Drive read fails — still learns the decision.
- **Board order is one more record kind, `board.order`.** It carries the account
  list's total order (`ids`, deduplicated, id-charset only) plus the clock of the
  preference document it came from — so the record and the durable Drive copy
  agree on which order is newer, and a receiver stores the document the sender
  holds. It is addressed to the constant scope id `account-order`, which is what
  makes the outbox hold *one* order (a burst of reorders collapses to the newest)
  and what lets the projection's per-id LWW pick the newest order. Bounds: 512
  ids and 60 KiB per record (`MAX_ORDER_IDS`, `MAX_ORDER_BYTES`, both under the
  relay's 64 KiB operation payload cap); past them the publication is refused and
  the Drive preference document stays the only record, so an account with more
  boards than that converges at the next reconcile. Applying an order is a
  **local** write: it never fires `projectOrderChanged`, so a received order is
  never published back and the poll cannot become the realtime path. Merge rule
  on receipt: known ids ordered exactly as the record gives them, ids this device
  does not have dropped (never imported, never resurrected), and a local board the
  record does not mention kept immediately after its local predecessor. Two
  sessions reordering at once are resolved by the account plane's own clock —
  `updatedAt`, then `seq`, then the log row id — with the local preference's
  `updatedAt` standing in for the local intent; an exact tie is broken by the two
  orders restricted to the boards both sessions hold, so both sides keep the same
  winner.
- **Content key**: the account room has its own content key, carried by the same key
  courier as a board's and created only by the device holding
  `account-authority:<hash>`; the room is not a plaintext plane. A device enrolled
  later receives a grant on the next courier pass, which each reconcile round and
  board open runs.
- **Failure reporting**: no `account:<hash>` pin means no connection at all — the
  channel reports `absent-pin` / `no account pin` in `pboardCollaboration()`'s
  `account` field and one console line, instead of reconnecting at a room it cannot
  join (`accountChannel.ts:646`). Nothing in this path is awaited by opening a
  board.
- **A foreign manifest is refused, and re-pinning is explicit.** The automatic
  bootstrap verifies the published authorization under the *pin*. A manifest signed
  by a different authority therefore reports `failed` and the pin is left exactly
  where it was — fail-closed on purpose, because that file lives in this account's
  private `appDataFolder` and any client able to write that folder could otherwise
  make itself the account's authority. The escape is
  `accountChannel.repinPublishedAuthority()` (`runtime.ts`, offered only by the
  collaboration panel's account section, and only while the channel is
  `absent-pin` for that reason). It reads the published file, verifies it under the
  key the file *carries* rather than the stale pin, and requires that it names
  exactly `account:<hash>`, lists this browser's `account-device:<hash>`, is
  unexpired, and carries no Drive binding. Any refusal names the check that failed
  and writes nothing; success replaces the pin (and the accepted-membership record
  that described the retired authority) and re-runs the bootstrap. Nothing
  automatic calls it: a bootstrap, reconcile round, channel start, or retry over
  the same manifest a re-pin would accept still reports `failed` and moves nothing.
  The honest consequence is reported, never softened: the browser can read and
  write the account room afterwards only if the new authority's private key is
  local, and otherwise it reports `authority-not-local` and can never renew.
- **Cross-account delivery is not wired.** A per-account **inbox** exists
  server-side (`services/pboard-signaling/src/account_inbox.rs`): durable, bounded
  at 4 KiB × 64 hints per inbox, 7-day TTL, eviction rather than refusal, addressed
  by account hash so the relay never holds the address. Its **client half does not
  exist** — there is no sender and no consumer in `src/`. Cross-account discovery
  therefore still runs on Drive polling. An account room is also writable only by
  that account's own devices, so a board shared *with* another account cannot be
  announced into that account's room at all.

Covered by `tests/multiBrowser/boardLifecycle.test.ts` (realtime discovery without a
Drive poll, duplicate delivery leaving one row and one subscription, the missing-pin
report, a record that grants nothing, a delete reaching a peer that holds no room,
a rename, two contexts of one profile publishing at once, and — for creation-time
announcement — a board created while Drive refuses writes: the peer holds the
record as verified-absent with zero Drive mutations of its own, then converges
without a reload once the board is published, plus a count assertion that an
importing device announces nothing so the room carries exactly one `board.created`
per board). `tests/multiBrowser/latencyProbe.test.ts` measures the delivery path
end to end.

## Authorization and security limits

Two authority stories coexist in the tree, and only one of them governs access in
the deployed configuration.

**Access is the Drive ACL.** In `operationSync` mode (the default,
`src/sync/runtime.ts:174`) membership comes from the board folder's Drive
permissions, `usesIdentitySharing()` is false (`:2559`), and the permission service
is what invites, re-roles and removes (`src/sync/drivePermissions.ts:720-738`).
The signed-manifest model below does not decide who may read a board in that mode.

**What the signed model is still for.** It is the relay's admission vocabulary and
the client-side trust root behind it, and it is exercised in every build where the
relay path is on:

- **Canonicalization and signatures**: `canonical.ts` (canonical JSON, strict
  parsing with duplicate-member rejection, base64url, domain separators, size
  limits). `keys.ts` holds ECDSA P-256 device keys with canonical-JWK SHA-256
  fingerprints, persisted outside Google OAuth storage.
- **Board authority and manifests**: `manifest.ts` signs a device key → role list
  bound to the Drive project/folder ids, with epoch, issue/expiry times and
  anti-rollback state. Clients pin the authority fingerprint through out-of-band
  enrollment; a manifest read from Drive alone is never trusted. The protocol caps
  a manifest's life at 360 s (`services/pboard-signaling/src/admission.rs:113`,
  `:175`); the client issues 300 s with a 120 s renew window
  (`src/collab/boardGrants.ts:50-51`).
- **One authority per board — one decision point**: `adoptAuthority(board)` in
  `src/collab/boardGrants.ts` is the only procedure that creates or adopts a board
  authority, and every entry routes through it under one exclusive lock; the answer
  is adopt (create/rekey/restore), already-adopted, or a refusal with a reason. The
  Drive export marker (`pboardDriveSharedProjects[board].projectFileId`) is a
  durability record, **not** adoption trust: a Drive-exported board auto-adopts the
  durable operation log and keeps synchronizing through Drive. A refusal requires
  real rival trust: a pinned Drive authority, a live identity-directory
  advertisement, or a signed data block that needs an explicit Drive ownership proof
  to re-key. Content-key creation is gated on the same answer: only the authority
  device mints, other writers receive the key as a courier grant, so one board
  converges on one authority, one relay room and one content key.
- **Signaling envelopes and the peer connection state machine**
  (`session.ts`, `webrtcHandler.ts`: `discovered → signalingVerified →
  transportConnected → mutualProofVerified → replicationReady → closed`) belong to
  the WebRTC path described under "History", and are live only on Android.
- **Content integrity for the legacy document path**: `mutation.ts` adds signed
  provenance (`_sec`) to replicated documents and wraps collection storage so a
  document failing verification is answered as a write error; `checkpoint.ts`
  binds Drive snapshots to authority-signed checkpoints. This path is not the one
  the extension runs.
- **Account room**: project-order and account rooms use a separate account
  authority and `collection: "accountOrder"` binding; shared-board credentials
  cannot join them, and account manifests carry no Drive project binding.
- **Endpoint policy**: `endpoint.ts` accepts only HTTPS fetch and WSS WebSocket
  endpoints (Google API origin allowlist) with an explicit loopback development
  exception that received data cannot enable.

**Grants live only in service memory** (PB-07). A relay restart drops every
published grant; an expired grant answers `404`, indistinguishable at the wire
from one never published, so the client keeps its own memory to label `expired`
versus `never-published` (`src/collab/grantAbsence.ts`). See gap 8.

**Renewal looks like revocation** (gap 4). The service's watch compares manifest
digests, so a renewal that changes the digest detaches the room with
`authorization_changed`. The digest comparison is
`services/pboard-signaling/src/lib.rs:201-205`; the detach code is produced at
`:1510`.

Current verification: `tests/securityProtocol.test.ts` (canonical/keys/manifest),
`tests/securityEndpoint.test.ts`, `tests/securityAdversarial.test.ts` (forged
manifests, viewer writes, replay, proof copying, cross-board binding, wrapper
persistence, checkpoint rollback, legacy rejection). The adversarial tests exercise
the security modules directly and the storage wrapper through a live RxDB
collection; real-browser DTLS evidence and real-Drive permission revocation remain
open release gates from the plan.

Live collaboration fails closed before signaling starts when a board or account
security provider is missing, rejects verification, or returns no trusted manifest.
The manager also checks manifest structure, freshness, room binding and local device
membership. A blocked start reports an error and closes partial rooms; local board
operations remain available. Retrying after trust is restored resolves the
manifests again.

## Operating limits the design accepts

- **The relay cannot verify a Drive write.** It holds no Drive credential, so a
  commit's evidence is a typed publication receipt with an `evidence_kind`, and
  the protocol says so rather than implying verification.
- **History is collectible, deletion is not automatic.** Retention pruning inside
  the relay removes only operations at or below the committed checkpoint and only
  after the post-publication retention window; it never removes the only copy.
  Moving superseded snapshots to Drive Trash requires a preview and an explicit
  owner confirmation ("History retention", owner-only), re-checked against a fresh
  preview at deletion time. There is deliberately no automatic gardening, and the
  legacy owner "Maintenance"/"Compact" button is gone: the snapshot half became
  automatic and the deletion half must not be.
- **A pruned history recovers by itself.** The transport reports
  `snapshot_required`, the runtime re-reads the board from Drive and resumes the
  connection above the committed checkpoint (`resumeFrom`).
- **A rollback needs a v3-aware binary.** An older server binary refuses a v3
  database, so rollback requires the v3-aware binary shipped one release earlier.
- **`--check-config` is a true dry run.** It validates configuration and exits
  without opening, creating or migrating the database; `--help` exists; exit codes
  are 0/1/2 (`services/pboard-signaling/src/main.rs:47`, `:63`, `:449`).


## Verification

> **Scope note.** This section is an investigation log, oldest entries last. The
> gauges, budgets and caching rules it produced are live; the *transport* several
> of the later entries measured (Drive signaling rooms, per-peer presence files,
> ICE attempts) is not part of the running extension. Where an entry describes
> work on a transport this build does not start, the measurement still explains
> why the current rule exists — read the rule, not the mechanism. Validation
> evidence is dated; no undated test count in this document represents the
> current suite.

### Attributing a sustained CPU load without a profiler

A build with `VITE_PBOARD_DIAGNOSTICS=1` collects counters for the work that
repeats: the Drive requests by purpose, the background sync attempts and how
they ended, the boards being retried, the shared-project discovery listings,
the account identity lookups, the React renders, the effect executions, the
repository subscription emissions, the collaboration session initialisations,
and — since the idle-CPU investigation — the wall-clock `timings` of the
recurring operations (`reconcile`, `sync:project`, `collab:refreshRole`,
`collab:start`).

#### The transport and idle-cost gauges

Three families of live gauge exist so the "one application socket per session"
and "idle cost does not grow with the board count" requirements are **measured**
rather than asserted. All of them live in `active` in `pboardCounters.snapshot()`
and in the `counters` field of `pboardCollaboration()`, and all are inert in a
production build.

**`transport.open` and `transport.topic.<topic>`** — application WebSockets
dialled and not yet closed, and the same split by the room topic that dialled
them. Counted in `createOperationLogSync` (`src/sync/operations/logSync.ts`,
where the socket is constructed) and `openCourier`
(`src/sync/operations/keyCourierTransport.ts`) — at the **dial**, not at handle
creation, because a handle that never reaches the network is not a socket. Each
dial owns one idempotent release, so an explicit `close()` and the later
`onclose` event count one socket once.

The unit matters: a **dial is not a room**. Under protocol 3 the first room on a
relay URL dials and every later room attaches to that socket
(`logSession.ts:880-900`), so `transport.open` stays at **1** for a context
however many boards it has attached, while `transport.topic.<topic>` attributes
that one dial to the topic that made it. In the v2 fallback, or transiently while
a key-courier exchange is open, each room dials its own. A production build with
one board open and no account pin therefore reads `transport.open = 1`, one
`transport.topic.pboard-collab-<board>-cards` key, and no peer-signaling key at
all — the extension does not open that room.
`tests/multiBrowser/socketGauge.test.ts` asserts the gauge equals
`FakeSignaling.roomsHeld().length` in exactly that scenario (one board, no pin),
so the number is cross-checked against the relay rather than against itself;
`tests/multiBrowser/singleSocket.test.ts` is what pins one socket across twenty
boards.

**`transport.history`** — one record per relay socket this context dialled, so a
Firefox network panel full of `/ws` upgrades can be **attributed** rather than
guessed at. `transport.open` (above) answers "how many"; this answers "which
ones, opened by what, and did they overlap". Each entry is

```
{ id, trigger, room, device, openedAt, closedAt, lifetimeMs, open,
  close: { code, reason, by } | null,
  reconnect: { scheduled, delayMs } }
```

`id` is unique and monotonic in the context; `trigger` is a stable string naming
the subsystem and call site — `session:attach`, `session:recovery`,
`account:attach`, `v2:room`, `courier:pass`, `courier:attach`,
`courier:account`, `courier:device-approved`, `courier:foreign-row`,
`courier:repair`, `beacon:handoff`, `signaling:room`. A probe that a relay
without v3 turns into a private per-room connection is re-attributed to
`v2:room` once that is known, so the count by trigger names the transport the
socket actually became. `room` is the relay topic the dial was attributed to;
`device` is the **first 8 characters only** of the device key id. `by` is
`client`, `server` or `network`, and `reconnect` is recorded on the record that
ended, not on its replacement. Overlapping `openedAt`/`closedAt` windows are
concurrency; ordered ones are churn.

Beside the history sit `dials`, `open`, `closed`, `byTrigger`, `byClose` and
`byCloseReason` (keyed `"<by>:<code>"`, with the sanitised reason appended when
the transport reported one). At most 32 entries are retained; the counters are
not capped. The console also prints a one-line `transport:` summary and a table
of the history beside the room table, because the unit there is the socket: one
socket can carry every room, so the room rows cannot answer it. No token, payload or key is stored: the reason is truncated to 64
characters with control characters stripped, and the device id is a prefix.

The record is taken with `trackTransportSocket`
(`src/sync/transportDiagnostics.ts`) at each socket construction — the shared
session's probe (`logSession.ts`), the v2 room (`logSync.ts`), the courier
(`keyCourierTransport.ts`) and the experimental signaling transport
(`experimentalWebSocketSignaling.ts`) — and it **changes no connection
behaviour**. In a production build the helper returns `undefined` and the socket
is untouched (`tests/sync/transportDiagnostics.test.ts` pins both halves).


**`timer.<name>`** — callbacks still scheduled, maintained by
`countedInterval`/`countedTimeout` (clear with `clearCountedTimer`; a plain
`clearInterval` leaves the gauge armed and therefore detectable). The **key set
is the armed set**: a name disappears at zero, so "the timer set is identical
with one board and with a hundred" is one comparison. Routed points:
`logSync.heartbeat` (the 15 s log heartbeat, `logSync.ts`),
`log.consolidate` (the 5-minute consolidation interval, one per *attached*
board, `runtime.ts`), `sidebar.status` (1 s), `sidebar.role` (10 s) and
`sidebar.toolbarPin` (1.5 s) in `src/sidebar/App.tsx`, and `conflicts.scan`
(the 10 s conflicts rescan in `src/storage/browser.ts`). A gauge that scales
with the board count is that timer being armed per board instead of per
component. `counters.clear()` zeroes the counters and then **republishes** the
armed set, so an idle report cannot claim an idle context the registry can see
is not idle.

**`rx.subscriptions` and `journal.listeners`** — repository subscriptions
currently held (`subscribeRead` in `src/storage/rxdbRepository.ts`, which every
reader goes through) and journal readers (`ChangeJournal.subscribe` in
`src/storage/changeJournal.ts`). Both are live gauges, so a board switch that
fails to release one reads as a number that climbs. A double unsubscribe is
released once.

**Per-board work** — `events['reconcile.round']` counts rounds,
`events['reconcile.board']` the per-board legs inside them (so
`reconcile.board / reconcile.round` is the O(boards) factor one round costs),
`events['reconcile.skip']` the boards an automatic round proved owed nothing
(see below), `events['heal.board']` the relay heal legs, and
`timings['sync.board']` the per-board synchronize duration. These stay *events*
rather than gauges on purpose: they count work done, not work pending, and a
refactor does not make them disappear.

### The automatic round does no per-board work it can prove is unnecessary

A reconcile round used to call `syncOperations` for **every** board it could
name, every round. That call opens the board's session, verifies the Drive role,
polls the account change feed, lists the board's folder and projects the result
— all of it per board, all of it repeated, and none of it able to find anything
for a board that is clean, already synced, bound, has nothing unpublished and
whose Drive folder no device has written since this context last synchronized it.

`runtime.ts:roundNeedsWork` is the gate. It asks, in order and stopping at the
first fact that answers *yes, do the work*:

1. is this the board the context displays? (its room may be attached and its gap
   pull happens through the round, so it is always worked);
2. is it bound locally? (an unbound board is what a first import, a migration or
   a baseline publication looks like);
3. is it neither `dirty` nor outside `status === 'synced'`? (an errored board is
   dirty by `markError`, so the retry rides the same check);
4. has it ever completed a pass (`lastSyncedAt`)?
5. is the local operation store's pending outbox empty (`pendingTiming`)? — an
   outbox row is work whatever `dirtyFlushAt` says, so the flush deadline needs
   no separate test;
6. is its local change token the one this context last answered for?
7. is its Drive folder's feed revision the one this context last answered for,
   and did the round's single feed pass actually succeed?

Facts 1–6 are local and cheap. Fact 7 is what makes the gate correct rather than
merely quiet: the account-wide Changes feed is applied **once per round** before
any board is touched (`createDriveChanges().poll`), and it bumps a folder's
revision exactly when a file appeared in it or left it. That is every other
device's publication, so a board whose revision has not moved cannot have been
written by anyone. A round that cannot read the feed proves nothing, hands out no
revisions, and therefore skips nothing.

Nothing is inferred. Every branch returns *work* when a fact is missing, so the
cases that are never gated are: a first import (a board with no local binding),
the displayed board, anything dirty, pending or errored, a board whose change
token or folder revision moved, a board this context has never settled, and a
board newly discovered by the Drive listing or the account channel — both
arrive unbound locally. **Forced** rounds (Sync now, the worker's cold start, the
account poll alarm, connect, recovery and erasure retries) never consult the
gate at all.

The gate is per *device and context*, and that is the bound on staleness: a
board's remote edit reaches this device on the round after the feed reports it,
which is the same latency the feed's 15-second window already imposed on every
board's inventory. The one behaviour that changed is that a **second** unforced
round inside a feed window no longer re-lists every board: the round asks the
feed once and skips what it can prove is quiet. `tests/sync/reconcileGate.test.ts`
pins the arithmetic (20 clean boards ⇒ zero `reconcile.board` legs and twenty
`reconcile.skip`; one dirty board ⇒ exactly one leg; a forced round ⇒ twenty; a
board whose feed revision moved ⇒ one leg even though it is locally clean).

One board can now stay unsynchronized longer than before, and the bound is worth
stating: a board that is **not** in this context's `boardStore.listBoards()` (so
the feed has never cached its folder) and that a peer publishes to will be picked
up from the feed once this context has listed that folder — which happens the
first time the board is worked. In practice that is one round later than the
per-board listing would have found it, bounded by the round cadence
(`drivePollDelay`, 10–60 min) and by the next forced round, both of which this
context performs. No board is skipped forever: the first pass over any board
records its folder revision, and every pass after that is proven against it.

The gauges were added to pin the invariants that hold **today**, so the coming
single-transport refactor is a regression trap rather than a leap of faith:
`tests/sync/transportInvariants.test.ts` compares the armed-timer set at 1 and
at 100 boards and asserts the subscription gauges return to their starting count
after twenty switches; `tests/multiBrowser/socketGauge.test.ts` pins the socket
count against the relay; `tests/collab/transportGauges.test.ts` pins the gauges
themselves (a double release, a `timer.*` key left at zero, or a gauge that
survives `clear()` would make every other assertion meaningless) and proves the
production build records nothing while behaving identically.

The same build prices every Drive request it sends. `driveCost` records the projected
cost, the cost Google reported through `X-Drive-Request-Cost`, how many responses
carried that header, and the charged cost per resource. The reported number is
authoritative and the projection is the local model, so a report can show where the
two disagree. The discovery block also records cache hits and misses, which separates
a layout that is being cached from one that re-lists on every pass.

The Drive counter is wired into the fetcher every Drive provider uses:
identity endpoints are classified by URL, everything else by the operation
that issued it (`withDrivePurpose` marks `sync` and `reconcile` runs;
unscoped traffic counts as `other`). A session rebuild names the gate branch
that reopened it: `effects["collab:start:rooms-empty"]` growing on a steady
cadence is the manager's rebuild storm, `collab:start:security` is the grant
poll reporting a change, `timings["collab:start"].runs` counts the rebuilds
and `timings.reconcile` the reconciliations, their counts and durations.

A production build does not collect them: each call site is a single boolean
test, and the fetcher wrapper and duration wrappers are not created at all.
The counters are read from the background page's console, and from the
sidebar's console:

```js
pboardCounters.snapshot()
pboardCounters.snapshot().driveCost
pboardCounters.clear()
pboardDriveQuota()   // always available, unlike the counters above
await pboardCollaboration()   // sidebar console; the room lives where the board is open
```

`pboardDriveQuota()` returns the context's Drive quota ledger: `charged` and
`requests` in the current window, `limit` (what this context defers at right now,
after any denial backoff), `configuredLimit`, `accountLimit` (the assumed account
figure), and `spend`, the window's units and request count per request shape,
largest first. The counters are a development
build only; the ledger is collected in every build, because a rate limit is a
sustained condition and the one line a denial prints is not enough to watch it.

`pboardCollaboration()` is one read of everything this context knows, labelled
with the context that answered (`exposeCollaborationDiagnostics`,
`src/sync/realtimeDiagnostics.ts:173`). In the running build the fields that
matter are:

- **`authBudget`** — which automatic-auth endpoints this context has spent on,
  the waiters, the 429 cooldown bound, and both ceilings: `relayDials`
  (`limit`/`windowMs`/`usedInWindow`/`deferred`/`failed`) and `relayAttempts`.
  `usedInWindow === limit` with `deferred > 0` is the client pacing itself;
  `failed` climbing beside it is the proxy refusing upgrades anyway.
- **`account`** — the account channel's own record: `state`
  (`disabled`/`starting`/`connected`/`failed`/`absent-pin`/`gap`/`closed`),
  `reason` (the sentence a human reads; `no account pin` is the production
  state, gap 1), `appliedSeq`, `lastKind`, `outbox`, `deferred` and
  `deferredBoards`, `skipped` by reason, `appliedByKind`, `error`,
  `reconnectReason`, `throttled`.
- **`rooms`** — one entry per board this context has a session for. With the log
  transport the fields that answer questions are `log`
  (`phase#appliedSeq +pending`), `log.reconnectReason` and its last five
  scheduled reconnects, `throttled`, and `error`. The peer-era fields (`listed`,
  `roles`, `stale`, `unresolved`, `connected`, `iceFail`) are still printed and
  are structurally empty in the extension, because no presence files are written
  and no peer connection is attempted. Read them as "the peer transport, if this
  build had one".
- **`counters`** — the gauges described above, read next to the rooms they explain
  instead of asking a developer to run a second command.

A room's `error` is deliberately its own: one board losing its grant reports
`error: "authorization_changed"` while its siblings keep their phase and cursor.
Snapshots hold identifiers and outcomes only, never board content.


`driveCost.projected` and `driveCost.byResource` are in Google quota units, priced
by method (`X-Drive-Request-Cost` when a response reports it); they cover the one
context reading them, so read them in both the background page and the sidebar and
add — Google's per-user limit adds this account's other browsers, devices and the
signaling service on top.

`driveCost` has no per-purpose split, and the quota ledger does not add one
either: presence polling and a board's sync overlap in the same tick, so
attributing a concurrent request to whichever caller happened to be active would
understate the other. The ledger attributes by *request shape* instead — see
`pboardDriveQuota()` below — which identifies a loop without pretending to know
which subsystem issued it. For the recurring totals,
`tests/idleSessionRequestRate.test.ts` prices an idle open board, so a
`driveCost` that climbs while nobody edits is the presence poll described under
“An open board paid Drive for presence it already had”, and a `driveCost` that
climbs only with edits is the sync path.

The counters are the fastest way to attribute a load to a component: a
`renders` count that grows while the board is idle points at a subscription
that publishes more often than it should, a `backgroundSync.unsettled` count
that grows points at a board the worker cannot settle, a
`sharedDiscovery.listings` count that grows points at a layout that is not
being cached, and a `driveRequests.identity` count that grows by units of
three per board sync points at the uncached account identity.

Read the cost block as `pboardCounters.snapshot().driveCost`. A `byResource.list` that
grows while the board is idle names the resource being over-priced, `reportedRequests`
staying at 0 means every number in the report is model rather than measurement, and a
reported cost above the projection names a request the model does not account for. The
throttle that defers these requests never refuses one and never adds one, so a growing
cost count is real traffic, not retry traffic.

To take a 60-second idle report in Firefox: load a diagnostics build, open
the sidebar on the board that shows the problem, in both the sidebar's and
the background script's console (about:debugging → this extension → inspect)
run `pboardCounters.clear()`, wait a full minute without touching anything,
then capture `JSON.stringify(pboardCounters.snapshot())` from each console
twice, 30 seconds apart. Compare which counters moved; that names the
component while a profiler capture shows its stack.

For a stack-level view, record a Firefox Profiler run instead. Open
`about:profiler`, choose **Record**, leave the sidebar open and idle for a
minute, stop the recording, and in the flame graph look for the busiest
self-time frames. The ones that matter here are the extension's own bundle
(`sidebar-*.js` and `background.js`): a long `JSON.parse` or `canonicalize`
frame inside `privateDriveHistory` points at the archive verification, a
`setState`-shaped frame inside the sidebar bundle points at a render, and
repeated `IDBObjectStore.getAll` frames point at a subscription re-reading.

Admission regressions are in `tests/collaborationAdmission.test.ts`. The existing
manager convergence tests and browser smoke harness explicitly double the
authentication boundary while retaining real WebRTC transport and storage. They
do not establish end-to-end protocol-2 authentication; protocol/adversarial tests
exercise signature verification and persistence guards separately.

Relevant test files include `tests/drivePermissions.test.ts`, `tests/driveSignaling.test.ts`, `tests/collaborationManager.test.ts`, `tests/sharedDiscovery.test.ts`, `tests/sharedSync.test.ts`, `tests/imageSync.test.ts`, `tests/accountSignaling.test.ts`, and `tests/conflictResolution.test.ts`. Tests mock Google transports; they are not evidence of authenticated real-Drive behavior.

`npm run test:webrtc:browser` runs two isolated headless Chromium profiles with real IndexedDB and WebRTC against simulated Drive records. It covers bidirectional project template/card mutations, account order, project deletion without resurrection, newer fork conflict resolution, and replayed JSEP answers. It needs Chromium on PATH or `PBOARD_CHROMIUM_BIN`; it makes no authenticated Google requests.

Use [BUILD.md](../BUILD.md) for the ordinary validation commands. Real Google account invitation/role/removal flows, Drive latency/quotas, restrictive networks, and Firefox/Chromium extension lifecycle behavior still need dedicated integration or manual verification. No undated test count in this guide represents the current suite result.

Current causal peer-history integration (20 October 2026): [Job 7 data flow, authorization, compatibility and validation](architecture/peer-causal-history.md). Proven journal descendants outrank timestamps; unresolved variants remain retained. The legacy document policy described above remains a compatibility projection when causality is unavailable.


Job 8 adds [durable offline permissions and pending work](architecture/offline-authorization.md)
and a separate Google service-admission gate for the public independent-board
rendezvous path. Google identity still cannot authorize arbitrary boards.
Structural pending commands, portable historical admission and owner-authorized
recovery remain incomplete; no authority replacement or deployment is implied.

Removal/bootstrap follow-up (20 October 2026): signed board deletion records
signed tombstones before list/selection teardown, and resolves authorization from
board grants. Initial guard installation and teardown share the repository's
local mutation queue with snapshot recovery. Existing empty cards must verify as
signed before bootstrap completes. See the
[removal and bootstrap race fixes](architecture/offline-authorization.md#removal-and-initial-bootstrap-races--20-october-2026-follow-up).


Invitation renewal follow-up (21 October 2026): the original authority browser
maintains device grants for every locally owned, permitted board, including
unselected boards, and republishes its saved email invitations after directory
loss. Valid advertised policies are checked before renewal, preserving replay and
authority-replacement rejection. Unchanged policies are republished only near
expiry; pending device requests retry at most every 30 seconds unless explicitly
refreshed. The sidebar polls every five seconds with a four-second identity cache,
and shows a compact owner/short-ID row and “Waiting for owner…” status. Polling
intervals are not a latency guarantee: background throttling, offline authority,
revoked devices or network failures can still delay enrollment. Initial content
transfer still needs an authorized online peer with the board open. No server
quota, credential, Drive permission or security validation was relaxed.

Directory-capacity isolation (21 October 2026): a verified `directory_capacity`
rejection is now scoped to the unpublished board. It no longer aborts enrollment
of devices under other valid advertised policies. Publication retries for that
board are bounded to once per 30 seconds unless explicitly forced. A full pending
request queue is similarly reported per board. The UI retains valid invitations
and displays a collaboration quota warning; malformed proofs, policy conflicts
and authorization failures still reject access normally. No server limits or
permissions are relaxed, and over-quota boards receive no directory admission.

Private Drive reconciliation already uses a separate path and remains available
for account-bound, backed-up changes regardless of this signaling quota. Changes
that have not reached Drive cannot be recovered from Drive after their source
browser is closed; WebRTC also needs an authorized online peer. The native
Chromium regression fills the real Rust sixteen-board owner directory, verifies
rejection of a seventeenth publication, then recovers a signed same-account edit through
private Drive while B's peer session is stopped, without transferring board
ownership. Google HTTP is simulated; no public service is changed by this test.

### Active-board connection lifecycle and repeated grant checks

Independent WebSocket collaboration opens two collection pools for the selected
board, not two pools per saved board. The two collection rooms negotiate on
their own signaling topics, so they open in parallel rather than one after the
other.

A board switch no longer waits for the previous board's transports to close.
The manager keeps one session object per board, holding that board's rooms,
history sessions, image transfer and mutation guard. `doStart()` retires the
outgoing session and opens the incoming one immediately: the old rooms are
cancelled in the background while the new board connects on its own channel.
The retired session is marked inactive at once, so its late callbacks can no
longer write into the manager's current state. The sidebar no longer stops the
session on a board switch for the same reason; closing the sidebar still stops
it.

Two ordering rules keep the overlap safe. A room waits for the previous session
to release the same signaling topic, because the rendezvous admits one session
per device and room. A board waits for the previous session to release its
mutation guard, because the runtime keeps one guard entry per board and the
guard wraps the shared collection's storage instance; guard installs and
removals are serialized so two wrappers can never be chained. A switch to a
different board waits for neither.

Switching still does not promise delivery of the final peer message. Pending
history is retained for later authorized exchange, and independent private
Drive work can finish in the background. The pool lifecycle regression checks
cancellation on switch and on stop, and the board-switch regression checks that
the new board opens while the old rooms are still closing and that a reopened
room waits for its predecessor. No new draining pool or per-board connection
cache was introduced.

The native Chromium smoke harness times a real switch between two boards with
live WebRTC and RxDB replication. The switch opens the new board in single-digit
milliseconds because it no longer waits for the previous board's transports to
close; the peers then renegotiate the reopened board's own DataChannel. The
harness asserts the switch completes, that the board reopens, and that the
peers reconnect before content replicates again.

Identity discovery still polls for current signed membership. It now avoids
repeating `grants.trust()` and invalidating the security context when a previously
verified complete bundle is unchanged. This optimization requires a matching
SHA-256 digest of the entire received and locally saved bundles, the same device,
the same persisted accepted epoch/hash, and a still-valid current manifest.
Removal of local grants, changed history,
tampered prefixes and expiry force full validation; disconnect/provider disable
clears the memo. No server authorization or membership checks are skipped.
Account-wide private Drive reconciliation and the identity polling frequency are
unchanged; this is a specific reduction in redundant client work, not a claim
that all background synchronization costs have been eliminated.

### Startup recovery of missing private boards

The sidebar reconciles private Drive boards on mount, every 30 seconds, on focus,
when it becomes visible, and when the browser returns online. These requests use
the same coalesced account reconciliation path. WebRTC and the original device
are not required to restore data already uploaded into the user's appDataFolder.

Recovery now isolates unreadable history archives and board-specific failures:
valid archives still discover remote-only boards, including boards without a
compatibility snapshot. Each affected board retains an error/pending state;
other boards continue restoring. A failed snapshot read never counts as remote
absence and blocks overwriting that board's unreadable snapshot. Invalid archives
are never admitted, and count toward the existing aggregate recovery byte limit.
Ordering or legacy invitation discovery failures are reported after independent
private recovery rather than blocking it. Inventory/list failures still reject;
local deletion markers, account bindings, authorization and conflict checks remain
in force. An incomplete scan rejects with an aggregate error, so callers cannot
mistake partial recovery for complete success. Successful later discovery clears
only its own stale sidebar error notice.

Regression scenarios cover an unavailable source device, multiple missing boards,
history-only recovery, images, an unrelated corrupt archive, unreadable snapshots,
retry after repair, idempotence, retained local work, and failing ordering/legacy
discovery services. Private recovery does not create a board-authority permission.

### Same-account menu order with independent WebSocket collaboration

Menu ordering remains an account-private preference (`projectOrder:<account>` in
RxDB settings, persisted through the existing `account-preferences-` appDataFolder
transport for durability), and it is also carried in realtime as one
`board.order` record per settling reorder on the account room — see
"`projectOrder` is realtime over the account room" above. The Drive copy is what
a fresh browser reads; the record is what a connected peer applies. A browser
that cannot join the account room still converges through its periodic
reconciliation round.

The independent WebSocket provider currently opens board content rooms, not a
production account-order room. Starting/stopping those pools must therefore not
reset the preference account to null. The manager now preserves the account scope
already verified by private persistence while connected, and detaches it on
disconnect. This requires no additional Google identity HTTP per board switch and
grants no account-room admission. Existing legacy authenticated account-order
WebRTC replication remains available and unchanged.

The regression uses two isolated repositories viewing different boards, exercises
switch/stop, persists and retrieves both reorder directions through private Drive,
and checks that logout edits do not modify the saved account preference. It also
asserts that no unapproved signaling room is opened. Board participants from other
accounts do not receive the user's full menu or private board IDs. Immediate
account-order delivery over the independent WebSocket/WebRTC path remains a
separate integration requiring account-scoped authentication; board grants alone
must never authorize it.

### Local read amplification and sidebar responsiveness

The sidebar mounts several repository subscriptions at once: the board's card
list, the project list, the current project, the pending-work panel and the
conflict panel. Every journal change notifies all of them, and each one used to
re-read the tables it needed from IndexedDB. One local card edit therefore
turned into a burst of table scans, and the cost grew with the board's history
because the conflict panel reconciled the whole change log and the pending-work
panel read the pending-edit table for every reader.

The journal now reports which stores changed, and the tables that several
readers share are read once and kept until that store changes:

- the pending-edit table behind the pending-work overlay,
- the committed change log behind the conflict panel,
- the board-erasure markers in the receipts table.

The conflict panel keeps the reconciliation outcome of a document whose history
did not change, and the peer history keeps the records it already verified
against the board manifest instead of checking every author signature again on
each flush. A reader also waits for a burst of notifications to end before it
reads, so one write causes one read rather than one per notification.

Measured in native Chromium over a session of eighty card writes, the journal
reads fell from 3396 to 632, and the reads of one edit no longer grow with the
board's history. The per-edit cost is now two receipt reads, two permission
reads and three indexed change-log reads.

`tests/recovery/readAmplification.test.ts` pins these bounds, and the
`experiments/collaboration/ui-perf.mjs` harness measures them in a real
browser. No document content, authorization rule or durable record changed.

### The background worker's idle sync loop

The background service worker schedules an idle sync for a board whose sync
state is pending. A sync whose upload was superseded by a newer local change
left that state pending without advancing the change token, so the worker
scheduled the same superseded upload again, and again: the board synced in a
tight loop, keeping the extension's background process at full CPU and
producing a steady stream of Drive requests.

Two changes stop it. A superseded upload now advances the change token, so
each attempt is a new one rather than a repeat of the attempt that was just
superseded. The worker also keeps the set of boards that already have a sync
scheduled, so the state change that follows a sync that stayed pending does
not schedule a second one, and a sync that does not settle its board backs off
like a failed attempt instead of rescheduling immediately.

`tests/recovery/uploadStaleLoop.test.ts` and
`tests/recovery/backgroundSyncLoop.test.ts` pin both properties.

### Firefox fires a storage change for a write that changed nothing

Firefox reports `storage.onChanged` for a write whose value is identical to
the stored one; Chromium does not. The extension watched two storage keys, so
on Firefox a write that changed nothing was still a trigger.

Three writes are now conditional. The board's sync state is written only when
a field differs from the stored record, and the shared board's layout is
recorded only when its folder, file or realtime folder differs. The state
store's comparison treats an absent field and an explicit `undefined` field as
the same, because the record is stored as JSON.

`tests/recovery/syncStateWrite.test.ts` and
`tests/recovery/sharedProjectsWrite.test.ts` pin both properties.

### The sidebar restarted the board's live session every ten seconds

The sidebar refreshes the board's collaboration role every ten seconds, to
notice a remote change of the role. A board that cannot open a live room —
one without a collaboration security manifest, or with an expired one — failed
that refresh, and the failure made the manager start the board again. Every
ten seconds the sidebar therefore repeated the whole start-up path: the role
and the shared file were resolved again, the session was torn down, and a new
one was attempted. With Drive connected, each attempt is a Drive round trip.

The manager now records why a board could not start, together with the role
and the shared file it had resolved. A refresh that finds the same board, the
same role and the same shared file does not repeat the start-up path. The
attempt is made again when the board's authorization is reported as changed,
or when the room whose trust was missing now has it — the account room and
the board room are checked separately, so a board that becomes trusted later
is still opened.

The sidebar also no longer restarts the board's session for a Google token
refresh. A refresh keeps the same account and only extends the token's
lifetime; a new authorization, which may name a different account, still
does.

`tests/collaborationManagerIdle.test.ts` pins the properties: the start-up
path is not repeated while nothing changed, the board is opened once its
authorization arrives, and a deliberate stop makes the next start try again.

### The private history was downloaded and verified again on every reconciliation

The private history is append-only: every sync stores a new immutable
archive, and the archives grow with the board's history. Every reconciliation
downloaded and re-verified every archive of every board, so the cost of one
reconciliation grew without bound and ran on the sidebar's main thread.

An archive's name carries its content fingerprint, and an archive is
immutable, so a fingerprint this device already verified is remembered and its
bytes are not fetched again. A file id is remembered with it, so an archive
that was replaced under a new id is fetched again.

Measured in real Firefox with the real extension against a mock Drive, the
archives of a board with a growing history were downloaded eight times over
ninety seconds before the change and twice after it. The archive inventory
read is flat in the number of archives.

`tests/recovery/historyArchiveCache.test.ts` and
`tests/recovery/historyCost.test.ts` pin both properties.

### The board was re-rendered for a pin context that had not changed

The sidebar asks the background page every 1.5 seconds whether the current
page can be pinned. The answer is a fresh object every time, so storing it
re-rendered the whole board. A card is not a memoized component, so every
card re-rendered and re-parsed its markdown.

The answer is now compared field by field, and only a changed answer is
stored. A changed answer still re-renders the board, as it must.

`tests/sidebarPinContext.test.ts` pins the comparison.

### The sidebar re-rendered the board continuously while it was open

The sidebar observes the whole settings collection from its project list and
its current project. Two writes to that collection happened on every
account-preference sync, which the sidebar runs on a timer:

- the account's project order was merged and written unconditionally, and the
  merge produces a new value each time, so the write changed the collection
  even when the order had not changed;
- the local order was written unconditionally as well.

Each write re-read the list and the current project and published a new
array, so the board re-rendered. Every render re-rendered every card, and
every card re-parsed its markdown. The render also asked Drive for the board's
role and shared file, so the idle sidebar produced a steady stream of Drive
requests.

The order is now compared by content before it is written, so an unchanged
order is not written at all, and the settings collection is not touched.

The change log was a second source of the same churn. The journal announces
its changes to the other extension contexts over a broadcast channel, and the
announcement carried no table names, so a reader in the other context could
not tell that a change to the change log did not affect it. The table names
now travel with the announcement, and a subscription refreshes only for the
tables it mirrors.

Measured in real Firefox with the real extension, over 60 seconds with the
sidebar open and no user activity: the board re-rendered 14 times and the
project list and the current project were published 7 times each. After the
change the board re-renders 0 times, both publications are 0, and the
extension's process uses 1.7 % of one core.

`tests/recovery/projectOrderWrites.test.ts` and
`tests/recovery/subscriptionEmissions.test.ts` pin both properties.

### The background worker resynced a board faster than its own backoff

The worker writes the board's sync state while it syncs, and that write is a
storage change. The worker's own change listener saw the write and
scheduled the board again, with the idle delay and without the backoff. The
two paths raced for the same alarm name, and the later writer won, so a board
that could not settle was resynced far more often than the backoff allows,
and each attempt ran the whole Drive pipeline.

The worker now holds the board in a retry set for the length of the attempt,
so its own state write is not a reason to schedule it again, and the armed
retry decides when the board runs.

`tests/recovery/backgroundResyncSchedule.test.ts` pins the properties: one
alarm per unsettled sync, a delay that grows between the retries, and a fresh
local change that still gets the idle delay.

### The shared board's layout and the account's identity were fetched again and again

A board that is not shared has no shared layout to cache, so every resolution
of its layout fell back to discovery, which lists every shared `project.json`
in the account. The sidebar resolves the board's role every ten seconds, and
the role and the shared file are resolved in parallel, so a local board
produced a full Drive listing several times a minute. The discovered list is
now kept for a minute and reused.

The account's identity was fetched from Drive on every check of the private
history, and one board's sync makes several checks. The account is now read
once per sync and once more at the end, so a different account signed in
mid-sync is still noticed.

### The account order and the peer history re-read what they had already read

Two paths repeated work that had already been done, and both grew with the size
of the board.

The account order merged the saved order with the local one, and the merge
always produced a `deletedProjectIds` key — even when no side had recorded a
deletion. The stored order then differed from the uploaded file by that empty
key, so every sync uploaded the difference again. The merge now leaves the key
absent when no side recorded a deletion, and the stored order and the uploaded
file stay identical.

The peer history read the board's whole change log again in every round of an
exchange, and verified each record's author signature each time. A record the
peer already holds was answered with an empty request, which meant the record
was delivered, but the answer was forgotten when the exchange ended, so the
record was offered again in the next exchange. The exchange now reads the
history once, keeps the peer's answer for the whole session, and spends its
rounds on the records the peer still needs rather than on a fixed number. A
board with a long history is transferred completely instead of failing with
"History changed continuously during transfer".

`tests/recovery/accountOrderSync.test.ts` and
`tests/recovery/peerHistoryExchange.test.ts` pin both properties.

### A missing shared image was probed on Drive forever

A card that references a shared image the receiver does not hold starts a
retry loop that asks Drive (and, once authorized peers exist, asks them) for
the asset. The retry ran on a fixed two-second poll. When the asset simply
does not exist in Drive — its owner closed its browser before uploading it,
or it was deleted there — the receiver asked every two seconds forever, per
missing asset, on an otherwise idle board: a steady stream of Drive requests
and signature work that nothing could ever answer.

The periodic retry now doubles its wait per consecutive pass that ends with
an asset still missing or a transfer that failed, up to a 60-second ceiling,
and a clean pass resets it to the base poll. An explicit tick — a card edit,
a new blob, a manual sync — always runs the transfer immediately and
recomputes the next wait, so a late upload is picked up as soon as any local
activity happens and the repair itself restores the base cadence.

`tests/recovery/imageSyncBackoff.test.ts` pins the properties: probes grow
sub-linearly against a fixed poll, retries never stop, an explicit tick
probes through the backoff, and a clean pass brings the base cadence back.

### An empty Drive signaling room was polled at the connect cadence

Each open shared board keeps its Drive signaling rooms polling so peers can
discover each other and exchange offers. The poll ran at the full cadence —
two seconds, and once per collection room — even when the room had held no
peer since the board was opened: an idle sidebar kept roughly 90 Drive round
trips a minute going out for a room that could not deliver anything, and any
response processing with it.

The poll now tracks when the room last saw activity: a live peer in the
roster, a delivered signal, or an outbound signal. Past the presence TTL of
silence the next schedule waits a slow interval (15 seconds, kept below a
quarter of the presence TTL so the presence heartbeat stays visible) instead
of the fast cadence; discovering an idle peer then costs at most one slow
poll per side. Writing a signal re-arms the fast cadence immediately, so an
actual connection attempt is never slowed by an idle past, and a live roster
holds the room at the fast cadence for as long as peers are present.

`tests/recovery/signalingIdleBackoff.test.ts` pins the cadence: dense polls
while a room is young, silence after the idle boundary, one poll per slow
interval thereafter, the fast cadence held by a live peer and re-armed by a
send.

### One browser start asked Drive the same questions once per caller

The extension worker and the sidebar page each build a runtime, and each one
reconciles at startup. Neither the identity lookup, the AppData listings nor the
reconcile round was shared, so the same question was asked once per caller and
once per context: a warm start of three boards measured 89 Drive requests,
of which 16 were `about?fields=user(…)` — the account's email, resolved again by
the erasure sweep, the preference round, the changes feed once per board, and
once more when the feed persisted its cursor — and 28 were `files.list` over the
same AppData prefixes. Because both contexts also start within a second or two
of each other, the burst lands inside the short window Google checks per user
and per method, which is what produced the spike in `DriveAbout.Get` and
`DriveFiles.List` while the per-minute budget looked untouched.

Three mechanisms, none of which is a time cache of mutable state, take it back:

- `src/sync/driveIdentity.ts` keys the account identity by access token, so a
  token refresh or an account switch costs exactly one lookup and the concurrent
  callers join the one in flight. A failed lookup is never cached.
- `src/sync/driveSharedRequest.ts` replays only requests that are *already in
  flight*, for idempotent `GET`s only. Presence polling and change detection
  still see a fresh answer on the next tick, which is what the
  `cache: "no-store"` funnels guarantee.
- `reconcileAll` is single-flight per context and stamps a completed round in
  shared storage (`pboardDriveLastReconciledAt`, 30-second window), which is the
  only coordination the two contexts have. Every explicit user action, the
  connect path and the recurring alarm pass `{ force: true }`; a failed round
  stamps nothing and stays immediately retryable.

The same measurement exposed why the local quota ledger looked healthy while
Google was denying requests: it priced a request from its projection
(`1 + fields + pageSize`), so a three-board start "spent" 2,994 units of the
325,000 units/minute per-user budget — 0.9 % — while Google had already charged
3,590 for those 89 requests. Google prices a request by *method* (read 5, list
100, edit 50, download 200, other 5) and page size is not part of the price, so
the old model under-priced a two-row name lookup (6 where Google charges 100)
and over-priced a 1,000-row changes page (1,005 where Google charges 100). The
ledger now accumulates the documented per-method cost and stays comparable with
the Cloud console's Total Query Cost metric; the projection survives as
`driveProjectedCost`, for diagnostics only. Neither number is the whole truth:
Google's per-user metric also counts this account's other devices, browser
profiles and the signaling service's own verification calls, and it enforces
short-window rate checks that no per-minute budget predicts.

`tests/startupRequestProfile.test.ts` boots the worker and the sidebar over one
storage and one Drive stub and prints the per-method profile for cold, warm,
WebRTC-enabled and identity-denied starts. It pins two identity reads per
startup, a warm three-board start inside 70 requests and 4,500 units, that a
first-ever start costs more than a steady-state one, and that denying the
identity lookup costs one failed request rather than a retry storm.

A denial also parks the context that saw it: `driveQuota` keeps a shared
cooldown, so every later caller is answered locally for up to five minutes and
nothing new is learned about whether Google still refuses. The ✕ beside a Drive
error clears that state so it can be observed: `clearDriveSyncError` forgets the
board's stored failure and this page's cooldown, and `DRIVE_CLEAR_PROJECT_ERROR`
makes the worker forget its own — the worker is the context that usually issued
the denied request. Neither call forgives a pending change, so the next sync is
a real request that reports the failure again if the limit is genuinely spent;
that is how a one-off rate window is told apart from exhaustion.

`tests/driveSyncControls.test.tsx`, `tests/background.test.ts`,
`tests/recovery/syncStateWrite.test.ts` and the dismissal case in
`tests/driveQuota.test.ts` pin the four halves of that: the button appears only
with a failure on screen and clears both contexts, the worker refuses an unnamed
board and reports a failed dismissal, the stored board stays dirty and is written
once, and a dismissed cooldown lets the next request reach Drive with the
escalation restarted at one window.

### An open board paid Drive for presence it already had

After the startup fan-out was fixed, the ledger kept reporting exhaustion during
ordinary editing — 65,205 of the 325,000 units/minute per user, with the denial
cooldown escalating to its five-minute ceiling. Startup is a burst; a rate limit
that returns while a board is merely open is a *recurring* cost. There is only
one of those: each open shared board polls its `realtime/` folder for peers every
two seconds, and `createDriveSignalStore` paid for that poll as though it knew
nothing from one tick to the next.

| per poll, per room | request | units |
| --- | --- | --- |
| `readPeer(own)` resolves the file name | `files.list` | 100 |
| `readPeer(own)` reads the body | `alt=media` | 200 |
| `writeOwn` resolves the file name again | `files.list` | 100 |
| `writeOwn` rewrites the record | upload | 50 |
| `listPeers` lists the room | `files.list` | 100 |
| `listPeers` then fetches **every** presence file | `alt=media` | 200 × peers |

Roughly 950 units every two seconds per room — about 28,500 units a minute, twice
that with the cards and projects pools open, and more with each additional peer,
each abandoned presence file, and every folder large enough to page.

Nothing in that list learns anything new. Three rules, all inside the store and
the poll loop, remove it:

- the session's own presence file is remembered by Drive id, and its body is the
  body this session wrote, because this session is the only writer of it (the
  file name carries the per-session peer id). The poll reads it through
  `PboardDriveSignalStore.ownRecord()`, which costs nothing. `readPeer` itself is
  unchanged and still reports Drive truth — it promises that, and a stale answer
  there would be a lie about the remote state, not a cache miss.
- a peer's record is re-fetched when the listing shows its `modifiedTime` moved,
  or after a quarter of the presence TTL has passed since the last fetch, so a
  write that landed in the same second as the previous one delays a signal by
  that window and never loses it.
- a presence file that Drive has not rewritten while the room's newest one aged
  by two TTLs belongs to a session that is gone. Its record is already past the
  TTL in the caller's own reckoning, so it is handed back as last read instead of
  bought again at 200 units per poll — which is what keeps a room whose crashed
  peers left files behind cheap forever. The comparison is between Drive's own
  write times, never against the poll's injected clock.

Presence is also rewritten less often: a record is a claim of liveness for the
presence TTL, so the poll rewrites it at a quarter of that interval, while a
change of *content* — an outbox entry, a presence envelope — is written
immediately and re-arms the interval. Reads keep their full cadence, because that
is how a second browser is discovered; only the redundant rewrite goes away. A
poll slower than the TTL itself (a configuration, not the shipped 2 s/60 s pair)
skips nothing, since that poll is the only chance to renew the claim.

Measured over the same 12-second idle window over one shared board with Drive
signaling enabled, before and after:

| Google method | requests before | units before | requests after | units after |
| --- | --- | --- | --- | --- |
| `DriveFiles.List` | 18 | 1,800 | 7 | 700 |
| `DriveFiles.Get (media)` | 10 | 2,000 | 0 | 0 |
| `DriveFiles.Update` | 6 | 300 | 1 | 50 |
| other reads | 7 | 130 | 7 | 130 |
| **total, units per minute** | 41 | **21,150** | 15 | **4,400** |

Two consequences worth stating plainly. The listings that remain are the room
being read, which is the feature; and the projection model that had been kept for
diagnostics is what hid this — at 100 units a listing and 200 a download, presence
was the most expensive thing the product does, while the projection priced the
same window as a rounding error. Related: a listing is priced per request, not per
row, so the funnels now ask for Google's maximum page (`pageSize=1000`, and 100
for `permissions.list`, which coerces anything larger) instead of 20, which only
multiplied 100-unit requests on any folder with more than twenty entries.

`tests/driveSignalingStore.test.ts` pins the store rules — own file resolved once
and never re-downloaded, `ownRecord()` free while `readPeer` still reports a
corrupted or deleted Drive file truthfully, re-fetch on `modifiedTime` or after
the re-read window, one fetch for a dead session's file ever, a failed write
forgetting the remembered id, and a vanished file dropping its cache entry.
`tests/driveSignaling.test.ts` pins the heartbeat cadence: five polls, three
presence writes, no gap near the TTL, a signal written at once and not rewritten
by the next poll. `tests/recovery/signalingIdleBackoff.test.ts` counts polls
rather than writes, since a write no longer means a poll happened.
`tests/idleSessionRequestRate.test.ts` measures the sustained rate over the real
two-second cadence and budgets it: the room is still listed, nothing is
downloaded, and the window stays inside 6,000 units per minute — where the code
above costs 21,150 and fails it.

### A Drive change backlog was walked from the beginning on every failure

With presence costed correctly, a ledger report still showed 175,525 of Google's
325,000 units per minute in one context, denial after denial, each with a longer
cooldown. Startup and presence are both bounded; only a loop reaches that number.
The loop was the account-wide Drive Changes feed in
`src/sync/operations/changes.ts`, and what made it unbounded was not that it
paged — paging a long history is legitimate — but that it threw the page cursor
away whenever a round did not finish:

- a backlog longer than the 100-page round cap *threw*, and the shared failure
  handler answered any non-quota feed failure by nulling the feed cursor and
  marking every board's folder as needing a full listing;
- a quota denial inside the backlog rethrew immediately, which left the cursor at
  the value the round started with, because the cursor only advanced once the
  whole backlog had been walked and a terminal cursor seen.

Either way the next round started from the same stale cursor and paid for the
same pages again — 100 units each — and the first way additionally listed every
board in full. Denied in the middle, the round could not converge, so the
backlog was charged once per attempt for as long as the account was denied:
10,000 units a round, plus a full listing per board, on every round.

A Changes `nextPageToken` is a valid resumption point, so the cursor now travels
with the progress: it is kept per page, persisted when a round stops at the cap,
and persisted before a quota denial is rethrown. The cap no longer throws or
invalidates anything — it stops, holding the cursor, and the next round continues
there. A long history becomes a bounded cost that shrinks instead of a loop that
grows. `tests/operations/changes.test.ts` pins both halves: a denial on the third
page resumes with the third page on the retry (the already-applied pages are
never requested again), and a 120-page history costs exactly 100 pages in one
round and 20 in the next, with no board listing forced by either.

Two quota-ledger changes came out of the same report, because a ledger that can
only print a total cannot find a loop or stop one:

- The denial line now carries the composition of the window, not just its sum:
  requests, how long the window has been running, and the two largest *request
  shapes* with their units and counts — `GET files?q='…' in parents and trashed =
  false 170000u/1700req` says both how expensive the requests are and that
  something is calling them 28 times a second. Shapes group a loop's requests
  together (three board folders are one loop, not three spends) by folding the
  per-board ids away in `driveRequestSignature`.
- A context defers at `DRIVE_CONTEXT_COST_BUDGET` (100,000 units/minute) instead
  of Google's whole per-user budget, and **halves that ceiling on every real
  denial**, recovering a quarter of the gap per clean window down to a floor of
  `DRIVE_MIN_COST_PER_MINUTE` (4,000). The reason it has to be adaptive is in the
  next case study: the 325,000 figure is documented, not measured, and a project
  can be entitled to far less. The snapshot keeps the two apart — `limit` is what
  is deferring now, `configuredLimit` what the session started with,
  `accountLimit` the assumed account figure to compare against the Cloud console.
  `pboardDriveQuota()` reads the ledger in any build.

Correcting the booking a response belongs to was also wrong whenever requests
overlapped: the ledger held one slot for "what `acquire` booked", so a response
corrected the most recent booking — a different request's — and a second
`observe` for one response charged the difference again. Bookings are a queue
now, matched oldest-first, with an observation that has no booking reporting
without charging. The parallel roster reads of a presence poll are exactly the
overlap that hid it.

### The ledger said 31,310 of 325,000 and Google denied anyway

After the backlog fix the denial came back with its own arithmetic:
`drive quota ledger: charged 31310 of limit 325000 units/min … retry after 60000ms`
escalating to 300000ms, in the sidebar context, from `realtime()` → `join()` →
`writeOwn`/`readPeer`/`listPeers`. Ten percent of the budget it was told it had,
refused. Either the account was being spent elsewhere (another device, profile or
app under the same OAuth project — the Cloud console's *Total Query Cost* metric
split by method is the only way to see it), or this project's real per-user
entitlement is nowhere near the 325,000 the documentation quotes. Both readings
demand the same behaviour from the client: spend less when the provider says no,
instead of insisting on a number it assumed. Hence the adaptive ceiling above —
it costs a user in a healthy account nothing, and it is the difference between a
denied account recovering and one hammering until Google throttles the project.

The same log named one waste that was real and local, and it is fixed: the burst
of ~25 `GET files/{id}?alt=media` requests at the top of a session is a room's
presence folder being read whole. A shared board keeps one presence file per
session that ever joined, so a board that has been opened a few dozen times holds
a few dozen abandoned files, and a cold poll downloaded every one of them at 200
units to read records the caller discards for being past the presence TTL —
5,000 units per board per page load, paid again on every reload. The poll now
skips a file whose `modifiedTime` is two presence-TTL windows behind the room's
newest without downloading it at all, and then removes the file, which is what
`### A room full of browsers that had already closed` below explains.
`tests/driveSignalingStore.test.ts` pins that an abandoned presence file is never
fetched, not even on the first poll, and is deleted rather than merely ignored.

### A file Drive lists but cannot serve was asked for every poll

With the quota denials gone (`pboardDriveQuota()` reporting `charged: 8495` of
`limit: 100000` in 33 s, 95 requests), the extension inspector was still full of
`404` — pairs of `GET files/{id}?alt=media` and `GET files/{id}?fields=…` for the
same handful of ids, over and over. The listing succeeds and keeps naming files
the account cannot read by id (deleted as a presence session left, or unreadable
under the folder's ACL), so every poll re-asked for each dead id: a download and
a role lookup each, twice per peer per pass, forever. Drive's answer about a
specific id it has deleted does not change, so the presence store asks once and
remembers (`gonePeerFiles`, bounded), and `peerRole` caches the resulting absence
instead of dropping it and re-asking. `tests/driveSignalingStore.test.ts` pins
that a listed-but-unservable presence file is fetched once and then never again.

Handing back a ghost's last record was also wrong on its own terms: a file Drive
cannot serve is not a live session, and a phantom roster entry sends its role
lookup back to the same unreadable file every pass. A peer whose file comes back
gone is dropped where the 404 is seen, cache and all.

Remembering is only ever in-memory, and that showed up as a second shape in the
log: ~70 distinct ids, each 404'd at most once or twice, in one burst per page
load. A board's `realtime/` folder is shared by every browser that ever opened it,
so it collects the presence files of crashed sessions; the memory of which of them
Drive cannot serve dies with the page, and the next reload paid for the whole
graveyard again — one hundred and forty 404s before anything else had happened.
Once the re-ask budget is spent the store therefore *removes* the file: Drive's own
answer is that it does not exist, `deleteFile` is idempotent, a file this account
may not delete answers 403 and is ignored, and the browser the file belonged to
writes it again on its next heartbeat, because a failed write forgets the id and the
name is re-resolved. A room cleans its own folder instead of re-reading it forever.
`tests/driveSignalingStore.test.ts` pins the budget ending in a delete and the
listing going quiet. What remains per reload is one metadata ask per deleted legacy
checkpoint (a handful of units, and the only honest answer to a file that may come
back from Trash).

The same misreading sat in the legacy write-barrier check, where the cost was not
noise but a board that never synced again: before each sync, every
`binding.legacyFileIds` file is verified still content-restricted, and a
`404` — the legacy checkpoint was deleted, so nothing can write into it — was
reported as *"the legacy write protection was removed; re-lock the legacy
checkpoint"*, an instruction nobody can carry out, thrown again on every sync.
`legacyBarrierIntact` now reads a gone file as a barrier that holds — and, because
that check runs before every sync of every board, remembers the verdict: Drive
never reuses a file id, so the question is asked once per session and a migrated
library of boards no longer pays a 404 per deleted checkpoint per round. A
non-terminal failure (503, quota) is asked about again exactly as before. Pinned
by `tests/operations/service.test.ts`; the phantom-peer retirement by
`tests/driveSignalingStore.test.ts`.

The third copy of the misreading was the expensive one in units, and it was in the
synchronisation path itself. `performSync` reads every `snapshot-*` and
`operations-*` id its listing names, and a read that answered 404 rejected the
whole sync — so the *other* files in that poll were not applied either, nothing
about the dead id changed, and the next poll paid 200 units for it again forever.
A board whose Drive folder held one compacted-away segment had therefore stopped
synchronising altogether while looking like a connection problem. A file Drive
reports gone is now recorded in the same downloaded-ledger that stops the asking
(the id is terminal; Drive never reuses one) and the rest of the batch is applied;
a file that merely failed — the fake answers 500 for that case — is left unread so
the segment is retried, because swallowing it would lose operations. Pinned by
`tests/operations/session.test.ts` (*"forgets a Drive file it can list but no
longer read"*).

The fourth copy was the one that answers *"why is the inspector full of 404s every
time Pboard starts?"*, because it ran in the path a **new** browser pays. Image
copies are verified after every sync: for each image on the board the listing's
`image-<hash>.json` candidates are tried in order until one reads, and only a
*success* was recorded in the downloaded ledger. A second device has never
downloaded any image, so it must try the candidates — and if one of them had been
deleted, it was tried on every single sync, a metadata request and a media request
each, forever. Gone candidates are now recorded like any other terminal verdict;
a copy that is present but corrupt stays retryable, because that answer can change.
`tests/operations/service.test.ts` (*"stops asking Drive for an image copy Drive can
no longer serve"*) pins the steady state at two requests for the dead id instead of
two more per sync.

So the startup burst has four sources, and each is now paid at most once per id per
browser: the presence files of every browser that ever opened the board (`realtime/`
is shared, and crashed sessions leave their files behind), compacted operation
segments and snapshots, deleted image copies, and the deleted legacy checkpoints a
migrated board still names in `legacyFileIds`. Nothing in that list is a request the
board wants an answer to twice — which is the whole content of these fixes.

### A room full of browsers that had already closed

Two browsers, one board, `connected: 1` in both — and no update ever travelled.
The counters added for that report said why in one line each: `edits 0` and
`recv 0` on both sides, so no frame was ever handed to the open data channel; and
the same table showed what the room was actually doing instead — `peers` naming
**sixty-eight** presence files, `unresolved 31`, `connected 0`. Every reload of
the board had left another presence file behind, the folder is shared by every
browser that ever opened the board, and skipping the *download* of an abandoned
file (above) left it in the listing, where the room still counted it, still asked
Drive for its role, and still tried to open a peer connection to a session that
had closed months ago. `connected: 1` had even been a passing accident of a
poll where the roster happened to be small.

The poll's own rule for "gone" is Drive's write time — a presence file untouched
while the room's newest moved on by two TTLs — so the store now agrees with that
rule at its source and deletes the file, once: `expiredPeerFiles` remembers the
attempt, so a file this account may not delete answers 403 exactly once per poll
cycle rather than once per poll, and the browser a file belonged to recreates it
on its next heartbeat. The room listing in the runtime additionally marks a peer
whose presence record is older than the presence TTL as `stale` *before* paying
for its role lookup: the roster filter downstream applies the same rule, but it
applied it after the quota had been spent, which is how most of a board's Drive
budget was buying roles for browsers that were not running. `stale` is visible in
`pboardCollaboration()` as its own role value, because "sixty peers" and "sixty
ghosts" must not print the same way.

`tests/driveSignalingStore.test.ts` pins the removal, the single attempt per file
under a refused delete, that a file two TTLs behind is ignored but left alone, and
that a write to a vanished presence file recreates it instead of failing the room.

The next report was worse and more honest: sixty-nine presence files, every one of
them between 53 and 98 s old, `me` absent from the listing, and *no* stale entries
left behind by old builds — those files were being created right now, by this
browser, thirty-odd times a minute. A room that is switched off and back on writes
a new presence file when its identity is not stable, and the code had exactly one
such switch: a Drive error on the sync path calls `setRealtime(false)`, the
sidebar's ten-second `refreshRole()` calls `setRealtime(true)`, and
`realtime()` chose a fresh `crypto.randomUUID()` every time. Under a throttled
account that is a closed loop: the ghost flood causes denials, a denial closes the
room, the reopen mints a new presence identity and another file, the new file is
written by a session that is torn down ten seconds later. `connected 0` and
`selfListed false` follow — a session that lives ten seconds never finishes ICE,
and one that cannot write presence is invisible to the browser it is looking for.

So the presence identity is now minted once per board per JS context and reused
across room restarts (`realtimePeers` in `sync/runtime.ts`), and the room snapshot
counts `starts`: a number climbing while a board is merely open is the flap itself,
visible without a profiler.

The removal added above was then too eager, and the next console said so:
`uploadJsonFile` answered `404 notFound` inside `join`, file after file, five
attempts each. A presence file being *old* is not a presence file whose owner is
gone — Firefox throttles a background tab to roughly one wake a minute and the
presence TTL is 60 s, so a live collaborator in an unfocused window is two TTLs
silent routinely. Deleting out from under that browser cost it a 404 on every
heartbeat, because the store wrote to the id it remembered while Drive's listing went
on naming the file it had just lost; the 404 escaped `writeOwn`, escaped `join()`, and
no room started — `connected 0`, `edits 0`, the original report again. So removal
waits five TTLs (`expiredPeerMs`), which no throttle window reaches, and a write to a
file Drive no longer serves *recreates it in the same call*: forgetting the id is not
recovery when the listing that replaces it is the lagging one. The download skip
stays at two TTLs, for the same throttle reason.

### A throttled account took the realtime room down

Quota backoff made the room disconnect, in two places that both read "I could not
check" as "not allowed":

- the realtime revalidation loop (`operations/realtime.ts`) ran
  `canRead(peer).then(allowed => !allowed && drop(peer)).catch(() => drop(peer))`.
  While the local ledger is in cooldown every role check *rejects*, so each pass
  dropped every peer — live, working data channels torn down for a provider-side
  delay, each peer then needing a full renegotiation. A rejection now leaves the
  peer connected; only a verification that actually answers "no" disconnects, and
  the send path still re-checks per message.
- the per-board role answers added under “A peer leaving took the realtime room
  down” held the folder role for the cache window, including a `revoked` verdict —
  and every peer's role is read from that answer, so one bad-looking folder read
  emptied the room for as long as it was held. A `revoked` folder role is now held
  for a second: long enough to answer one pass (peers are queried back to back),
  too short to survive into the next one.

- hardest of the three, and the one that matches a room that simply went quiet:
  `OperationSession` switched realtime **off** whenever a role check failed —
  `catch { await this.setRealtime(false); throw error }` around the role read in
  `performSync` and `receiveRealtime`. Since the quota ledger *refuses* role
  checks during a deferral by design, one throttled minute disabled the room for
  the rest of the session: the data channel stayed open, `receiveRealtime`
  returned at its first line, and the collaborator looked present while ignoring
  everything.

  Exempting only the quota error left the worse half of the bug, which looked like
  a completely different complaint: *"WebRTC does not work, `connected 0`"*. A
  thrown error is not an answer — 404 on some resource, an aborted request, a Google
  503 — while a revocation *is* one, returned as `'revoked'` and acted on by every
  caller directly. Closing the room for a thrown error started a loop, because the
  sidebar re-resolves the role every ten seconds and re-enables realtime the moment
  one read succeeds: fail, close, succeed, open. `pboardCollaboration()` printed it
  as `starts: 63` and `starts: 71` after ten minutes of both browsers sitting open,
  and a peer connection rebuilt every ten seconds never finishes ICE — which is
  exactly the Firefox log line *"WebRTC: ICE failed"* beside a roster that looked
  healthy. `roleOrKeepRealtime` now keeps realtime up for **any** failure and counts
  it (`roleCheckFailures`/`roleCheckError`, surfaced in the table as `roleFail` and
  inside `roomError`), so a genuinely broken role is still visible, as a number
  rather than as a room that stops existing. Only `'revoked'` closes the room.

The presence counterpart is bounded the same way: a presence file Drive cannot
serve is retired, but retirement expires — three re-asks, a minute apart, then
never again. The folder holds the *other browsers'* live sessions, and presence is
how they find each other, so a single failed read must not exclude a peer for the
whole session; an abandoned file must not be re-read every two seconds either.
`tests/operations/realtime.test.ts` and `tests/operations/session.test.ts` pin the
cannot-check-versus-revoked split (a quota refusal, and any other failure, leaves
the peer connected and realtime enabled and is counted; only a revocation closes
both); `tests/driveSignalingStore.test.ts` pins the re-ask budget. `iceFail` in the
same table is counted where the transport drops a peer whose `RTCPeerConnection`
reported `failed`, which is what a missing relay server leaves behind once the room
itself stops restarting.

### Adopting a migrated board failed on a legacy copy that no longer existed

A fresh browser profile signing in as the same user adopts the boards it finds in
Drive, and adopting one freezes its pre-protocol copies: `protectLegacy` reads the
legacy file and locks it read-only. Those copies were created by the *first*
device, or had been deleted altogether, so the read answered `404` and the lock
was refused — and both were fatal: `Google Drive operation storage failed (404)`,
retried per file per attempt, while the board stayed unopened. A deleted file
cannot be written by anybody, so there is nothing to protect; a file belonging to
another account can only be locked by that account, and refusing to open the
board bought no protection at all. `protectLegacy` now verifies what Drive
actually holds after a refused lock — gone, already locked, or not ours to lock
each mean the board opens — and fails only when this account owns the file and
Drive still refuses, with a message that says so. Gone ids join the same session
memory as the barrier check (`driveHttp.ts`), so each is asked about once.
`tests/operations/driveStore.test.ts` pins all three outcomes.

### A peer leaving took the realtime room down

`Google Drive operation storage failed (404)` from `realtime()` → `join()` →
`listPeers`, repeating on every render: the roster listing named a presence file,
its session deleted that file a moment later, and the role lookup for it read a
file Drive no longer had. Every Drive funnel reported a failed response as a
plain `Error` with the status inside the text, so the caller could not tell
"the file is gone" — routine, benign, the peer simply left — from "storage
failed" — worth retrying and reporting. It treated both as the second, and since
`listPeers` rejects, `join()` rejected and realtime could not be enabled at all,
retrying forever against a file that is never coming back.

The funnels now throw the same message with the status attached beside it
(`driveHttpError`, `src/sync/driveHttp.ts`), and a gone resource is read as what
it is: the peer is dropped from the roster, and a presence *folder* that vanished
since the session resolved its id is an empty room rather than a failed poll,
recovering on the next listing. Any other status still propagates — degrading a
500 into "nobody is here" would be a silent lie. Pinned by
`tests/operations/driveStore.test.ts` (gone is classified apart from every other
failure) and `tests/driveSignalingStore.test.ts` (a vanished folder reads as an
empty room and recovers; a vanished peer file drops that peer only).

Finally, the operations realtime role check fetched three answers — the folder's
own role, the presence listing and the board's ACL page — *inside* its per-peer
loop, and the presence poll asks for every peer's role on every tick: a 100-unit
listing and a 100-unit ACL page, multiplied by the roster, every pass. Those
answers are per board, not per peer, so each is now one short-lived
single-flight value (`oncePerPass`, `src/sync/runtime.ts`); a grant or revocation
is observed one pass later, exactly as it already was behind the ten-second
per-peer role cache.

### Two browsers were each alone in their own room

The end of the same symptom, and the one all the earlier hardening missed:
`pboardCollaboration()` in the two browsers reported the *same* board, `role:
owner`, `ready: true`, `error: null` — and each room listing one presence file,
its own. The `folder` column named the two: **the browsers had created two
`realtime/` folders under the same board**, so each was in a room the other could
not exist in, while Drive sync continued normally.

`ensureRealtimeFolder` resolved the folder with a Drive *name search* and cached
whatever it got, forever. Drive's name-search index lags — the reason discovery in
this codebase uses the shared-with-me shelf instead — so a browser joining a board
another browser had just set up could miss a folder that already existed, create
its own, and then keep that id for the life of the local cache. Nothing ever
compared the two again.

Resolution now goes through the parent folder's *listing*, which is what every
collaborator sees, and the canonical child is chosen deterministically (lowest
id), so independent browsers converge on it whatever order they started in. The
listing wins over the cache even when the cached folder is one of the listed ones:
preferring a browser's own id is exactly what kept the two rooms apart. The
listing is consulted once per board, and again when the cache stops matching the
answer it gave — a cache left by an older build must not freeze a room away from
its collaborators. The realtime room resolves against the **operations layout**
folder id (the `sharedFileId` the diagnostics report, the one both browsers
already agree on) rather than whichever parent it cached first. Pinned by
`tests/drivePermissions.test.ts`: a second browser adopts the existing folder
instead of adding one, and a browser sitting on a duplicate is moved onto the
canonical folder and its cache follows.

Two things made that state unreadable, and both are now fixed because a room that
never started must not look like a room nobody joined:

- `createOperationRealtime` closes the session and **rethrows** when `join()`
  rejects, and the sidebar's only handler for `collaborationManager.start()` is
  `.catch(() => {})`. So anything thrown while the room was being built — a
  permission lookup, a listing, a Drive refusal — produced `ready: true`,
  `error: null`, no peers, forever. `realtime()` now records that failure in the
  room snapshot before rethrowing, and it appears as `roomError`.
- the convergence listing runs inside that same join path, so it must never be the
  reason a room fails to start: a refused listing falls back to the folder this
  browser already has and tries again on the next resolution. Pinned in
  `tests/drivePermissions.test.ts` (a lower-id folder appearing after a refusal is
  adopted, which only happens if the listing was retried).

The duplicate folders this bug left behind stay in Drive, orphaned; their presence
files are no longer read by anything, and the extra folder can be deleted by hand.

### A room could name its peers but not reach them

Two browsers, one Google account, one open board, and updates arrived only when a
browser pulled from Drive — the shape of "WebRTC is not working". Three separate
things produce that sentence, and until the room's own answers were readable none
of them could be told apart from the outside:

- a deleted presence file that Drive goes on naming in the folder listing. The
  room resolves a role for every listed peer before admitting it, so each pass
  paid a fresh 404 for the same unreadable id for as long as the board was open.
  `peerRole` now consults the same remembered-absence memory the legacy write
  barrier uses (`driveHttp.ts`): asked once, then never again, while a peer whose
  file Drive *can* serve is still verified every pass.
  `tests/ghostPresenceRequests.test.ts` plants that exact shape — listed,
  downloadable, metadata 404 — and pins one metadata ask across three polls,
  failing to three asks without the memory.
- the other browser was never in the listing, because it never wrote presence:
  realtime off in that browser, or its own Drive traffic refused, or a board whose
  `realtime/` folder it cannot create.
- the peers were found and no data channel came up, which is a transport question,
  not a Drive one: `collab/security/ice.ts` pins STUN defaults
  (`stun.l.google.com`, Twilio) and adds nothing else unless the operator sets
  `pboardIceServers` — a JSON array of URLs or `{urls, username, credential}`
  objects in extension storage, credentials accepted for `turn:`/`turns:` only and
  never read off the machine. **Without a TURN entry, two browsers that are not on
  the same network have only server-reflexive candidates to try**, and self-hosted
  signaling on a VPS does not change that: relaying is a separate endpoint, and
  the presence-based room in this build uses Drive, not the WebSocket rendezvous
  (`DEFAULT_RENDEZVOUS`), which belongs to the earlier buffer path. `pboardIceServers`
  belongs to the deployment notes of whatever runs the VPS, because a TURN server
  with no client configured for it is a server nothing uses.

### A second device could not open boards another one migrated

Authority recovery in WebSocket mode looks up the existing canonical
`pboard/<boardId>/board.json.gz` folder before consulting legacy `project.json`
sharing records. A private board needs no collaborator ACL to qualify: a fresh
Drive identity and folder-permissions read must prove that the connected account
is its owner. Discovery never creates or merges folders, bypasses local folder
caches, and refuses duplicate board folders or snapshots. Missing data and API
failures leave recovery blocked. This avoids treating a board in the unified
layout as “not shared” before checking its owner's permissions.

Coverage: `tests/recovery/authorityRekeyRuntime.test.ts` exercises owner recovery,
writer refusal, missing data and discovery failures;
`tests/sync/driveBoardStore.test.ts` checks read-only discovery and ambiguity.

The v2 redesign (local-first RxDB + user-visible Drive snapshots + server
buffer + single-writer leader) was approved with these decisions: buffer
encrypted by default, private-board history archives relocate to the visible
folder, split-brain is detect-and-repair (accepted Drive limitation),
Drive-hosted `realtime/` signaling stays as the fallback transport for the
legacy Drive-provider mode only. Canonical storage (audit of 2026-10) is one
unified path for every board — `My Drive/pboard/<boardId>/board.json.gz`
plus `attachments/` — and Google Drive AppData has no role in websocket
(Sync v2) persistence; the AppData-backed provider serves only the legacy
Drive-provider mode. An automatic legacy pass (decision 2026-10-24: connect
is consent, no prompt) relocates AppData copies and legacy `Pboard/` shared
folders into the unified layout on the first Sync v2 reconcile — uploads are
read-back verified before the flip, sources are deleted only after the
90-day read-only window, and relocated shared boards carry their
collaborator ACL before any write (a failed ACL listing skips the board
rather than downgrade access; the old folder is never touched). Building
blocks landed first, each standalone-tested before integration:

- [`src/sync/snapshotV2.ts`](../src/sync/snapshotV2.ts): `pboard-board-v2`
  gzip snapshot (`CompressionStream`) with `snapshotSeq`, leader `epoch`,
  per-collection checkpoint digests and per-device op `watermarks`; strict
  size caps and v1↔v2 upgrade/rollback helpers.
- [`src/sync/bufferCrypto.ts`](../src/sync/bufferCrypto.ts) +
  [`src/storage/contentKeyStore.ts`](../src/storage/contentKeyStore.ts):
  AES-256-GCM op envelope (opId authenticated as AAD) under a per-board
  content key held in a dedicated IndexedDB database; only editors provision
  keys, and the signaling server only ever stores ciphertext.
- [`src/sync/bufferProtocol.ts`](../src/sync/bufferProtocol.ts): client pump —
  same-tick batch coalescing, in-order halt-and-backoff, drop only after the
  server durably acknowledges, zero timers while idle, `pagehide` stop that
  keeps pending ops for the next session. `seal` is injectable (tests run
  synchronously; production uses AES-GCM).
- [`src/sync/snapshotMerge.ts`](../src/sync/snapshotMerge.ts): the repair
  rule for the accepted split-brain limit — merge two snapshot views by
  (snapshotSeq, epoch) base plus per-document causal retention and per-device
  watermark max; order-independent and idempotent, so every leader repairs
  identically without coordinating.
- [`src/sync/drivePublish.ts`](../src/sync/drivePublish.ts): leader publish
  path — metadata probe, conditional media upload with `If-Match` (412 →
  re-merge), 403 mapped to immediate leadership surrender.
- [`src/sync/bufferClient.ts`](../src/sync/bufferClient.ts): typed client for
  those endpoints; `authorize(board)` is injected so the collab runtime adapter
  supplies grant-bound signatures from the same device key as WebRTC admission.
  429 maps to pump backpressure; `lease_busy` reads as "not now".
- [`src/sync/leaderLoop.ts`](../src/sync/leaderLoop.ts): one publish cycle
  (claim → probe → download → decrypt+merge → serialize → conditional upload →
  buffer commit → leader commit); conflict commits nothing, forbidden ends
  leadership immediately. Scheduling and lease heartbeat belong to the caller.
- [`services/pboard-signaling/src/op_buffer.rs`](../services/pboard-signaling/src/op_buffer.rs):
  durable buffer — append-only fsync'd journal, torn-tail truncation on
  replay, idempotent insert by op id, ordered replay, per-board/global bounds
  with backpressure, commit marks with retention and atomic compaction. No new
  crate dependencies; ciphertext fields are opaque.
- [`services/pboard-signaling/src/buffer_api.rs`](../services/pboard-signaling/src/buffer_api.rs)
  + `App::with_op_buffer`: HTTP endpoints `/buffer/challenge|ops|list|commit`
  and `/leader/claim|observe|commit`, each authorized by the existing
  board-grant admission proof (fresh single-use challenge + device signature
  over the authority-signed manifest; viewers rejected for writes). Gated on
  `PBOARD_SIGNALING_BUFFER_DIR` — inert when unconfigured. Only
  independent-grant manifests (no Drive bindings) authenticate here;
  Google-shared boards keep using Drive ACLs.
- [`services/pboard-signaling/src/leader.rs`](../services/pboard-signaling/src/leader.rs):
  leases (45 s, renewal keeps epoch, takeover bumps it), `observe`/`commit`
  reporting with monotonic `snapshotSeq` and a `stale` flag that marks
  out-of-order overwrites for the repair merge.

Integration (complete, opt-in):

- [`src/sync/bufferAuth.ts`](../src/sync/bufferAuth.ts): the per-call
  `Authorizer` adapter — fetches a single-use challenge and signs it with the
  same device key and manifest as WebRTC admission, so buffer writes require a
  current authority-signed editor grant.
- [`src/collab/peerHistory.ts`](../src/collab/peerHistory.ts): content keys
  ride the mutually authenticated peer history channel (`key-want`/`key-put`):
  served only to owner/editor peers, stored only after id/material validation,
  and a viewer never receives or stores one. The manager exposes
  `requestContentKey()`/`ensureContentKey()` for first-writer provisioning.
- [`src/sync/bufferRuntime.ts`](../src/sync/bufferRuntime.ts): composes the
  pump, the change journal and the leader publish cycle — nothing touches the
  network until a local committed mutation fires; repeat notifications reuse
  one armed cycle; stop is instant. Ops from foreign content keys stay
  buffered (never dropped) until key converges.
- [`src/sync/driveBoardStore.ts`](../src/sync/driveBoardStore.ts): the
  canonical store — find-or-create `pboard` root and per-board folder
  (single-flight; a rival copy created mid-operation is caught by the
  post-create re-list; cached ids expire after 60 s so an instance whose
  copy was merged away elsewhere adopts the survivor rather than writing
  into the trashed duplicate; duplicate trees merge by content — oldest
  folder survives, children move in, same-name files keep the newer copy,
  the loser in Drive trash), `board.json.gz` lifecycle
  with cached `If-Match` revisions plus cached-id eviction when a snapshot
  vanished underneath, folder-listing board discovery and `attachments/`
  CRUD; private boards are simply folders without extra ACLs, so sharing
  never relocates data. Media downloads use the v3 host — the upload host
  rejects GETs with 405.
- [`src/sync/boardSyncV2.ts`](../src/sync/boardSyncV2.ts): board persistence
  over that store for websocket mode on the exact triggers the legacy path
  used (background loop, blur/pagehide flush, connect, delete) — no parallel
  pipeline, no new loops. `runtime.ts` routes `googleDrive.syncProject/
  reconcileAll/deleteProject/pullProject/pushProject` by the persisted
  collaboration setting; `runtime.bufferRealtime.start(boardId)` starts a
  buffer runtime for connected writers (unified folder + board grant).
  Tests: `tests/sync/driveBoardStore.test.ts`, `boardSyncV2.test.ts` and
  `unifiedMode.test.ts` (persistence issues zero AppData requests in v2
  mode, the legacy probe is a single read-only listing per session, and the
  first reconcile auto-migrates a seeded AppData board including
  fresh-profile import).
- [`src/sync/bufferSnapshotStore.ts`](../src/sync/bufferSnapshotStore.ts):
  snapshot file lifecycle inside a folder (find-or-create, cached `If-Match`
  revision); in the unified layout it publishes the same canonical
  `board.json.gz` as board sync.
- [`services/pboard-signaling/buffer-probe.mjs`](../services/pboard-signaling/buffer-probe.mjs)
  (`npm run test:buffer`) spawns the real server binary against a scratch
  buffer directory and verifies the wire contract end to end: inert without
  configuration, single-use challenges, forged-signature and viewer rejection,
  dedupe, ordered list, lease enforcement, commit, op size/charset limits, and
  durability of uncommitted ops across restart. Buffer/leader routes carry a
  5 MiB body envelope (the 16 KiB API default could not fit op batches).
- Startup/maintenance modules (pure, unit-tested):
  [`src/sync/startupReconcile.ts`](../src/sync/startupReconcile.ts) (pull/buffer
  ladder from snapshot etag + watermarks; not yet called from UI),
  [`src/sync/privateMigration.ts`](../src/sync/privateMigration.ts) (audited
  resumable migration ladder for one legacy `appDataFolder` board:
  folder → export → upload → history → **read-back verify** → flip → seal;
  verification failure re-uploads once, then aborts unverified; source
  read-only, 90-day recovery window),
  [`src/sync/legacyMigration.ts`](../src/sync/legacyMigration.ts) (the
  automatic pass driving that engine per AppData board plus the shared
  `Pboard/` ACL-copy relocation and window-gated source cleanup; wired into
  `runtime.ts` once per session on v2 `reconcileAll`),
  [`src/sync/attachmentGc.ts`](../src/sync/attachmentGc.ts) (attachments
  collectable only after absence from two snapshot revisions).

Verification: `tests/snapshotV2.test.ts`, `tests/bufferPump.test.ts`,
`tests/snapshotMerge.test.ts`, `tests/leaderLoop.test.ts`,
`tests/sync/bufferRuntime.test.ts`, `tests/sync/startupReconcile.test.ts`,
`tests/sync/privateMigration.test.ts`, `tests/sync/legacyMigration.test.ts`,
`tests/sync/attachmentGc.test.ts`, `tests/sync/driveBoardStore.test.ts`,
`tests/sync/boardSyncV2.test.ts`, `tests/sync/unifiedMode.test.ts`,
`tests/collab/contentKeyExchange.test.ts` (live linked-peer key exchange),
plus `npm run test:buffer` (21 live-server checks) and `cargo test --lib`
(21 tests including the buffer/leader/API set) with `cargo clippy` clean.

## Drive operation refactor checkpoint — 28 October 2026

> **Superseded as a status statement.** This entry recorded the protocol
> foundation as not yet the active runtime. It is now the active runtime: board
> persistence goes through the operation log and Drive snapshots
> (`src/sync/operations/`), and `operationSync` defaults to `true`
> (`src/sync/runtime.ts:174`). The entry is kept because it is the point at which
> the transport-independent engine landed, and the
> [architecture assessment](architecture/drive-operation-sync.md) it links to is
> still the design record.

The existing WebRTC toggle remains available in all builds, retains its local
preference and closes the realtime manager without disabling Drive sync. In the
extension build the composition root switches the peer pools off entirely
(`src/sync/browser.ts:17`).


## Automatic-auth budget, relay heal, and why 429s are invisible

Four automatic-auth endpoints plus every WebSocket dial carry every
authorization round trip: `POST /identity/challenge`, `POST
/identity/exchange`, `POST /grants/publish`, `GET /grants/<board>` and `GET
/ws`. The signaling service counts the four HTTP endpoints in **one
process-wide window** (`automatic_auth_per_second = 32`,
`services/pboard-signaling/src/lib.rs:171`), and the reverse proxy in front of it
denies one source IP above its own request-rate limit — one stick table over
`src`, so every tab, every room, the account channel, every identity call *and
every upgrade* share it. The deployed HAProxy backend admits **180 requests per
10 s per IP** (it was 60; the change is host configuration, not repository
content, so treat the number as a deployment fact rather than something this
document can show you a line of).

So one browser that churns — re-enrolling, re-reading a grant that is not
published yet — can lock *the other browser on the same account* out of every
identity round and grant read at once. A refused upgrade answers with the proxy's
own denial (`PR--` in the host's log), which reaches the browser as
`NS_ERROR_WEBSOCKET_CONNECTION_REFUSED` / `NS_BASE_STREAM_CLOSED`, **not** as a
`429` any client can report: an unmetered dial burst and a rate limit look
identical from inside the page. Measured once on a live host, under the older
60/10 s limit: 222 `POST /identity/challenge`, 223 `POST /identity/exchange`, 117
`GET /ws` and 26 `429`s in forty minutes from a single IP, with the worst denial
window made of 8 × `GET /ws` beside 3 × `POST /identity/exchange`.

Client side, `src/collab/authBudget.ts` is the whole answer, and it covers
dials. Every automatic caller in a browser context — identity, grants, the
operation log's dial, the courier's dial and the account channel's dial — spends
from one token bucket — sustained 2.5 requests/second, burst 5 — so two browsers
in lockstep stay under the proxy and one browser stays far under the service. A
`429` pauses every automatic caller in that context for a jittered backoff (full
jitter in `[0, delay]`, `delay` doubling 1 s → 30 s while refusals keep arriving,
decaying after 60 clean seconds) and the refused request is retried exactly once
behind that pause; nothing queues up behind a 429, because the pause — not a
private sleep — is what the retry waits on. Enrollment churn is killed at the
same source: the relay's automatic enrollment round coalesces per board for 30 s,
and a device request that the service already holds is not re-filed inside a 30 s
window, which is what put the doubled `identity/challenge` →
`identity/exchange` pairs into the journal.

**A dial is a request, and the bucket alone is not enough.** A token bucket at
2.5/s still admits a burst of five. Protocol 3 removed the *per-board* dial from
that arithmetic — a page load no longer opens one socket per board, because the
first room dials and every later room attaches (`logSession.ts:880-900`) — but a
cold context still dials once per runtime (the MV3 worker and the sidebar are two
module graphs) and the account channel's room joins on that same socket. Dialling
is therefore bounded twice: by the bucket under the `relay/ws` kind, and by a
**hard count of 8 dials per 10 s per browser context**
(`AUTH_BUDGET_RELAY_DIALS`, `authBudget.ts:168`). One dial costs at most three
proxy requests (the upgrade, `identity/challenge`, `identity/exchange`), which put
8 dials at 24 of one browser's 90-request share under the 180/10 s limit and left
the old 60/10 s arithmetic workable at the same count — which is why the number
did not have to rise when the limit did. The same numbers set the
**context-wide attempt allowance** in `logSync.ts` (8 attempts per 10 s, shared by
every topic) on top of the per-topic ceiling — six attempts per board multiplies
to 36 when eight topics reconnect at once, and the proxy's limit is per IP, not
per room. A dial that has no slot **waits** for one; only the per-topic ceiling
refuses, because only a per-topic loop is a diagnosis. A dial spends its slot and
its token immediately before the socket is constructed — nothing is held while a
connection is in flight — and a dial that never authenticates is counted as
`failed` (`logsync.dial_failed`), because a refused upgrade has no `429` to report
and would otherwise look like a healthy spend.

What that costs in practice, measured (`tests/multiBrowser/latencyProbe.test.ts`):
a two-browser account cold start plus a first board open spends ~3.9 s on the
account channel and ~5.2 s on the first board, of which most of the wall clock is
budget waiting, and a second browser's admission adds ~13 s (16 identity
exchanges, roughly two-thirds of it pacing). An edit with both boards open costs
~35 ms and spends nothing. Those are the numbers the "about 13 s" in gap 5 refers
to.


`pboardCollaboration()` reports both numbers: `authBudget.byKind['relay/ws']`
plus `authBudget.relayDials` (`limit`, `windowMs`, `usedInWindow`, `deferred`,
`failed`), and `reconnectAttempts` (`limit`, `windowMs`, `usedInWindow`,
`deferred`). `usedInWindow === limit` with `deferred > 0` is the client pacing
itself; `failed` climbing beside it is the proxy refusing upgrades anyway.

`GET /grants/<board>` answering `404` means "no grant published right now", not
"never". `src/collab/grantAbsence.ts` remembers that for a bounded window (1 s,
doubling to 60 s) so a browser that opens a board while the owner's browser is
asleep stops reading it over and over; any explicit action — `Reconnect`, a
forced round, a save — clears it.

**Recovery is triggered by state changes, never by a mechanism.** An MV3
worker restarts routinely on idle; `src/sync/background.ts` stamps a durable
`pboardWorkerEpoch` and the sidebar watches it and runs the relay heal leg for
the board actually on screen. So does the first worker message that succeeds
after one failed, and so does the owner's `Reconnect` button in the
collaboration disclosure, and `Sync now` reports what the leg answered. The leg
is conditional by construction: replay operations the relay never carried
(`broadcastUnsent`), advertise if this device is the authority, run the courier
pass if the content key looks wrong, reconnect only if the channel is not
synced, pull a visible gap, and consolidate the log last. A healthy board
answers with `idle:synced` and **no relay request at all** — that condition is
what keeps routine worker restarts out of the rate budget instead of adding
reconnect churn to ordinary browsing. The same conditional leg runs per board
inside a forced reconcile, failure-isolated, and arrives in
`DriveReconcileResult.relay` as `healed:<steps>` / `idle:<reason>` /
`failed:<reason>`, so "Sync now" can say what the relay did.

A throttled background tab is a supported state, not a fault. Firefox runs one
timer callback per minute there, so the 15 s heartbeat cannot be the recovery
path; on `visibilitychange` → visible the log channel reconnects immediately
instead of waiting for a backoff timer, and a hidden disconnected board is
reported as expected rather than as an error. `pboardCollaboration()` now shows
the request budget (`authBudget`: rate, waiters, cooldown bound, the
`relayDials` allowance with its `usedInWindow`/`deferred`/`failed` counts), the
context attempt allowance (`reconnectAttempts`) and each room's
`log.reconnectReason` with the last five scheduled reconnects, so the next
occurrence is readable from the console.

**Backoff became a policy, not a suggestion.** A connection that never reaches
`synced` does not get its delay forgiven for having authenticated — the
connect→authenticate→die loop keeps climbing the 1 s → 30 s ladder, because
that loop is exactly the pattern that spent the shared budget in November.
Immediate reconnection (visibility, worker epoch, heal) applies only to a
connection that was *healthy* when it ended — the proxy-aged tunnel — and
every other trigger merely guarantees the next attempt stays scheduled. On
top of the ladder sits a ceiling: more than six connection attempts for one
board inside any thirty-second window means something outside the backoff is
driving, and the board stops with `reconnect:throttled` (visible as
`THROTTLED(Reconnect to retry)` in `pboardCollaboration()`'s `reconn` column
and as the board's status sentence). The attempt ledger belongs to the board
inside the browser context, so re-creating the room is not an escape hatch;
only a person's `Reconnect` clears it, and the forced heal leg passes the
ceiling exactly once per press — and that bypass still waits for a context dial
slot, because the per-topic ledger is a local decision while the proxy's per-IP
budget is not. Six per topic is also *only* a per-topic bound: eight topics
reconnecting at once (a page load, or every tunnel dying together) would be 48
attempts. On top of it sits the context-wide allowance described above — 8
attempts per 10 s, shared by every topic — which **queues** a dial instead of
refusing it. That asymmetry is deliberate: a per-topic loop is a diagnosis and
must stop, while many healthy rooms opening at once must all open, merely spread
out. A board can therefore wait at most one window for a slot; it can never be
silenced by another board's churn, and it never reports `reconnect:throttled`
because the context was busy. A refusal of the automatic authorization
itself — a `403` at identity exchange, or one of the relay's terminal refusal
codes — ends the connection terminally as `admission:refused`: the service has
already superseded that authorization, no retry can succeed, and again only
`Reconnect` retries.

**A dead Google session stops relay work and says so.** A Drive role lookup
that *throws* is not a revocation: when the auth store has been cleared (the
401 path clears it), every role call throws and treating that as `revoked`
silently stops publishing while joiners 404 forever. Those sites now classify
through `getConnectionState()` — `revoked` only when the account is still
connected — and the heal leg answers `failed:drive-unauthorized` before it
spends any identity request against a dead token. `pboardCollaboration()`'s
`grantAbsences` additionally distinguishes `expired` (this browser read the
grant before; the lifetime lapsed while the authority browser slept) from
`never-published`, because those two 404s deserve different sentences. The
grant lifetime itself — five minutes, renewed inside the last two — is now the
named pair `BOARD_GRANT_LIFETIME_MS` / `BOARD_GRANT_RENEW_WINDOW_MS` in
`src/collab/boardGrants.ts`: the lifetime *is* the revocation latency, and
changing the values (and with them the ~20 Drive writes per open board per
hour) is a protocol decision, recorded there rather than hidden in literals.

## One WebSocket per session: the multiplexed operation log (protocol 3)

> This is the detailed record of the transport summarised under
> [Transport](#transport-one-websocket-per-browser-context) near the top: the
> per-room state machine, what a board switch costs, and the v3/v2 negotiation.
> It describes the running code; the entries between it and that summary are
> history and budgets.

The relay used to be *one room per connection*. That implied one socket per
board, and it made every board switch a dial, an upgrade and a full admission —
in a flaky tunnel, multiplied by the number of boards visited. Protocol 3
removes the implication: a connection authenticates **once** and then attaches
and detaches rooms on the socket it already has.

Nothing about protocol 2 changes. A server that offers `[1,2]` in
`supportedVersions` gets the deployed behaviour byte for byte, and a client must
never assume 3 — it negotiates by capability and falls back.

### The owner: one socket per `(relay URL)`, one device per room

`src/sync/operations/logSession.ts` owns the socket. It is created by whichever
room dials first (the "prober"), it outlives every individual room, and it is
looked up in `relaySessions` by **relay URL alone**. That is the whole of "one
WebSocket per session": a module graph is a browser context, and a context has
one relay URL, so the session registry *is* the invariant.

The socket is **not** keyed by device key, and it must not be. Each board
enrols its own device (`board-device:<board>`, `signalingSelection.ts`), so the
rooms on one socket are signed by different keys. What makes that admissible is
the v3 `attach` frame carrying its own `deviceKeyId`:

```json
{"type":"attach","room":"<room id>","deviceKeyId":"<this board's device>",
 "signature":"…","authorization":{…},"serviceAdmission":"…"}
```

The service verifies the room's proof against the device the frame presents, and
the service receipt is consumed for exactly `(challenge, session, room, device)`.
So one connection acts for many devices, and **each room keeps its own
attribution**: every operation a room appends is authored by *that room's*
device, never by the device that happened to dial the socket. An earlier
arrangement keyed the client's session map by `(url, deviceKey)` because a v3
server could only verify an attach against the connection's device; two boards
then could not share a socket at all, and the relay answered
`service_auth_required`. That limitation is gone with the field.

A service receipt, unlike the device key, is **not** reusable: the service
consumes one per `(challenge, session, room, device)` on presentation, so every
`attach` mints its own through the same `admitService` the private path uses.
The client keeps only in-flight pairs, never a settled receipt — a minute-long
reuse cache handed a spent receipt to the next attach of the same board, which
then answered `service_auth_required` (terminal) on every later attempt while a
sibling room carried on syncing. A receipt that cannot be minted is that room's
own cause and stays that room's: it retries on its own backoff through the same
auth budget, and the socket and its other rooms are never disturbed.

### Per-room state machine

Every board is a room, and every room runs the same machine whichever transport
carries it — a private v2 socket or the shared v3 one. `logRoom.ts` holds the
transport-independent half (cursor, applied sequence, unacknowledged queue) and
`logSync.ts` the status half:

```
connecting ──attach/admit──▶ bootstrap ──replay applied──▶ synced
     ▲                           │                           │
     │                           │   history pruned          │ socket lost
     │                           ▼                           ▼
     │                        snapshot ◀─────────── offline (backoff)
     │                                                       │
     └──────────── explicit Reconnect ◀───────── error ◀──────┘
                                                (terminal cause:
                                                 unauthorized,
                                                 authorization_changed,
                                                 grant_expired, …)
```

The states and who owns each transition:

| State | Meaning | Leaves it on |
|---|---|---|
| `connecting` | no attachment on a live socket yet | `attached` → `bootstrap` |
| `bootstrap` | attached; the first replay window is being applied | `synchronized('synced')` → `synced`, `synchronized('snapshot')` → `snapshot` |
| `synced` | live and caught up; edits are submitted here | socket loss → `offline`, a coded `detached` → `error` |
| `snapshot` | the history was pruned; a Drive snapshot must be read first | `resumeFrom(sequence)` → `bootstrap` |
| `offline` | the connection is down or awaiting backoff; the room stays *wanted* | recovery re-attach → `bootstrap` |
| `error` | terminal: a refusal or per-room detach, retried only by explicit Reconnect | `Reconnect` → `connecting` |

Two properties are load-bearing and both are per room:

- **The cursor is the room's own.** Recovery re-attaches the room and bootstraps
  from *its* `appliedSeq` (`subscribe {afterSeq}`), so a drop costs the history
  the room had not yet applied and nothing more. Rooms never share a cursor.
- **A room's failure is the room's.** A `refused` or a server-initiated
  `detached{code}` is routed to the room it names and to no other: the socket
  stays, the siblings keep their phase, their cursor and their attachment, and
  the failing room reports the code it was given in its own vocabulary
  (`error: "authorization_changed"`). A detach is therefore *not* a disconnect,
  and a refusal does not spend a re-admission. The recovery set (`wanted`) is
  what survives a drop; a terminal room leaves it, so nothing re-dials for it.

### Board switching, re-opening, and what a switch costs

- **Switching board A → B** detaches A's room and attaches B's — same socket,
  same authentication, one `detach` and one `attach` on the wire.
- **Re-opening a board this context already holds** is answered locally: the
  session sees the room in `live`, hands the new handle the role it already has,
  and sends nothing. Zero sockets, zero admissions, zero attaches.
- **A brand-new board under a new device key** attaches to the live socket. One
  attach, no dial, no admission.
- **A drop** (tunnel death, server restart) schedules one recovery dial and
  re-attaches every room in `wanted`, each from its own cursor. The end state is
  exactly one live socket, whatever the board count.

### v3 versus v2 selection

The first room on a relay URL is the prober. Its welcome decides the mode for the
whole context:

1. dial once, read `supportedVersions`;
2. **contains 3** → `begin()` takes that socket over and the context multiplexes;
   every later room attaches;
3. **does not contain 3** → the probe's socket is handed back to the room and
   every room keeps dialling its own, exactly as before. The v2 path is untouched
   by this change — same frames, same admission, same backoff.

Because a v2 server closes the socket on an unknown frame, the client must never
send `attach` speculatively: the mode is settled from the welcome, not assumed.

### The socket budget, and why it had to change

`Limits::session_bytes` was a *lifetime* cap per socket that never reset — fine
for a socket reopened on every switch, fatal for the one long-lived socket v3
asks a client to hold: a healthy connection would eventually die of the bytes it
had already delivered. The service now accounts **per rolling window**, with a
connection budget and a separate per-room budget, so one busy board cannot starve
the rooms that share its connection (the server side of that change is described
in `services/pboard-signaling/PROTOCOL.md`).

### Known limitation, stated as a fact of this build

The account channel (`pboard-account-<hash>-order`) enrols its own device
(`account-device:<hash>`) and is a room like any other, so it joins a board's
socket on the same terms. Two things are **not** true:

- **Cross-account delivery does not exist.** Another account's devices cannot
  discover or reach a board over the socket, because an account room is writable
  only by that account's own devices. The per-account inbox that would route a
  hint across accounts is implemented **server-side only**
  (`services/pboard-signaling/src/account_inbox.rs`) and has no sender or
  consumer in `src/`; it is not faked with polling, and Drive polling is what
  actually finds such boards.
- **The channel is inert in the shipped build anyway** (gap 1): without an
  `account:<hash>` pin it reports `absent-pin` and attaches nothing, so in
  practice this room is absent from the socket rather than sharing it.

Everything above is per *browser context*, not per tab and not per profile: the
MV3 worker and the sidebar are two module graphs, so they are two sessions and
two sockets — the same split as before this change, and the reason the
`relaySessionSnapshots()` diagnostics console lists them separately.

## Relay admission posture and account-lease keep-alive — 7 November 2026

The deployed relay switched to manifest-cryptographic admission for every
room. On the operator's explicit decision, `PBOARD_SIGNALING_GOOGLE_EMAILS`
and `PBOARD_SIGNALING_GOOGLE_IDENTITIES` were removed from the service and
`PBOARD_SIGNALING_REQUIRE_TLS_PROXY` set to `0` (the binary's
`public_service_requires_google_admission` guard keys on that flag; HAProxy
still terminates TLS for every client and the app binds loopback only — see
vps-maint `PBBOARD-COLLABORATION.md` / `CHANGELOG.md`, 2026-11-07 entries).
Consequences for this repository:

- **No service-admission tickets.** With no enrollment configured, the
  welcome omits `requiresServiceAdmission`, so `admitService` and the whole
  Google-exchange path stay silent on the live relay. The code paths remain —
  servers that configure enrollment still get the checked flow — but nothing
  may assume a ticket will be requested. A relay that answers welcome with
  `requiresServiceAdmission: true` while the client cannot reach
  `/identity/exchange` produces the silent welcome→close loop observed on
  7 November; the journal signature was `identity_enrollment_verified` →
  `unauthorized` (browser-signed authority) or plain `service_auth_required`.
- **The extension must hold the relay host permission.** The relay origin is
  declared in `manifest.json` `host_permissions`, because every
  endpoint-gated call (`hasSignalingHostPermission` →
  `canAccessEndpoint`) refuses silently without it. A missing host permission
  is the canonical cause of "dials, receives welcome, sends nothing, closes".
- **Five-minute room leases need an attached keep-alive.** `MANIFEST_LIFETIME_MS`
  is 300 s and the server caps issuance at 360 s (`admission.rs`), so an
  attached account socket's lease expires between reconcile rounds by design.
  `keepAccountManifestTicker` (runtime.ts) renews under the pinned authority
  on a 60 s tick whenever the account channel reports `connected` and the
  manifest is expired or under two minutes from expiry. Renewal is authority
  business: only the browser holding the authority key publishes; other
  devices re-attach on manifests the round refetched.
- **Android can reach the identity endpoints at the edge.** HAProxy now
  answers CORS for `Origin: https://localhost` on `/identity/*` only
  (vps-maint `deploy/pboard-signaling/haproxy-cors.cfg`). It is inert with
  enrollment disabled and kept so a future enrollment-enabled relay works
  from the WebView without another edge change.
- **Socket lifetime semantics unchanged and now actually met:** the account
  channel stays attached while the browser lives or the Android app is
  foreground; Android stops all live channels when backgrounded
  (`service.ts` `setForeground`), which remains the only deliberate teardown
  short of disconnecting Drive.

## Same-account board-grant discovery through Drive — 8 November 2026

Symptom that hid for two days: every device appeared healthy on the relay —
authenticated, attached, sends flowing — yet no live frame ever reached
another device, and sync looked Drive-only. The server's operation log named
the cause: every board room had exactly one device, ever. The room name
carries the signing authority's fingerprint (`relayAdmission.ts`), and each
browser had minted **its own board authority**, because the one question that
prevents a second authority — `directoryAdvertisesAuthority` — was answered
by the enrollment-era identity directory. With enrollment off (posture
above) that question can never be answered, it swallowed to "no authority",
and every device dutifully created its own private room.

The fix keeps the existing grant machinery and changes only discovery and
membership transport, both to the one channel every device of the account
shares — the account's Drive appDataFolder:

- **Grant mirror.** After each relay publication, the authority device also
  writes `pboard-board-grant-<board>.pboard` beside the account authority
  file (`grantExchange.publish`, runtime). Content is the public bundle —
  public keys and signatures only — mirroring is best-effort on write.
- **Decision.** `decideAuthority` consults the mirror first, before even the
  local restore probe: a published grant means *join*, never rival — this is
  what keeps a browser that minted its own authority during the split era
  from restoring it from stale keys. Joining is safe for the legitimate
  authority device too: ownership derives from root key + roster, not from a
  stored flag. A **failed** lookup blocks only `create` (restore and rekey
  carry their own cryptographic proofs and survive a Drive outage); a
  malformed mirror naming another board is a hard refusal, and an explicit
  Drive-ownership re-key refuses while a mirror governs.
- **Join.** A device with no authority stores the published bundle as its
  record (full `verified()` first: fingerprint, history, its own listed
  device) and presents it unchanged. All devices present the same manifest
  bytes, so all rooms converge on one fingerprint — that is the whole sync
  fix. A joining device holds no authority key: `ownsAuthority` stays false;
  rotations remain authority-device work, as with the account manifest.
- **Membership.** A device that finds a published grant (and a device joining
  one) announces its board identity —
  `pboard-board-member-<board>--<deviceKeyId>.pboard`, signed by the board
  device key. The authority device folds announced members into the roster at
  the next issuance (role `editor`; blocked devices stay blocked; explicit
  roles win). Same-account devices converge without pairing codes; the
  pairing flow remains for cross-account grants.
- **Not changed:** relay publication itself (still authoritative for readers
  via `/grants/<scope>`), the never-overwrite record rule (`saveIfAbsent`),
  revocation, recovery, and the enrollment directory — which stays wired
  behind the mirror for enrollment-enabled deployments. Related noise fix:
  `/identity/challenge` answering 404 is now understood as "this deployment
  has no identity enrollment" (`enrollmentAbsent` in
  `googleIdentitySharing.ts`) — automatic directory rounds resolve to an
  empty directory and the authority oracle answers false instead of throwing
  `HTTP 404` at board paths or hammering the endpoint every round. Explicit
  sharing actions still reach the endpoints and fail loudly.

Operational notes: an existing browser that already split (its own authority
from the bug era) keeps its private room until its stale grant records are
cleared once — disconnect/reconnect alone does not clear them; remove the
`pboardBoardGrants` storage entry, then reopen the board to announce and
join. Board grants live while the authority browser renews them (5-minute
lifetime, unchanged): a board whose authority browser stays closed goes
Drive-only for the live lane until it opens again.

## WebSocket control frames closed the connection — 8 November 2026

A board room detached with `detached:invalid_frame` while idle: the session
loop read `let Message::Text(text) = frame else { reason="invalid_frame"; break }`,
which is RFC-compliant hostility — a browser keep-alive-pings a WebSocket whose
worker went into the background (unsolicited, unblockable), tungstenite surfaces
that ping in the stream, and the connection ended. What looked like a flaky room
was the socket dying of its own browser's health check; every room on it went
with it, and the 300-second grant leases expired behind the dead socket
(`GET /grants/<scope>` answering 404 behind an errored room is this shape).
The relay now answers control frames the way the protocol layer promises: ping
and pong refresh the inbound-idle clock and spend neither the message-rate nor
the byte budget; a Close ends the session; only a Binary frame stays an invalid
frame (`lib.rs`, hardening test
`browser_control_pings_keep_the_connection_and_binary_still_closes_it`). The
application heartbeat remains the JSON ping every 15 s — this fix makes idle
survivable, not unnecessary. Deploying this binary is part of the fix: until
the service is updated, a backgrounded browser still loses its rooms at the
next keep-alive. Activation completed the same day at 13:36 UTC: the
feature-free release build (SHA-256 `c0aba8cf33787860ccdf76e8234d33cc027e108aa0f889e9c93b8e792782c4b9`)
replaced the executable atomically and only this service restarted; the
rollback copy, configuration checksums and post-activation validation are
recorded in the service README (“Control-frame keep-alive fix — 8 November 2026”).

**The renewal that never ran — 8 November 2026 (second entry that day)**

A second same-day defect turned the fixed keep-alive behaviour into its
successor: boards attached, worked, and every room detached exactly 300 s
later with `grant_expired`. The grant manifest is renewed *lazily* —
`boardCollaboration.security()` re-issues the manifest only when a caller
arrives inside the two-minute renew window — and after the operation-log
rewire no caller ever arrived again: the room factory asks for security once,
at open. The account manifest has always had a 60-second ticker for exactly
this reason (`keepAccountManifestTicker`); the board grant never got its
twin. Consequences observed live: attached rooms died on a five-minute timer
even while fully idle, and a second browser could only join during the first
five minutes after the authority browser opened the board, which reads to a
person as "it synced once and then never again". `armBoardGrantKeepAlive`
(runtime) now runs that missing heartbeat for every attached board — one
tick a minute, gated on `ownsAuthority` because only the authority browser
can re-sign the manifest, and `security()` republishes the current epoch on
the authority browser when the renew window has not opened. The invariant to
watch for: while an authority browser holds a board open, the journal shows a
`board_grant_published` epoch increment every few minutes and no attached
room ever says `grant_expired`; a second browser can then open the same board
at any moment, not only within five minutes of the first.

### Manual Drive folder review

In Android Settings → Google Drive or below the Firefox collaboration panels, **Review Drive folders** lists direct board-folder candidates under every `pboard` root. The scan is read-only and compares folder names with the boards and deletion facts available on this device. An unidentified folder may be a live board or its only recovery copy on another device; absence from the local list is not proof of deletion. The report shows the newest modification date among direct files, excluding subfolders; expand a folder to see its ID and direct contents before deciding. An owned, non-active folder may be moved to Google Drive Trash only after an explicit per-folder confirmation and exact-name entry. The app rechecks the account, root, folder ownership, local board list and direct contents before the move. Unidentified folders containing subfolders are excluded. No permanent deletion is performed, and this does not garden operation history within a live board.

## A protocol verdict that read as throttling — 9 November 2026

One browser of a two-browser pair stopped starting its WebSocket entirely; the
other worked. Its journal read `Operation log refused: malformed`, then
`Operation log is disconnected` on every later attempt. The service log called
the same twelve sessions `reason="malformed"`, ~300 ms after they opened, with
no `authenticated` line at all: the connection died on its **first** frame.
Verified against the deployed relay: with `negotiated` still 1, a frame that is
not a `Client` variant fails the strict parse (`lib.rs:1070`), so a pre-auth
`attach`/`detach`/`renewGoogle`, or an `authenticate` carrying one unknown
top-level field, is answered `{"type":"error","code":"malformed"}` + close —
while a pre-auth `ping` is `invalid_state`. `without_unknown_fields` only runs
once a connection is v3 (`:1281`), which is why the tolerance exists but does
not cover the frame that negotiates.

The client made that unrecoverable by classification, not by protocol:
`malformed` was not in `TERMINAL_REFUSALS`, so a refused room asked
`attachWanted` to rebuild the whole shared connection, each rebuild spent a
dial from the context's allowance, and after six in thirty seconds the per-topic
ceiling engaged. From then on the sidebar reported `reconnect:throttled` and
**nothing automatic would dial at all** — the real cause had been replaced by
the symptom of surviving it, and only an explicit Reconnect would resume. That
is why the second browser looked dead rather than refused.

The protocol family (`protocolRefusal`, `logPolicy.ts:60`) is now terminal, and
terminal at the **connection**: the session records the verdict (`protocolVerdict`),
`dial` refuses to ask the relay again, `recover` reports the service's own code
to every room and stops instead of laddering, and `describeLogStatus` says the
two sides do not speak the same protocol instead of "the server refused this
board". An explicit Reconnect clears it, because either side's build may be the
thing that changed. What this does *not* do is hide the mismatch: the code the
service sent is the code the person sees.

Deployment state measured the same day, for the next reader of the same journal:
haproxy on the OVH host already allows `/drive/admit` and `/identity/challenge`
(`/etc/haproxy/haproxy.cfg:59-60`, limit 180/10 s), so a 404 from
`/identity/challenge` is the **service's own** posture
(`identity_enrollment.rs:381`, no `google_enrollment` configured — see the
`enrollmentAbsent` note above), not a stale proxy rule. Do not go looking for a
proxy reload in this incident; there was none to do.

### Legacy relocation and restrictions disabled

Automatic relocation of legacy boards and automatic read-only restrictions on
legacy snapshots are disabled. Operation sync no longer requires those older
files to have a read-only restriction. Existing Drive restrictions are not
removed by this change. The `migration-*.json` baseline records remain in use
by current boards and are still read when another device opens them.

### Drive-authorized operation sync

The operation-sync client uses Google identity and Drive permission checks for
account and board rooms. It does not fall back to signed device authorities or
the identity-enrollment directory when those credentials are unavailable; the
live channel remains unavailable until they can be obtained. Its collaboration
panel no longer starts the old enrollment flow or offers legacy grant controls.
The relay's legacy protocol endpoints are unchanged and remain separately
deployable; disabling those server endpoints requires a coordinated deployment.

