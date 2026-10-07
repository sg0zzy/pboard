# Pboard collaboration (sharing + realtime)

Status: first usable version. Local-first, no pboard backend. Google Drive is the
persistent store and the permission authority; WebRTC (RxDB P2P replication) is the
low-latency live path. Everything is behind existing repository/sync seams so private
projects are unchanged.

## Architecture

```
                 Google Drive
        persistence + permissions
             /                \
            / (bootstrap,      \ (live, low latency,
           (offline, backup)    (only while peers online)
          /                     \
    RxDB A  <===============>  RxDB B
             WebRTC (RxDB P2P)
```

- **Google Drive** — durable state, project sharing (per-file Drive permissions),
  bootstrap for a user who has no peer online, and offline store-and-forward.
- **WebRTC** — live document changes between online peers, using RxDB's replication
  protocol (no custom document protocol).
- **RxDB** — local database, document change propagation, conflict handling.

Private projects keep the current single-user layout (`appDataFolder` snapshot + whole-
project LWW Drive sync). When a project is **shared**, it gets a visible app-managed
Drive file whose Drive permissions are the access-control source.

**App wiring.** `src/sync/browser.ts` builds a module-level `collaborationManager`
(manager options bound to `drivePermissions`, a `bootstrapFromDrive` that imports
the Drive snapshot, and a `signalingFor` factory that constructs a Drive-backed
`PboardSignaling` per topic). `App.tsx` starts the manager on the current project
and stops it on unselect/unmount; the manager serializes start/stop so a rapid
switch can't race the pool list. The Share button + "Share Project" dialog
(`src/sidebar/components/ShareControls.tsx`) sits left of the Drive cloud icon and
drives the permission service (invite / role change / remove; owner not removable;
viewer read-only).

## Data model and storage

Local state is unchanged: the shared RxDB database `pboardlocalv1` with `projects`,
`cards`, `settings` collections. Replication uses those same collections.

Drive storage for a **shared** project is a visible file:

```
My Drive/
  Pboard/                       (app-managed folder, created on first share)
    <projectId>/                (one folder per shared project)
      project.json              (v1 pboard-project snapshot: project + cards + inline images)
      image-<SHA256>.json        (immutable image assets, fetched by connected browsers)
      realtime/                 (ephemeral WebRTC signaling records, best-effort)
        offer-<peer>.json
        answer-<peer>.json
        ice-<peer>.json
```

- `project.json` reuses the existing v1 snapshot wire format
  (`src/sync/snapshot.ts`), so serialization/deserialization is unchanged.
- Access to `project.json` follows its Drive permissions (reader = pull, writer = push).
- The owner's original `appDataFolder` copy is left in place until the project is
  shared; after migration the sync state points `remoteFileId` at the visible file so
  both layouts resolve to the same record. Private projects are never touched.

**Migration is safe and non-destructive:** creating the visible file uploads the current
snapshot; it does not delete the private file. Project IDs, `updatedAt`/`revision`
semantics, tombstones, and crash-safety behavior are preserved (the snapshot format is
identical).

### Snapshot conflict policy for shared projects

Whole-project LWW (`project.updatedAt`) is correct for the single-user path but would
clobber fine-grained WebRTC merges on a shared board. So for **shared** projects:

- **Bootstrap** (user has no local cards for the project): import `project.json` once.
- **Live**: WebRTC merges card/project documents (RxDB conflict handling).
- **Images**: owners and editors publish local images as hash-addressed assets in
  the shared Drive folder. All roles fetch missing images while the board is open
  and cards refresh when bytes arrive. Existing inline snapshot images remain a
  fallback; restoring a matching image never replaces newer card text.
- **Persistence**: `project.json` is the bootstrap source for new collaborators and is
  re-uploaded whenever a collaborator is invited and when an owner/editor syncs
  pending changes (manually or on the idle cadence). Shared sync writes to the
  shared file rather than private app data and updates the toolbar sync status.
  Viewers only restore matching image bytes. A newer remote backup is never
  overwritten by an older local board; that situation reports a sync error.
  A shared project does **not** auto-import a remote snapshot over existing local
  cards (no LWW clobber while peers are live).
- Private projects keep the existing auto-pull LWW behavior.

### Account-specific project list order

Project list positions are preferences, not shared project content. Reordering
writes a `projectOrder:<account-hash>` setting rather than project documents.
The account hash derives from the trimmed, lowercase Google Drive email address.
An independent WebRTC room replicates only that account's order setting, using
ephemeral `account-signal-<account-hash>-<peer>.pboard` records in private
`appDataFolder` for rendezvous. Project snapshot discovery excludes these records.

Sessions of the same account can display different projects and still exchange
the full list order, including private projects. Different accounts never join the
same order room. Viewers can change their own list order without obtaining board
editing rights. Other settings, including current project selection, stay local.
The local list uses the account preference for known project IDs and appends
projects absent from that preference; it does not create or delete projects from
an order received from another session. Disconnecting preserves the last visible
order locally. Both sidebars must be open for WebRTC preference synchronization.
Project order is also saved in private Drive app data under the separate
`account-preferences-` namespace. Reordering saves that preference; startup
reconciliation and project sync restore or update it using its timestamp. A new
browser restores saved ranks even before all private/shared boards are imported,
so it does not depend on the original browser remaining open. Selected projects
remain local to each browser. The same account preference carries permanent
`deletedProjectIds`. Those markers replicate live, merge even when a concurrent
order update is newer, and persist in Drive. They hide the board and its cards,
move a deleted selection to a remaining project, and block stale snapshot imports
and shared-board rediscovery. Offline deletions merge back into the account
preference on reconnect. Other accounts retain their own preferences.

Only the owner deletes shared project and card records. An editor or viewer
removing a shared project writes only their account's removal marker; the
shared collections and the owner's board remain intact. This removal syncs to
the collaborator's other sessions and blocks rediscovery. Deletion checks Drive
ownership again at the time of the action. If a known shared project's ownership
cannot be verified (including offline), removal affects only the account list.

Confirming a deletion commits the account marker and the current-project switch
first, then resolves Drive ownership, so the board disappears from the confirming
user's sidebar without waiting for the network. Ownership verification and the
per-card tombstone pass continue in the background; a failure there is reported to
the user but does not undo the committed account marker. RxDB's update plugin
applies changes per document, so the tombstone pass is O(cards) and is kept off
the user-blocking path.

## Permissions model

Google Drive v3 `permissions` API is the **authoritative** ACL. There is no independent
pboard ACL.

| pboard role   | Drive role | can |
|---------------|-----------|-----|
| owner         | owner     | read, write, manage members, delete project |
| Editor        | `writer`  | read, write (replication push + Drive push), remove from own list |
| Viewer        | `reader`  | read (replication pull only; no push), remove from own list |

Role mapping: Viewer→`reader`, Editor→`writer`. The owner is the authenticated account
that owns the file. A lightweight in-memory cache of members exists for UI
responsiveness only and is reconciled against Drive on open and after every mutation.

Viewer write restriction is enforced **in the collaboration layer**, not just the UI:
the repository is gated to the viewer's role (`setMutatorRole`), so a mutation to the
shared project is rejected at the storage layer — no divergent local write exists to
be streamed. The WebRTC pool is also pull-only for viewers (no push), and the UI is
read-only. UI read-only controls are a convenience on top of this.

## WebRTC replication

Per active shared project, two RxDB replication pools are started (one per replicated
collection), each scoped to that project:

- `cards` pool, topic `pboard-collab-<projectId>-cards`
- `projects` pool, topic `pboard-collab-<projectId>-projects`

Distinct topics per collection keep the simple-peer room semantics clean (a room must
not mix two collection schemas).

Scoping: the master's WebRTC handler streams its **whole** collection (every
project's documents), so a room would leak a peer's private projects. Documents are
scoped to the active project in two places, because the RxDB pull path has no way to
drop a document (a `null` pull modifier would crash `persistFromMaster`):

- **Receive** — the pboard connection handler drops out-of-project documents from the
  incoming replication responses (cards by `projectId`, the project doc by `id`).
- **Send** — the `push` modifier returns `null` for out-of-project documents (the push
  path filters nulls).

- Editor/owner: `push` + `pull` enabled, both scoped.
- Viewer: `pull` only (no push) — and the repository gate rejects shared-project
  mutations at the storage layer (see above).
- `isPeerValid` runs the role/authorization check on connect (see below).

Conflict policy: `projects` and `cards` resolve document conflicts by last write wins on
the document's own write time (`max(updatedAt, deletedAt)`); `settings` merges
`projectOrder` values and otherwise keeps the master state. **Rationale:** RxDB's default
handler keeps the master state whenever the fork's assumed master state is absent or
differs from the real one, and a dropped fork write is never re-applied. That is the normal
state for a document both peers created independently — one peer bootstrapped the Drive
snapshot, the other created it — so under the default policy an editor's first change to
that document is silently lost. WebRTC picks the master by storage-token hash, not by who
edited, so the default policy decides authorship arbitrarily. `updatedAt` is monotonic per
instance, so it is a usable cross-peer ordering; ties keep the master state, and the losing
side converges on the next upstream pass. Whole-field merge (no CRDT) and character-level
concurrent text editing remain out of scope. Covered by `tests/conflictResolution.test.ts`.

Conflicts are resolved only on the fork: the master peer just serves `masterWrite` and never runs
the replication protocol, so the fork's own write is the state the handler sees.
`experiments/collaboration/webrtc-browser-smoke.mjs` verifies this in native Chromium — an agreed
version is replicated to the fork, the fork then diverges while disconnected (a failed push writes
no meta row, so its assumed master state stays stale), and the newer write wins on both sides.

## Signaling

`SignalingProvider` (interface) abstracts rendezvous so the transport is swappable:

```ts
interface SignalingProvider {
  connect(projectId: string, peerId: string): Promise<void>;
  publish(projectId, kind, payload): Promise<void>;   // offer | answer | ice
  subscribe(projectId, kind, onMessage): () => void;
  close(projectId): Promise<void>;
}
```

- `DriveSignaling` (Phase 2, primary for the extension): ephemeral JSON records under
  `Pboard/<projectId>/realtime/`. Uses **non-trickle ICE** (`trickle:false`) so an offer
  and answer each carry all candidates in a single record — this keeps the Drive API
  call count bounded. Polling continues while the board is open, including after
  transient Drive failures. Each browser session has a distinct peer id even when
  both use the same Google account. Signals carry a recipient peer id, and heartbeat
  and signal writes are serialized so they cannot overwrite one another. Presence
  and signal TTLs ignore expired peers and prune old outbox entries; leaving removes
  the session's own record. Offer/answer/ICE are coordination data, never project content, and are never
  logged.
- `DevWebSocketSignaling` (Phase 1, tests/dev): points the simple-peer handler at a
  signaling endpoint (RxDB's `startSignalingServerSimplePeer` in Node tests). This is
  the temporary mechanism, isolated behind the same interface.

`createPboardWebRTCConnectionHandler(signaling, topic, peerId)` returns an RxDB
`WebRTCConnectionHandler` (connect$/disconnect$/message$/response$/send) built on
`simple-peer` + the injected `SignalingProvider`. Replication logic never references a
specific signaling service.

The handler tracks each peer's JSEP signaling state and validates every
description before applying it: an `offer` is accepted only by the answerer
(`remotePeerId > ownPeerId`) while the state is `new`, `stable` or
`have-remote-pranswer`; an `answer`/`pranswer` only in `have-local-offer`.
State advances on the description this instance emits *and* on the one it
applies, so a duplicated or replayed answer from the Drive outbox is dropped
instead of raising `InvalidStateError: Cannot set a local answer in 0`. ICE
candidates always pass because `simple-peer` holds them until a remote
description exists; signals from a sender that is not yet known are buffered
and re-validated when the peer is created.

The Share dialog offers **Enable live collaboration** for a private project, allowing
two browsers on the same account to start live replication without an email invite.
Drive connection and sharing changes restart the current board's collaboration;
access is also checked periodically to discover sharing enabled by another browser.
The dialog reports connected browsers and transport errors. Tests exercise late peer
discovery and bidirectional replication over real WebRTC with simulated Drive records.

**Limitation (documented, not silent):** Drive-based signaling has real latency (each
record is a Drive read/write; polling-based). Connection setup can take seconds. Once
the data channel is open, replication is low-latency. If live measurements show Drive
signaling is unsuitable, the extension falls back to a configured WebSocket signaling
URL (`DevWebSocketSignaling`), and we document that a signaling endpoint is required —
we do **not** ship a permanent pboard server.

## Authorization of peers

Knowing a `projectId` is not authorization. On connect, `isPeerValid` checks the
authenticated Google identity and the project's Drive permissions:

1. Resolve the current user's email (Drive People API `people/me`).
2. Confirm the user has a Drive permission on the project file (owner/reader/writer).
3. Map to pboard role. A user with no permission → drop the peer (no replication).
4. Role gates the direction (Viewer → pull only, no push).

Received replication documents are scoped to the active project by the connection
handler (receive) and the push modifier (send), and pass RxDB's schema validation,
before they touch the database; remote peers are treated as untrusted.

## Connection / UI states

Internal collaboration states (no permanent labels; surfaced via the Share button
tooltip and, later, a collaborator count):

`private | shared | connecting | peer-connected | offline | sync-error`

The existing cloud/auth icon is untouched; the Share button is separate.

## Security / privacy

- Google OAuth tokens and Drive credentials are never sent over WebRTC or to peers.
- ICE/signaling records are ephemeral, pruned by age, and never logged.
- All received replication documents are scoped by the connection handler (receive)
  and pass RxDB's schema validation; peers are untrusted even with Drive access.
- Viewer peers cannot push writes (enforced in the collaboration layer: repository
  gate + pull-only pool).

## Testing

- Share UI: button rendering/placement, dialog open/close, invite validation, role
  change, removal confirmation, error handling (jsdom).
- Drive permissions service: list, reader/writer invite, update, remove, identity,
  shared-file migration (fetch fakes).
- RTC: two-instance replication, reconnect, offline edits, conflict behavior, viewer
  read-only, project scoping (Node + fake-indexeddb + node-datachannel + fake
  signaling). Networking-dependent integration tests are isolated from unit tests.

## Current limitations / experimental

- Drive-based signaling latency is real; a configured WebSocket endpoint is the
  fallback. Not a pboard backend.
- Same-card character-level concurrent text editing is out of scope (whole-field merge
  via the RxDB default conflict handler).
- Image bytes travel through Drive rather than WebRTC. A new image may appear a
  few seconds after its card reference, depending on upload and polling latency.
- OAuth scope widened from `drive.appdata` to the full `drive` scope: a shared
  board's files are not owned by the recipient, and `drive.file` cannot reliably
  find or manage other users' files (including incoming permission invitations),
  so discovery and collaboration use `drive` rather than `drive.file`.

### Native browser signaling regression

`npm run test:webrtc:browser` runs two isolated headless Chromium profiles as
the same project owner, using real IndexedDB, WebRTC and RxDB replication. A
local HTTP server simulates Drive with cacheable presence/handshake responses.
The test verifies peer discovery and replication of the five mutation types in
both directions — project category (board template, including the card-type
remap it forces), card state, card category, card creation and card deletion
(tombstone, not only the live card list) — plus live account project order,
deletion after switching projects, protection against stale snapshot
resurrection, and exactly one presence file per session/collection. It also
runs the JSEP gate inside a single page over an in-process signaling scope: two
handler instances negotiate, the answer captured from that handshake is replayed
to a third instance that never sent an offer, and the test asserts the replayed
answer is dropped rather than applied while native Chromium raises
`InvalidStateError` for the same description. It needs Chromium on PATH (or
`PBOARD_CHROMIUM_BIN`) and makes no authenticated Google requests.

Drive reads bypass the HTTP cache in both the shared-folder and private-account
transports. Otherwise cached file searches or media downloads can hide peers,
lose handshake updates, and create duplicate presence files.
