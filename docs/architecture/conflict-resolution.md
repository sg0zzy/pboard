# Persistent manual conflict resolution

Job 5, 19 October 2026. Builds on the [local journal and causal engine](causal-change-journal.md)
under the approved [synchronization contract](synchronization-contract.md).
This adds local conflict review and authorized authored resolutions. [Job 7](peer-causal-history.md) now adds authenticated
WebRTC history exchange; [Job 6](private-drive-history.md) now adds
private Drive persistence and fresh-device recovery of history and drafts.

## User flow

The sidebar shows a collapsed **Conflict requires resolution** panel when the
local journal contains conflicting or compatible concurrent heads. It includes
retained conflicts from boards outside the ordinary visible board list. No
temporary-disconnection popup or competing storage/provider choice is added.

Expand a board/card entry, compare its versions and choose a starting version.
For a live card, edit **Resolution title** and **Resolution text**, or review the
compatible engine preview with **Use combined text**. Board-name conflicts support
manual names. Deletion variants require **Confirm deletion resolution**. No version
is automatically selected by timestamp. Original versions and signatures remain
in local history after resolution.

Drafts save locally while typing. Reopening restores a sole saved draft; multiple
drafts can be selected explicitly. Each editor window writes a separate draft
slot, preserving parallel drafts and older selections. If new heads arrive, the
draft stays visible and submission is blocked until the current versions are
reviewed. A failed draft save prevents submission and leaves the text in the editor.
Controls use existing light/dark theme tokens, labelled inputs and native details,
radio buttons and fieldsets. Local retained image bytes can be previewed.

## Write and authorization boundaries

`src/storage/conflictResolution.ts` implements repository-level `listConflicts`,
`saveConflictDraft` and `resolveConflict`; the browser facade and sidebar reuse
these methods. The global panel does not depend on the current board selection.
Journal notifications refresh it across extension contexts, with coalesced reads;
periodic refresh covers permission expiry without a document change. A read failure
reports incomplete recovery without presenting an empty successful result.

A resolution request supplies the exact reviewed heads, a selected retained
variant and optional manual text. The command clones the request, rejects stale,
duplicate, cross-scope or unknown choices, checks board/card invariants, and compares
the actual previous document during the incremental write. A later concurrent
branch remains a conflict; it is not silently included in the reviewed parent set.
The local WAL commits the new value with every reviewed head as a parent. Original
variants are never rewritten or garbage-collected. Card deletion remains a soft
tombstone; a subsequent explicit resolution can restore a concurrent edit.

Private local boards need no Google identity or remote key. Existing viewer gates
still apply. When the board history contains signatures, resolution requires the
current installed trusted editor/owner context. It also verifies signed source
heads under that authority/history before deriving a new authored value. Missing,
expired or revoked grants and foreign/unverifiable signatures fail closed. A
current editor cannot resolve a shared-board deletion decision; that is owner-only.
Google login supplies none of these board permissions.

`resolutionOrigin.ts` matches an ephemeral local intent to exact intended document
bytes and parent IDs; no intent is read from network data or persisted in RxDB
schemas. Existing live mutation hooks sign a **new** operation whose existing
`_sec.provenance.parents` field references all reviewed heads. Storage guards then
verify that operation as usual. The intent is cleared on success/failure and does
not affect subsequent ordinary edits. Original authors' signatures are not reused
on changed data. Publishing under another authority is not an automatic migration.

The journal keeps its existing database name, upgrades additively from schema 1 to
2, and adds only a local `drafts` store/index. Existing entries and delivery receipts
are retained. Journal writes request IndexedDB strict durability before reporting
completion. Upgrading closes older journal connections through `versionchange`;
old extension views should be reloaded rather than attempting mixed-version writes.
No application RxDB schema, OAuth configuration, key, grant or snapshot is migrated.

## Verified evidence

```sh
npx vitest run tests/recovery/conflictResolution.test.ts tests/conflictResolutionControls.test.tsx
npm run test:recovery -- --browser
```

The 24 Job 5 tests exercise real RxDB resolution writes and signatures, editor/owner
roles, expired/revoked/uninstalled grants, foreign authority evidence, stale/cross-board
requests, source preservation, separate persistent drafts, soft delete/restore,
concurrent resolutions, commit/ack interruption, additive journal upgrade, and UI
comparison/manual editing/failure handling. They do not mock collaboration security
to grant unauthorized resolutions.

The native private-recovery probe also renders the actual React conflict editor in
Chromium, enters a draft, waits for its IndexedDB commit, kills the browser process,
reopens the same isolated profile, restores the draft and explicitly saves it to
the real RxDB card with both reviewed parents. No signaling is used. Its two branches
are an explicitly constructed **local private fixture**, not a claim of authenticated
history exchange through a production transport. Shared collaboration regression
probes continue using real signatures, admission checks and native WebRTC; Google
HTTP remains synthetic.

Local validation passed: focused recovery 151 tests plus 5 explicit expected gaps,
Rust 36 tests, all seven native harness stages, root/Android typechecks and both
browser builds/package verification. The complete suite has 655 passes, 5 expected
gaps and the same two pre-existing releaseMetadata/standardsPolicy failures. Full
acceptance remains blocked; these component/native successes do not close every
scenario in the contract.

## Remaining limits

- Private Drive now backs up original variants, resolutions and drafts, including
  fresh-device recovery. C03 passes. Authenticated peer history exchange is implemented in Job 7; historical permission
  and complete platform/lifecycle acceptance remain open.
- Unknown imported ancestry is conservatively retained and may require review;
  legacy operations without author proofs retain unknown ancestry under Job 7. The panel makes that
  existing engine limitation visible rather than claiming real concurrent edits
  have been proved in every legacy import.
- Missing parents, more than eight heads, unavailable image bytes, a removed/hard
  deleted board/document and an incompatible current template block application.
  Board-name resolution and choosing a compatible template version are supported;
  changing a template as part of a resolution and applying a board-deletion variant
  require a later board-wide recovery transaction. Evidence stays visible meanwhile.
- Existing verification requires historical authors to remain authorized by the
  current manifest. A removed author's old signed variant may therefore need
  additional trusted recovery before it can be resolved. This job does not weaken
  that policy. Durable offline permissions and expiry-tolerant local drafts remain
  Job 8; the existing A04/A08 gaps are unchanged.
- Drafts/history have no destructive compaction policy and are not included in
  current exports. Local-device loss can lose unpublished history. Large-history
  storage/latency, Firefox/Android native recovery and accessibility review remain
  validation gaps, not inferred successes from Chromium/unit tests.

No rendezvous deployment, production release, tag, OAuth scope change or shared
Drive-folder migration is performed by this job. Full acceptance remains blocked.
