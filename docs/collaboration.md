# Pboard collaboration architecture

Approved implementation target: [two operating modes, synchronization semantics and recovery
acceptance scenarios](architecture/synchronization-contract.md). That contract is
the approved baseline; its implementation is staged and the behavior described
here remains the current compatibility baseline.

Update, 19 October 2026: ordinary production builds also expose an opt-in,
independent board-grant WebSocket/WebRTC path. Google/Drive ACLs do not authorize
that path, and optional private Drive persistence can run alongside it. See the
[current architecture review, authorization model and limits](architecture/websocket-signaling-experiment.md#current-architecture-review-and-correction--19-october-2026).
Google-connected WebSocket devices now enroll automatically under owner-signed
email policies. Same-account devices need no invitation; other accounts must be
explicitly invited via Share project. See the [current account-sharing flow](../services/pboard-signaling/README.md#automatic-google-account-sharing--current-flow).

WebSocket invitations now appear as **Shared boards available** in the main
sidebar, outside collapsed collaboration settings, including on an empty device.
Both browsers must have WebSocket collaboration enabled at the same rendezvous
and be connected to their respective Google accounts. Discovery runs every five
seconds and on focus. The original authority browser must be online to approve
the recipient device; until then the invitation shows a waiting status. After
approval, **Open board** waits for the authenticated peer transfer before
selecting the received board. The owner must have that board open for the initial
transfer. No unsigned placeholder or cross-account private Drive read is used.
An unsuccessful open reports the error and restores the previous live session
when the user has not navigated elsewhere. Account login alone never opens a
room or grants board membership. Previously received boards remain in the normal
project list rather than being repeated in the invitation inbox.

The sections below describe the preserved legacy Drive collaboration path; its
shared folders are actual existing functionality, not private appData storage.

Reviewed against the implementation on 12 October 2026. Google Drive provides persistent snapshots, sharing permissions, and signaling. RxDB stores local documents and replicates live changes over WebRTC. Pboard does not operate a central synchronization server. See [local storage](rxdb-storage-refactor.md) for migration and rollback, and [refactor status](../REFACTOR_STATE.md) for remaining validation.

## Runtime wiring

`src/sync/browser.ts` constructs the permission service, shared snapshot sync, shared-board discovery, and collaboration manager. `src/sidebar/App.tsx` starts the manager for the current project and stops it on unmount. A project change starts the new board, which retires the previous board's session in the background; it does not stop first. Start, stop, and role refresh operations are serialized.

The sidebar discovers shared boards on load, every 30 seconds, on focus, and after Drive/sharing changes. Background reconciliation also runs discovery. Discovery skips existing local boards and removed projects, isolates per-board failures, and rejects snapshots with a mismatched project ID. Access is refreshed every 10 seconds while the board is open. Changes to the resolved role or shared file restart the pools.

The Share dialog manages invitations, viewer/editor roles, and member removal. **Enable live collaboration** creates a shared layout without inviting another account, allowing two browsers on the same account to connect. The dialog shows waiting, connected-browser, and error messages.

## Drive layout and permissions

Private boards keep `project-<id>.pboard` snapshots in `appDataFolder`. Shared boards use this layout in the owner's Drive:

```text
My Drive/
  Pboard/
    <projectId>/
      project.json
      image-<SHA256>.json
      realtime/
        sig-<topic>-<peerId>.json
```

`src/sync/drivePermissions.ts` creates/reuses this layout and caches folder, project-file, and realtime-folder IDs in `pboardDriveSharedProjects`. Enabling sharing uploads the local snapshot without deleting the old private backup. Private snapshot reconciliation skips shared boards; shared snapshot writes use the separate shared-sync path.

The project **folder** is the main permission target; child files inherit access. Viewers receive `reader`, editors receive `writer`, and the folder owner is the board owner. Viewer signaling needs writes, so the permission service grants separate writer access to the realtime folder; role changes retain signaling writer access, while member removal revokes it separately. Account identity comes from Drive's `about?fields=user(emailAddress,displayName)` endpoint, not the People API.

| Role | Board content | Membership | Project removal |
| --- | --- | --- | --- |
| Owner | Read and write | Invite, change roles, remove members | Delete shared content |
| Editor | Read and write | No membership controls in Pboard | Remove from own account list |
| Viewer | Read | No membership controls in Pboard | Remove from own account list |

Google OAuth requests both `drive.appdata` and full `drive`. The broad Drive permission supports incoming shared-board discovery and files owned by other accounts; `drive.file` was not retained for that path. Search calls use `drive` for shared files and `appDataFolder` for private records. Both transports bypass HTTP caches for discovery and media reads.

## Shared snapshots and images

`project.json` uses the version-1 project snapshot format, including inline images at the compatibility boundary. Discovery imports a missing board; the manager can bootstrap when no local project exists. Existing local boards are not replaced wholesale by shared Drive snapshots.

`src/sync/sharedSync.ts` restores matching missing image bytes for every role. Owners/editors upload pending snapshots on the existing manual and idle synchronization triggers. A newer remote snapshot reports a conflict rather than being overwritten by an older local board. Viewers do not upload board content. Because existing documents are not automatically refreshed from the shared snapshot, reconnecting peers remains necessary to receive live changes to an already-local board.

`src/collab/imageSync.ts` publishes immutable hash-addressed image assets for owners/editors and downloads missing assets for all roles. Card/image subscriptions and a two-second poll drive transfer while the board is open. Size and SHA-256 checks reject corrupted assets. Image arrival refreshes the card without replacing newer text. Image bytes travel through Drive, not WebRTC, and can arrive later than the card reference.

## Live replication and conflicts

The active shared board has two RxDB replication pools:

- `cards`: `pboard-collab-<projectId>-cards`.
- `projects`: `pboard-collab-<projectId>-projects`.

The connection handler filters received documents to the active project. Push modifiers omit documents belonging to other projects. Owners/editors have pull and push; viewers have pull only. The repository's `setMutatorRole` gate rejects viewer content mutations in the normal client. Project removal is a separate account-preference operation and is allowed for viewers.

RxDB chooses master/fork by storage-token hash, not user role. The repository gate is needed because omitting push on a viewer pool does not stop a viewer acting as master from serving its stored documents.

Projects and cards resolve conflicts by last write wins on `max(updatedAt, deletedAt)`. Ties retain master state. This avoids the default RxDB handler discarding a newer independent fork write when its assumed master state is stale. It is document replacement, not a character-level CRDT. Clock skew can affect which write wins; simultaneous edits to the same document can lose one user's changes. `tests/conflictResolution.test.ts` and the native-browser harness cover independent newer fork writes and deletion conflicts.

## Signaling and connection lifecycle

The implemented `PboardSignaling` interface in `src/collab/signaling.ts` is:

```typescript
interface PboardSignaling {
  join(onRoster: (peerIds: string[]) => void): Promise<{ peerId: string; peers: string[] }>;
  sendSignal(toPeerId: string, signal: unknown): Promise<void>;
  onSignal(handler: (fromPeerId: string, signal: unknown) => void): void;
  onError?(handler: (error: unknown) => void): void;
  leave(): Promise<void>;
}
```

Three implementations exist: in-memory signaling for tests, a WebSocket implementation for development, and Drive signaling for the shipped extension. There is **no configured automatic WebSocket fallback** in the application.

Each Drive peer owns one `sig-<topic>-<peerId>.json` record containing presence and a directed outbox. Writes are serialized, delivery is at least once with deduplication, expired signals are pruned, and leaving deletes the own record. Defaults are two-second polling, 60-second presence expiry, and 240-second signal expiry. Expiry makes stale records inactive; it does not guarantee that files left by a crashed browser are physically deleted.

`createPboardWebRTCConnectionHandler(options)` builds the simple-peer handler from signaling, optional native WebRTC bindings, and a document-scoping predicate. Non-trickle ICE bundles candidates into the offer/answer. Its JSEP state gate rejects stale answers that do not match a locally emitted offer; unknown senders are buffered until a peer is created.

Connection setup can take seconds and depends on Drive availability and quotas. Once connected, changes use the WebRTC channel. The current simple-peer defaults use Google and Twilio STUN services. No TURN relay is configured, so restrictive networks may prevent connections. Credentials are not sent to peers; signaling can expose network addresses. See the [privacy policy](privacy.md).

## Account preferences and deletion

Project ordering belongs to the account, not the shared board. A normalized Google email hash selects `projectOrder:<account-hash>`. A separate settings pool uses `pboard-account-<hash>-order`; rendezvous records are `account-signal-<hash>-<peer>.pboard` in private app data. Only that account's preference is replicated. Other settings, including current selection, remain local.

Private `account-preferences-` records persist order and permanent `deletedProjectIds` even when no peer is online. Removal markers merge independently of newer concurrent ordering changes. They hide projects/cards and prevent stale snapshot import or shared-board rediscovery. Viewers can reorder or remove boards from their own account list.

Deletion commits the account removal marker and selection switch first. Drive ownership resolution and card tombstones continue afterward. Owners delete content; editors/viewers remove only their own list entry. If ownership of a known shared board cannot be verified, the operation is account-only. Errors in background work are surfaced without undoing the list removal.

Private Drive deletions can remain pending offline. Shared-project tombstones are retained and private reconciliation does not delete shared Drive folders. Previously downloaded content, old private backups, and collaborators' independent copies are not erased by removing access or hiding a board. Local image tombstones retain references and there is no automatic blob garbage collection.

## Authorization and security limits

Protocol-2 security (`src/collab/security/`) implements the owner-approved device-key model from [collaboration-security-plan](collaboration-security-plan.md):

- **Canonicalization and signatures**: `canonical.ts` (canonical JSON, strict parsing with duplicate-member rejection, base64url, domain separators, size limits). `keys.ts` holds ECDSA P-256 device keys with canonical-JWK SHA-256 fingerprints, persisted outside Google OAuth storage.
- **Board authority and manifests**: `manifest.ts` signs a device key → role list bound to the Drive project/folder ids, with epoch, issue/expiry times (5-minute design default) and anti-rollback state. Clients pin the authority fingerprint through out-of-band enrollment; a manifest read from Drive alone is never trusted.
- **Signaling envelopes**: `session.ts` signs presence announcements and every offer/answer/candidate envelope, bound to board, collection, manifest hash, epoch, both session ids, sequence, and expiry; receivers keep replay caches and bound queues (64 KiB envelope cap, 32 pending signals per session).
- **Connection state machine**: `webrtcHandler.ts` runs `discovered → signalingVerified → transportConnected → mutualProofVerified → replicationReady → closed`. After DTLS connects, both sides exchange one signed proof over a fresh challenge plus the ordered offer/answer transcript hash. `connect$` fires and RxDB sees content only after mutual proof, and `isPeerValid` requires a verified session context in the manager. Auth fails after 10 s.
- **Content integrity**: `mutation.ts` adds signed provenance (`_sec`) to replicated card/project documents and wraps collection storage so a document failing verification is answered as a write error — signed provenance is checked through every persistence path (pull, live stream, masterWrite, conflict writes) before RxDB persists. Signed mutations require an owner/editor device under the *current* manifest; viewer-signed mutations are rejected; repeated identical operations are idempotent and conflicting duplicates are rejected. `checkpoint.ts` binds Drive snapshots to authority-signed checkpoints (state hash + monotonic sequence; tampering, rollback and stale imports are rejected). Shared images remain SHA-256-bound to their card references with a strict MIME allowlist.
- **Account room**: project-order rooms use a separate account authority and `collection: "accountOrder"` binding; shared-board credentials cannot join them, and account manifests carry no Drive project binding.
- **Endpoint policy**: `endpoint.ts` accepts only HTTPS fetch and WSS WebSocket endpoints (Google API origin allowlist) with an explicit loopback development exception that received data cannot enable.

Current verification: `tests/securityProtocol.test.ts` (canonical/keys/manifest), `tests/securityEndpoint.test.ts`, `tests/securityAdversarial.test.ts` (forged manifests, viewer writes, replay, proof copying, cross-board binding, wrapper persistence, checkpoint rollback, legacy rejection). The adversarial tests exercise the security modules directly and the storage wrapper through a live RxDB collection; real-browser DTLS evidence and real-Drive permission revocation remain open release gates from the plan. Drive latency, restrictive networks and the owner-offline availability tradeoff are unchanged.

Live collaboration fails closed before signaling starts when a board or account
security provider is missing, rejects verification, or returns no trusted manifest.
The manager also checks manifest structure, freshness, room binding and local device
membership. Shared-board rooms require installed mutation protection. There is no
legacy admission option in the production manager. A blocked start reports an error
and closes partial rooms; local board operations remain available. Retrying after
trust is restored resolves the manifests again. If account-order replication is
requested alongside a shared board, both contexts must be available before either
room starts.

## Verification

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
transport). Reorders trigger preference persistence; another open sidebar pulls
preferences through startup/focus/visibility/online and periodic reconciliation.
The periodic interval is 30 seconds, not an immediate delivery guarantee.

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
