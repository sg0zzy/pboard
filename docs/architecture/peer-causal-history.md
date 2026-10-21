# Authenticated peer causal history

Job 7, 20 October 2026. Extends the [local journal](causal-change-journal.md),
[manual resolutions](conflict-resolution.md) and [private Drive recovery](private-drive-history.md).
The existing manager, signaling providers, DTLS mutual proof, DataChannels, RxDB
pools and storage guards are reused. Drive remains the default signaling provider.
There are no new OAuth permissions, application schemas, authority keys or services.

## Current data flow

```text
Local command -> signed document -> WAL + detached causal author proof -> RxDB
Verified DataChannel -> offer IDs -> request missing -> bounded record/chunks
  -> verify scope + document + causal proof + current/historical authorization
  -> persist private-backup intent -> durable journal -> guarded projection -> ack
  -> sender's board/device-specific receipt
```

`src/collab/peerHistory.ts` runs once per authenticated cards/projects connection.
Each room exchanges only its board and collection. Account-order rooms retain their
existing implementation. Both directions offer committed record IDs, send only
missing records, and confirm delivery after IndexedDB commits and projection checks.
Every new connection offers history again: old receipts cannot hide data lost by
a reinstalled peer. Replays deduplicate by content identity. A disconnected/expired
session cannot finish admission or acknowledge a pending transfer.

The handler flushes history before its ordinary RxDB messages so storage observations
can reuse original journal identities instead of inventing unknown parentage. RxDB
can emit a storage event before the WAL outcome commits, so a signed document can
still arrive first; exact signed-operation aliasing supplies its later proven
ancestry without deleting either record. Local
edits arriving during exchange are picked up in bounded additional passes. Journal
notifications wake the exchange and restore the causal projection after legacy
replication writes. Network waits do not hold the local command queue. Exact local projection/resolution
intents do not reject competing valid replication writes; those take the ordinary
WAL and signature-verification path. Late callbacks can retire only their original
peer connection. Incoming
history marks the account-private backup dirty before journal admission; a peer
receipt never implies a Drive acknowledgement.

RxDB's existing conflict handler now recognizes proven journal ancestry while a
trusted board context is installed. When both candidate documents are retained and
the graph has a sole current/deleted head, that head outranks document clocks.
Concurrent or incomplete histories retain the compatibility projection policy and
all journal variants. When a displayed ancestor needs replacing, fallback prefers
a signed head over a legacy unsigned branch without deleting either branch; this
keeps installed signature guards active. A displayed timestamp winner is **not** a resolved conflict.
No second WebRTC stack or replacement replication library was introduced.

## Author proofs and compatibility

`src/collab/security/journalProof.ts` signs a domain-separated `pboard-journal-change-v1`
proof of the complete content ID, board, original author, epoch and manifest hash.
The content ID already commits to the collection, document bytes and parent IDs.
`journalStorage.ts` persists this detached proof before committing a new local
signed write. It lives additively on journal entries; IndexedDB schema 2 and existing
application schemas/identities remain unchanged. Proofs contain no private key.

Receivers first validate content identity and scope, then the original mutation
signature, then its author-only causal proof. Verified same-authority manifest
history permits original epochs while current author membership still applies.
A viewer may forward an owner's/editor's unchanged proof; viewer-authored changes,
removed authors, missing historical authorization, tampered links and foreign-board
records fail closed. Receiving or relaying never re-signs another author's history.
Google login, Drive ownership and knowledge of a board ID supply none of these rights.

Older signed mutations do not prove journal parentage. They can be transferred as
deterministic **unknown-ancestry** roots. Their original signatures/values remain
unchanged. Unverifiable original records stay local. Unsigned pre-enrollment history
is never disclosed to peers; branches whose full ancestry cannot be authenticated
are transferred conservatively without asserting that ancestry. The source journal
is retained intact. Subsequent signed edits can build on the exact signed baseline.

A legacy observation and a later proven entry can represent the exact same signed
operation. The engine aliases only byte-identical signed values when a known entry
has its causal proof. It retains both records, signatures and IDs. Equal text alone,
different operations or unsigned variants never establish this equivalence. This
avoids false conflicts when RxDB observed an operation before its history arrived.

Private recovery batches now optionally retain detached proofs alongside their
changes. Existing version-1 files remain readable and unchanged; new files add the
optional field. Fresh-device recovery preserves proofs without restoring authority,
pins, enrollment or grants. Old clients can ignore proofs; their replays remain
conservative. Existing signed protocol-2 clients without the history capability
continue using the authenticated RxDB path after a 1.5-second capability wait.
Advertising history and then failing validation/acknowledgement closes that session;
there is no downgrade to unsigned collaboration.

## Wire and resource limits

Application frames use `kind: "pboard-history"`, `version: 1`, and a request ID:

| Operation | Content |
| --- | --- |
| `hello` | Capability announcement after mutual DTLS authentication |
| `offer` / `wanted` | Up to 16 content IDs; current sender offers one per exchange |
| `put` / `ack` | One immutable change with optional author proof / committed IDs |
| `chunk` | Transfer ID, sequential index/total and at most 8,192 string units |

The receiver rejects unsupported versions, unknown operations/fields, unsolicited
responses, unrequested records, interleaved/out-of-order chunks and collection/board
mismatches. There is one outgoing request, one inbound offer and one partial assembly
per session. A logical transfer is at most 512 KiB and 64 chunks; wire frames are at
most 64 KiB. Request and assembly deadlines are ten seconds. Reception is capped at
200 history frames/second; the native handler paces outgoing history frames at least
ten milliseconds apart. Processing is sequential, with a 10,000-record scan window
and at most eight catch-up passes per flush. Exceeding limits leaves source data
retained and delivery incomplete. These are resource guards, not measured capacity
or latency guarantees. No signaling-server protocol, persistence or logging is added.

## Validation

```sh
npx vitest run tests/recovery/peerHistory.test.ts tests/recovery/privateDriveHistory.test.ts
npm run test:recovery -- --browser
npm run typecheck
npm --prefix apps/android run typecheck
```

Thirty-two new peer tests use real repositories, manifests, mutation signatures
and causal proofs over an isolated in-memory wire. They cover durable origin proofs,
missing records, replay, receipts, reconnect/database loss, independent offline card
edits, text conflicts, authorized two-parent resolutions, edit/delete retention,
unchanged relay proofs, private-data exclusion, Unicode chunking and reversed clocks.
Two additional native-handler tests inject excessive queued frames/bytes at the
actual input event and assert immediate teardown. Negative checks also reject malformed application values despite valid author
signatures. Application validation is shared with private persistence. Checks cover
modified ancestry/content/proofs, foreign boards, viewer
mutations, unknown operations/fields, unrequested records, floods, quotas, expiry,
interruption and chunk deadlines. A further private Drive test restores detached
proofs on a fresh device without board authority. These component session contexts
are fixtures; actual session authentication is exercised by the native harness.

The native Chromium same-account and different-invited-account scenarios create
actual signed branches with both managers running against an unavailable local
relay. After restart they retain both conflicting authors, exchange an explicit
signed two-parent resolution, and apply a descendant with a backwards document clock
through the real DataChannel/RxDB integration. No constructed graph or permissive
history verifier is used in that scenario. Existing Drive signaling, snapshots,
images, independent outages, source-profile destruction and revocation remain
regression scenarios. Google HTTP is synthetic; no public VPS is contacted.

## Changed files and final results

| Files | Job 7 change |
| --- | --- |
| `src/collab/peerHistory.ts` (new) | Versioned, bounded missing-history exchange and durable peer receipts |
| `src/collab/security/journalProof.ts` (new) | Original-author causal proofs and iterative portable-history closure |
| `src/collab/webrtcHandler.ts`, `manager.ts`, `src/sync/runtime.ts` | Authenticated room wiring, send barriers, paced transfers, bounded input, stale-session guards and durable private-backup intent |
| `src/collab/security/liveMutations.ts`, `src/storage/journalStorage.ts`, `changeJournal.ts` | Proof creation before local commit; received writes preserve original identities and bypass local-only intents |
| `src/storage/causalReconciliation.ts`, `rxdbRepository.ts` | Exact signed-operation aliases, shared application validation and proven-ancestry conflict handling |
| `src/storage/journalMaterialization.ts`, `privateRecovery.ts` | Concurrent valid writes use ordinary verification; signed fallback projections retain unsigned legacy evidence |
| `src/sync/privateDriveHistory.ts` | Optional detached proofs in immutable private recovery batches |
| `tests/recovery/peerHistory.test.ts` (new), `privateDriveHistory.test.ts`, `tests/webrtcHandler.test.ts` | 35 new history, security, private recovery and input-queue checks |
| `services/pboard-signaling/secure-browser-smoke.mjs` | Native signed offline branches, resolution, reversed clocks and safe fixture diagnostics |
| `services/pboard-signaling/src/identity_enrollment.rs` | Test-only policy clock fix; production server unchanged |
| `scripts/recovery/scenarios.json`, architecture/index/collaboration docs and `STANDARDS_MIGRATION_REPORT.md` | Evidence, compatibility limits and remaining jobs |

Final local validation: full suite **709 passed, 3 expected failures and the same
2 pre-existing releaseMetadata/standardsPolicy failures**. Focused recovery: 203
passed plus 3 expected failures; Rust: 36 passed. All seven native harness stages,
root/Android typechecks, Firefox/Chromium builds/package verification, documentation
relative links and whitespace checks pass. Additional isolated legacy Drive runs
also pass after the projection/concurrency fixes. The complete acceptance inventory
remains 35 partial, 3 known gaps and 17 gaps across 55 scenarios; strict mode fails
as intended. Native Google HTTP is simulated and performance is not benchmarked.

## Remaining limits

- Peers must have an authorized connectivity path. Private per-account Drive files
  and the rendezvous do not provide asynchronous cross-user board delivery when
  peers never overlap online.
- New causal history is authenticated; older clients cannot reconstruct parentage
  they never recorded. Unknown/unverifiable branches can require manual review.
- Non-conflicting unsigned private changes can merge through Job 6. Signed shared
  field combinations remain conservative and require a newly authorized resolution;
  this job does not automatically author merge operations or elect a merge leader.
- Current-membership and historical-manifest checks intentionally hold changes by
  removed authors. Durable offline permission decisions, grant expiry, viewer roles
  across restart, delegation and trusted authority recovery remain Job 8.
- Image references/signatures travel with changes; image bytes still use existing
  persistence paths. Independent peer attachment transfer is Job 9. Personal manual
  drafts are backed up privately and are never shared with other users.
- First account binding, whole-session account generation, automatic operating modes,
  unified status, MV3 sleep/resume and complete recovery scheduling remain later jobs.
- No long-history/load/latency benchmark or native Firefox/Android recovery has been
  measured here. All-platform and live-Google acceptance remains incomplete.
- A pre-existing Rust test fixture read its clock twice to construct a maximum-length
  policy, causing intermittent expiry-window rejection. It now derives expiry from
  the same captured instant. Production Rust authorization code is unchanged.

No release, tag, deployment, credential change or data migration is performed.


Job 8 follow-up: [offline authorization](offline-authorization.md) adds local
historical admission receipts, durable roles and separate pending card edits.
Receipts are not transferable authorization; historical forwarding to fresh peers
after author revocation still has explicit limits. Source and proof formats from
this job remain unchanged.

### Attachment framing hardening (20 October 2026)

Board-scoped attachment requests now require a verified signed card reference;
knowledge of a global blob hash is insufficient. Small `image-put` transfers keep
their existing format. Larger assets use sequential acknowledged `image-part`
frames with `imageId`, `index`, `total` and `data` fields, within the same
`pboard-history` version-1 envelope on the authenticated DataChannel. Each data
segment is at most 32 KiB; a receiver holds only one requested, size-bounded
assembly and writes no blob before final hash/MIME/dimension verification.
History frames retain their 512 KiB assembly bound and the native 64 KiB frame
bound. The rendezvous protocol and server are unchanged. Both peers need the
updated client for large attachments; older receivers reject the unknown operation.
The strict JSON parser now counts nesting outside strings, so literal braces in
card content/chunks neither corrupt framing nor weaken the depth bound.
