# Pboard collaboration architecture

> **Current default, 28 October 2026:** [Drive-first operation synchronization](architecture/drive-operation-sync.md)
> replaces peer authority, device-grant gating and mutable board snapshots in the
> normal browser/Android runtime. Drive ACLs authorize access; immutable operations
> converge without WebRTC or an online owner. The sections below retain the prior
> implementations and investigation history for compatibility/recovery context.

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

The sidebar discovers shared boards on load, every 30 seconds, on focus, and after Drive/sharing changes; the Drive **Sync now** button additionally reconciles immediately with a fresh (uncached) listing, so a just-received invitation surfaces on click. Background reconciliation also runs discovery. Because Drive name search can lag a fresh grant by minutes, discovery additionally expands the shared-with-me shelf (board folders and directly shared `project.json` markers) as a best-effort supplement, so invitations surface without waiting for the index. Discovery skips existing local boards and isolates per-board failures, and rejects snapshots with a mismatched project ID. A locally removed (left) board normally stays hidden forever; it is restored only when the owner re-invited and no leave revocation is still pending. Re-invitation is recognized by grant identity, not by time: the caller's own collaborator grant `id` must differ from the `id` recorded at the previous observation, or from the null baseline a leave recorded through this app sets, because Drive's `Permission` resource exposes no creation time and its `id` is opaque. The first observation of a grant can therefore never be ordered against an earlier removal: it records the baseline and reports no re-invitation, so a grant that predates the leave does not restore the board. Access is refreshed every 10 seconds while the board is open. Changes to the resolved role or shared file restart the pools.

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

The project **folder** is the main permission target; child files inherit access. Viewers receive `reader`, editors receive `writer`, and the folder owner is the board owner. Viewer signaling needs writes, so the permission service grants separate writer access to the realtime folder; role changes retain signaling writer access, while member removal revokes it separately. Account identity comes from Drive's `about?fields=user(emailAddress,displayName)` endpoint, not the People API. Because the email belongs to the access token, `src/sync/driveIdentity.ts` resolves it once per JS context per token and shares the in-flight lookup, so every consumer of the account — the erasure sweep, the preference round, the changes feed, the role checks — pays one request instead of one each.

| Role | Board content | Membership | Project removal |
| --- | --- | --- | --- |
| Owner | Read and write | Invite, change roles, remove members | Delete shared content |
| Editor | Read and write | No membership controls in Pboard | Leave: own list, own Drive ACL, own realtime ACL |
| Viewer | Read | No membership controls in Pboard | Leave: own list, own Drive ACL, own realtime ACL |

Only the owner's removal deletes shared content. A non-owner "delete" is a **leave**: the repository hides the board (order entry dropped, `deletedProjectIds` marker so discovery ignores it unless the owner later re-invites), then `drivePermissions.removeSelfFromProject` revokes the caller's own folder and realtime permissions so the owner's member list updates. The revocation is recorded in `pboardPendingBoardLeaves` and retried after every reconcile round, so an offline leave still lands; while a marker is pending, a re-appear cannot undo the leave. A subsequent genuine invitation (permission created after the removal) restores the board automatically. The deletion-role resolver (`src/sync/projectDeletion.ts`) maps shared-offline or unknown-role boards to viewer, so a non-owner can never reach the content-deleting path. Signed independent boards gate deletion on the owner's authority grant and additionally re-check the Drive ACL (`reverifySharedDeletionRole`, wired to `drivePermissions.myRole`) immediately before destroying content: a Drive editor/viewer permission downgrades the delete to a leave even when the locally imported grant says owner; a Drive failure or an unshared board keeps the grant's verdict. Boards without any Drive ACL leave locally only — the owner's device manifest still lists departed devices until the owner removes them.

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

### Attributing a sustained CPU load without a profiler

A build with `VITE_PBOARD_DIAGNOSTICS=1` collects counters for the work that
repeats: the Drive requests by purpose, the background sync attempts and how
they ended, the boards being retried, the shared-project discovery listings,
the account identity lookups, the React renders, the effect executions, the
repository subscription emissions, the collaboration session initialisations,
and — since the idle-CPU investigation — the wall-clock `timings` of the
recurring operations (`reconcile`, `sync:project`, `collab:refreshRole`,
`collab:start`).

The same build prices every Drive request it sends. `driveCost` records the projected
cost, the cost Google reported through `X-Drive-Request-Cost`, how many responses
carried that header, and the charged cost per resource. The reported number is
authoritative and the projection is the local model, so a report can show where the
two disagree. The discovery block also records cache hits and misses, which separates
a layout that is being cached from one that re-lists on every pass.

The Drive counter is wired into the fetcher every Drive provider uses:
identity endpoints are classified by URL, everything else by the operation
that issued it (`withDrivePurpose` marks `sync` and `reconcile` runs;
unscoped traffic counts as `other`). A session rebuild names the gate branch
that reopened it: `effects["collab:start:rooms-empty"]` growing on a steady
cadence is the manager's rebuild storm, `collab:start:security` is the grant
poll reporting a change, `timings["collab:start"].runs` counts the rebuilds
and `timings.reconcile` the reconciliations, their counts and durations.

A production build does not collect them: each call site is a single boolean
test, and the fetcher wrapper and duration wrappers are not created at all.
The counters are read from the background page's console, and from the
sidebar's console:

```js
pboardCounters.snapshot()
pboardCounters.snapshot().driveCost
pboardCounters.clear()
```

`driveCost.projected` and `driveCost.byResource` are in Google quota units, priced
by method (`X-Drive-Request-Cost` when a response reports it); they cover the one
context reading them, so read them in both the background page and the sidebar and
add — Google's per-user limit adds this account's other browsers, devices and the
signaling service on top.

The counters are the fastest way to attribute a load to a component: a
`renders` count that grows while the board is idle points at a subscription
that publishes more often than it should, a `backgroundSync.unsettled` count
that grows points at a board the worker cannot settle, a
`sharedDiscovery.listings` count that grows points at a layout that is not
being cached, and a `driveRequests.identity` count that grows by units of
three per board sync points at the uncached account identity.

Read the cost block as `pboardCounters.snapshot().driveCost`. A `byResource.list` that
grows while the board is idle names the resource being over-priced, `reportedRequests`
staying at 0 means every number in the report is model rather than measurement, and a
reported cost above the projection names a request the model does not account for. The
throttle that defers these requests never refuses one and never adds one, so a growing
cost count is real traffic, not retry traffic.

To take a 60-second idle report in Firefox: load a diagnostics build, open
the sidebar on the board that shows the problem, in both the sidebar's and
the background script's console (about:debugging → this extension → inspect)
run `pboardCounters.clear()`, wait a full minute without touching anything,
then capture `JSON.stringify(pboardCounters.snapshot())` from each console
twice, 30 seconds apart. Compare which counters moved; that names the
component while a profiler capture shows its stack.

For a stack-level view, record a Firefox Profiler run instead. Open
`about:profiler`, choose **Record**, leave the sidebar open and idle for a
minute, stop the recording, and in the flame graph look for the busiest
self-time frames. The ones that matter here are the extension's own bundle
(`sidebar-*.js` and `background.js`): a long `JSON.parse` or `canonicalize`
frame inside `privateDriveHistory` points at the archive verification, a
`setState`-shaped frame inside the sidebar bundle points at a render, and
repeated `IDBObjectStore.getAll` frames point at a subscription re-reading.

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

### Firefox fires a storage change for a write that changed nothing

Firefox reports `storage.onChanged` for a write whose value is identical to
the stored one; Chromium does not. The extension watched two storage keys, so
on Firefox a write that changed nothing was still a trigger.

Three writes are now conditional. The board's sync state is written only when
a field differs from the stored record, and the shared board's layout is
recorded only when its folder, file or realtime folder differs. The state
store's comparison treats an absent field and an explicit `undefined` field as
the same, because the record is stored as JSON.

`tests/recovery/syncStateWrite.test.ts` and
`tests/recovery/sharedProjectsWrite.test.ts` pin both properties.

### The sidebar restarted the board's live session every ten seconds

The sidebar refreshes the board's collaboration role every ten seconds, to
notice a remote change of the role. A board that cannot open a live room —
one without a collaboration security manifest, or with an expired one — failed
that refresh, and the failure made the manager start the board again. Every
ten seconds the sidebar therefore repeated the whole start-up path: the role
and the shared file were resolved again, the session was torn down, and a new
one was attempted. With Drive connected, each attempt is a Drive round trip.

The manager now records why a board could not start, together with the role
and the shared file it had resolved. A refresh that finds the same board, the
same role and the same shared file does not repeat the start-up path. The
attempt is made again when the board's authorization is reported as changed,
or when the room whose trust was missing now has it — the account room and
the board room are checked separately, so a board that becomes trusted later
is still opened.

The sidebar also no longer restarts the board's session for a Google token
refresh. A refresh keeps the same account and only extends the token's
lifetime; a new authorization, which may name a different account, still
does.

`tests/collaborationManagerIdle.test.ts` pins the properties: the start-up
path is not repeated while nothing changed, the board is opened once its
authorization arrives, and a deliberate stop makes the next start try again.

### The private history was downloaded and verified again on every reconciliation

The private history is append-only: every sync stores a new immutable
archive, and the archives grow with the board's history. Every reconciliation
downloaded and re-verified every archive of every board, so the cost of one
reconciliation grew without bound and ran on the sidebar's main thread.

An archive's name carries its content fingerprint, and an archive is
immutable, so a fingerprint this device already verified is remembered and its
bytes are not fetched again. A file id is remembered with it, so an archive
that was replaced under a new id is fetched again.

Measured in real Firefox with the real extension against a mock Drive, the
archives of a board with a growing history were downloaded eight times over
ninety seconds before the change and twice after it. The archive inventory
read is flat in the number of archives.

`tests/recovery/historyArchiveCache.test.ts` and
`tests/recovery/historyCost.test.ts` pin both properties.

### The board was re-rendered for a pin context that had not changed

The sidebar asks the background page every 1.5 seconds whether the current
page can be pinned. The answer is a fresh object every time, so storing it
re-rendered the whole board. A card is not a memoized component, so every
card re-rendered and re-parsed its markdown.

The answer is now compared field by field, and only a changed answer is
stored. A changed answer still re-renders the board, as it must.

`tests/sidebarPinContext.test.ts` pins the comparison.

### The sidebar re-rendered the board continuously while it was open

The sidebar observes the whole settings collection from its project list and
its current project. Two writes to that collection happened on every
account-preference sync, which the sidebar runs on a timer:

- the account's project order was merged and written unconditionally, and the
  merge produces a new value each time, so the write changed the collection
  even when the order had not changed;
- the local order was written unconditionally as well.

Each write re-read the list and the current project and published a new
array, so the board re-rendered. Every render re-rendered every card, and
every card re-parsed its markdown. The render also asked Drive for the board's
role and shared file, so the idle sidebar produced a steady stream of Drive
requests.

The order is now compared by content before it is written, so an unchanged
order is not written at all, and the settings collection is not touched.

The change log was a second source of the same churn. The journal announces
its changes to the other extension contexts over a broadcast channel, and the
announcement carried no table names, so a reader in the other context could
not tell that a change to the change log did not affect it. The table names
now travel with the announcement, and a subscription refreshes only for the
tables it mirrors.

Measured in real Firefox with the real extension, over 60 seconds with the
sidebar open and no user activity: the board re-rendered 14 times and the
project list and the current project were published 7 times each. After the
change the board re-renders 0 times, both publications are 0, and the
extension's process uses 1.7 % of one core.

`tests/recovery/projectOrderWrites.test.ts` and
`tests/recovery/subscriptionEmissions.test.ts` pin both properties.

### The background worker resynced a board faster than its own backoff

The worker writes the board's sync state while it syncs, and that write is a
storage change. The worker's own change listener saw the write and
scheduled the board again, with the idle delay and without the backoff. The
two paths raced for the same alarm name, and the later writer won, so a board
that could not settle was resynced far more often than the backoff allows,
and each attempt ran the whole Drive pipeline.

The worker now holds the board in a retry set for the length of the attempt,
so its own state write is not a reason to schedule it again, and the armed
retry decides when the board runs.

`tests/recovery/backgroundResyncSchedule.test.ts` pins the properties: one
alarm per unsettled sync, a delay that grows between the retries, and a fresh
local change that still gets the idle delay.

### The shared board's layout and the account's identity were fetched again and again

A board that is not shared has no shared layout to cache, so every resolution
of its layout fell back to discovery, which lists every shared `project.json`
in the account. The sidebar resolves the board's role every ten seconds, and
the role and the shared file are resolved in parallel, so a local board
produced a full Drive listing several times a minute. The discovered list is
now kept for a minute and reused.

The account's identity was fetched from Drive on every check of the private
history, and one board's sync makes several checks. The account is now read
once per sync and once more at the end, so a different account signed in
mid-sync is still noticed.

### The account order and the peer history re-read what they had already read

Two paths repeated work that had already been done, and both grew with the size
of the board.

The account order merged the saved order with the local one, and the merge
always produced a `deletedProjectIds` key — even when no side had recorded a
deletion. The stored order then differed from the uploaded file by that empty
key, so every sync uploaded the difference again. The merge now leaves the key
absent when no side recorded a deletion, and the stored order and the uploaded
file stay identical.

The peer history read the board's whole change log again in every round of an
exchange, and verified each record's author signature each time. A record the
peer already holds was answered with an empty request, which meant the record
was delivered, but the answer was forgotten when the exchange ended, so the
record was offered again in the next exchange. The exchange now reads the
history once, keeps the peer's answer for the whole session, and spends its
rounds on the records the peer still needs rather than on a fixed number. A
board with a long history is transferred completely instead of failing with
"History changed continuously during transfer".

`tests/recovery/accountOrderSync.test.ts` and
`tests/recovery/peerHistoryExchange.test.ts` pin both properties.

### A missing shared image was probed on Drive forever

A card that references a shared image the receiver does not hold starts a
retry loop that asks Drive (and, once authorized peers exist, asks them) for
the asset. The retry ran on a fixed two-second poll. When the asset simply
does not exist in Drive — its owner closed its browser before uploading it,
or it was deleted there — the receiver asked every two seconds forever, per
missing asset, on an otherwise idle board: a steady stream of Drive requests
and signature work that nothing could ever answer.

The periodic retry now doubles its wait per consecutive pass that ends with
an asset still missing or a transfer that failed, up to a 60-second ceiling,
and a clean pass resets it to the base poll. An explicit tick — a card edit,
a new blob, a manual sync — always runs the transfer immediately and
recomputes the next wait, so a late upload is picked up as soon as any local
activity happens and the repair itself restores the base cadence.

`tests/recovery/imageSyncBackoff.test.ts` pins the properties: probes grow
sub-linearly against a fixed poll, retries never stop, an explicit tick
probes through the backoff, and a clean pass brings the base cadence back.

### An empty Drive signaling room was polled at the connect cadence

Each open shared board keeps its Drive signaling rooms polling so peers can
discover each other and exchange offers. The poll ran at the full cadence —
two seconds, and once per collection room — even when the room had held no
peer since the board was opened: an idle sidebar kept roughly 90 Drive round
trips a minute going out for a room that could not deliver anything, and any
response processing with it.

The poll now tracks when the room last saw activity: a live peer in the
roster, a delivered signal, or an outbound signal. Past the presence TTL of
silence the next schedule waits a slow interval (15 seconds, kept below a
quarter of the presence TTL so the presence heartbeat stays visible) instead
of the fast cadence; discovering an idle peer then costs at most one slow
poll per side. Writing a signal re-arms the fast cadence immediately, so an
actual connection attempt is never slowed by an idle past, and a live roster
holds the room at the fast cadence for as long as peers are present.

`tests/recovery/signalingIdleBackoff.test.ts` pins the cadence: dense polls
while a room is young, silence after the idle boundary, one poll per slow
interval thereafter, the fast cadence held by a live peer and re-armed by a
send.

### One browser start asked Drive the same questions once per caller

The extension worker and the sidebar page each build a runtime, and each one
reconciles at startup. Neither the identity lookup, the AppData listings nor the
reconcile round was shared, so the same question was asked once per caller and
once per context: a warm start of three boards measured 89 Drive requests,
of which 16 were `about?fields=user(…)` — the account's email, resolved again by
the erasure sweep, the preference round, the changes feed once per board, and
once more when the feed persisted its cursor — and 28 were `files.list` over the
same AppData prefixes. Because both contexts also start within a second or two
of each other, the burst lands inside the short window Google checks per user
and per method, which is what produced the spike in `DriveAbout.Get` and
`DriveFiles.List` while the per-minute budget looked untouched.

Three mechanisms, none of which is a time cache of mutable state, take it back:

- `src/sync/driveIdentity.ts` keys the account identity by access token, so a
  token refresh or an account switch costs exactly one lookup and the concurrent
  callers join the one in flight. A failed lookup is never cached.
- `src/sync/driveSharedRequest.ts` replays only requests that are *already in
  flight*, for idempotent `GET`s only. Presence polling and change detection
  still see a fresh answer on the next tick, which is what the
  `cache: "no-store"` funnels guarantee.
- `reconcileAll` is single-flight per context and stamps a completed round in
  shared storage (`pboardDriveLastReconciledAt`, 30-second window), which is the
  only coordination the two contexts have. Every explicit user action, the
  connect path and the recurring alarm pass `{ force: true }`; a failed round
  stamps nothing and stays immediately retryable.

The same measurement exposed why the local quota ledger looked healthy while
Google was denying requests: it priced a request from its projection
(`1 + fields + pageSize`), so a three-board start "spent" 2,994 units of the
325,000 units/minute per-user budget — 0.9 % — while Google had already charged
3,590 for those 89 requests. Google prices a request by *method* (read 5, list
100, edit 50, download 200, other 5) and page size is not part of the price, so
the old model under-priced a two-row name lookup (6 where Google charges 100)
and over-priced a 1,000-row changes page (1,005 where Google charges 100). The
ledger now accumulates the documented per-method cost and stays comparable with
the Cloud console's Total Query Cost metric; the projection survives as
`driveProjectedCost`, for diagnostics only. Neither number is the whole truth:
Google's per-user metric also counts this account's other devices, browser
profiles and the signaling service's own verification calls, and it enforces
short-window rate checks that no per-minute budget predicts.

`tests/startupRequestProfile.test.ts` boots the worker and the sidebar over one
storage and one Drive stub and prints the per-method profile for cold, warm,
WebRTC-enabled and identity-denied starts. It pins two identity reads per
startup, a warm three-board start inside 70 requests and 4,500 units, that a
first-ever start costs more than a steady-state one, and that denying the
identity lookup costs one failed request rather than a retry storm.

A denial also parks the context that saw it: `driveQuota` keeps a shared
cooldown, so every later caller is answered locally for up to five minutes and
nothing new is learned about whether Google still refuses. The ✕ beside a Drive
error clears that state so it can be observed: `clearDriveSyncError` forgets the
board's stored failure and this page's cooldown, and `DRIVE_CLEAR_PROJECT_ERROR`
makes the worker forget its own — the worker is the context that usually issued
the denied request. Neither call forgives a pending change, so the next sync is
a real request that reports the failure again if the limit is genuinely spent;
that is how a one-off rate window is told apart from exhaustion.

`tests/driveSyncControls.test.tsx`, `tests/background.test.ts`,
`tests/recovery/syncStateWrite.test.ts` and the dismissal case in
`tests/driveQuota.test.ts` pin the four halves of that: the button appears only
with a failure on screen and clears both contexts, the worker refuses an unnamed
board and reports a failed dismissal, the stored board stays dirty and is written
once, and a dismissed cooldown lets the next request reach Drive with the
escalation restarted at one window.

## Sync v2 components (unified storage wired; buffered realtime opt-in per board)

Authority recovery in WebSocket mode looks up the existing canonical
`pboard/<boardId>/board.json.gz` folder before consulting legacy `project.json`
sharing records. A private board needs no collaborator ACL to qualify: a fresh
Drive identity and folder-permissions read must prove that the connected account
is its owner. Discovery never creates or merges folders, bypasses local folder
caches, and refuses duplicate board folders or snapshots. Missing data and API
failures leave recovery blocked. This avoids treating a board in the unified
layout as “not shared” before checking its owner's permissions.

Coverage: `tests/recovery/authorityRekeyRuntime.test.ts` exercises owner recovery,
writer refusal, missing data and discovery failures;
`tests/sync/driveBoardStore.test.ts` checks read-only discovery and ambiguity.

The v2 redesign (local-first RxDB + user-visible Drive snapshots + server
buffer + single-writer leader) was approved with these decisions: buffer
encrypted by default, private-board history archives relocate to the visible
folder, split-brain is detect-and-repair (accepted Drive limitation),
Drive-hosted `realtime/` signaling stays as the fallback transport for the
legacy Drive-provider mode only. Canonical storage (audit of 2026-10) is one
unified path for every board — `My Drive/pboard/<boardId>/board.json.gz`
plus `attachments/` — and Google Drive AppData has no role in websocket
(Sync v2) persistence; the AppData-backed provider serves only the legacy
Drive-provider mode. An automatic legacy pass (decision 2026-10-24: connect
is consent, no prompt) relocates AppData copies and legacy `Pboard/` shared
folders into the unified layout on the first Sync v2 reconcile — uploads are
read-back verified before the flip, sources are deleted only after the
90-day read-only window, and relocated shared boards carry their
collaborator ACL before any write (a failed ACL listing skips the board
rather than downgrade access; the old folder is never touched). Building
blocks landed first, each standalone-tested before integration:

- [`src/sync/snapshotV2.ts`](../src/sync/snapshotV2.ts): `pboard-board-v2`
  gzip snapshot (`CompressionStream`) with `snapshotSeq`, leader `epoch`,
  per-collection checkpoint digests and per-device op `watermarks`; strict
  size caps and v1↔v2 upgrade/rollback helpers.
- [`src/sync/bufferCrypto.ts`](../src/sync/bufferCrypto.ts) +
  [`src/storage/contentKeyStore.ts`](../src/storage/contentKeyStore.ts):
  AES-256-GCM op envelope (opId authenticated as AAD) under a per-board
  content key held in a dedicated IndexedDB database; only editors provision
  keys, and the signaling server only ever stores ciphertext.
- [`src/sync/bufferProtocol.ts`](../src/sync/bufferProtocol.ts): client pump —
  same-tick batch coalescing, in-order halt-and-backoff, drop only after the
  server durably acknowledges, zero timers while idle, `pagehide` stop that
  keeps pending ops for the next session. `seal` is injectable (tests run
  synchronously; production uses AES-GCM).
- [`src/sync/snapshotMerge.ts`](../src/sync/snapshotMerge.ts): the repair
  rule for the accepted split-brain limit — merge two snapshot views by
  (snapshotSeq, epoch) base plus per-document causal retention and per-device
  watermark max; order-independent and idempotent, so every leader repairs
  identically without coordinating.
- [`src/sync/drivePublish.ts`](../src/sync/drivePublish.ts): leader publish
  path — metadata probe, conditional media upload with `If-Match` (412 →
  re-merge), 403 mapped to immediate leadership surrender.
- [`src/sync/bufferClient.ts`](../src/sync/bufferClient.ts): typed client for
  those endpoints; `authorize(board)` is injected so the collab runtime adapter
  supplies grant-bound signatures from the same device key as WebRTC admission.
  429 maps to pump backpressure; `lease_busy` reads as "not now".
- [`src/sync/leaderLoop.ts`](../src/sync/leaderLoop.ts): one publish cycle
  (claim → probe → download → decrypt+merge → serialize → conditional upload →
  buffer commit → leader commit); conflict commits nothing, forbidden ends
  leadership immediately. Scheduling and lease heartbeat belong to the caller.
- [`services/pboard-signaling/src/op_buffer.rs`](../services/pboard-signaling/src/op_buffer.rs):
  durable buffer — append-only fsync'd journal, torn-tail truncation on
  replay, idempotent insert by op id, ordered replay, per-board/global bounds
  with backpressure, commit marks with retention and atomic compaction. No new
  crate dependencies; ciphertext fields are opaque.
- [`services/pboard-signaling/src/buffer_api.rs`](../services/pboard-signaling/src/buffer_api.rs)
  + `App::with_op_buffer`: HTTP endpoints `/buffer/challenge|ops|list|commit`
  and `/leader/claim|observe|commit`, each authorized by the existing
  board-grant admission proof (fresh single-use challenge + device signature
  over the authority-signed manifest; viewers rejected for writes). Gated on
  `PBOARD_SIGNALING_BUFFER_DIR` — inert when unconfigured. Only
  independent-grant manifests (no Drive bindings) authenticate here;
  Google-shared boards keep using Drive ACLs.
- [`services/pboard-signaling/src/leader.rs`](../services/pboard-signaling/src/leader.rs):
  leases (45 s, renewal keeps epoch, takeover bumps it), `observe`/`commit`
  reporting with monotonic `snapshotSeq` and a `stale` flag that marks
  out-of-order overwrites for the repair merge.

Integration (complete, opt-in):

- [`src/sync/bufferAuth.ts`](../src/sync/bufferAuth.ts): the per-call
  `Authorizer` adapter — fetches a single-use challenge and signs it with the
  same device key and manifest as WebRTC admission, so buffer writes require a
  current authority-signed editor grant.
- [`src/collab/peerHistory.ts`](../src/collab/peerHistory.ts): content keys
  ride the mutually authenticated peer history channel (`key-want`/`key-put`):
  served only to owner/editor peers, stored only after id/material validation,
  and a viewer never receives or stores one. The manager exposes
  `requestContentKey()`/`ensureContentKey()` for first-writer provisioning.
- [`src/sync/bufferRuntime.ts`](../src/sync/bufferRuntime.ts): composes the
  pump, the change journal and the leader publish cycle — nothing touches the
  network until a local committed mutation fires; repeat notifications reuse
  one armed cycle; stop is instant. Ops from foreign content keys stay
  buffered (never dropped) until key converges.
- [`src/sync/driveBoardStore.ts`](../src/sync/driveBoardStore.ts): the
  canonical store — find-or-create `pboard` root and per-board folder
  (single-flight; a rival copy created mid-operation is caught by the
  post-create re-list; cached ids expire after 60 s so an instance whose
  copy was merged away elsewhere adopts the survivor rather than writing
  into the trashed duplicate; duplicate trees merge by content — oldest
  folder survives, children move in, same-name files keep the newer copy,
  the loser in Drive trash), `board.json.gz` lifecycle
  with cached `If-Match` revisions plus cached-id eviction when a snapshot
  vanished underneath, folder-listing board discovery and `attachments/`
  CRUD; private boards are simply folders without extra ACLs, so sharing
  never relocates data. Media downloads use the v3 host — the upload host
  rejects GETs with 405.
- [`src/sync/boardSyncV2.ts`](../src/sync/boardSyncV2.ts): board persistence
  over that store for websocket mode on the exact triggers the legacy path
  used (background loop, blur/pagehide flush, connect, delete) — no parallel
  pipeline, no new loops. `runtime.ts` routes `googleDrive.syncProject/
  reconcileAll/deleteProject/pullProject/pushProject` by the persisted
  collaboration setting; `runtime.bufferRealtime.start(boardId)` starts a
  buffer runtime for connected writers (unified folder + board grant).
  Tests: `tests/sync/driveBoardStore.test.ts`, `boardSyncV2.test.ts` and
  `unifiedMode.test.ts` (persistence issues zero AppData requests in v2
  mode, the legacy probe is a single read-only listing per session, and the
  first reconcile auto-migrates a seeded AppData board including
  fresh-profile import).
- [`src/sync/bufferSnapshotStore.ts`](../src/sync/bufferSnapshotStore.ts):
  snapshot file lifecycle inside a folder (find-or-create, cached `If-Match`
  revision); in the unified layout it publishes the same canonical
  `board.json.gz` as board sync.
- [`services/pboard-signaling/buffer-probe.mjs`](../services/pboard-signaling/buffer-probe.mjs)
  (`npm run test:buffer`) spawns the real server binary against a scratch
  buffer directory and verifies the wire contract end to end: inert without
  configuration, single-use challenges, forged-signature and viewer rejection,
  dedupe, ordered list, lease enforcement, commit, op size/charset limits, and
  durability of uncommitted ops across restart. Buffer/leader routes carry a
  5 MiB body envelope (the 16 KiB API default could not fit op batches).
- Startup/maintenance modules (pure, unit-tested):
  [`src/sync/startupReconcile.ts`](../src/sync/startupReconcile.ts) (pull/buffer
  ladder from snapshot etag + watermarks; not yet called from UI),
  [`src/sync/privateMigration.ts`](../src/sync/privateMigration.ts) (audited
  resumable migration ladder for one legacy `appDataFolder` board:
  folder → export → upload → history → **read-back verify** → flip → seal;
  verification failure re-uploads once, then aborts unverified; source
  read-only, 90-day recovery window),
  [`src/sync/legacyMigration.ts`](../src/sync/legacyMigration.ts) (the
  automatic pass driving that engine per AppData board plus the shared
  `Pboard/` ACL-copy relocation and window-gated source cleanup; wired into
  `runtime.ts` once per session on v2 `reconcileAll`),
  [`src/sync/attachmentGc.ts`](../src/sync/attachmentGc.ts) (attachments
  collectable only after absence from two snapshot revisions).

Verification: `tests/snapshotV2.test.ts`, `tests/bufferPump.test.ts`,
`tests/snapshotMerge.test.ts`, `tests/leaderLoop.test.ts`,
`tests/sync/bufferRuntime.test.ts`, `tests/sync/startupReconcile.test.ts`,
`tests/sync/privateMigration.test.ts`, `tests/sync/legacyMigration.test.ts`,
`tests/sync/attachmentGc.test.ts`, `tests/sync/driveBoardStore.test.ts`,
`tests/sync/boardSyncV2.test.ts`, `tests/sync/unifiedMode.test.ts`,
`tests/collab/contentKeyExchange.test.ts` (live linked-peer key exchange),
plus `npm run test:buffer` (21 live-server checks) and `cargo test --lib`
(21 tests including the buffer/leader/API set) with `cargo clippy` clean.

## Drive operation refactor checkpoint — 28 October 2026

The [architecture assessment, operation protocol, recovery design, implementation
status and validation record](architecture/drive-operation-sync.md) describe the
new transport-independent protocol foundation. It is not yet the active board
runtime. Existing authority/grant and snapshot paths described above still apply.
The existing WebRTC toggle is now available in all builds, retains its local
preference and closes the existing realtime manager without disabling Drive sync.
