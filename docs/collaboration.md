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

## Data model and storage

Local state is unchanged: the shared RxDB database `pboardlocalv1` with `projects`,
`cards`, `settings` collections. Replication uses those same collections.

Drive storage for a **shared** project is a visible file:

```
My Drive/
  Pboard/                       (app-managed folder, created on first share)
    <projectId>/                (one folder per shared project)
      project.json              (v1 pboard-project snapshot: project + cards + inline images)
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
- **Persistence**: the local snapshot is uploaded to `project.json` on the existing idle
  sync cadence (backup + new-peer bootstrap source), but a shared project does **not**
  auto-import a remote snapshot over existing local cards (no LWW clobber while peers
  are live).
- Private projects keep the existing auto-pull LWW behavior.

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
  call count bounded. Stale records are pruned by `modifiedTime` on open and on
  publish. Offer/answer/ICE are coordination data, never project content, and are never
  logged.
- `DevWebSocketSignaling` (Phase 1, tests/dev): points the simple-peer handler at a
  signaling endpoint (RxDB's `startSignalingServerSimplePeer` in Node tests). This is
  the temporary mechanism, isolated behind the same interface.

`createPboardWebRTCConnectionHandler(signaling, topic, peerId)` returns an RxDB
`WebRTCConnectionHandler` (connect$/disconnect$/message$/response$/send) built on
`simple-peer` + the injected `SignalingProvider`. Replication logic never references a
specific signaling service.

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
- WebRTC image transfer is **not** used; images reach collaborators via the Drive
  snapshot (bootstrap) and, once both peers have the blob locally, via the existing
  blob store. A peer who has never seen an image gets it on the next Drive bootstrap.
  (RxDB's WebRTC plugin does not document attachment replication.)
- OAuth scope widened from `drive.appdata` to `drive.file` (required to create/share
  visible files and manage their permissions). If permission management is rejected
  under `drive.file`, widen to `drive`.
