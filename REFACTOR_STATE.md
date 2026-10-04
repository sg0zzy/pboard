# Pboard collaboration refactor — handoff

Local-first project sharing + viewer/editor permissions + WebRTC realtime RxDB
replication. No pboard backend server. Google Drive = persistent store AND
permission authority; RxDB WebRTC = low-latency live path. Private projects stay
unchanged — everything is behind existing repository/sync seams.

---

# Refactoring goal

Add collaboration to the existing pboard extension:
- **Project sharing**: owner shares a project; collaborators are explicitly
  invited by Google account (no public links).
- **Viewer vs Editor roles**, mapped 1:1 onto Google Drive permissions
  (viewer → `reader`, editor → `writer`, owner = file owner). Drive is the
  single permission authority.
- **Realtime sync** between connected peers via RxDB's WebRTC replication
  (two collections: `cards` + `projects`), with a `PboardSignaling` seam so the
  transport is swappable (Drive-hosted for the shipped extension; memory /
  WebSocket for tests and dev).
- **Viewer read-only enforcement** at the storage layer (not just the UI) so no
  local write exists to replicate.
- Share button + "Share Project" dialog in the sidebar toolbar.

Intended end state: a shared project can be opened by an invited viewer or
editor; edits flow live over WebRTC while online and bootstrap from the Drive
snapshot when a peer has no local copy; viewers cannot mutate.

---

# Current architecture / decisions

- **Drive layout per shared project** (in the owner's My Drive, under a root
  `Pboard/` folder):
  - `<folder>` — one folder per project.
  - `project.json` — the shared snapshot (serialize/deserialize via
    `src/sync/snapshot.ts`); the bootstrap source for peers with no local copy.
  - `realtime/` — ephemeral per-peer signaling records
    (`sig-<topic>-<peerId>.json`). Each peer owns exactly one file; no cross-peer
    races.
- **`src/sync/drivePermissions.ts`** — the whole permission + shared-layout
  surface. `DrivePermissionTransport` (thin Drive v3 API wrapper),
  `DrivePermissionService` (ensureSharedProject, read/writeSharedSnapshot,
  projectFileId, realtimeFolderId, discoverSharedProjects, myRole,
  listCollaborators, invite, updateRole, removeCollaborator), and
  `createDriveSignalStore` (a `PboardDriveSignalStore` backed by `realtime/`).
  Layout is cached in `browser.storage.local` under
  `pboardDriveSharedProjects` (`DriveSharedProjectRecord` = `{ folderId,
  projectFileId, realtimeFolderId }`).
- **`src/collab/signaling.ts`** — the `PboardSignaling` seam with three backends:
  - `createMemorySignalingScope()` — in-process; tests + same-tab.
  - `createWebSocketSignaling(topic, url)` — RxDB signaling-server wire protocol.
  - `createDriveSignaling(options)` — Drive-backed; polls its own `realtime/`
    record, reads every peer's, relays undelivered signals. At-least-once
    delivery; outbox bounded by `signalTtlMs` (default 240000). `PboardDriveSignalStore`
    = `{ peerId, now(), readPeer, writeOwn, listPeers }`.
- **`src/collab/webrtcHandler.ts`** — `createPboardWebRTCConnectionHandler`, a
  simple-peer handler scoped to one shared project (buffers signals before a data
  channel exists; dedupes by handshake).
- **`src/collab/manager.ts`** — `createCollaborationManager`. One manager drives a
  single shared project: runs the two RxWebRTC pools, resolves the role,
  bootstraps if needed, and sets the viewer write-gate. `CollaborationManagerOptions`
  = `{ myRole, getSharedFileId, bootstrapFromDrive, signalingFor, getRepository,
  wrtc? }`; returns `{ start(projectId), stop(), refreshRole(), state() }`.
  `CollaborationRole` = `"private" | "viewer" | "editor" | "owner"`.
- **Viewer write-gate** — `src/storage/rxdbRepository.ts` gained a `mutatorRole?`
  option + `setMutatorRole(projectId, role|null)` + `assertCanMutate(projectId)`
  (throws when the active project is `viewer`). It is called at the top of every
  content mutation (rename/delete/changeTemplate project, add/update/reorder/etc.
  card). Rationale: WebRTC picks master/slave by token hash, not role, and the
  master streams its change log unconditionally — so a viewer that happens to be
  master would otherwise leak local writes. The gate is the authoritative
  enforcement; the replication push modifier alone does not cover that path.
- **OAuth** — `src/sync/googleAuth.ts` now requests `DRIVE_SCOPE` =
  `drive.appdata` + the full `drive` scope (the private app-data path is
  unchanged; the full `drive` scope is required because a recipient's
  collaboration targets files this account does not own, which `drive.file`
  cannot reliably find or manage, including incoming permission invitations).
- **Rejected / not done**: public "anyone with link" sharing; a permanent pboard
  signaling/backend server (Drive signaling is the shipped path; a low-latency
  WebSocket fallback is documented, not implemented, for the first usable
  version).

## Invariants to preserve
- Private projects must be byte-for-byte unchanged (no new Drive writes, no new
  UI, no role set → `assertCanMutate` is a no-op).
- `assertCanMutate` must stay at the head of every per-project content mutation.
- Each signaling peer writes only its own `realtime/` file.
- The manager is per-project and `start()` always `stop()`s the previous project
  first (role change takes effect on next start).

---

# Completed work

Core collaboration layer is **built and unit-tested in isolation**:
- `src/collab/manager.ts` — manager + role gating + pool lifecycle.
- `src/collab/signaling.ts` — `PboardSignaling` seam: memory + WebSocket +
  Drive-backed signaling.
- `src/collab/webrtcHandler.ts` — scoped simple-peer connection handler.
- `src/sync/drivePermissions.ts` — permission service, shared-layout store,
  Drive-backed `PboardDriveSignalStore`.
- `src/storage/rxdbRepository.ts` — viewer write-gate (`mutatorRole`,
  `setMutatorRole`, `assertCanMutate` on all content mutations).
- `src/sync/browser.ts` — exports `sharedProjects` (local `DriveSharedProjectStore`),
  `drivePermissions` (`createDrivePermissionService` wired to the transport + a
  `readSnapshot` that exports the RxDB project and serializes it), and
  **`collaborationManager`** (the live singleton, wired below).
- `src/collab/manager.ts` — `start`/`stop` are serialized through a `runExclusive`
  mutex so a rapid project switch or unmount never races the shared pool list.
- `src/sidebar/App.tsx` — a `useEffect` on `currentProject?.id` calls
  `collaborationManager.start(id)` / `stop()` (start on select, stop on unselect
  and unmount).
- `src/sidebar/components/ShareControls.tsx` — Share button + "Share Project"
  dialog (Invite email + Viewer/Editor role, Collaborators list with role
  selector + remove; owner not removable/downgradable; viewer read-only). Takes
  an injectable `DrivePermissionService` so it is independently testable.
- `tests/drivePermissions.test.ts` — permission service (mock transport +
  shared-layout store): layout ensure/reuse, snapshot read/write, role
  resolution, collaborator list/sort, invite/update/remove, discovery,
  empty-cache discovery path.
- `tests/driveSignaling.test.ts` — Drive signaling (shared in-memory store +
  injected clock): roster presence, at-least-once delivery + dedupe, outbox
  TTL, presence TTL, leave.
- `tests/shareControls.test.tsx` — Share UI (jsdom + createRoot): render,
  invite with role, role change, remove, viewer read-only, error, Escape close,
  no-project.
- `tests/collaborationManager.test.ts` — manager start/stop/role/gate tests.
- `tests/sync.test.ts` — scope assertion updated to the new two-scope set.
- `docs/collaboration.md` — architecture doc (sharing, permissions, signaling,
  offline/reconnect, security, testing).
- `src/sync/sharedDiscovery.ts` — `createSharedBoardDiscovery`: imports newly
  invited boards (`rx.importProject` + `setMutatorRole`) without touching local
  edits or selection; single-flight, per-entry failure isolation, skips
  disconnected/no-repo/tombstoned/already-local boards and rejects snapshots
  whose project id does not match. Wired in `src/sync/browser.ts`
  (`discoverSharedBoards`, tombstone-aware via the drive tombstone store) and run
  from `App.tsx` (on load, every 30 s, on window focus, on Drive connect and
  shared-state change) and from `googleDrive.beforeReconcile`.
- `src/collab/imageSync.ts` — shared image sync: owners/editors publish local
  card images into the shared Drive folder, viewers fetch missing ones; a 2 s
  poll + card/image subscription trigger fetches; integrity verification
  (size + hash) rejects bad assets. Also repairs pre-existing missing blobs
  whose hash matches a current card.
- Account-scoped project list order — `reorderProjects`/
  `setProjectOrderAccount` in `src/storage/rxdbRepository.ts` persist the order
  under an account-keyed setting; the manager runs an independent
  `pboard-account-<hash>-order` WebRTC settings pool (push-only own id via a
  scoped push modifier) with `account-signal-<hash>-<peer>.pboard` rendezvous
  records in `appDataFolder`.
- `src/sync/googleDriveProvider.ts` — shared projects are excluded from private
  snapshot push/pull; deleting a shared board locally keeps a permanent
  tombstone (the owner's Drive folder is not removed) so discovery cannot
  re-import it; reconciliation skips shared tombstones.
- `src/sidebar/components/ShareControls.tsx` also surfaces the live-
  collaboration status and the "Enable live collaboration" toggle for
  same-account, cross-browser runs.
- `tests/sharedDiscovery.test.ts` — discovery/import (skip rules, invalid
  snapshot isolation, role application, reactive list + selection preserved).
- `tests/imageSync.test.ts` — image publish/fetch/repair + integrity rejection.
- `tests/accountSignaling.test.ts` — account-order signaling store + pool.
- `src/types/simple-peer-browser.d.ts` — type shim for the `simple-peer` min
  bundle used by `src/collab/webrtcHandler.ts`.
- `experiments/collab/*.mjs` — WebRTC / simple-peer / node-datachannel spikes.
- `package.json` — `node-datachannel` devDependency (used by the spikes).
- `LICENSE.md` + README — GPLv3 notice.

Note: `experiments/collaboration/` is a **pre-existing, separate** experiment
(own `package.json` + ignored `node_modules`) and is untouched by this work.

## Phases complete
- Permission service + Drive shared layout + signaling store. ✅
- WebRTC manager + scoped handler + write-gate. ✅
- Drive-backed + memory + WebSocket signaling. ✅
- Isolated unit tests for the manager. ✅
- Architecture documentation. ✅
- **App-layer wiring** (manager singleton + Drive signaling + bootstrap in
  `browser.ts`, start/stop effect in `App.tsx`, manager mutex). ✅
- **Share UI** (Share button + "Share Project" dialog in
  `src/sidebar/components/ShareControls.tsx`, wired into the toolbar). ✅
- **Full test coverage** (permission service, Drive signaling, Share UI,
  manager, write-gate). ✅
- **Shared board discovery/import** (connect, sidebar load, 30 s interval,
  focus, background reconcile) + deletion-resurrection fix. ✅
- **Shared image sync** over Drive with integrity verification. ✅
- **Account-scoped project order** over a dedicated WebRTC pool. ✅

---

# Current state

- The app-layer wiring is **done**: `collaborationManager` is a module-level
  singleton in `src/sync/browser.ts` (myRole → `drivePermissions.myRole`,
  getSharedFileId → `drivePermissions.projectFileId`, `bootstrapFromDrive`
  downloads the shared snapshot and imports it, `signalingFor` builds a Drive
  signal store + `createDriveSignaling` per topic with one stable peer id per
  session, `imageTransport` for shared image sync, `getAccountId` for the
  account-order pool). `App.tsx` starts/stops it on the current project. The
  manager now serializes start/stop so a rapid switch or unmount can't race the
  pool list.
- **Shared board discovery/import is wired**: `discoverSharedBoards` runs on
  sidebar load, every 30 s, on window focus, on Drive connect / shared-state
  change, and from `googleDrive.beforeReconcile`; imported boards appear in the
  local project list with their role applied. Deleting a shared board keeps a
  permanent local tombstone so discovery never re-imports it.
- **Typecheck: PASS** (`tsc --noEmit` exit 0). **Tests: PASS** (242/242, 41
  files, `vitest run`). **Build: PASS** (`npm run build:all` + `npm run
  verify:build`).
- The **full collaboration feature is implemented and wired**: the manager is
  live (App drives it on project selection), the permission service + Drive
  signaling are connected, shared images sync over Drive, project order syncs
  per account, and the Share button + "Share Project" dialog
  (`src/sidebar/components/ShareControls.tsx`) is in the toolbar, left of the
  Drive cloud icon.

---

# Known issues

- No failing tests.
- The Share UI, permission service, and Drive signaling are all unit-tested
  with mocked seams (transport/store); real-Drive behavior is not covered.
- `experiments/collab/*.mjs` are throwaway spikes (not imported by the extension,
  not covered by the suite).
- Verified in code + unit tests: `discoverSharedProjects` skip rules and import,
  `myRole` resolution, and the manager lifecycle. Still to exercise manually:
  real-Drive behavior (latency, ACL edge cases) and a two-browser WebRTC run.

---

# Remaining work (dependency order)

The required feature (sharing + permissions + WebRTC realtime replication +
Share UI + discovery/import + image sync + account order + tests) is
implemented and verified (typecheck + 242 tests + both builds + build
verification). Remaining work:

1. **Real-Drive verification** (manual): exercise `discoverSharedProjects`,
   `myRole`, invite/update/remove, Drive signaling, and the manager
   end-to-end across two browser instances over WebRTC (unit-mocked only so
   far).
2. **Docs drift**: `docs/collaboration.md` is current as of the scope fix;
   update it if the architecture shifts again.

**Optional cleanup:**
- Decide whether `experiments/collab/*.mjs` spikes should be kept or removed once
  the feature is verified.

---

# Recommended next step

**The feature is complete.** Suggested next steps:

1. Verify against real Google Drive (the unit suite mocks all Drive seams):
   `discoverSharedProjects`, `myRole`, the invite/update/remove round trip,
   Drive signaling latency, and a two-instance WebRTC replication run.
2. Commit the work once verified (currently on `main`; a checkpoint commit was
   made for the wiring state).

Do NOT expand scope (no public links, no backend server).
