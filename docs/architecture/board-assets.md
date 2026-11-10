# Board assets: metadata through operations, bytes through Drive

Specification, 2 November 2026; state re-checked 6 November 2026. **Implemented as
three unwired modules:**
`src/sync/operations/assets.ts` (metadata type, name building/parsing, byte
verification, the state machine, the reclamation planner),
`src/sync/operations/assetQueue.ts` (`runAssetUploadCycle`: verify → allocate →
upload → write the operation, persisting intent before I/O), and
`src/sync/operations/assetReclaim.ts` (`runAssetReclamation`: owner → lease → listing
→ plan → delete → audit, under the consolidation lease). Their tests are deterministic
and total 33.
**Not implemented: the wiring and the protocol** — no `assets` collection exists in
the operation protocol (`src/sync/operations/protocol.ts:5` is `'projects' | 'cards'`),
so metadata cannot reach a board yet; producing and judging real Drive listings,
persisting the queue, blob-store refusal on a verification failure, owner-only
scheduling, and the pending badge are caller obligations, each stated as an exact
predicate or port rather than faked with I/O. One integration mismatch to resolve when
wiring: the planner requires `createdTime`, while `driveStore.ts`'s `ImmutableFile`
makes it optional — an omitted timestamp must be passed as an unparseable sentinel so
the planner's `Date.parse` guard protects the file rather than deleting it.
Context: [collaboration architecture](../collaboration.md),
[operation log and snapshots](websocket-operation-log.md).

## Why this shape

Images today are already stored as Drive files referenced from operations, but the
reference is image-specific and the byte handling is inline with the editor. A
generic asset model exists so that pasted files, audio, and whatever comes next
travel the same path as cards: **identity and metadata converge through the
operation log, bytes stay in Drive, and a client can always tell whether it is
holding a complete file.**

The one rule that decides everything else: **bytes never travel through the log or
a peer.** An operation carries a hash and a Drive file id; the log stays
transport-neutral and small, Drive stays the only thing that stores large payloads,
and the hash is what makes "metadata arrived before bytes" a recoverable state
instead of a corrupted board.

## Model

```ts
/** Metadata only. Never the bytes: an asset row must be safe to replicate. */
export type BoardAsset = {
  id: string;          // board-global, client-generated (crypto.randomUUID)
  driveFileId: string; // Drive file holding the bytes, allocated before the op is written
  name: string;        // display name; not trusted for type or safety
  mimeType: string;    // allowlisted, see Verification
  size: number;        // bytes, exact
  sha256: string;      // lowercase hex over exactly those bytes
};
```

`id` is stable across renames and re-uploads of the same logical attachment;
`driveFileId` changes if the bytes are replaced, and replacing bytes therefore means
a new asset plus an operation that moves the reference — never an in-place
overwrite. That is what makes retention safe (below) and what lets two devices upload
the same paste twice without corrupting anything: they produce two assets, and the
hash reveals that they are the same bytes.

Metadata is designed to reach a board through two operations on an `assets`
collection: `create` (with the full `BoardAsset` in `fields`) and `patch` (name
only, plus a delete operation). **That collection does not exist yet** — the
operation protocol is closed to `'projects' | 'cards'`
(`src/sync/operations/protocol.ts:5`), so no asset row can be written today; the
compatibility section below explains why adding it is a rollout decision rather
than an additive change. Bytes are uploaded **before** the operation is written, so
an operation can never reference bytes that do not exist yet. The reverse hazard —
bytes with no operation, because the tab died in between — is expected and is what
reclamation is for.

## Naming

Drive listing is the only index, so the file name carries the classification:

```
asset-<sha256>.<extension>
```

- Content-addressed: two identical uploads name the same file, which turns "is this
  already stored?" into a listing lookup rather than a download.
- Parseable without metadata: a GC pass needs the hash from the name, and never
  trusts a name parsed from user input.
- Anything that does not match the pattern is **not an asset**, and a GC pass must
  treat an unparseable name as untouchable rather than as junk.

## States, and what is allowed in each

An asset held by a device is in exactly one of these. The names matter because the
pending badge and the "Synced" claim depend on them.

| State | Meaning | Allowed actions |
| --- | --- | --- |
| `local-ready` | bytes are in the local blob store, hash computed | create the Drive file, then the operation |
| `uploading` | Drive file allocated, upload in flight | retry; never allocate a second file for the same `id` |
| `remote` | Drive has the bytes, operation is written | serve to peers by hash |
| `reference-only` | operation arrived, bytes are absent | download by `driveFileId`, verify, then `remote` |
| `failed` | verification or upload failed | retry with the *same* `id` and hash; surface it |

Two rules that the synchronization contract already demands and this inherits:
metadata arriving before bytes keeps the reference and shows a pending attachment,
and **a missing asset prevents a "Synced" claim** for the board. A failed upload is
never silently downgraded to "attachment removed".

## Verification

Verification happens on every byte ingestion path, with no exceptions, before bytes
reach the blob store:

1. `size` must equal the received length.
2. SHA-256 over the received bytes must equal `sha256` (lowercase hex compare).
3. `mimeType` must be on the allowlist, and the allowlist is the *rendering*
   decision, not the storage decision: refuse to store a type the interface would
   have to execute or sniff to display.
4. A size ceiling per asset, enforced before upload and again on download.

A mismatch is a `failed` asset, not a silent discard and not a partial save. The
hash is also the deduplication key, so verification cannot be skipped as an
optimization: two assets that verify to the same hash are, for every purpose in this
system, the same bytes.

## Offline upload queue

Uploads are queued per board, in the local store, and survive a restart:

- **Order**: the operation is written *after* the bytes land, so a queue entry that
  is replayed can never produce an operation pointing at an unallocated file id.
- **Idempotency**: the entry keys on `id`; replay reuses the allocated `driveFileId`
  when it is already present, and the content-addressed name makes a duplicate
  upload harmless.
- **Backpressure**: an offline device keeps accepting attachments (they are local
  work, not pending conflicts) and shows how many are waiting; the queue is not a
  source of pending status in the sense the contract uses for *unresolved* changes.
- **Never blocks local editing**: losing connectivity must not lose the paste, and a
  queue failure leaves the local copy intact.

## Reclamation, and why "unreferenced" is not enough

Deleting an asset is the one irreversible action in this subsystem, so a candidate
must clear every test:

1. **Unreferenced by every retained snapshot's receipts**, not merely absent from the
   live board state: a card that is temporarily hidden, or a history a snapshot still
   covers, is not junk.
2. **Older than the grace window**, measured from creation, not from last access —
   last-access is a lie during a sync storm and a fiction for an offline device.
3. **Not in flight**: no device may be between "Drive file allocated" and "operation
   written". The grace window is what covers this, which is why the window must be
   longer than a plausible upload, not shorter.
4. **Nothing in the listing is unknown**: a partial or failed listing makes the whole
   pass a no-op. This is the difference between reclaiming space and deleting a
   board's images because Drive throttled one request.

Reclamation is owner-only, and it runs where consolidation runs, reusing the same
lease so a reclamation cannot race a snapshot.

## Test list (all offline)

- `verifies a hash mismatch before the blob store sees the bytes`
- `refuses an off-allowlist type before uploading, and stores bytes for an allowed one`
- `keeps the same id and hash across an upload retry after a failure`
- `does not allocate a second Drive file when a queued upload is replayed`
- `metadata without bytes shows pending and blocks a Synced claim`
- `a partial Drive listing reclaims nothing`
- `reclaims only after the grace window, and only when no retained snapshot covers it`
- `identical bytes from two devices yield one Drive file and two asset rows`

## Compatibility: the operation wire format is closed, and tolerant readers shipped

The first draft of this section argued the opposite of what the tree now does, so it
is corrected here rather than left as a plan someone would implement twice.

**Structural validation is still closed** — shape, identity, frontier and size throw
for everything, which is the forgery gate (`src/sync/operations/protocol.ts:113`,
`validateOperation`; unknown operation fields are rejected there). **Vocabulary is
tolerant**, and that tolerance is already implemented:

- `validateCommand` returns early for a command whose collection or field names this
  build does not know (`protocol.ts:88-98` → `isKnownVocabulary`, `:62`). An unknown
  collection is therefore *structurally valid* and *unreadable*, not invalid.
- On the log path the row is not failed: `logRoom.ts` validates it, counts
  `metrics.skipped`, reports `logsync.unsupported_operation` and still advances the
  cursor past it (`logRoom.ts:167-176`), because a row this build cannot read must
  not wedge a board forever.
- The engine owns the skip ledger (`engine.ts:126`, `skippedOperations()`,
  persisted in checkpoints), and **any device holding a skipped operation refuses to
  publish a consolidation snapshot** (`session.ts:369-372`: "a snapshot would prune
  history its receipts do not cover"). That is exactly the receipt rule the earlier
  draft said would have to be invented: an operation a client ignored is never
  covered by that client's snapshot, so it cannot be pruned on its account.

So the ordering is no longer "build a tolerant reader first"; it is "the tolerant
reader is universal only once every deployed client carries it". What is still
unknown is the fraction of users on an auto-updating build — the repo has no
measurement — and an older client that predates the skip ledger would still hold its
cursor below an asset operation. That residual risk is a rollout question about
released builds, not a missing mechanism.

| Option | What it takes | Cost |
| --- | --- | --- |
| **Tolerant readers first** (shipped) | Add `assets` to `Collection` once the skip-carrying client is universal. Older clients skip the row whole, keep their cursor moving, and refuse to consolidate while they hold it — so nothing they cannot read is ever pruned on their account. | Nothing further in the protocol; the remaining work is the wiring listed at the top of this document, plus knowing the release population. |
| **Reuse an existing field** | Store asset metadata as the *value* of an already-allowed card field (string-shaped), which older clients accept as opaque text. | Ugly and semantically dishonest: a board's visible card content becomes a metadata carrier, and older clients may render it. Only useful if a pre-skip-ledger client must coexist. |
| **Version floor** | Refuse to write asset operations to a board unless every participant has announced support. | There is no participant roster on the log path to ask, and a floor that cannot be enforced is a fiction. |

Recommendation, unchanged in substance: **tolerant readers first**, which is now a
statement about deployment rather than about code. Do not choose the field-reuse
path to get a demo working: it is the one option that cannot be removed later
without another compatibility problem.

## Decided by the owner, 2 November 2026

1. **Grace window: seven days.** Matches the recovery expectations already in the repo
   — long enough to outlast a worst-case offline queue drain, short enough that
   abandoned uploads do not accumulate. This is `DEFAULT_ASSET_GRACE_MS`; no change
   needed.
2. **Size ceiling: 8 MiB.** Accepted deliberately, including the consequence that
   8–20 MiB attachments which the current image path (`MAX_IMAGE_FILE_BYTES`,
   `src/images/processing.ts:3`) accepts will be refused as assets. The generalisation
   therefore *tightens* attachment size on purpose; if that turns out to matter in use,
   the ceiling is a caller parameter, not a code change.
3. **Replaced bytes: keep, then reclaim.** A replacement leaves the previous Drive file
   in place so an offline undo can still resolve it, and reclamation is what eventually
   removes it — which is the assumption `runAssetReclamation` and the grace window
   already encode.
4. **Tolerant readers first, then assets.** Approved as the compatibility route; the
   implementation is tracked separately from this spec.

## Open decisions

None outstanding for the module, queue and reclamation drivers.

Cutover is gated on something narrower than the earlier draft claimed: tolerant
readers are **already implemented** and hold their cursor past a row they cannot
read while refusing to consolidate history their receipts do not cover (see the
compatibility section). What remains is (a) the wiring listed at the top of this
document and (b) knowing that no pre-skip-ledger client is still receiving writes
for a board — a release-population question the repo cannot answer.

One integration mismatch still has to be resolved when wiring: the reclamation
planner requires `createdTime`, while `ImmutableFile` makes it optional
(`src/sync/operations/driveStore.ts:13`). An omitted timestamp must be passed as an
unparseable sentinel so the planner's `Date.parse` guard protects the file instead of
deleting it.
