# Private Drive causal persistence and recovery

Job 6, 19 October 2026. Implements account-private history persistence on top of
the [journal](causal-change-journal.md) and [manual resolutions](conflict-resolution.md).
RxDB remains the local data store. Drive/WebRTC can operate independently; signaling
selection and defaults are unchanged. [Job 7](peer-causal-history.md) adds authenticated peer history exchange.

> **Scope note (24 October 2026):** this AppDataFolder-based design describes
> the legacy Drive-provider mode only. Under Sync v2 (websocket provider) no
> board data touches AppData; every board persists to the unified visible
> store `My Drive/pboard/<boardId>/board.json.gz` (+ `attachments/`) — see
> [`docs/collaboration.md`](../collaboration.md) "Sync v2 components" and
> `src/sync/driveBoardStore.ts`. AppData is read/written only by the audited
> migration engine (`src/sync/privateMigration.ts`) driven by the automatic
> legacy pass (`src/sync/legacyMigration.ts`, once per session on v2
> reconcile: read-back verified before the flip, sources deleted only after
> the 90-day window). Account ordering preferences intentionally stay in
> AppData under v2 as device-independent account metadata (product decision,
> 24 October 2026); they are account settings, not board content. Their sync
> paths: an immediate upload on every reorder, a pull/upload round-trip on
> every reconcile (legacy provider internally; Sync v2 via `reconcileAll`),
> and live propagation between same-account sessions over the WebRTC account
> room `pboard-account-<account>-order`, which replicates only the single
> `projectOrder:<account>` settings document.

## Data flow and compatibility

For the RxDB private-persistence path, a sync reads the user's immutable recovery
files, validates and unions their changes into the local journal, projects the
causal result into RxDB, and uploads missing history/drafts/image bytes. It then
updates the existing `project-<id>.pboard` v1 snapshot as a compatibility copy.
Whole-board timestamps no longer select the private RxDB result on this path.

New files are additive, inside the same private Google `appDataFolder`:

```text
project-<board>.pboard                  existing v1 compatibility snapshot
history-<board>_<SHA256>.pboard          immutable recovery batch
account-preferences-<account>.pboard    existing account preferences
```

A recovery batch has format `pboard-private-history`, version 1, and contains its
board ID, original scoped changes/parents, content-addressed inline image bytes,
manual drafts and fingerprints of recognized v1 projections. The filename binds
the canonical complete payload to SHA-256. History is created with POST and never
updated with PATCH. Two overlapping writers therefore retain both branches even
if their last compatibility snapshot writes replace one another. Duplicate files
from uncertain create acknowledgements are harmless: changes deduplicate by ID.

The existing v1 snapshots, folder layout, shared image assets, grants, keys, OAuth
configuration and RxDB schemas remain intact. No existing file is migrated or
deleted as a history-compaction operation. Legacy storage and existing regular
Drive shared-folder synchronization retain their original code path. Older clients
ignore recovery batches and can still consume the v1 snapshot, with the limits below.

## Causality, conflicts and durable recovery

Private unsigned changes use proven ancestry instead of arrival order or wall
clock. Independent cards survive; reviewed independent fields of one card can
produce a deterministic new merge change. Both source variants remain immutable.
Project revision/timestamps remain compatibility metadata. The project append
high-water mark takes the maximum observed key; this does not choose card moves.

Conflicting text, incompatible structural edits and insufficient ancestry remain
durable conflicts. A current local head remains the displayed projection where
possible. Fresh devices choose a deterministic projection without marking the conflict
resolved. Signed fallback heads take precedence over unsigned legacy branches; all
original variants remain retained. Card tombstones survive restoration and ancestor replay. Board
deletion history is retained; deleted boards are not recreated from stale v1 data.
Hidden-board conflicts can be recovered into the journal without making the board
visible, so the global conflict panel can still show their retained evidence.

An explicit manual resolution references all reviewed heads and persists through
private Drive. Drafts from parallel windows and prior draft versions are retained
without arrival-order replacement. Draft saves now reuse the existing dirty marker
and idle-backup scheduler. Successful backup does not clear the conflict panel.

Projection writes use an exact local materialization intent: already durable
changes are not recorded again as new unknown roots. Existing origin-signing hooks
are skipped for imports; storage verification guards still run. The journal stays
authoritative for retained variants if a crash interrupts projection. A retry
reprojects its committed history. The normal successful local-save guarantees
remain independent of remote availability.

Delivery receipts are account-specific and committed only after a successful
immutable upload or verified remote read. Remote inventory is checked independently
of local receipts, so a missing remote file is not hidden by an old acknowledgement.
New edits/drafts arriving during transfer keep the board dirty. The compatibility
upload retains the change token captured before history exchange, including the
gap between history completion and snapshot upload. History can restore a board
even when its v1 compatibility upload never completed.

Old-client snapshot contents not recognized by an archived projection fingerprint
become unknown-ancestry branches. A card absent from a v1 snapshot is **not** a
deletion proof. The client preserves local cards and edits for review instead of
using a newer snapshot timestamp to erase them. This preserves evidence, not a
promise of lossless synchronization among clients that never recorded history.

## Account isolation and collaboration authorization

The runtime captures an OAuth credential and derives the account identity using
that same credential. History and compatibility writes use token-bound transport
closures; changing the global account cannot redirect those bytes to another user's
Drive. Tokens stay in memory/auth storage and are never included in recovery files
or logs. A local board/account binding is stored additively in local RxDB settings.
An established binding rejects a different account without rebinding the board.

Session checks run outside the repository command queue. Remote HTTP cannot hold
the materialization lock and block local editing. Per-write deletion/application
checks inside that queue use local storage only. The held-download/logout regression
now passes. Full account/mode generation isolation, account changes during a whole
multi-board session and the initial ownership decision for previously unbound boards
remain Job 11; the M07 expected failure is still explicit.

Account-private recovery permits reading one's stored board copy. It is **not**
a board grant, an invitation, peer authentication or proof of shared-board ownership.
Signed documents retain their exact signatures. Boards with signed history do not
get automatic unsigned merges or replacement signatures. Installed mutation guards
continue enforcing trusted membership before projection/publication where active.
Fresh devices receive no authority key, trusted-device enrollment, pin or grant from
these files. Automatic authority initialization also checks retained signed history,
even when the current displayed projection itself has no signature.

The independent WebSocket path skips legacy shared-folder discovery during private
reconciliation. Its private file recovery no longer depends on that legacy lookup.
The default Drive collaboration path remains unchanged. Other legacy UI/discovery
entry points still need the planned compatibility separation; this is not a claim
that every application request already uses only appData scope. No OAuth scope changes
are made. The public rendezvous receives no history, documents, images or Drive tokens.

## Validation

```sh
npx vitest run tests/recovery/privateDriveHistory.test.ts
npm run test:recovery -- --browser
npm run typecheck
npm --prefix apps/android run typecheck
```

Seventeen new component tests exercise overlapping immutable uploads and last-writer
snapshot replacement, recovery after permanent loss of both sources, safe field
merge/replay, conflicting text/drafts/resolutions, edit/delete and board tombstones,
independent additions, old-client branches, corrupt/cross-board input, account
bindings, captured transports, mid-transfer edits, local queue independence,
hidden-board conflict recovery, empty-migration selection and history-only recovery.
C03 and the specific M06 held-download case are ordinary passing regressions now;
they no longer count as expected failures. A04, A08 and M07 remain expected gaps.

The native Chromium probe backs up unresolved branches/draft, resolves through the
actual React UI, backs up the resolution, kills the source process and permanently
deletes its isolated profile/keys. A fresh profile restores content, causal parents,
original variants and the draft from private Drive while peers/Rust are offline.
Original shared-board signatures survive and no authority/grant appears. Private
file recovery makes no legacy shared-file discovery request in this independent
path. The two conflict branches are a locally constructed private fixture; Google
HTTP is synthetic. Separate native same/different-account WebRTC and preserved Drive
regressions verify existing collaboration behavior. No live-Google claim is made.

## Limits and next job

- [Job 7](peer-causal-history.md) exchanges authenticated causal history through
  WebRTC and optionally preserves detached proofs in these recovery batches. Legacy
  operations can retain unknown ancestry. There is no cross-user delivery guarantee
  when authorized peers never overlap online.
- A signed board's automatic merge/publication still requires current board
  authorization. Expired local grants, cached viewer persistence and historical
  authors removed from the current manifest retain the existing Job 8 limitations.
- Applying board-wide template/deletion resolutions, hard-deleted document recovery
  and missing-ancestor/image cases retain Job 5's explicit blocks. Failed/uncertain
  WAL outcomes remain local recovery evidence; only committed changes and manual
  drafts enter this remote history format.
- Current exported board archives do not constitute a complete portable journal/key
  backup. Drive history is an additional recovery source, not an encrypted key backup
  or a replacement for export/recovery validation.
- Processing is sequential and bounded: 128 changes/images/drafts/fingerprints per
  incoming batch, 32 MiB per file, 10,000 files and a 128 MiB aggregate scan window.
  Outgoing batches start at 16 records and shrink for large images; a single oversized
  record fails pending. No truncation, destructive compaction or silent fallback
  occurs. These are client guards, **not measured capacity guarantees**.
- History and image copies grow over time. Whole-account scans are repeated per
  board; incremental indexing, API/storage cost measurements and a reviewed retention
  policy are needed before a wider rollout. Large collections can remain pending at
  the documented limits; local and remote source data stay intact.
- Malformed or unsupported legacy compatibility snapshots can still block a full
  reconciliation scan. The failure preserves source data; automatic repair is not
  implemented.
- Firefox/Android native recovery, OS sleep/MV3 lifecycle and actual Google API
  consistency/permission behavior remain acceptance gaps. Strict release acceptance
  stays blocked. No server deployment, tag, release or credential migration occurs.

### Enrollment and attachment account isolation (20 October 2026)

The browser/Android connect action now records consent only after successful
Google identity verification. It binds the account hash and reviewed visible
board IDs; an old timestamp-only `pboardBindingDisclosure` does not grant access
to another account or future standalone board. Existing durable board bindings
remain valid. To enroll a newly created standalone board, use the sidebar's
explicit Sync now action for that board, or reconnect; Android's explicit Sync
now enrolls its visible board set. Automatic new-board mode enrollment remains
part of the unfinished operating-mode lifecycle.

Private image operations pin one credential across all HTTP requests/retries and
check the board's existing private account binding and current account continuity.
A denied/expired/switched session leaves local images and pending delivery intact;
it never retries with another account's credential. Peer image recovery can still
proceed when private image persistence is unavailable.
