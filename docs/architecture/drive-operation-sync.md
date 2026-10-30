# Drive-first operation synchronization

Status: active default browser and Android runtime, 28 October 2026. Supersedes
peer-authority and mutable-board synchronization for normal application use.
No dependency, authentication service, backend, or framework was added.

## Original architecture assessment (28 October 2026)

- `types/index.ts` and `storage/rxdbSchemas.ts`: boards are projects, with name,
  template, revision, timestamps, fractional order and tail order. Cards contain
  title/content, type, status, display mode, source, image hash/metadata, fractional
  order and soft/permanent deletion. There are no persisted editable columns;
  status sections are presentation. Account project order and current selection
  are separate settings. Images use IndexedDB blobs with data URLs at legacy boundaries.
- `storage/rxdbRepository.ts`: React subscriptions observe RxDB over IndexedDB.
  Commands are locally serialized; no network acknowledgement is needed for local
  unsigned edits. Signed boards have an offline pending-edit overlay and cached
  entitlements. `journalStorage.ts` writes a separate IndexedDB WAL before RxDB,
  then records the outcome. Startup compares prepared values with durable documents.
  This is recovery across two databases, not a transaction spanning both.
- `changeJournal.ts`: content-addressed document versions with parent IDs, receipts,
  permissions, conflict drafts and pending edits. Existing identity is a hash of
  entire document bytes and ancestry, rather than an actor sequence stream.
- `causalReconciliation.ts`: retains conflicting variants and offers three-way
  previews for selected fields. Structural/concurrent deletion conflicts need user
  resolution. The RxDB replication conflict handler separately uses document clocks.
  These paths cannot be reused as automatic operation convergence unchanged.
- `sync/driveBoardStore.ts`, `boardSyncV2.ts`: visible `pboard/<id>/board.json.gz`
  plus attachments; mutable whole-board gzip snapshots with conditional writes.
  Sync reads/serializes entire boards, with one retry after a concurrent write.
  Legacy private and account-preference paths still use AppData; shared legacy
  boards use `Pboard/<id>/project.json`. Existing migration relocates board data.
  Folder deduplication currently merges children by filename/modifiedTime, which
  is unsuitable for immutable history: immutable files must be preserved by ID.
- `drivePermissions.ts`, `sharedDiscovery.ts`: Drive folder ACLs, identity and
  invitation discovery are reusable. Viewer signaling has separate write access.
  Current shared sync restores images but an existing local board does not
  necessarily discover another editor's document updates without a live peer.
- `collab/manager.ts`, `webrtcHandler.ts`, `peerHistory.ts`: two RxDB pools per board,
  Drive/WebSocket signaling, DTLS channels, scoped document transfer plus signed
  causal history. Device grants/manifests and authority enrollment can require the
  original browser online. The optional server-buffer path adds a single writer
  lease and mutable snapshots. Neither is the proposed persistence protocol.
- Existing toolbar (`sidebar/App.tsx`) has Drive sync and a persisted live WebRTC
  toggle that renders unconditionally (`LIVE_COLLABORATION_STORAGE_KEY`); the
  `VITE_PBOARD_SIGNALING_PROVIDER === "websocket"` flag gates only the debug-section
  button. Manager disable closes resources; Drive scheduling is independent. Reuse both
  controls. Compact belongs in an owner maintenance popover on narrow screens.
- No application undo/redo command stack was found in `src` or Android sources.
  Escape cancels uncommitted form edits; trash restore is a normal card update.
  A future command undo must emit conditional property changes, never restore a board.
- Vitest covers storage, peer history, permissions, snapshots, recovery and the realtime
  frame rules (`tests/operations/realtime.test.ts`, 49 assertions). The live
  browser/WebRTC and UI performance harnesses (`npm run test:webrtc:browser`,
  `npm run test:ui:perf`) are integration checks outside vitest; toolbar overflow is
  asserted by the post-build Chromium smoke, not vitest. Counters
  track renders, emissions and recurring work. Prior measurements in collaboration
  docs are historical; they are not evidence for this new protocol.

## Convergence model and protocol

The domain has projects and cards. Status sections are fixed UI columns, not
persisted column entities. Moves change status and/or existing fractional order
keys. Project order, current selection and WebRTC preference remain local/account
settings. Images are atomic hash/MIME/dimension references, with separate bytes.

`protocol.ts` defines `pboard-operations-v1`: versioned `create`, `patch` and
terminal `delete` commands for projects/cards. Patches contain changed properties
and explicit optional-property unsets. Each operation has a random persistent
actor stream, contiguous sequence, stable `actorId:seq` ID, Lamport clock and
causal vector. One strict journal transaction allocates the sequence, stores the
operation and its outbox row. Shared extension contexts serialize allocation in
IndexedDB; independent profiles/devices have independent random actors even on
the same Google account. No timestamp or account email allocates operation IDs.

`engine.ts` uses per-property registers ordered by (Lamport clock, actor in code
unit order, sequence). Causally later operations have greater clocks. Concurrent
independent properties merge; conflicting edits select the same deterministic
winner everywhere. Source and image are atomic properties. Order is fractional
key then stable entity ID. Concurrent moves/order edits therefore converge.
Permanent deletion wins over all updates/moves and cannot recreate that ID.
Trash/restore are normal status/deletedAt edits; creation after permanent deletion
requires a new entity ID. Updates before creation are retained but invisible.

Every transport invokes the same validator/engine. Duplicate IDs are compared
against exact SHA-256 receipts, including after checkpoint restore; conflicting
bytes stop synchronization. Dependencies wait in an actor-indexed queue. Only a
complete contiguous prefix advances the frontier; missing references, gaps and
unsupported versions remain recoverable errors. Network inventories are retried
rather than dropping dependent operations. Canonical state excludes local and
ephemeral fields. No peer chooses the authoritative board.

A small domain engine fits this schema without a new CRDT library, generalized
sequence tree, or translation of existing storage APIs. Its tradeoff is explicit
register semantics rather than character-level collaborative text merging.

### Concrete operation example

```json
{
  "schemaVersion": 1,
  "boardId": "board",
  "actorId": "writer-device",
  "seq": 1,
  "opId": "writer-device:1",
  "clock": 3,
  "deps": { "baseline": 2 },
  "collection": "cards",
  "entityId": "card",
  "kind": "patch",
  "fields": { "status": "done", "orderKey": "a1" },
  "unset": []
}
```

Creation requires complete domain fields; `patch` supplies changed fields only;
`delete` has empty fields/unset. `source` and `image` are atomic values. Images are
hash references plus MIME/dimensions, with bytes in the existing blob/Drive asset
path. No project account order, local selection, provenance credential or transport
preference is part of an operation. Property clocks do not use wall-clock dates.

## Local durability and materialization

`source.ts` adapts the existing document WAL, without serializing/diffing a board
per edit. A local command prepares an immutable document journal entry, commits
RxDB, finishes the entry, and converts its changed domain properties into an
operation. Journal schema **10** adds operation stores and pending/source indexes;
legacy rows remain. The committed-entry transaction also writes a conversion
intent when the board is bound. Conversion is idempotent on source ID. Startup
first recovers prepared document entries by durable value comparison, then
recovers conversion intents. This preserves the existing two-database recovery
protocol: it does not pretend RxDB and the separate journal share a transaction.
An interrupted conversion leaves recoverable WAL work, not a successful network
acknowledgement or a silently lost edit.

`projection.ts` materializes only touched entities into existing RxDB collections,
using the existing journal-materialization scope so receives never manufacture
new local edits. Bootstrap/checkpoint replacement performs one full projection.
Journal notifications are board-scoped so an edit does not wake every cached
board session. Applied frontiers commit before projection; other contexts reload only the new
operation tail and checkpoint generation. Existing reactive subscriptions, blobs,
imports/exports, trash restore and staged form cancellation remain intact.
There is no existing application undo/redo stack to replace. Whole-board restore
is never used to undo another user's edit.

The outbox distinguishes local persistence, realtime send, verified Drive
publication, and incorporated snapshot. Peer delivery never clears publication.
Sequence/WAL/outbox writes and upload intents use strict IndexedDB durability.
Browser storage is still subject to user clearing or platform eviction; it is not
a substitute for an acknowledged cloud backup.

## Regular Drive organization and synchronization

Keep the existing board folder, sharing ACLs and legacy discovery file IDs. Both
legacy `Pboard/<board>/` and unified `pboard/<board>/` layouts are supported. New
immutable files are direct children to avoid another shared-folder creation race:

```text
<existing board folder>/
  project.json                     retained, read-only discovery/legacy recovery
  board.json.gz                    retained if present, read-only legacy recovery
  migration-<Drive file ID>.json    immutable upgrade/baseline reference
  operations-<segment ID>.json      immutable operation batch
  snapshot-<snapshot ID>.json       immutable complete checkpoint
  image-<SHA-256>.json              immutable image asset
  realtime/                        existing ephemeral signaling records
```

Names are hints, never unique identity. Inventory, verification and deletion use
actual Drive IDs. Immutable collisions survive legacy folder merging. No new board,
operation, snapshot, image, preference or erasure data is written into
`appDataFolder` by the operation protocol; old AppData copies are read-only
migration/recovery sources. The legacy compatibility path still uses AppData for its
own records (`src/sync/driveTransport.ts:31,68,83,114`), so that claim is scoped to
the operation protocol.
Account preferences and private erasure markers use the existing regular root.

Local edits commit immediately and are sent over WebRTC immediately when available.
Automatic Drive publication runs at the earlier of 30 minutes of editing inactivity
or 25 minutes after the oldest unpublished operation. Since 25 minutes is shorter,
the oldest-operation deadline normally wins. Pending operation timestamps survive
restart; older outbox rows without timestamps are treated as overdue. Manual Sync
flushes immediately. Background Drive polling starts at 10 minutes and backs off
exponentially with jitter to one hour. Android schedules work while in the foreground;
when suspended or offline, pending work is retained and retried on return.

Segments hold at most 128 operations/4 MiB, and
2 MiB per operation. A pass prepares up to eight segments and schedules remaining
publication. Its pre-generated Drive ID and exact payload are durable before
multipart CREATE. Retry uses the same ID; 409 and successful uploads require
exact read-back verification. Published segment envelopes also carry a SHA-256
checksum; editor bootstrap markers commit to the complete baseline checkpoint,
so a missing final segment cannot masquerade as a complete baseline. Failure retains the intent, with bounded exponential
backoff and jitter; manual Sync bypasses per-intent retry delay, but respects the
Google quota cooldown. A crash after remote success
but before local acknowledgement therefore adds no logical operation or file.

`changes.ts` persists an account-wide Drive Changes token **with a durable file-ID
inbox**, then downloads operations. It filters by known board folder IDs, follows
pages, separates accounts, and recovers expired/unavailable cursors through full
inventory. Automatic feed checks are shared across boards within a context and
run at most once every 15 seconds; manual Sync checks immediately unless quota
cooldown is active. Full inventory also runs every five minutes and on manual Sync.
Quota-denied feed calls propagate without falling back to full board listings.
Active board polling adapts from 15 to 120 seconds with jitter; board activation
recovers immediately. Existing account discovery/background alarms remain.
Polling continues with WebRTC enabled or disabled. Manual Sync always runs a fresh
pass, discovers snapshots/logs, retries the outbox and preserves concurrent local
edits. Status cannot report synced with an unpublished outbox or clear a newer
local dirty token.

### Request cost and quota

Every Drive funnel prices its request through one model, `src/sync/driveQuota.ts`:
base 1, +1 per top-level projected field, 2 when a projected field carries a nested
selection, +`pageSize` for the list, search and permission-list resources, +10 for a
continuation page, and base-only for `alt=media` and `generateIds`. Google's
`X-Drive-Request-Cost` response header is authoritative: the throttle charges the
cost Google reported when the response carries it, and the model value is the
projection used before the response arrives. A derived projection is reported as a
model, never as a measurement. The table is pinned in
`tests/driveFieldCostModel.test.ts` and mirrored by
`experiments/collaboration/driveFieldCostModel.mjs`.

The local ledger is shared by Drive transports within one JavaScript context,
using a fixed one-minute window. Other contexts and devices contribute to Google's
per-user quota but are absent from this local estimate. Its default is the
documented per-user figure a browser client is bounded by: 325,000 cost units per user
per project per minute, against 1,000,000 per project per minute
(https://developers.google.com/workspace/drive/api/guides/limits, last updated
2026-09-11). `DRIVE_DEFAULT_COST_PER_MINUTE` carries that figure; the previous 10,000
was unverified and produced deferrals on an ordinary inventory burst.

The throttle defers when the accounting it holds plus the pre-flight projection exceeds the
limit, then waits the rest of the window, so a deferral can be triggered by the
estimate on a request Google would have served — a `pageSize=200` inventory list
projects 204 while the documented price for a list is 100 (5 for a read, 200 for a
download, 50 for an edit, 5 for other). A reported `X-Drive-Request-Cost` corrects the
charge. The ledger remains a local estimate, not a measurement of total account usage.
An actual quota denial starts a 60-second cooldown regardless of the local charge,
doubling on repeated denials up to five minutes. During cooldown other calls fail
with the same quota classification and remaining wait without sending requests or
queuing retries. After five minutes without denials the backoff resets. Changes
feed requests, immutable uploads and quota-shaped 429 responses share this handling;
quota-shaped 429s are not replayed by the short transient retry loop.
Quota is quota, not permission — `rateLimitExceeded` and `userRateLimitExceeded` reach
the caller as `DriveQuotaExceededError` before any role mapping, so a rate limit is
never read as `revoked`, while `insufficientPermissions`,
`accessTokenPolicyInsufficient` and `insufficientScopes` stay permission failures.
`capacityExceeded` is storage quota, not API quota. The reported error labels the
accounting as a local estimate and states only a
relation that holds: `charged N of limit M` while the window is inside the budget, and
`projected cost N > limit M` only when the projection genuinely crosses it.
`secondDelay` takes the upper bound of the advertised range and clamps to 30 s,
`Retry-After` is read as delta-seconds or an HTTP date and clamps to 10 s, and a value
that cannot be parsed is never waited on.

Volume follows from the model. A capped page needs its continuation token in the
projection, so every capped listing projects `nextPageToken` and follows it:
list/search/permission-list at 20 and the operation inventory at 200. The role check
is folded into the metadata projection, so a card read needs no separate parent
request. `findFile` keeps a single page of 2, and the `changes` page size stays 1000
because that resource is not priced by page size. Permission reads project only the
fields the v3 `Permission` representation carries
(`id,type,role,emailAddress,displayName`); it has no `createdTime`, so reinvite
detection compares the observed permission id instead of a creation timestamp.

## Optional WebRTC

`realtime.ts` uses native DataChannels and the existing Drive signaling folder.
Only operations with the same durable IDs and a small frontier handshake are
sent. A mismatch triggers Drive recovery; no full-board reconnection transfer,
peer election, device-authority enrollment, leader or buffer lease participates.
Chunking/backpressure bounds realtime work; oversized edits use Drive delivery.
The lexical SDP initiator rule only avoids offer collisions.

Existing Drive metadata/ACLs admit peers. Signal-file ownership maps to the current
Drive permission; cached decisions last at most ten seconds. Session revalidation
closes peers on lost access; each persistent action checks current Drive role.
Known viewers cannot generate local edits or send persistent peer operations.
A disconnected authorized editor can keep drafting locally; once revocation is
observed, publication and editing stop and retained work remains exportable.
Google permission propagation and the ten-second observation interval bound this
behavior; there is no separate authorization token or signature infrastructure.
Group/domain grants without an individually resolvable peer identity fall back
to Drive delivery. Signaling failure never disables Drive synchronization.

Generation-fenced setup closes a connection that finishes after disabling.
Roster reconciliation replaces failed channels; successful Drive revalidation
can resume suspended WebRTC. The existing persisted local WebRTC toggle closes signaling/channels and leaves
Drive recovery/publication running. Main-toolbar Drive Sync is reused. Owner
Compact and confirmed gardening live in a compact Maintenance disclosure, with
busy/result/error states and keyboard-accessible controls. Header wrapping is
verified at 240/320/480/800 px. No durable operation is produced by intermediate
UI drag positions; the final committed repository change is durable.

## Migration and old clients

On first adoption, validate the legacy snapshot before installing a write barrier,
set and verify Google's content restriction on the legacy files, then reread the
frozen source. Retain original bytes/file IDs/ACLs. Owners use an owner-restricted
barrier where available; editors can establish an ordinary editor restriction.
Normal sync checks that the barrier remains installed and stops if it is removed.
Old binaries can read legacy data but Drive rejects their snapshot overwrites.
A marker alone is not treated as old-client protection. An account lacking the
Drive capability to set the barrier receives an actionable migration failure;
local data stays available. Before upgrade, fresh viewers can read the legacy
checkpoint but cannot edit or initiate migration. No unsupported CAS or file lock is used.

A deterministic content-addressed legacy stream creates the baseline. Owners
publish an immutable initial snapshot; editors may instead publish baseline
operation segments and a marker while the owner is offline. These are operations,
not editor-created snapshots. Another profile recovers through actual baseline
file IDs until owner compaction exists. Concurrent migrations/candidates join
without locks. Partial uploads/locked-but-unmarked migration retry safely.
Ambiguous pre-protocol offline forks become visible local recovery boards instead
of overwriting newer shared fields. Legacy pending drafts retain their original
bytes and can be explicitly reviewed as new property operations after current
Drive authorization. Image hashes/bytes, private erasure markers and account order
are preserved. Explicit erasure prevents stale/fresh profile resurrection.

An old binary hard-coded to journal schema 6 cannot open the upgraded local DB.
Do not downgrade that profile in place; export/recover through a separate profile.
New clients fail closed on unsupported operation/snapshot versions. Legacy runtime
code remains available only for explicit compatibility tests/recovery tooling
(`operationSync: false`), not a second active board writer. Existing signed and
experimental server source files remain as recovery evidence and are not erased.

## Compaction and gardening

Only fresh Drive owners may compact. Capture a complete causal frontier, create a
unique snapshot with board/schema identity, parent candidates, register stamps,
tombstones, complete sequence watermarks, exact receipts and SHA-256 integrity,
then upload/read-back verify through a durable retry intent. Worker tasks handle
snapshot construction/validation/JSON hashing and gardening in browser UIs; MV3
background processing already runs outside the UI. Capturing/cloning state still
has a main-thread cost; no claim of zero-cost serialization is made.
Editing proceeds during upload. Checkpoints join register maxima and tombstone
unions; incomparable branches cannot overwrite one another. Later/unpublished
operations replay over the checkpoint. No owner-online editing requirement,
mutable snapshot pointer, distributed lock or overwrite exists.

Compaction deletes nothing. There is no automatic gardening. A manual preview
shows counts, recoverable bytes and policy and requires confirmation. It retains
at least **three** verified snapshots, every incomparable branch, and all history
newer than **90 days**. A log's exact operation receipts must be present in **every**
retained checkpoint before deletion. Old snapshots need coverage in every retained
checkpoint too. Invalid/missing history aborts the plan. Eligibility is recomputed
against the exact reviewed file-ID set; each trash operation rechecks ownership
and folder membership. Interrupted deletion requires a fresh review. Files move
to Drive Trash; legacy snapshots, markers and images are never gardened. An
offline client can load retained checkpoints and replay its unpublished work;
late segments without coverage remain protected regardless of their age.

## Validation and measured limits

Protocol tests cover randomized multi-client permutation/duplication/delay
convergence, conflicts, gaps, actor forks, same-account allocation, crashes and
retry, snapshots/concurrent owner instances, conservative gardening, and Drive-only
offline editing. Real RxDB integration tests cover migration, images, local forks,
WAL conversion recovery, editor bootstrap without an owner, revocation, shared
IndexedDB contexts, manual sync, default runtime and private erasure. UI tests
cover owner controls, repeated activation and deletion confirmation. Reproduction:

```sh
npm run typecheck
npm test -- --maxWorkers=1
npm run typecheck --prefix apps/android
npm test --prefix apps/android
npm run build:all
node experiments/collaboration/toolbar-smoke.mjs
node experiments/collaboration/ui-perf.mjs experiments/collaboration/operation-browser-probe.ts
node experiments/collaboration/ui-perf.mjs experiments/collaboration/operation-storage-probe.ts
```

Native Chromium, 1,000 cards, two independent IndexedDB repositories, simulated
Drive, WebRTC disabled: two recorded runs of 50 local edits had medians **8.7–9.3 ms**, maxima **30.2–33.3 ms**,
zero Drive requests during edits, one operation segment, and **600–649 ms** compaction.
The first window had no long-task entries; a repeat during the serial regression
run recorded one **50 ms** entry. Bootstrap of both clients was **2.94 s**; total
synthetic Drive requests including a third fresh recovery and compaction were
**141**. Observed heap was approximately **43–51 MB**
for the probe page, not incremental sync memory. Native DataChannel probe delivers
84k-character operations with duplicate Drive recovery, reconnect and revocation.

One Node microbenchmark recorded whole-board clone/JSON at **188 ms elapsed /
191 ms process CPU** versus incremental hash/apply/entity-read at **6.3 ms /
7.8 ms CPU** for 100 edits on 1,000 cards. Snapshot generation was **84 ms**.

`performance.test.ts` additionally isolates whole-board clone/JSON versus incremental
operation application in Node. It is not a measurement of the former full runtime.
Do not extrapolate browser timings to live Google API latency or claim a measured
production CPU improvement. Receipts retain one hash/clock per operation and local
raw WALs remain durable: memory/storage are not history-independent. Snapshot
size is bounded at 32 MiB; exceeding limits reports an error and retains data.
A proven compact receipt/pruning format is future work, not aggressive deletion.

Permanent measurement tests reproduce the per-edit figures below:
`tests/operations/performance.test.ts` (whole-board clone/serialize versus
incremental application), `tests/operations/wireVolume.test.ts` (per-edit realtime
wire volume and retained state) and `tests/operations/wholeBoardComparison.test.ts`
(both paths against fake Drive on one workload: 1,000 card creates, then 50 edits
each followed by a forced sync). Run them with the commands above; latency is
run-dependent, byte counts are not.

Per-edit wire volume for a representative card patch, one client and one actor:

| quantity | value | basis |
|---|---|---|
| canonical operation body | 221 B | measured |
| delivered frame envelope (`id`, `index`, `total`, `text`) | 338 B | measured |
| frames per delivered edit | 1 | asserted in `tests/operations/realtime.test.ts` |
| edits per frame at the 8,000-char chunk cap | 36 | derived (`floor(8000 / 221)`) |
| 128-operation patch batch | 28,632 B → 4 frames | measured / derived |
| inbound buffer bound per connection | 16,777,216 B | derived from `realtime.ts:33,36` (`16 × 1 MiB`); `[INFERENCE]`, not observed |

`tests/operations/realtime.test.ts` (29 tests, green) covers frame rules, permission
gates, the 256 in-flight cap, chunk windows, roster, signalling, broadcast, close and
the frontier handshake, and asserts exactly one new frame per broadcast through the
real `send` path.

Retained state for the same workload: engine board state JSON **530,923 B** and
checkpoint JSON **1,199,052 B** for **1,001** receipts. The checkpoint exceeds the
state because it keeps one hash/clock per operation, so incremental retained memory
grows with history rather than with current content.

End-to-end comparison on that workload (run 2026-10-28):

| path | median edit + forced sync | max | Drive requests | payload per edit | retained |
|---|---|---|---|---|---|
| incremental | 4.9 ms | 236 ms (first edit; 4–6 ms afterwards) | 414 (8.3 per edit) | 511 B | 1,051 journal ops, 429,695 B state JSON, 58 segment files |
| whole board | 14.7 ms | 27.5 ms | 350 (7.0 per sync) | 10,392 B per sync | 441,915 B snapshot JSON |

The incremental path does not win on request count in this workload; it wins on
payload per edit (511 B against a whole-board gzip re-upload) and latency. Quote the
whole-board figure as upload bytes per sync, not per edit. Incremental bytes count
segment payload bodies only; multipart CREATE envelope and metadata overhead are
excluded, and no live Google API cost or latency is implied.
Live Google accounts/real ACL propagation, physical Android devices, and native
Firefox collaborative sessions have not been exercised here. Browser builds and
Android tests validate integration, not those external environments. Retained
legacy WebRTC tests have shown an intermittent pre-delete conflict timeout; record
full-suite outcomes separately from focused new-protocol results. A complete
serialized run passed **175 files / 1,162 tests** after the checksum/empty-text
compatibility additions. The focused operation suite passes **76 tests**. Android
passes **15 files / 98 tests**; both TypeScript checks and managed Firefox/Chromium
builds/package verification pass. Firefox lint has zero warnings/errors/notices.
Final board-scoped notification, locale-independent RxDB order ties, offline
deleted-board recovery, and WebRTC
setup/toggle/reconnect adjustments were verified with the focused operation suite,
storage journal tests, and the native Chromium DataChannel probe. The latter also
closes a live RTCPeerConnection and verifies automatic replacement/delivery. No live-account validation is implied.

Drive API references: [content restrictions](https://developers.google.com/workspace/drive/api/guides/content-restrictions),
[Changes API](https://developers.google.com/workspace/drive/api/guides/manage-changes),
[pre-generated IDs and retry](https://developers.google.com/workspace/drive/api/guides/create-file).
