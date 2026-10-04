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
  re-uploaded whenever a collaborator is invited. It is **not** refreshed on the idle
  sync cadence (shared projects are skipped there), so a board that receives no new
  invites keeps its invite-time snapshot in Drive while live edits flow via WebRTC.
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

## Permissions model

Google Drive v3 `permissions` API is the **authoritative** ACL. There is no independent
pboard ACL.

| pboard role   | Drive role | can |
|---------------|-----------|-----|
| owner         | owner     | read, write, manage members, delete project |
| Editor        | `writer`  | read, write (replication push + Drive push) |
| Viewer        | `reader`  | read (replication pull only; no push) |

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

RxDB's default conflict handler is used. **Rationale:** RxDB's default resolves a
document write conflict deterministically (it does not silently drop work the way a
naive last-write-wins on the whole string would; it operates per document with the
`_meta` revision). For v1 we keep that rather than introducing a CRDT, and we document
that same-card *character-level* concurrent text editing is out of scope (whole-field
merge). This is intentional, not an oversight.

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
