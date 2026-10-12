# Pboard collaboration architecture

Reviewed against the implementation on 12 October 2026. Google Drive provides persistent snapshots, sharing permissions, and signaling. RxDB stores local documents and replicates live changes over WebRTC. Pboard does not operate a central synchronization server. See [local storage](rxdb-storage-refactor.md) for migration and rollback, and [refactor status](../REFACTOR_STATE.md) for remaining validation.

## Runtime wiring

`src/sync/browser.ts` constructs the permission service, shared snapshot sync, shared-board discovery, and collaboration manager. `src/sidebar/App.tsx` starts the manager for the current project and stops it on project changes or unmount. Start, stop, and role refresh operations are serialized.

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

Drive enforces API access to snapshots, image files, and signaling folders. The manager resolves the **local account's** role and applies local mutation restrictions. Those checks do not authenticate each remote WebRTC participant: `isPeerValid` currently returns `true`, and no signed peer identity or per-operation ACL validation is implemented.

Project scoping, normal-client viewer gates, and folder access provide the current boundaries. They do not establish strong authorization against a modified client. A viewer has writable signaling access, and an already-connected peer may retain content or a live channel after Drive access changes. Periodic local role refresh is not immediate remote-peer revocation. Any stronger peer-authentication or receiver-side write authorization requires separate implementation and tests.

## Verification

Relevant test files include `tests/drivePermissions.test.ts`, `tests/driveSignaling.test.ts`, `tests/collaborationManager.test.ts`, `tests/sharedDiscovery.test.ts`, `tests/sharedSync.test.ts`, `tests/imageSync.test.ts`, `tests/accountSignaling.test.ts`, and `tests/conflictResolution.test.ts`. Tests mock Google transports; they are not evidence of authenticated real-Drive behavior.

`npm run test:webrtc:browser` runs two isolated headless Chromium profiles with real IndexedDB and WebRTC against simulated Drive records. It covers bidirectional project template/card mutations, account order, project deletion without resurrection, newer fork conflict resolution, and replayed JSEP answers. It needs Chromium on PATH or `PBOARD_CHROMIUM_BIN`; it makes no authenticated Google requests.

Use [BUILD.md](../BUILD.md) for the ordinary validation commands. Real Google account invitation/role/removal flows, Drive latency/quotas, restrictive networks, and Firefox/Chromium extension lifecycle behavior still need dedicated integration or manual verification. No undated test count in this guide represents the current suite result.
