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
  `drive.appdata` + `drive.file` (the private app-data path is unchanged;
  `drive.file` is required to create visible shared files + manage their ACL).
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

---

# Current state

- The app-layer wiring is **done**: `collaborationManager` is a module-level
  singleton in `src/sync/browser.ts` (myRole → `drivePermissions.myRole`,
  getSharedFileId → `drivePermissions.projectFileId`, `bootstrapFromDrive`
  downloads the shared snapshot and imports it, `signalingFor` builds a Drive
  signal store + `createDriveSignaling` per topic with one stable peer id per
  session). `App.tsx` starts/stops it on the current project. The manager now
  serializes start/stop so a rapid switch or unmount can't race the pool list.
- **Typecheck: PASS** (`tsc --noEmit` exit 0). **Tests: PASS** (208/208, 38 files,
  `vitest run`). **Build: PASS** (`npm run build:all` + `verify-build.mjs all`).
- The **full collaboration feature is implemented and wired**: the manager is
  live (App drives it on project selection), the permission service + Drive
  signaling are connected, and the Share button + "Share Project" dialog
  (`src/sidebar/components/ShareControls.tsx`) is in the toolbar, left of the
  Drive cloud icon.

---

# Known issues

- No failing tests.
- The Share UI, permission service, and Drive signaling are all unit-tested
  with mocked seams (transport/store); real-Drive behavior is not covered.
- `experiments/collab/*.mjs` are throwaway spikes (not imported by the extension,
  not covered by the suite).
- Verify-on-next-session: that `discoverSharedProjects` + `myRole` + Drive
  signaling behave correctly against real Drive (only unit-mocked here), and the
  manager end-to-end across two browser instances over WebRTC.

---

# Remaining work (dependency order)

The required feature (sharing + permissions + WebRTC realtime replication +
Share UI + tests) is implemented. Remaining work is verification and optional
cleanup:

1. **Real-Drive verification**: exercise `discoverSharedProjects`, `myRole`,
   invite/update/remove, Drive signaling, and the manager end-to-end across two
   browser instances over WebRTC (unit-mocked only so far).
2. **Verify**: full suite + typecheck + `npm run build:all` +
   `npm run verify:build all`; update `docs/collaboration.md` if anything shifts.

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
