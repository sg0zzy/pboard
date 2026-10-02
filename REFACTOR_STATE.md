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
  `readSnapshot` that exports the RxDB project and serializes it), the module-level
  `collaborationManager` singleton (`myRole`, `getSharedFileId`, `bootstrapFromDrive`,
  `signalingFor`, `getRepository`), `sessionPeerId`, `parseCollabTopic`, and
  `loadSharedProjects` (imports only missing shared projects).
- `src/sync/googleAuth.ts` — `DRIVE_SCOPE` (appdata + drive.file).
- `tests/collaborationManager.test.ts` — manager start/stop/role/gate tests.
- `tests/browserCollaboration.test.ts` — browser-layer wiring tests (`loadSharedProjects`
  import/skip behavior + `collaborationManager` API).
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
- Browser-layer wiring (`src/sync/browser.ts`) + wiring test
  (`tests/browserCollaboration.test.ts`). ✅

---

# Current state

- The **browser-layer wiring is complete** (`src/sync/browser.ts` now exports a
  module-level `collaborationManager` singleton — `myRole`, `getSharedFileId`,
  `bootstrapFromDrive`, `signalingFor`, `getRepository` — plus `sessionPeerId`,
  `parseCollabTopic`, and `loadSharedProjects`). It is unit-tested in
  `tests/browserCollaboration.test.ts` and **not yet reachable from the running
  extension**: nothing in `src/sidebar/App.tsx` calls `start()`/`stop()` yet.
- **Typecheck: PASS** (`tsc --noEmit` exit 0). **Tests: PASS** (184/184, 36 files,
  `vitest run`). Build: not re-run this turn; the type-checked source is green.
- Git: branch `agent/bonsai`. Working tree clean after the Milestone 1 commit.
- The `PboardSignaling` / manager / permission pieces are complete and tested; the
  `collaborationManager` singleton and `drivePermissions` service are now
  instantiated in `src/sync/browser.ts` (reachable for the App). The App-level
  wiring (Milestone 2) is the next step.

---

# Known issues

- No failing tests.
- **Not implemented yet**: Share button + "Share Project" dialog UI; the
  `drivePermissions` service test; the Drive signaling test; a Share UI test.
- `experiments/collab/*.mjs` are throwaway spikes (not imported by the extension,
  not covered by the suite).
- Verify-on-next-session: that `discoverSharedProjects` + `myRole` behave
  correctly against real Drive (only unit-mocked here).

---

# Remaining work (dependency order)

**Required (the actual feature):**

1. ✅ **Wire the manager + Drive signaling + bootstrap into the browser layer**
   (`src/sync/browser.ts`): done — `collaborationManager` singleton (`myRole`,
   `getSharedFileId`, `bootstrapFromDrive`, `signalingFor`, `getRepository`) +
   `sessionPeerId`, `parseCollabTopic`, and `loadSharedProjects` exported, plus
   `tests/browserCollaboration.test.ts` unit tests.
2. **Wire the manager into the App** (`src/sidebar/App.tsx`): `start(projectId)`
   when a shared project is selected, `stop()` on change/unselect; load discovered
   shared projects on startup so they appear in the picker; bootstrap (import) a
   selected project that has no local copy.
3. **Share button + Share Project dialog** (`src/sidebar/App.tsx` + a new
   component, modeled on `DriveSyncControls.tsx`): button immediately LEFT of the
   cloud icon; dialog with two sections — Invite (email + Viewer/Editor role +
   Invite) and Collaborators (list with role selector + remove; owner cannot
   remove themselves). Uses the `drivePermissions` service.
4. **Tests**: `drivePermissions` service (mock transport), Drive signaling
   (mock store + injected `now`), Share UI.
5. **Verify**: full suite + typecheck + `npm run build:all` +
   `npm run verify:build all`; update `docs/collaboration.md` if anything shifts.

**Optional cleanup:**
- Decide whether `experiments/collab/*.mjs` spikes should be kept or removed once
  the feature is verified.

---

# Recommended next step

**First task: wire the collaboration manager into the App (`src/sidebar/App.tsx`).**

Milestone 1 is complete — `src/sync/browser.ts` exports the `collaborationManager`
singleton (`myRole`, `getSharedFileId`, `bootstrapFromDrive`, `signalingFor`,
`getRepository`), plus `sessionPeerId`, `parseCollabTopic`, and `loadSharedProjects`
(all unit-tested in `tests/browserCollaboration.test.ts`). The manager is instantiated
in the browser layer but not yet reachable from the App.

Inspect before editing:
- `src/sidebar/App.tsx` — the toolbar (`app-title-row`, `DriveSyncControls` at
  line ~728) for the Share button (insert immediately **left** of it), and the
  project-select lifecycle (lines ~769–778) for `start()`/`stop()`.
- `src/sidebar/components/DriveSyncControls.tsx` — model the "Share Project"
  dialog on it.

Wire `loadSharedProjects()` on mount, `collaborationManager.start(projectId)` on
shared-project select, and `stop()` on change/unselect/unmount. Then build the
Share button + dialog (Invite: email + role + Invite; Collaborators: list + role
selector + remove; owner cannot remove themselves). Keep the manager a module-level
singleton; `start()` must run `stop()` first. Do NOT expand scope (no public links,
no backend server).
