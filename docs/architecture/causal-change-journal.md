# Durable change journal and causal reconciliation

Jobs 3 and 4, 19 October 2026. This implements the local history and reconciliation
foundation of the approved [synchronization contract](synchronization-contract.md).
[Job 6](private-drive-history.md) now persists and reconciles private Drive history;
[Job 7](peer-causal-history.md) now exchanges authenticated peer history. [Job 5](conflict-resolution.md) now adds local conflict UI, durable drafts
and authorized authored resolutions.

## Durable writes (Job 3)

Every repository instance opens `<RxDB database name>-change-journal-v1`, a local
IndexedDB database with `entries` and `receipts` stores (Job 5 adds `drafts` through
an additive schema-2 upgrade). Native IndexedDB avoids
loading a second, incompatible Dexie runtime alongside RxDB's adapter. No new
dependency, RxDB collection/schema, board ID or snapshot format is introduced.
The journal is recovery metadata/history; live RxDB documents remain authoritative.
It is not an independent remote backend.

The wrapper on the actual projects/cards storage instance runs inside subsequently
installed collaboration verification guards. Failed authorization cannot create
journal entries. Local command writes are explicitly distinguished from snapshot
imports and replication storage contexts. Observing a replacement is **not** proof
that its author observed the previous local version. Snapshot/bootstrap imports
(untrusted-import context: Drive pulls, bootstraps, board files) write **no**
journal records at all — they are replicated state, not authored changes, and
each pull would otherwise add an unanchored observation root that reconciles as
an unrelated-history conflict against the previous pull. The first local edit
after an import anchors on the imported bytes as its baseline; verified history
arrives only through the authenticated history exchange.

Writes first commit a prepared journal record, then write the RxDB document, then
commit the journal outcome before acknowledging the save. These are separate
IndexedDB transactions, **not** a claimed cross-database atomic transaction:

1. Preparation failure rejects the write before touching its RxDB document.
2. Failed document writes are recorded as rejected, without pending delivery.
3. A crash/ambiguous failure leaves the prepared value intact. Startup compares
   exact current document bytes (including tombstones and signatures); matching
   records become committed. Other prepared records become uncertain and remain
   recoverable. They are never automatically replayed or published.
4. A document committed before a failed journal acknowledgement remains present;
   the caller receives an error and startup recovery repairs the journal outcome.

RxDB's incremental queue requires per-row storage errors, so journal errors return
those rather than leaving callers waiting on a rejected bulk-write promise.
Multi-document commands can still partially commit; this stage does not invent
an atomic board transaction. Drive dirty events and account-generation boundaries
remain the existing implementation until their integration jobs.

Each immutable change carries format version, SHA-256 content identity, board,
collection/document binding, parent IDs, ancestry certainty and exact application
value. RxDB `_rev`, `_meta` and `_attachments` are excluded; `_sec` and tombstones
are preserved. Parentage comes from an exact known previous value, not its clock.
Ambiguous matches and first edits of legacy data retain an unknown baseline.
An entry proved by this board's own authority counts as exact evidence for its
own bytes even when the chain above it lacks a portable anchor (a board that
was attested from unsigned history), so continued signed edits do not fork onto
duplicate baseline roots. A removal re-signs and re-stamps its document in
place; it anchors on the unique committed entry matching the document content
after ignoring `_sec` and `updatedAt`.
A local write also matches a `prepared` entry whose bytes are the current
document: that entry came from an interrupted write whose document persisted
while its journal finish never ran, so anchoring on it (and committing it)
prevents a spurious baseline fork. At reconciliation time, heads descending
only from synthetic `baseline` roots are inert snapshots, never authored
branches: a lone authored chain beside such heads resolves to the newest
state instead of a conflict.

A prepare that names a specific recorded entry as its parent is refused when that entry is no
longer the head this journal recorded for the document, because another recorded entry has
already superseded it. The refusal lands at prepare time, before the entry is constructed or
written, so the recorded head stays intact and nothing is left pending: a queued or stale-UI
write cannot become an anonymous fork that only surfaces as a conflict at confirm time.
Content that more than one recorded candidate could explain is not a claim on a specific
entry, so the unknown baseline root above is never refused.
Existing records are captured lazily when first edited; there is no destructive
startup rewrite or automatic signature attestation. Legacy imports retain unknown
ancestry. Existing signed operation IDs/signatures remain unchanged inside `_sec`.

Receipts are keyed by change ID and explicit destination, such as an account or
peer. An acknowledgement for one destination cannot clear another's work.
Received changes and legacy baselines also remain pending for other destinations;
receipt of a peer edit must not imply that its private backup is already durable.
Job 6 marks account-specific receipts after verified private history persistence.
Peer history delivery is not yet acknowledged. Established account bindings are
enforced; first binding and complete account lifecycle isolation remain Job 11.

History and uncertain records are not garbage-collected on logout, board deletion,
or reopening. Normal repository image deletion also protects image IDs referenced
by retained history. Journal connections close with RxDB. Old clients can still
read existing documents but do not record or understand this history; an old-client
edit will require conservative ancestry handling when a new client returns.

## Reconciliation (Job 4)

`repository.reconciliation.inspect({ boardId, collection, documentId })` derives
heads from committed immutable entries. Conflicts persist as their exact variants
and graph; their deterministic projection is recomputed after reopening rather
than maintained in a second mutable conflict table.

- A sole descendant supersedes its ancestors regardless of timestamps.
- Missing parents, unrelated histories or ambiguous merge bases retain conflicts.
- Card title, content and display mode can combine only with a unique common
  ancestor, valid field values and no incompatible concurrent value for a field.
  Text remains atomic. Equivalent concurrent values retain both source identities.
- Structural/order/template changes are conservative conflicts. This engine does
  not yet validate cross-document template changes against every card.
- Concurrent deletion/edit retains both intentions; a descendant deletion remains
  deleted when an old edit is replayed. No deletion compaction runs.
- A resolution is another authorized descendant referencing all resolved heads.
  A partial resolution cannot erase unseen branches; concurrent incompatible
  resolutions become another conflict. Job 5 implements local signing and review UI.
- Unowned roots (2026-10-24/25): reconciliation classifies parentless,
  unknown-ancestry, unproven entries with origin `observed` (pre-fix pull
  journaling, pre-signature replication) or `baseline` (private-backup
  `capture`) as residue — they assert no authorship. If every head is
  residue, the newest is the document's state; if exactly one head carries
  a verified author proof and every other head is residue, the author chain
  IS the document (kind current/deleted), with the residue retained but
  inert. No journal entry is written and no resolution fork is created, so
  the author's next entry — including a delete — chains cleanly and the
  second same-account browser applies it as an ordinary update instead of
  raising a "Conflict requires resolution" panel. Any local, linked, or
  additional proven dissent keeps full conflict reporting.
- Capture never forks (2026-10-25): `privateRecovery.capture` seeds baseline
  roots only for documents with no committed journal history at all. Writing
  a fresh root for an already-journaled document whose bytes drifted (seal
  re-stamping, untrusted snapshot updates) forked the author's own chain on
  every backup and surfaced the fork on every collaborator.

Merge previews are explicitly unsigned, never submitted to RxDB replication and
never represented as an original author's signed document. All source signatures
remain immutable. Job 5 permits a currently authorized editor to explicitly author
a reviewed merged revision; it never publishes the unsigned preview as source data.

The bounded `receive(changes, verify)` entry point checks content identity, scope,
parents and document binding, requires an explicit verifier even on replay, and
atomically retains a verified batch. Cross-board references are rejected even
when the child arrives before its parent. There is no permissive verifier default.
Reconciliation intake refuses a batch whose board was retired while the batch was in flight,
never appending to a retired journal and never reading one as live history; the refusal is
decided from the erasure markers read inside the same strict transaction that would write the
entries, and a refused batch strands nothing pending. Other callers that tolerate a
partially-applied batch keep the silent per-entry drop.
It is not connected to legacy transport payloads in these jobs: current protocol-2
mutation signatures authenticate document data, **not the new journal parentage**.
Job 7 adds detached author proofs and a separate bounded peer intake path that
authenticates complete change identity and current board-specific authorization. Google identity alone is insufficient.
Job 6 separately validates and restores account-private recovery copies; it does
not treat those files as a peer authorization proof.

## Validation and remaining work

```sh
npx vitest run tests/recovery/changeJournal.test.ts tests/recovery/causalReconciliation.test.ts
npm run test:recovery -- --browser
npm run typecheck
```

The 24 new tests cover actual RxDB writes, restart, scoped acknowledgements,
preparation failure, commit/ack interruption, uncertain recovery, signed baseline
preservation, rejected writes, image retention, causal ordering, equivalent and
independent changes, persistent text conflicts, structural edits, missing parents,
tombstones, resolutions, replay, invalid identities, cross-board references, a prepare that
claims a superseded parent, and a batch whose board was retired while it was in flight.
IndexedDB unit tests use fake-indexeddb; native browser recovery is separate.

The existing native WebRTC regression exposed responses finishing after a peer
was destroyed. The handler now drops responses belonging to closed sessions; a
new session performs its own catch-up. This is not a delivery acknowledgement.

[Private Drive history](private-drive-history.md) now reconciles causal changes,
retains conflicts/drafts and restores them after source-device loss. C03 is an
ordinary passing regression. Compatibility snapshots and legacy shared-folder
paths remain available; WebRTC exchanges authored history through [Job 7](peer-causal-history.md), with
conservative unknown ancestry for legacy operations.
Portable exports do not yet include this journal. Unsaved remote history remains
vulnerable to permanent device loss. Signed-grant expiry, viewer persistence,
initial account binding and automatic two-mode activation remain open jobs.
Strict acceptance stays blocked.

History stores full document variants and grows with edits; no destructive
compaction policy is introduced. Real-disk storage/latency and long-history load
measurements remain necessary before claiming production capacity. The public
rendezvous, OAuth configuration, Drive layout, schemas, grants, keys and default
signaling provider are unchanged. No deployment or release is performed.
