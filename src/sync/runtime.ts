import { createDriveChanges } from './operations/changes';
import { DriveQuotaExceededError } from './driveQuota';
import { dirtyFlushAt } from './syncPolicy';
import { validId } from './operations/protocol';
import { createOperationRealtime } from './operations/realtime';
import { createOperationService } from './operations/service';
import { createGoogleIdentitySharing } from "../collab/googleIdentitySharing";
import { createCollaborativeCopy } from "../collab/collaborativeCopy";
import { identifyLegacyBoard, legacyTransitionFor, transitionLegacyBoard } from "../collab/legacyTransition";
import { COLLABORATION_SETTINGS, createBoardGrantService, type CollaborationSettings } from "../collab/boardGrants";
import { BoardExistingSignedDataError } from "../collab/authorityErrors";
import { createDeviceEnrollment, storageManifestEpochs } from "../collab/security/enrollment";
import { loadIceServers } from "../collab/security/ice";
import { classifyBoardAuthority } from "../collab/authorityDiagnostics";
import { collaborationDiagnostic } from "../collab/diagnostics";
import { collaborationCounters } from "../collab/counters";
import { createGoogleBrokerEnrollment, googleBrokerEnabled } from "../collab/googleBrokerEnrollment";
import { experimentalSignalingEnabled, selectRuntimeSignaling } from "../collab/signalingSelection";
import { createDriveBoardStore, BOARD_SNAPSHOT_FILENAME } from "./driveBoardStore";
import { defaultDriveIdentityCache, type DriveIdentityCache } from "./driveIdentity";
import { createBoardSyncV2 } from "./boardSyncV2";
import { createDriveTransport } from "./driveTransport";
import { createPrivateDriveHistory } from "./privateDriveHistory";
import { createGoogleDriveProvider, type DriveReconcileResult, type GoogleDriveProvider } from "./googleDriveProvider";
import { createBackendProjectSnapshotStore, deserializeProjectSnapshot, serializeProjectSnapshot } from "./snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore } from "./state";
import { cleanupLegacySource, migrateLegacyBoards, type LegacyMigrationDeps, type LegacyMigrationResult } from "./legacyMigration";
import { cleanupDue, type MigrationState } from "./privateMigration";
import {
  createDrivePermissionTransport,
  createDrivePermissionService,
  PENDING_BOARD_LEAVES_KEY,
  createDriveSignalStore,
  type DriveSharedProjectRecord,
  type DriveSharedProjectStore
} from "./drivePermissions";
import { createCollaborationManager, type CollaborationManager } from "../collab/manager";
import { createBufferRuntime, type BufferRuntime } from "./bufferRuntime";
import { createBufferClient } from "./bufferClient";
import { createGrantAuthorizer } from "./bufferAuth";
import { createBufferSnapshotStore } from "./bufferSnapshotStore";
import type { DriveFetch } from "./drivePublish";
import type { BoardImage } from "../types";
import { createContentKeyStore } from "../storage/contentKeyStore";
import { createDriveSignaling, type PboardSignaling } from "../collab/signaling";
import type { KeyValueStorage } from "../storage/repository";
import { withStorageLock } from "../storage/lock";
import type { RxRepository } from "../storage/rxdbRepository";
import { hashBlob, imageToBlob } from "../storage/blobStore";
import { createAccountSignalStore } from "./accountSignaling";
import { createSharedBoardDiscovery } from "./sharedDiscovery";
import { createSharedProjectSync, createSharedProjectRefresh } from "./sharedSync";
import { createAccountPreferenceSync } from "./accountPreferences";
import type { GoogleAuthProvider } from "./googleAuth";
import { ensureDeviceKey, publicKeyFingerprint } from "../collab/security/keys";
import { verifyManifest, acceptManifest, manifestIsCurrent, createInMemoryManifestEpochStore, type SignedManifest } from "../collab/security/manifest";
import { parseStrictJson } from "../collab/security/canonical";
import { verifyMutation, createMutationReplayCache, type MutationGuardInstall } from "../collab/security/mutation";
import type { CollaborationSecurityOptions } from "../collab/manager";

/** Storage key holding the timestamp of the last completed reconcile round.
 * Every context that shares storage reads it, which is how the sidebar's
 * mount-time discovery skips the round the extension worker just finished.
 * Exported so a test can start a session with no reconcile history. */
export const DRIVE_LAST_RECONCILED_AT_KEY = "pboardDriveLastReconciledAt";

/** Platform-independent Drive and WebRTC wiring shared by browser and Android. */
export function createDriveRuntime({ auth: googleAuth, storage, getRepository, fetcher: rawFetcher = fetch, hasSignalingHostPermission, onReconciled, identity = defaultDriveIdentityCache(), operationSync = true }: {
  /** Legacy protocol is retained only for compatibility tests/recovery tooling. */
  operationSync?: boolean;
  auth: GoogleAuthProvider; storage: KeyValueStorage; getRepository: () => Promise<RxRepository | null>; fetcher?: typeof fetch;
  hasSignalingHostPermission?: (origin: string) => Promise<boolean>; onReconciled?: () => Promise<void>;
  identity?: DriveIdentityCache;
}) {
  // Diagnostics build: count every Drive request issued through any provider
  // below by purpose; a production build returns the fetcher unchanged.
  const fetcher = collaborationCounters.instrumentFetcher(rawFetcher);
  /** Each subsystem builds its own permission transport, but they all resolve
   * the account through one cache: `about.get` used to be paid once per
   * consumer, several times per board, on every startup and every poll. */
  const permissionTransport = () => createDrivePermissionTransport(googleAuth, fetcher, undefined, identity);
  let signalingSettings: CollaborationSettings | undefined;
  const independentCollaboration = () => signalingSettings?.provider === "websocket";
  const legacyBroker = () => signalingSettings === undefined && googleBrokerEnabled();
  /** Existing recorded trust markers only; a missing signature never classifies a legacy copy. */
  const legacyHasPin = async (boardId: string) => {
    const pins = (await storage.get("pboardSecurityPins")).pboardSecurityPins as Record<string, unknown> | undefined;
    return Boolean(pins?.[`board:${boardId}`]);
  };
  const legacyDriveTrust = async (boardId: string) => Boolean(await legacyHasPin(boardId) || (await sharedProjects.get(boardId)).projectFileId);
  const boardCollaboration = createBoardGrantService({ storage, fetcher, canAccessEndpoint: hasSignalingHostPermission,
    async recoveryHistory(board) {
      const rx = await getRepository(); return rx ? (await rx.journal.publicGrants.where('boardId').equals(board).toArray()).map(g => g.manifest) : [];
    },
    // Locally retained grant chain (verified at each guard install): lets an
    // authority device rebuild a lost grant record without the service cache.
    async publicGrantHistory(board) {
      const rx = await getRepository(); return rx ? (await rx.journal.publicGrants.where('boardId').equals(board).toArray()).map(g => g.manifest) : [];
    },
    async validateRecoveryData(board, bundle) {
      const rx = await getRepository(); if (!rx) throw new Error('Recovery data storage is unavailable');
      const history = new Map(bundle.history.map(e => [e.payload.epoch, e.payload]));
      for (const entry of (await rx.journal.entries.where('boardId').equals(board).toArray()).filter(e => e.value._sec)) {
        const p = (entry.value._sec as any).provenance, manifest = history.get(p.epoch);
        if (!manifest || p.issuedAt < manifest.issuedAt - 30000 || p.issuedAt > manifest.expiresAt) throw new Error('Recover the signed public grant history for these board versions before restoring authority');
        await verifyMutation(entry.value, { boardId: board, collection: entry.collection, manifest, now: () => p.issuedAt }, createMutationReplayCache());
      }
    },
    async onAuthorization(board, permission, authorityReplacementAuthorized) {
      const rx = await getRepository();
      if (!rx) throw new Error("Cannot persist verified board permission");
      const previous = await rx.journal.permissions.get(board);
      // Replacement is allowed only when the grant service is installing a
      // Drive-verified authority transition (re-key); every other caller keeps
      // the original pin.
      if (previous?.authorityKeyId && previous.authorityKeyId !== permission.authorityKeyId && !authorityReplacementAuthorized)
        throw new Error("Board authority replacement is forbidden");
      await rx.journal.permissions.put(permission);
    },
    async onTransition(board, record) {
      const rx = await getRepository();
      if (!rx) throw new Error("Cannot persist board authority transition");
      await rx.journal.authorityTransitions.put({ id: `${board}:${record.newAuthorityKeyId}`, boardId: board, record: record as unknown as Record<string, unknown>, storedAt: Date.now() });
      collaborationDiagnostic("board_grant.rekeyed", { count: 1 });
    } });
  const identitySharing = createGoogleIdentitySharing({ storage, auth: googleAuth, grants: boardCollaboration, fetcher, canAccessEndpoint: hasSignalingHostPermission,
    async canInitialize(board) {
      const rx = await getRepository();
      if (!rx || await rx.isDeletedProject(board) || !await rx.getProject(board)) return false;
      const legacyPins = (await storage.get("pboardSecurityPins")).pboardSecurityPins as Record<string, unknown> | undefined;
      const legacyShared = (await storage.get("pboardDriveSharedProjects")).pboardDriveSharedProjects as Record<string, { projectFileId?: string }> | undefined;
      if (legacyPins?.[`board:${board}`] || legacyShared?.[board]?.projectFileId) throw new Error("This board has existing Drive collaboration trust. Keep its original provider or explicitly create a collaborative copy; automatic authority migration is forbidden.");
      const project = await rx.db.projects.findOne(board).exec();
      const cards = await rx.db.cards.find({ selector: { projectId: board } }).exec();
      const history = await rx.journal.entries.where("boardId").equals(board).toArray();
      if (project?.toJSON()._sec || cards.some(c => c.toJSON()._sec) || history.some(change => change.value._sec)) {
        // A board this device signed itself must never face a re-initialization
        // attempt: restore the lost grant record from the retained authority
        // keys first. Success means there is nothing to initialize.
        if (await boardCollaboration.restoreAuthorityRecord(board)) {
          collaborationDiagnostic("board_authority.restored", { room: "lost grant record adopted by its own authority device" });
          return false;
        }
        // Drive-verified owner re-key (D1/D4): live authenticated ownership of
        // the board folder is the only oracle; a refused or postponed re-key
        // falls through to the existing block below — now stating its reason.
        const rekey = await tryDriveRekey(board);
        if (rekey.done) return false;
        // Record which authority situation this is (never key material) so the
        // block can be supported with a precise recovery path.
        const diagnosis = await classifyBoardAuthority({
          boardId: board, storage,
          hasSignedHistory: history.some(change => change.value._sec),
          hasDocumentSignature: !!project?.toJSON()._sec || cards.some(c => c.toJSON()._sec)
        });
        collaborationDiagnostic("board_authority.blocked", { room: diagnosis.state });
        throw new BoardExistingSignedDataError("This board has existing signed collaboration data. Keep its original authority; automatic initialization cannot replace it."
          + (diagnosis.state === "authority-metadata-missing"
            ? " This device still holds the board's authority key but lost its grant record: open the board on this device while the grant service still caches its history, or import the sealed authority recovery file; the signed history itself stays intact."
            : diagnosis.state === "authority-foreign"
              ? " The board's authority lives on the device that signed it: open the board there so its grant can renew, import its sealed recovery file, or pair this device; local content stays readable and exportable."
              : "")
          + (rekey.reason ? ` Automatic Drive-ownership re-key was refused: ${rekey.reason}` : ""));
      }
      return true;
    },
    async canReceive(board, owner, email) {
      const rx = await getRepository();
      if (!rx || await rx.isDeletedProject(board)) return false;
      if (await boardCollaboration.localBundle(board)) return true;
      const legacyPins = (await storage.get("pboardSecurityPins")).pboardSecurityPins as Record<string, unknown> | undefined;
      if (legacyPins?.[`board:${board}`]) return false;
      // An invitation may create a new board, never replace unrelated local data.
      return !await rx.getProject(board) || owner === email;
    }
  });
  const driveSyncState = createDriveSyncStateStore(storage);
  const driveTombstones = createDriveTombstoneStore(storage);
  const isSharedProject = async (projectId: string) => Boolean((await sharedProjects.get(projectId)).projectFileId);
  const projectSnapshots = createBackendProjectSnapshotStore(storage, () => getRepository(),
    async (projectId) => !await isSharedProject(projectId));
  const driveTransport = createDriveTransport(googleAuth, fetcher);
  const driveProvider = createGoogleDriveProvider({
    auth: googleAuth,
    transport: driveTransport,
    snapshots: projectSnapshots,
    syncState: driveSyncState,
    tombstones: driveTombstones,
    history: createPrivateDriveHistory({ transport: createDriveTransport(googleAuth, fetcher, "history-"), snapshots: projectSnapshots,
      erasureTransport: createDriveTransport(googleAuth, fetcher, 'erased-'), imageTransport: createDriveTransport(googleAuth, fetcher, 'image-'),
      getRepository, getAccountId: connectedAccountId, async captureSession() {
        if (!await driveConnected()) return null;
        const token = await googleAuth.getAccessToken();
        const boundAuth = { ...googleAuth, getAccessToken: async () => token };
        const email = await connectedAccountEmail();
        return { account: await hashBlob(new Blob([email])),
          history: createDriveTransport(boundAuth, fetcher, "history-"), snapshots: createDriveTransport(boundAuth, fetcher),
          erasures: createDriveTransport(boundAuth, fetcher, 'erased-'), images: createDriveTransport(boundAuth, fetcher, 'image-') };
      } }),
    beforeReconcile: async () => {
      const saved = (await storage.get(COLLABORATION_SETTINGS))[COLLABORATION_SETTINGS] as { provider?: unknown } | undefined;
      // Independent private recovery must not depend on legacy shared-folder
      // discovery. The default Drive collaboration path remains unchanged.
      if (saved?.provider !== "websocket") await discoverSharedBoardSnapshots();
    },
    isSharedProject,
    syncSharedProject: (projectId, changeToken) => syncSharedProject(projectId, changeToken),
    syncPreferences: () => syncAccountPreferences(),
    isDeletedProject: async (projectId) => await (await getRepository())?.isDeletedProject(projectId) ?? false,
    // Connect is consent (product decision, 2026-10): once Google Drive is
    // connected under an account, every local board auto-enrolls for private
    // persistence — no per-board prompt. Earlier per-board disclosure records
    // remain valid evidence but are no longer required.
    allowBinding: async () => Boolean(await connectedAccountId())
  });
  // Sync v2 (websocket provider) persists every board — private or shared —
  // through the unified visible-Drive store (`/pboard/<boardId>/board.json.gz`)
  // on the same triggers the legacy path uses. AppData has no role in this
  // mode: the legacy AppData provider only runs while the Drive-provider
  // collaboration setting is active.
  const boardStore = createDriveBoardStore({ auth: googleAuth, fetcher });
  const boardSyncV2 = createBoardSyncV2({
    store: boardStore, snapshots: projectSnapshots, syncState: driveSyncState, tombstones: driveTombstones,
    getRepository, connectionState: async () => await googleAuth.getConnectionState(),
    deviceKeyId: async () => (await ensureDeviceKey("pboard-sync-v2-writer")).keyId
  });
  // The persisted collaboration setting is the authoritative mode signal:
  // `independentCollaboration()` only reflects it once a board pool has read
  // the settings, and routing must not depend on that ordering.
  const v2Mode = async () => {
    const saved = (await storage.get(COLLABORATION_SETTINGS))[COLLABORATION_SETTINGS] as { provider?: unknown } | undefined;
    return saved?.provider === "websocket";
  };
  /** How long a completed round answers a discovery-triggered reconcile. The
   * recurring alarm and every explicit user action pass `force`. */
  const RECONCILE_COALESCE_MS = 30_000;
  let reconcileRound: Promise<DriveReconcileResult> | null = null;
  async function lastReconciledAt(): Promise<number> {
    return Number((await storage.get(DRIVE_LAST_RECONCILED_AT_KEY))[DRIVE_LAST_RECONCILED_AT_KEY]) || 0;
  }
  async function performReconcileAll(): Promise<DriveReconcileResult> {
    if (operationSync) return reconcileOperations();
    const finish = async <T>(result: T): Promise<T> => {
      // Opportunistic maintenance after every reconcile round (pending
      // board-leave ACL removals); never fails or delays the reconcile.
      void onReconciled?.().catch(() => undefined);
      return result;
    };
    if (await v2Mode()) {
      // Silent legacy relocation first (connect is consent): boards found
      // in AppData or legacy shared folders join the unified layout before
      // this pass reconciles, and failures never block normal sync. The
      // account ordering preference also pulls/uploads here (it lives in
      // AppData by product decision); in legacy mode the drive provider
      // does both from its own reconcile.
      await Promise.all([
        runLegacyPass().catch(() => undefined),
        syncAccountPreferences().catch(() => undefined)
      ]);
      return finish(await boardSyncV2.reconcileAll());
    }
    return finish(await (collaborationCounters.enabled
      ? collaborationCounters.withDrivePurpose("reconcile", () => collaborationCounters.timed("reconcile", () => driveProvider.reconcileAll()))
      : driveProvider.reconcileAll()));
  }
  const googleDrive: GoogleDriveProvider = {
    ...driveProvider,
    // A fresh connect must immediately restore this account's boards; waiting
    // for the next sidebar focus would leave a new profile showing empty
    // local state next to a fully synced cloud.
    connect: async () => {
      await driveProvider.connect();
      void googleDrive.reconcileAll({ force: true }).catch(() => undefined);
    },
    syncProject: async (projectId, options) => operationSync ? syncOperations(projectId, options?.force ?? false) : await v2Mode()
      ? boardSyncV2.syncProject(projectId, options)
      : collaborationCounters.enabled
        ? collaborationCounters.withDrivePurpose("sync", () => collaborationCounters.timed("sync:project", () => driveProvider.syncProject(projectId, options)))
        : driveProvider.syncProject(projectId, options),
    reconcileAll: async (options) => {
      // One round at a time per JS context. Startup reaches this from several
      // callers at once (worker start, the sidebar's "reconcile now" message,
      // the sidebar's discovery effect, an erasure retry), and an unguarded
      // second round re-lists every folder AppData and Drive expose.
      if (reconcileRound) return await reconcileRound;
      // A fresh round in the *other* context (the sidebar page and the worker
      // each build a runtime) is recorded in shared storage, so the sidebar's
      // discovery effect does not repeat the round the worker just finished.
      // Only a completed round stamps; failures stay immediately retryable.
      if (!options?.force && Date.now() - await lastReconciledAt() < RECONCILE_COALESCE_MS)
        return { status: "reconciled", imported: 0, pulled: 0, pushed: 0, deleted: 0 };
      const round = performReconcileAll().finally(() => { if (reconcileRound === round) reconcileRound = null; });
      reconcileRound = round;
      const result = await round;
      await storage.set({ [DRIVE_LAST_RECONCILED_AT_KEY]: Date.now() });
      return result;
    },
    deleteProject: async (projectId) => operationSync ? (async () => {
      if (!await driveConnected()) return 'pending' as const;
      try { await operationService.flushRemoval(projectId); await driveTombstones.clear(projectId); return 'deleted' as const; } catch { return 'pending' as const; }
    })() : await v2Mode() ? boardSyncV2.deleteProject(projectId) : driveProvider.deleteProject(projectId),
    pullProject: async (projectId) => operationSync ? pullOperations(projectId) : await v2Mode() ? boardSyncV2.pullProject(projectId) : driveProvider.pullProject(projectId),
    pushProject: async (projectId) => operationSync ? (await syncOperations(projectId, true), { id: (await operationService.layout(projectId)).folderId, name: 'operations' }) : await v2Mode() ? boardSyncV2.pushProject(projectId) : driveProvider.pushProject(projectId)
  };

  const SHARED_PROJECTS_KEY = "pboardDriveSharedProjects";

  // Automatic legacy relocation (decision 2026-10-24): AppData board copies
  // and legacy shared `Pboard/` folders move into the unified layout without
  // prompting — connect is consent. Old copies are only deleted after the
  // migration verified the canonical snapshot and the read-only window
  // elapsed; failures leave everything untouched.
  const LEGACY_MIGRATIONS_KEY = "pboardPrivateMigrations";
  async function readMigrationRecords(): Promise<Record<string, MigrationState>> {
    const saved = (await storage.get(LEGACY_MIGRATIONS_KEY))[LEGACY_MIGRATIONS_KEY];
    return saved && typeof saved === "object" ? (saved as Record<string, MigrationState>) : {};
  }
  async function writeMigrationRecords(records: Record<string, MigrationState>): Promise<void> {
    await storage.set({ [LEGACY_MIGRATIONS_KEY]: records });
  }
  const legacyHistoryTransport = createDriveTransport(googleAuth, fetcher, "history-");
  const legacyPermissionTransport = permissionTransport();
  const legacyMigrationDeps: LegacyMigrationDeps = {
    skipBoard: operationSync ? async boardId => {
      const rx = await getRepository(); if (rx?.operationSource.bindings.has(boardId)) return true;
      const folder = (await sharedProjects.get(boardId)).folderId ?? await boardStore.existingBoardFolder(boardId);
      return folder ? (await legacyPermissionTransport.listFiles(folder)).some(file => file.name.startsWith('migration-')) : false;
    } : undefined,
    store: boardStore,
    listAppDataBoards: () => driveTransport.listProjectFiles(),
    listAppDataHistory: async (projectId) => (await legacyHistoryTransport.listProjectFiles())
      .filter(file => file.name === `history-${projectId}.pboard`),
    downloadFile: async (fileId) => {
      const text = await driveTransport.download(fileId);
      return text ? new TextEncoder().encode(text) : null;
    },
    deleteAppDataFile: (fileId) => driveTransport.delete(fileId),
    snapshots: projectSnapshots,
    syncState: driveSyncState,
    tombstones: driveTombstones,
    getRepository,
    deviceKeyId: async () => (await ensureDeviceKey("pboard-sync-v2-writer")).keyId,
    sharedLegacy: async () => {
      const saved = (await storage.get(SHARED_PROJECTS_KEY))[SHARED_PROJECTS_KEY] as Record<string, DriveSharedProjectRecord> | undefined;
      return Object.entries(saved ?? {}).flatMap(([projectId, record]) =>
        record.folderId && record.projectFileId
          ? [{ projectId, folderId: record.folderId, projectFileId: record.projectFileId }]
          : []);
    },
    listPermissions: async (folderId) => (await legacyPermissionTransport.listPermissions(folderId)).filter(permission => permission.type === "user"),
    createPermission: async (folderId, role, email) => {
      await legacyPermissionTransport.createPermission(folderId, role === "writer" ? "editor" : "viewer", email);
    },
    migrations: {
      load: async (projectId) => (await readMigrationRecords())[projectId],
      save: async (state) => { const records = await readMigrationRecords(); records[state.projectId] = state; await writeMigrationRecords(records); },
      clear: async (projectId) => { const records = await readMigrationRecords(); delete records[projectId]; await writeMigrationRecords(records); }
    },
    now: () => Date.now()
  };
  let legacyPassRun: Promise<LegacyMigrationResult> | null = null;
  function runLegacyPass(): Promise<LegacyMigrationResult> {
    legacyPassRun ??= (async () => {
      const result = await migrateLegacyBoards(legacyMigrationDeps);
      for (const state of Object.values(await readMigrationRecords())) {
        if (!operationSync && cleanupDue(state, Date.now())) await cleanupLegacySource(legacyMigrationDeps, state.projectId).catch(() => undefined);
      }
      return result;
    })().catch(error => { legacyPassRun = null; throw error; });
    return legacyPassRun;
  }

  function createSharedProjectStore(storage: KeyValueStorage): DriveSharedProjectStore {
    async function readAll(): Promise<Record<string, DriveSharedProjectRecord>> {
      const result = await storage.get(SHARED_PROJECTS_KEY);
      const saved = result[SHARED_PROJECTS_KEY];
      return saved && typeof saved === "object" ? (saved as Record<string, DriveSharedProjectRecord>) : {};
    }
    async function writeAll(all: Record<string, DriveSharedProjectRecord>): Promise<void> {
      await storage.set({ [SHARED_PROJECTS_KEY]: all });
    }
    return {
      async get(projectId) {
        const record = (await readAll())[projectId];
        return {
          folderId: record?.folderId ?? null,
          projectFileId: record?.projectFileId ?? null,
          realtimeFolderId: record?.realtimeFolderId ?? null,
          // Stays undefined while nothing has been observed: the sharing service
          // must tell "no baseline yet" from "observed with no grant".
          observedGrantId: record?.observedGrantId
        };
      },
      async set(projectId, patch) {
        const all = await readAll();
        const existing = all[projectId] ?? { folderId: null, projectFileId: null, realtimeFolderId: null };
        const next = { ...existing, ...patch };
        // The layout is re-recorded on every discovery pass and on every
        // signaling round trip. Writing it when nothing changed is not free:
        // the sidebar watches this key and restarts its Drive reconciliation
        // and its collaboration session on every write, so an unchanged
        // layout would keep both running. Firefox fires the change event for
        // an identical value as well, so the write must be skipped here.
        if (next.folderId === existing.folderId &&
            next.projectFileId === existing.projectFileId &&
            next.realtimeFolderId === existing.realtimeFolderId &&
            next.observedGrantId === existing.observedGrantId) return;
        all[projectId] = next;
        await writeAll(all);
      },
      async delete(projectId) {
        const all = await readAll();
        if (!(projectId in all)) return;
        delete all[projectId];
        await writeAll(all);
      }
    };
  }

  const sharedProjects = createSharedProjectStore(storage);

  const drivePermissions = createDrivePermissionService({
    transport: permissionTransport(),
    sharedProjects,
    findOwnershipFolder: async (projectId) => await v2Mode() ? boardStore.existingBoardFolder(projectId) : null,
    prepareOperationBoard: operationSync ? async projectId => { await operationService.open(projectId); } : undefined,
    isOperationBoard: async projectId => Boolean((await getRepository())?.operationSource.bindings.has(projectId)),
    readSnapshot: async (projectId) => {
      const rx = await getRepository();
      if (!rx) throw new Error("Sharing requires the RxDB storage backend");
      const { project, items } = await rx.exportProject(projectId, false);
      return serializeProjectSnapshot(project, items);
    }
  });

  const syncSharedProject = createSharedProjectSync({
    permissions: drivePermissions,
    snapshots: projectSnapshots,
    syncState: driveSyncState,
    getRepository: () => getRepository()
  });

  const discoverSharedBoardSnapshots = createSharedBoardDiscovery({
    connected: async () => await googleAuth.getConnectionState() === "connected",
    permissions: drivePermissions,
    getRepository: () => getRepository(),
    isDeleted: async (projectId) => Boolean(await driveTombstones.get(projectId)) ||
      Boolean(await (await getRepository())?.isDeletedProject(projectId)),
    isReshared: async (projectId) => {
      // A queued self-removal outranks everything: restoring now would eat
      // the leave the transport still has to deliver.
      const leaves = ((await storage.get(PENDING_BOARD_LEAVES_KEY))[PENDING_BOARD_LEAVES_KEY] ?? {}) as Record<string, true>;
      if (leaves[projectId]) return false;
      try {
        return await drivePermissions.wasReinvitedSince(projectId);
      } catch {
        return false;
      }
    },
    onReshared: async (projectId) => { await (await getRepository())?.unhideProject(projectId); }
  });

  async function discoverSharedBoards() {
    // The sidebar calls this while it stays open (and on focus). Private
    // account boards need the same recovery path as startup, not just legacy
    // shared-folder discovery. Reconciliation coalesces overlapping callers
    // and retains the normal binding, erasure and causal-history checks.
    await googleDrive.reconcileAll();
  }

  /**
   * Live collaboration for shared projects, driven by the RxDB repository.
   *
   * Each platform runtime owns one manager. The App calls `start(projectId)`
   * when a project becomes current and `stop()` on unmount; `start()` stops the
   * previous project first. Private projects have no content replication pool;
   * an independent account room can still synchronize the project list order.
   *
   * Signaling here is the legacy Drive-hosted path (ephemeral per-peer records
   * in the shared project's `realtime/` folder; account order uses private
   * appDataFolder records). Sync v2 selects websocket signaling instead —
   * `selectRuntimeSignaling` never reaches this factory in that mode.
   * `pool.cancel()` (on `stop()`) closes the handler, which calls
   * `signaling.leave()` and stops the poll loop.
   */

  /** Stable per-session peer id shared by both of a project's signaling pools. */
  const collaborationPeerId = crypto.randomUUID();

  /**
   * One Drive-signaling instance per pool (cards + projects). The manager creates
   * a fresh one per `signalingFor` call; `pool.cancel()` on `stop()` closes the
   * handler, which calls `signaling.leave()` and stops the poll loop. Both pools
   * of one start share `collaborationPeerId` so they identify as the same peer.
   */
  function driveSignalingFor(topic: string): PboardSignaling {
    if (topic.startsWith("pboard-account-")) {
      const account = topic.slice("pboard-account-".length, -"-order".length);
      return createDriveSignaling({ store: createAccountSignalStore({
        transport: createDriveTransport(googleAuth, fetcher, "account-signal-"),
        account, peerId: collaborationPeerId
      }) });
    }
    const projectId = topic.split("-").slice(2, -1).join("-");
    const store = createDriveSignalStore({
      transport: permissionTransport(),
      sharedProjects,
      projectId,
      peerId: collaborationPeerId,
      topic,
      realtimeFolderId: () => drivePermissions.realtimeFolderId(projectId)
    });
    return createDriveSignaling({ store });
  }

  // ---------------------------------------------------------------------------
  // Protocol 2: device keys, pinned board authority, signed manifests.
  //
  // Enrollment/trust bootstrapping is deliberately not implementable from Drive
  // data alone (the plan forbids it): the owner approves a device key through an
  // out-of-band verification (QR/fingerprint comparison). This runtime stores the
  // pinned authority fingerprints in app-private storage and exposes them for the
  // enrollment UI; without a pin no secure pool starts and collaboration stays
  // offline rather than falling back to the unsigned protocol.
  // ---------------------------------------------------------------------------

  /** Storage slots: pinned authority fingerprints per board/account. */
  const AUTHORITY_PIN_KEY = "pboardSecurityPins";

  type SecurityPins = Record<string, {
    /** Board/account id this pin governs. */
    scope: string;
    /** Canonical fingerprint of the pinned authority public key. */
    authorityKeyId: string;
    authorityPublicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
    pinnedAt: number;
    /** "board" rooms bind to a Drive file+folder; "account" rooms to the hash. */
    kind: "board" | "account";
  }>;

  async function readPins(): Promise<SecurityPins> {
    const stored = await storage.get(AUTHORITY_PIN_KEY);
    const pins = stored[AUTHORITY_PIN_KEY];
    return pins && typeof pins === "object" ? pins as SecurityPins : {};
  }

  async function writePins(pins: SecurityPins): Promise<void> {
    await storage.set({ [AUTHORITY_PIN_KEY]: pins });
  }

  /** Pins the board authority after an out-of-band verification (enrollment UI). */
  function pinBoardAuthority(boardId: string, authorityPublicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string }, driveProjectFileId: string, driveFolderId: string) {
    return (async () => {
      const pins = await readPins();
      pins[`board:${boardId}`] = {
        scope: boardId,
        authorityKeyId: await publicKeyFingerprint(authorityPublicJwk),
        authorityPublicKey: authorityPublicJwk,
        pinnedAt: Date.now(),
        kind: "board"
      };
      await writePins(pins);
      boardAuthorityCache.set(boardId, { driveProjectFileId, driveFolderId });
    })();
  }

  function pinAccountAuthority(account: string, authorityPublicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string }) {
    return (async () => {
      const pins = await readPins();
      pins[`account:${account}`] = {
        scope: account,
        authorityKeyId: await publicKeyFingerprint(authorityPublicJwk),
        authorityPublicKey: authorityPublicJwk,
        pinnedAt: Date.now(),
        kind: "account"
      };
      await writePins(pins);
    })();
  }

  const boardAuthorityCache = new Map<string, { driveProjectFileId: string; driveFolderId: string }>();

  /** Diagnostic text is fixed locally: never expose Drive bodies, keys or tokens.
   * Ordinary Drive clients retain the existing null/fail-closed behavior. */
  function unavailableSecurity(kind: "board" | "account", reason: "pin" | "missing" | "drive" | "invalid" | "authority" | "binding" | "expired" | "member" | "history"): null {
    if (!experimentalSignalingEnabled()) return null;
    collaborationDiagnostic(`security.${kind}.${reason}`);
    const label = kind === "account" ? "Account" : "Board";
    const request = kind === "account" ? "My account device request" : "My board device request";
    const renew = kind === "account" ? "Initialize / renew my account" : "Initialize / renew board authority";
    const details = {
      pin: `${label} enrollment is missing in this browser. On the original authority browser use "${renew}". On an additional browser use "${request}", obtain owner approval, then "Trust authority bundle".`,
      missing: `${label} authorization manifest was not found in Google Drive. Use "${renew}" on the original authority browser, then restart live collaboration.`,
      drive: `${label} authorization could not be read from Google Drive. Check the Drive connection and access, then retry; do not reset device keys.`,
      invalid: `${label} authorization signature or format could not be verified. Renew on the original authority browser; do not reset keys or trust a replacement authority automatically.`,
      authority: `${label} authority in Drive differs from the authority trusted by this browser. Use the original authority profile; do not initialize another authority or reset keys.`,
      binding: `${label} authorization belongs to a different account, board or Drive location. Select the same original board and account on both browsers.`,
      expired: `${label} authorization expired. Use "${renew}" on the original authority browser, then restart live collaboration on both browsers.`,
      member: `This browser's device is not approved for the ${kind}. Use "${request}", obtain owner approval, then "Trust authority bundle".`,
      history: `${label} authorization is older than or conflicts with the version accepted by this browser, or its acceptance could not be saved. Renew on the original authority browser; do not clear trust records.`
    };
    throw new Error(details[reason]);
  }

  async function resolveManifest(
    pin: SecurityPins[string],
    collection: "cards" | "projects" | "accountOrder",
    identity: { boardId: string; driveProjectFileId: string; driveFolderId: string } | null
  ): Promise<CollaborationSecurityOptions | null> {
    const key = await ensureDeviceKey(`${pin.kind}-device:${pin.scope}`);
    // Fetch the newest manifest for the room: board manifests live in the shared
    // folder; account manifests in appDataFolder.
    let raw: string | null;
    try {
      raw = pin.kind === "board" && identity
        ? await readBoardManifest(identity.driveProjectFileId, identity.driveFolderId, experimentalSignalingEnabled())
        : await readAccountManifest(pin.scope, experimentalSignalingEnabled());
    } catch (error) {
      if (!experimentalSignalingEnabled()) throw error;
      return unavailableSecurity(pin.kind, "drive");
    }
    if (!raw) return unavailableSecurity(pin.kind, "missing");
    let signed: SignedManifest;
    try { signed = parseStrictJson(raw) as unknown as SignedManifest; }
    catch { return unavailableSecurity(pin.kind, "invalid"); }
    if (typeof signed?.payload?.authorityKeyId !== "string") return unavailableSecurity(pin.kind, "invalid");
    if (signed.payload.authorityKeyId !== pin.authorityKeyId) return unavailableSecurity(pin.kind, "authority");
    let manifest;
    try { manifest = await verifyManifest(signed, pin.authorityPublicKey, pin.authorityKeyId); }
    catch { return unavailableSecurity(pin.kind, "invalid"); }
    if (pin.kind === "board" && identity && (manifest.boardId !== identity.boardId || manifest.driveProjectFileId !== identity.driveProjectFileId || manifest.driveFolderId !== identity.driveFolderId)) return unavailableSecurity(pin.kind, "binding");
    if (pin.kind === "account" && manifest.boardId !== `account:${pin.scope}`) return unavailableSecurity(pin.kind, "binding");
    if (experimentalSignalingEnabled()) {
      if (manifest.expiresAt <= Date.now()) return unavailableSecurity(pin.kind, "expired");
      if (!manifest.devices.some(member => member.deviceKeyId === key.keyId)) return unavailableSecurity(pin.kind, "member");
    }
    try { await acceptManifest(manifest, manifestEpochStore, Date.now()); }
    catch { return unavailableSecurity(pin.kind, "history"); }
    collaborationDiagnostic(`security.${pin.kind}.verified`, { count: manifest.devices.length });
    return {
        signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId },
        manifest,
        relayAuthorization: { authority: pin.authorityPublicKey, manifest: signed },
        boardId: manifest.boardId,
        ownSessionId: collaborationPeerId
    };
  }

  // D1/D4: re-establishing a lost board authority requires a live authenticated
  // Drive ACL read proving this account owns the board folder. Every failure —
  // Drive unavailable (postponement), unshared board, verified non-owner, or an
  // existing grant record on this device — refuses without touching local data,
  // leaving the ordinary block (or offline editing) exactly as before.
  async function tryDriveRekey(board: string): Promise<{ done: boolean; reason?: string }> {
    // Read the provider fresh instead of the lazily cached flag: the sharing
    // UI can reach this path before the manager's role refresh has run.
    if ((await boardCollaboration.settings()).provider !== "websocket") return { done: false };
    if (!await driveConnected()) return { done: false, reason: "Google Drive is not connected; re-keying postponed" };
    try {
      await boardCollaboration.reestablishAuthority(board, await drivePermissions.verifyDriveOwnership(board));
      collaborationDiagnostic("board_authority.rekeyed", { room: "owner re-established via live Drive ACL" });
      return { done: true };
    } catch (error) {
      const reason = String((error as Error)?.message ?? error).slice(0, 160);
      collaborationDiagnostic("board_authority.rekey_refused", { room: reason });
      return { done: false, reason };
    }
  }
  // Explicit user-triggered re-key (the auditable D1 act): unlike the automatic
  // decision-tree attempt, real errors propagate so the UI can show the reason.
  async function reestablishAuthorityFromDrive(board: string) {
    if ((await boardCollaboration.settings()).provider !== "websocket") throw new Error("Enable WebSocket collaboration before re-establishing a board authority");
    if (!await driveConnected()) throw new Error("Connect Google Drive before re-establishing a board authority");
    const transition = await boardCollaboration.reestablishAuthority(board, await drivePermissions.verifyDriveOwnership(board));
    collaborationDiagnostic("board_authority.rekeyed", { room: "explicit Drive ownership re-key" });
    return transition;
  }

  async function boardSecurityFor(projectId: string): Promise<CollaborationSecurityOptions | null> {
    if (independentCollaboration()) {
      // Independent mode never reaches the identity-driven auto-init path, so
      // a lost grant record on a board this device signed must be restored
      // here too, otherwise editing stays blocked with no initialization ever
      // attempted. Gated on the persistent signed-history flag: one cheap
      // lookup, no extra network for ordinary unsigned boards.
      if (!await boardCollaboration.localBundle(projectId)) {
        const rx = await getRepository();
        if (rx && await rx.journal.hasSignedHistory(projectId) && await boardCollaboration.restoreAuthorityRecord(projectId))
          collaborationDiagnostic("board_authority.restored", { room: "lost grant record adopted by its own authority device" });
        // Restore failed or is impossible: a Drive-verified owner may still
        // re-establish authority (D1/D4); refusals keep the ordinary block.
        else if (rx && await rx.getProject(projectId)) await tryDriveRekey(projectId);
      }
      return boardCollaboration.security(projectId);
    }
    if (!await driveConnected()) return null;
    if (legacyBroker()) {
      const role = await drivePermissions.myRole(projectId);
      const file = await drivePermissions.projectFileId(projectId);
      const folder = (await sharedProjects.get(projectId)).folderId;
      if (!role || !file || !folder) throw new Error("Enable Drive sharing before starting the Google-verified experiment");
      return googleBroker.security({ kind: "board", scope: projectId, file, folder, role });
    }
    const pins = await readPins();
    const pin = pins[`board:${projectId}`];
    if (!pin) return unavailableSecurity("board", "pin");
    const layout = await drivePermissions.realtimeFolderId(projectId).then(() => drivePermissions.projectFileId(projectId));
    const fileId = await layout || null;
    void fileId;
    return resolveManifest(pin, "cards", {
      boardId: projectId,
      driveProjectFileId: (await drivePermissions.projectFileId(projectId)) ?? "",
      driveFolderId: (await sharedProjects.get(projectId)).folderId ?? ""
    });
  }

  async function accountSecurityFor(account: string): Promise<CollaborationSecurityOptions | null> {
    if (legacyBroker()) return googleBroker.security({ kind: "account", scope: account, file: "", folder: "", role: "owner" });
    const pins = await readPins();
    const pin = pins[`account:${account}`];
    if (!pin) return unavailableSecurity("account", "pin");
    return resolveManifest(pin, "accountOrder", null);
  }

  // Manifest fetch helpers: board manifests are stored as signed envelope JSON.
  async function readBoardManifest(projectFileId: string, folderId: string, strict = false): Promise<string | null> {
    const transport = permissionTransport();
    const name = "pboard-manifest.json";
    const direct = await transport.findFile(name, folderId).catch(error => { if (strict) throw error; return null; });
    if (direct) return transport.downloadFileOrNull(direct.id);
    void projectFileId;
    return null;
  }

  async function readAccountManifest(account: string, strict = false): Promise<string | null> {
    const transport = createDriveTransport(googleAuth, fetcher, "pboard-account-manifest-");
    const file = await transport.findProjectFile(account).catch(error => { if (strict) throw error; return null; });
    return file ? transport.download(file.id).catch(error => { if (strict) throw error; return null; }) : null;
  }

  const manifestEpochStore = storageManifestEpochs(storage);

  // Per-project mutation verification (protocol 2): a document that arrives
  // through any persistence path for this project must carry valid signed
  // provenance or the write is rejected with a 422-equivalent storage error.
  const activeGuards = new Map<string, { install: MutationGuardInstall; projectId: string; security: CollaborationSecurityOptions; managed: boolean }>();

  async function installBoardMutationGuard(projectId: string, prepared?: CollaborationSecurityOptions, managed = false): Promise<MutationGuardInstall | null> {
    const securityContext = prepared ?? await boardSecurityFor(projectId);
    if (!securityContext) return null;
    const rx = await getRepository();
    if (!rx) return null;
    const pending = await storage.get("pboardEnrollmentAttestations");
    const all = (pending.pboardEnrollmentAttestations ?? {}) as Record<string, number>;
    // Only the first verified owner bootstraps existing unsigned local data.
    // A second same-account browser must receive signed data; stamping its stale
    // local snapshot with a new timestamp could overwrite newer shared content.
    const firstBrokerManifest = securityContext.manifestHistory?.get(1);
    const brokerBootstrapOwner = firstBrokerManifest?.devices.some(d => d.deviceKeyId === securityContext.signer.deviceKeyId && d.role === "owner") &&
      securityContext.manifest.devices.some(d => d.deviceKeyId === securityContext.signer.deviceKeyId && d.role === "owner");
    const install = await rx.installBoardSecurity({
      preserveSignedData: independentCollaboration(),
      security: securityContext, attestExisting: independentCollaboration() ? await boardCollaboration.canBootstrap(projectId) : legacyBroker() ? Boolean(brokerBootstrapOwner) : all[projectId] === securityContext.manifest.epoch });
    if (!independentCollaboration() && !legacyBroker() && all[projectId] !== undefined) { delete all[projectId]; await storage.set({ pboardEnrollmentAttestations: all }); }
    if (independentCollaboration()) {
      try { await boardCollaboration.markBootstrapped(projectId); }
      catch (error) { await install.uninstall(); throw error; }
    }
    activeGuards.set(projectId, { install, projectId, security: securityContext, managed });
    return install;
  }

  async function removeBoardMutationGuard(projectId: string): Promise<void> {
    const active = activeGuards.get(projectId);
    if (!active) return;
    activeGuards.delete(projectId);
    await active.install.uninstall();
  }

  /**
   * Verifies current board authorization out-of-band (without becoming the
   * actively collaborated board) and admits held pending work under it. The
   * mutation guard remains installed until replaced or stopped, so the recovery
   * panels can reconcile work on boards the manager is not currently connected
   * to. Fail-closed: no verified current grant or an
   * unverifiable manifest leaves everything retained.
   */
  async function renewBoardAuthorization(projectId: string): Promise<{ role: string }> {
    if (operationSync) return { role: await operationService.role(projectId) };
    const active = activeGuards.get(projectId);
    if (active?.managed) {
      // The manager owns its transports and guard. Let it refresh/restart them
      // together; an installed guard can be expired and is not proof of access.
      await collaborationManager.refreshRole();
      const currentGrant = (guard: typeof active | undefined) => !!guard && guard.security.manifest.expiresAt > Date.now() && manifestIsCurrent(guard.security.manifest, Date.now());
      const refreshed = activeGuards.get(projectId);
      if (refreshed && !currentGrant(refreshed)) await collaborationManager.start(projectId);
      const current = activeGuards.get(projectId);
      if (!current || !currentGrant(current)) throw new Error('No current board authorization is available. Local work is retained.');
      const role = current.security.manifest.devices.find(d => d.deviceKeyId === current.security.signer.deviceKeyId)?.role;
      const rx = await getRepository();
      if (!rx) throw new Error('Local repository is unavailable');
      if (role === 'owner' || role === 'editor') await rx.admitPendingWork(projectId);
      return { role: role ?? 'none' };
    }
    const securityContext = await boardSecurityFor(projectId);
    if (!securityContext) throw new Error("No current board authorization is available. Reconnect or renew board access first; local work is retained.");
    if (active) await removeBoardMutationGuard(projectId);
    const install = await installBoardMutationGuard(projectId, securityContext);
    if (!install || install.projectId !== projectId) throw new Error("Current board authorization could not be verified; local work is retained");
    const rx = await getRepository();
    if (!rx) { await removeBoardMutationGuard(projectId); throw new Error("Local repository is unavailable"); }
    // The guard stays installed so the panels can resolve/reconcile under the
    // verified grant. It is replaced when the manager starts this board, and its
    // manifest expiry keeps stale admission from signing anything new.
    const role = securityContext.manifest.devices.find(d => d.deviceKeyId === securityContext.signer.deviceKeyId)?.role;
    if (role === "owner" || role === "editor") await rx.admitPendingWork(projectId);
    return { role: role ?? "none" };
  }

  /** Import a shared project's snapshot from Drive when there is no local copy yet. */
  async function bootstrapFromDrive(projectId: string): Promise<boolean> {
    const rx = await getRepository();
    if (!rx) throw new Error("Collaboration requires the RxDB storage backend");
    if (await rx.getProject(projectId)) return false;
    const snapshot = deserializeProjectSnapshot(await drivePermissions.readSharedSnapshot(projectId));
    await rx.importProject(snapshot.project, snapshot.items);
    return true;
  }

  /** Drive I/O only when connected; private/unconnected projects resolve null locally. */
  const driveConnected = async () => (await googleAuth.getConnectionState()) === "connected";

  /**
   * The connected account's identity.
   *
   * The account is asked for on every private-history sync, twice: once for
   * the erasure inventory and once for the history itself. The answer is not
   * cached here: a different Google account can be signed in without the
   * stored token changing, so a cached identity could report the previous
   * account and let a board be written under it. The shared permission
   * transport caches the identity for the short-lived checks that need it.
   */
  async function connectedAccountEmail(): Promise<string> {
    collaborationCounters.countAccountIdentity(false);
    const user = await permissionTransport().currentIdentity();
    if (!user) throw new Error("Could not identify the Google Drive account");
    return user.email.trim().toLowerCase();
  }

  async function connectedAccountId(): Promise<string | null> {
    if (!await driveConnected()) return null;
    return hashBlob(new Blob([await connectedAccountEmail()]));
  }
  async function privateErasureAccount(boardId: string): Promise<string | null> {
    const rx = await getRepository();
    const bound = rx && (await rx.db.settings.findOne(`privateDrive:${await hashBlob(new Blob([boardId]))}`).exec())?.value;
    return bound || await connectedAccountId();
  }

  /** Explicit connect-time enrollment, scoped to the successfully verified account
   * and the boards reviewed by this action. Old timestamp-only consent is ignored. */
  async function authorizePrivatePersistence(boardId?: string) {
    const accountId = await connectedAccountId();
    const rx = await getRepository();
    if (!accountId || !rx) throw new Error("Connect Google and open local storage before enabling private persistence");
    const visibleBoards = (await rx.listProjects()).map(project => project.id);
    if (boardId && !visibleBoards.includes(boardId)) throw new Error("Select a local board before enabling private persistence");
    await withStorageLock(storage, "pboardBindingDisclosure", async () => {
      const previous = (await storage.get("pboardBindingDisclosure")).pboardBindingDisclosure as { version?: number; accountId?: string; boardIds?: string[] } | undefined;
      const priorBoards = previous?.version === 1 && previous.accountId === accountId && Array.isArray(previous.boardIds) ? previous.boardIds : [];
      const boardIds = boardId ? [...new Set([...priorBoards, boardId])] : visibleBoards;
      if (await connectedAccountId() !== accountId) throw new Error("Google account changed during private persistence enrollment");
      await storage.set({ pboardBindingDisclosure: { version: 1, accountId, boardIds, grantedAt: new Date().toISOString() } });
    });
  }

  const syncAccountPreferences = createAccountPreferenceSync({
    transport: createDriveTransport(googleAuth, fetcher, "account-preferences-", operationSync ? () => boardStore.rootFolder() : undefined),
    legacySource: operationSync ? createDriveTransport(googleAuth, fetcher, 'account-preferences-') : undefined,
    getAccountId: connectedAccountId,
    getRepository: () => getRepository()
  });

  const refreshFromDrive = createSharedProjectRefresh({
    connected: driveConnected, permissions: drivePermissions,
    getRepository: () => getRepository(),
    isDeleted: async (projectId) => Boolean(await driveTombstones.get(projectId)) ||
      Boolean(await (await getRepository())?.isDeletedProject(projectId))
  });

  const enrollmentTransport = permissionTransport();
  const experimentalEnrollment = createDeviceEnrollment({
    storage,
    async identity(kind, scope) {
      if (!await driveConnected()) throw new Error("Connect Google Drive before enrolling devices");
      const user = await enrollmentTransport.currentIdentity();
      if (!user) throw new Error("Google account identity unavailable");
      const email = user.email.trim().toLowerCase();
      if (kind === "account") {
        const account = await hashBlob(new Blob([email]));
        if (scope && scope !== account) throw new Error("Cannot enroll another account");
        return { kind, scope: account, boardId: `account:${account}`, driveProjectFileId: "", driveFolderId: "", email, role: "owner" };
      }
      if (!scope) throw new Error("Select a shared board first");
      const role = await drivePermissions.myRole(scope);
      const file = await drivePermissions.projectFileId(scope);
      const folder = (await sharedProjects.get(scope)).folderId;
      if (!role || !file || !folder) throw new Error("Enable Drive sharing and verify access before enrolling this board");
      return { kind, scope, boardId: scope, driveProjectFileId: file, driveFolderId: folder, email, role };
    },
    async read(id) {
      if (id.kind === "board") return readBoardManifest(id.driveProjectFileId, id.driveFolderId);
      return readAccountManifest(id.scope);
    },
    async publish(id, text) {
      if (id.kind === "board") {
        const file = await enrollmentTransport.findFile("pboard-manifest.json", id.driveFolderId);
        if (file) await enrollmentTransport.uploadJsonFile(file.id, text);
        else await enrollmentTransport.createJsonFile("pboard-manifest.json", id.driveFolderId, text);
      } else {
        const transport = createDriveTransport(googleAuth, fetcher, "pboard-account-manifest-");
        const file = await transport.findProjectFile(id.scope);
        await transport.upload(id.scope, text, file?.id);
      }
    },
    async roleForEmail(id, email) {
      if (id.kind === "account") return email === id.email ? "owner" : null;
      return (await drivePermissions.listCollaborators(id.scope)).find(person => person.email.trim().toLowerCase() === email)?.role ?? null;
    }
  });

  const googleBroker = createGoogleBrokerEnrollment({ storage, getAccessToken: () => googleAuth.getAccessToken(), fetcher, canAccessEndpoint: hasSignalingHostPermission });
  let iceConfiguration: Promise<RTCConfiguration | null> | null = null;
  const getIceConfiguration = () => (iceConfiguration ??= loadIceServers(storage).then(iceServers => ({ iceServers })));
  const legacyCollaborationManager: CollaborationManager = createCollaborationManager({
    getAccountId: async () => independentCollaboration() ? null : connectedAccountId(),
    // Private preference sync verifies and selects its own account. Board pool
    // lifecycle must not clear it, nor add Google identity HTTP on every switch.
    getProjectOrderAccountId: async fallback => independentCollaboration() && await driveConnected() ? undefined : fallback,
    myRole: async (projectId) => {
      const selected = await boardCollaboration.settings();
      const configured = (await storage.get(COLLABORATION_SETTINGS))[COLLABORATION_SETTINGS];
      signalingSettings = configured ? selected : undefined;
      if (independentCollaboration()) {
        try { await identitySharing.sync(projectId); }
        catch (error) {
          // Identity discovery is not needed to use an already pinned, current
          // device grant. No new enrollment or unsigned transport is permitted.
          if (!await boardCollaboration.localBundle(projectId)) throw error;
          collaborationDiagnostic("google.identity.unavailable");
        }
        return boardCollaboration.role(projectId);
      }
      return await driveConnected() ? drivePermissions.myRole(projectId) : null;
    },
    getSharedFileId: async (projectId) => (await boardCollaboration.settings()).provider === "websocket" ? null : (await driveConnected() ? drivePermissions.projectFileId(projectId) : null),
    bootstrapFromDrive: (projectId) => independentCollaboration() ? Promise.resolve(false) : bootstrapFromDrive(projectId),
    refreshFromDrive: (projectId, isActive) => independentCollaboration() ? Promise.resolve() : refreshFromDrive(projectId, isActive),
    signalingFor: (topic, security) => selectRuntimeSignaling(topic, () => driveSignalingFor(topic), security, signalingSettings, identitySharing.admitService),
    onHistoryReceived: (projectId) => driveSyncState.markDirty(projectId),
    boardSecurity: boardSecurityFor,
    // Explicit ICE endpoints (pinned defaults + optional operator additions);
    // resolved once per runtime; the loader already degrades to defaults.
    getIceConfiguration,
    accountSecurity: accountSecurityFor,
    securityChanged: async (projectId) => independentCollaboration() ? boardCollaboration.poll(projectId) : legacyBroker() ? googleBroker.poll(projectId, await connectedAccountId()) : false,
    installMutationGuard: (projectId, security) => installBoardMutationGuard(projectId, security, true),
    removeMutationGuard: (projectId) => removeBoardMutationGuard(projectId),
    // The legacy shared path uses the shared `Pboard/` folder assets; Sync v2
    // uses the board's own `attachments/` files in `/pboard/<boardId>/` plus
    // peer DataChannel bytes. Both need a connected Drive for the file leg.
    useImageTransport: async () => !independentCollaboration() || (await driveConnected()),
    imageTransport: async () => {
      // Sync v2: attachments are files in the board's own Drive folder
      // (`/pboard/<boardId>/attachments/`), the same store as the snapshot.
      if (independentCollaboration()) return {
        readImage: async (projectId: string, imageId: string) => {
          const found = await boardStore.findAttachment(projectId, imageId);
          if (!found) return null;
          const bytes = await boardStore.downloadFile(found.id);
          if (!bytes) return null;
          return JSON.parse(new TextDecoder().decode(bytes)) as BoardImage;
        },
        writeImage: async (projectId: string, imageId: string, image: BoardImage) => {
          await boardStore.uploadAttachment(projectId, imageId, new TextEncoder().encode(JSON.stringify(image)));
        }
      };
      return {
      readImage: async (projectId, imageId) => {
        const asset = await drivePermissions.readSharedImage(projectId, imageId);
        if (asset) return asset;
        // Recover images from snapshots written before shared image assets existed.
        const snapshot = deserializeProjectSnapshot(await drivePermissions.readSharedSnapshot(projectId));
        if (snapshot.project.id !== projectId) throw new Error("Shared snapshot belongs to a different project");
        for (const card of snapshot.items) {
          if (card.image?.dataUrl.startsWith("data:image/") && await hashBlob(await imageToBlob(card.image.dataUrl)) === imageId) return card.image;
        }
        return null;
      },
      writeImage: (projectId, imageId, image) => drivePermissions.writeSharedImage(projectId, imageId, image)
      };
    },
    getRepository: () => getRepository()
  });

  const operationChanges = createDriveChanges({ auth: googleAuth, fetcher, getRepository, getAccountId: connectedAccountId });
  const operationService = createOperationService({ changes: operationChanges, auth: googleAuth, store: boardStore, fetcher, getRepository,
    async recoverLegacyImage(boardId, imageId) {
      const found = await boardStore.findAttachment(boardId, imageId);
      if (found) { const bytes = await boardStore.downloadFile(found.id); if (bytes) return JSON.parse(new TextDecoder().decode(bytes)) as BoardImage; }
      return drivePermissions.readSharedImage(boardId, imageId);
    },
    async freezeLegacyMirrors(boardId, drive) {
      const privateCopy = await driveTransport.findProjectFile(boardId);
      if (privateCopy) await drive.protectLegacy(privateCopy.id);
      const unifiedCopy = await boardStore.snapshotFileId(boardId);
      if (unifiedCopy) await drive.protectLegacy(unifiedCopy);
    },
    async realtime(boardId, session, drive) {
      const transport = permissionTransport(), peerId = crypto.randomUUID();
      // Board viewers retain the existing separate signaling-folder permission.
      const realtimeFolder = await drivePermissions.realtimeFolderId(boardId);
      const topic = `pboard-operations-${boardId}`, prefix = `sig-${topic}-`;
      const base = createDriveSignalStore({ transport, sharedProjects, projectId: boardId, peerId, topic, realtimeFolderId: async () => realtimeFolder });
      const roles = new Map<string, { role: string | null; until: number }>();
      async function peerRole(id: string) {
        const cached = roles.get(id); if (cached && cached.until > Date.now()) return cached.role;
        if (await drive.folderRole() === 'revoked') return null;
        const files = (await transport.listFiles(realtimeFolder)).filter(file => file.name === `${prefix}${id}.json`);
        if (files.length !== 1) return null;
        const file = await drive.metadata(files[0].id);
        if (!file.parents?.includes(realtimeFolder)) return null;
        const permissions = await transport.listPermissions((await operationService.layout(boardId)).folderId);
        const owner = file.owners?.[0]?.emailAddress?.trim().toLowerCase();
        const role = file.ownedByMe ? await drive.folderRole() : permissions.find(permission => permission.type === 'user' && permission.emailAddress?.trim().toLowerCase() === owner)?.role ?? null;
        roles.set(id, { role, until: Date.now() + 10000 }); return role;
      }
      const signaling = createDriveSignaling({ store: { ...base,
        async listPeers() { const peers = await base.listPeers(); const result: typeof peers = {}; for (const [id, value] of Object.entries(peers)) if (await peerRole(id)) result[id] = value; return result; }
      } });
      return createOperationRealtime({ signaling, config: (await getIceConfiguration()) ?? undefined,
        canRead: async id => !!await peerRole(id), canWrite: async id => ['owner', 'editor', 'writer'].includes(await peerRole(id) ?? ''),
        receive: operations => session.receiveRealtime(operations), frontier: () => session.frontier(), recover: () => session.sync(false, false),
        state: (peers, error) => { if (operationProject === boardId) operationState = { ...operationState, connectedPeers: peers, error: error ?? null }; }
      });
    },
    sharedLayout: boardId => sharedProjects.get(boardId),
    recordLayout: (boardId, folderId, projectFileId) => sharedProjects.set(boardId, { folderId, projectFileId }),
    async stopLegacy(boardId) { await legacyCollaborationManager.stop(); await removeBoardMutationGuard(boardId); },
    async onStatus(boardId, error) { if (error) await driveSyncState.markError(boardId, error); }
  });
  async function syncOperations(boardId: string, force: boolean): Promise<import('./googleDriveProvider').ProjectSyncResult> {
    const rx = await getRepository();
    if (!rx) throw new Error('Local storage is unavailable');
    if (await rx.isDeletedProject(boardId)) return 'not-dirty';
    const syncState = await driveSyncState.get(boardId);
    const changeToken = syncState.changeToken ?? 0;
    // Opening an unbound local board migrates/publishes a baseline. Defer that
    // first publication too; importing a missing remote board remains immediate.
    if (!force && !rx.operationSource.bindings.has(boardId) && await rx.getProject(boardId)
      && syncState.dirty && dirtyFlushAt(syncState) > Date.now()) return 'not-dirty';
    try {
      const session = await operationService.open(boardId);
      const publish = force || await session.flushDue();
      await driveSyncState.markSyncing(boardId);
      await operationService.sync(boardId, force, publish);
      const project = await rx.getProject(boardId);
      const pending = await rx.operationSource.local.pendingTiming(boardId);
      if (pending) {
        const latest = await driveSyncState.get(boardId);
        await driveSyncState.set({ ...latest, dirty: true, status: 'pending',
          firstDirtyAt: new Date(pending.oldest).toISOString(), dirtyAt: new Date(pending.latest).toISOString() });
      }
      else if (project) await driveSyncState.markSynced(boardId, project.revision, (await operationService.layout(boardId)).folderId, changeToken);
      return 'pulled';
    } catch (error) { await driveSyncState.markError(boardId, error instanceof Error ? error.message : 'Drive sync failed'); throw error; }
  }
  async function pullOperations(boardId: string) {
    await syncOperations(boardId, true); const rx = await getRepository();
    if (!rx || !await rx.getProject(boardId)) return null;
    return { format: 'pboard-project' as const, version: 1 as const, exportedAt: new Date().toISOString(), ...await rx.exportProject(boardId) };
  }
  async function syncOperationErasures(rx: RxRepository) {
    const account = await connectedAccountId(); if (!account) return;
    const regular = createDriveTransport(googleAuth, fetcher, `erased-${account}-`, () => boardStore.rootFolder());
    const legacy = createDriveTransport(googleAuth, fetcher, 'erased-');
    const checkAccount = async () => { if (await connectedAccountId() !== account) throw new Error('Google account changed during erasure synchronization'); };
    for (const transport of [regular, legacy]) for (const file of await transport.listProjectFiles()) {
      const value = parseStrictJson(await transport.download(file.id), 1024 * 1024) as any;
      if (value?.format !== 'pboard-board-erasure' || value.version !== 1 || !validId(value.boardId)
        || file.name !== `${transport === regular ? `erased-${account}-` : 'erased-'}${value.boardId}.pboard`
        || (transport === regular && value.accountId !== account)) throw new Error('Invalid account erasure marker');
      await checkAccount(); await operationService.close(value.boardId); await rx.applyPrivateBoardErasure(value.boardId, account);
    }
    for (const marker of await rx.journal.boardErasures()) {
      if (marker.accountId !== account || !marker.cloudPending) continue;
      await operationService.close(marker.boardId); await operationChanges.forgetBoard(marker.boardId); await checkAccount();
      let file = await regular.findProjectFile(marker.boardId);
      if (!file) file = await regular.upload(marker.boardId, JSON.stringify({ format: 'pboard-board-erasure', version: 1, boardId: marker.boardId, accountId: account }));
      const verified = parseStrictJson(await regular.download(file.id)) as any;
      if (verified.boardId !== marker.boardId || verified.accountId !== account) throw new Error('Private erasure publication could not be verified');
      await checkAccount();
      // Confirmed deletion removes only this account's legacy private backups.
      for (const transport of [driveTransport, legacyHistoryTransport, createDriveTransport(googleAuth, fetcher, 'image-')]) {
        for (const candidate of await transport.listProjectFiles()) {
          if (!(candidate.name === `project-${marker.boardId}.pboard` || candidate.name.startsWith(`history-${marker.boardId}_`) || candidate.name === `history-${marker.boardId}.pboard`)) continue;
          const contents = parseStrictJson(await transport.download(candidate.id), 32 * 1024 * 1024) as any;
          if (contents?.boardId !== marker.boardId && contents?.project?.id !== marker.boardId) continue;
          await checkAccount(); await transport.delete(candidate.id);
        }
      }
      const layout = await sharedProjects.get(marker.boardId);
      if (layout.folderId) {
        const folder = await legacyPermissionTransport.getFile(layout.folderId).catch(error => {
          if (String(error).includes('404')) return null; throw error;
        });
        if (folder) {
          const permissions = await legacyPermissionTransport.listPermissions(layout.folderId);
          const email = (await connectedAccountEmail()).toLowerCase();
          const onlyOwner = permissions.length === 1 && permissions[0].role === 'owner' && permissions[0].emailAddress?.toLowerCase() === email;
          if (onlyOwner && folder.name === marker.boardId) { await checkAccount(); await boardStore.trashFile(layout.folderId); }
        }
      }
      await rx.journal.receipts.update(marker.id, { cloudPending: false } as any);
      await driveSyncState.forget(marker.boardId);
    }
  }
  let reconcilingOperations: Promise<import('./googleDriveProvider').DriveReconcileResult> | undefined;
  function reconcileOperations() {
    if (reconcilingOperations) return reconcilingOperations;
    reconcilingOperations = (async () => {
      const result: import('./googleDriveProvider').DriveReconcileResult = { status: 'disconnected', imported: 0, pulled: 0, pushed: 0, deleted: 0 };
      if (!await driveConnected()) return result;
      // Read/migrate legacy sources, preserving all original files. New board
      // persistence never runs the old AppData writer or leader/buffer runtime.
      const rx = await getRepository(); if (!rx) return result;
      const shared = await drivePermissions.discoverSharedProjects();
      await syncOperationErasures(rx);
      for (const tombstone of await driveTombstones.getAll()) await googleDrive.deleteProject(tombstone.projectId);
      await runLegacyPass();
      await syncAccountPreferences();
      const ids = new Set([...(await rx.listProjects()).map(project => project.id), ...await boardStore.listBoards(), ...shared.map(project => project.projectId)]);
      const errors: unknown[] = [];
      for (const id of ids) {
        if (await rx.isDeletedProject(id)) continue;
        const existed = !!await rx.getProject(id);
        try { await syncOperations(id, false); if (existed) result.pulled++; else result.imported++; }
        catch (error) { if (error instanceof DriveQuotaExceededError) throw error; errors.push(error); }
      }
      void onReconciled?.().catch(() => undefined);
      if (errors.length) throw new AggregateError(errors, errors[0] instanceof Error ? errors[0].message : 'Some boards could not synchronize');
      result.status = 'reconciled'; return result;
    })().finally(() => { reconcilingOperations = undefined; }); return reconcilingOperations;
  }
  // Preserve the platform lifecycle interface. No board authority, device grant,
  // RxDB master/fork pool, server buffer or leader participates in operation sync.
  let operationProject: string | null = null, realtimeEnabled = true;
  let operationState: import('../collab/manager').CollaborationState = { sharedFileId: null, role: 'private', ready: false, connectedPeers: [], error: null };
  let operationActivation = 0;
  const collaborationManager: CollaborationManager = operationSync ? {
    async start(boardId) {
      const activation = ++operationActivation;
      const previous = operationProject; operationProject = boardId;
      if (previous && previous !== boardId) { operationService.active(previous)?.setPolling(false); await operationService.active(previous)?.setRealtime(false); }
      if (activation !== operationActivation) return;
      operationState = { sharedFileId: null, role: 'private', ready: false, connectedPeers: [], error: null };
      if (!await driveConnected()) { operationService.active(boardId)?.setPolling(false); await operationService.active(boardId)?.setRealtime(false); return; }
      if (activation !== operationActivation) return;
      try {
        const rx = await getRepository(), state = await driveSyncState.get(boardId);
        if (rx && !rx.operationSource.bindings.has(boardId) && await rx.getProject(boardId)
          && state.dirty && dirtyFlushAt(state) > Date.now()) return;
        const session = await operationService.open(boardId);
        if (activation !== operationActivation) return;
        // Platform account polling covers inactive boards as well. Per-edit
        // flush timers remain active independently of the selected board.
        const role = await operationService.role(boardId);
        if (activation !== operationActivation) return;
        operationState = { sharedFileId: (await operationService.layout(boardId)).folderId, role: role === 'revoked' ? 'private' : role, ready: true, connectedPeers: [], error: null };
        // Recover immediately on activation. Optional signaling failures never
        // prevent Drive delivery or postpone it until the next polling timer.
        void session.sync(false, false).catch(error => driveSyncState.markError(boardId, error instanceof Error ? error.message : 'Drive synchronization failed'));
        try { await session.setRealtime(realtimeEnabled); }
        catch (error) { if (activation === operationActivation) operationState = { ...operationState, error: error instanceof Error ? error.message : 'WebRTC unavailable' }; }
        if (activation !== operationActivation && operationProject !== boardId) { session.setPolling(false); await session.setRealtime(false); }
      } catch (error) { if (activation === operationActivation) operationState = { ...operationState, error: error instanceof Error ? error.message : 'Collaboration unavailable' }; throw error; }
    },
    async stop() { operationActivation++; const old = operationProject; operationProject = null; if (old) { operationService.active(old)?.setPolling(false); await operationService.active(old)?.setRealtime(false); } operationState = { ...operationState, sharedFileId: null, ready: false, connectedPeers: [] }; },
    async setEnabled(enabled) { realtimeEnabled = enabled; if (operationProject) await operationService.active(operationProject)?.setRealtime(enabled); },
    async refreshRole() {
      const boardId = operationProject, activation = operationActivation;
      if (!boardId || !await driveConnected() || activation !== operationActivation) return;
      const rx = await getRepository(), state = await driveSyncState.get(boardId);
      if (rx && !rx.operationSource.bindings.has(boardId) && await rx.getProject(boardId)
        && state.dirty && dirtyFlushAt(state) > Date.now()) return;
      const role = await operationService.role(boardId);
      if (activation !== operationActivation) return;
      operationState = { ...operationState, sharedFileId: (await operationService.layout(boardId)).folderId,
        ready: role !== 'revoked', role: role === 'revoked' ? 'private' : role };
      try {
        await operationService.active(boardId)?.setRealtime(role !== 'revoked' && realtimeEnabled);
        if (activation === operationActivation) operationState = { ...operationState, error: null };
      } catch (error) {
        if (activation === operationActivation) operationState = { ...operationState, error: error instanceof Error ? error.message : 'WebRTC unavailable' };
        throw error;
      }
    },
    state: () => ({ ...operationState }), requestContentKey: async () => false, ensureContentKey: async () => false
  } : legacyCollaborationManager;
  const usesIdentitySharing = async () => !operationSync && (await boardCollaboration.settings()).provider === "websocket";
  // Only the sharing UI dispatches here. Existing Drive persistence, discovery,
  // image transfer, deletion/ACL handling and default transport keep their service.
  const sharePermissions = {
    async myRole(board: string) { if (!await usesIdentitySharing()) return drivePermissions.myRole(board); await identitySharing.sync(board); return boardCollaboration.role(board); },
    async listCollaborators(board: string) { if (!await usesIdentitySharing()) return drivePermissions.listCollaborators(board); await identitySharing.sync(board); return identitySharing.collaborators(board); },
    async projectFileId(board: string) { return await usesIdentitySharing() ? ((await boardCollaboration.localBundle(board)) ? "signed-board-grant" : null) : drivePermissions.projectFileId(board); },
    async ensureSharedProject(board: string) { if (!await usesIdentitySharing()) return drivePermissions.ensureSharedProject(board); await identitySharing.sync(board, true); if (!await boardCollaboration.localBundle(board)) throw new Error("Connect Google to initialize account sharing"); return board; },
    async invite(board: string, email: string, role: "editor" | "viewer") { if (!await usesIdentitySharing()) return drivePermissions.invite(board, email, role); await identitySharing.invite(board, email, role); },
    async updateRole(board: string, email: string, role: "editor" | "viewer") { if (!await usesIdentitySharing()) return drivePermissions.updateRole(board, email, role); await identitySharing.invite(board, email, role); },
    async removeCollaborator(board: string, email: string) { if (!await usesIdentitySharing()) return drivePermissions.removeCollaborator(board, email); await identitySharing.remove(board, email); },
    async canManageMembership(board: string) { if (!await usesIdentitySharing()) return null; await identitySharing.sync(board); return boardCollaboration.ownsAuthority(board); }
  };
  // --- Sync v2 buffered realtime (server op buffer + leader snapshots) ----
  // Inert unless `start(boardId)` is called explicitly (realtime UI with the
  // websocket provider and a Drive realtime folder). The server re-checks the
  // editor grant on every call, so a mid-session role loss fails closed; the
  // runtime itself stops on demand.
  const bufferContentKeys = createContentKeyStore();
  const bufferRuntimes = new Map<string, BufferRuntime>();
  async function bufferHttpOrigin(): Promise<string | null> {
    try {
      const endpoint = new URL((await boardCollaboration.settings()).url);
      if (endpoint.protocol === "wss:") endpoint.protocol = "https:";
      if (endpoint.protocol === "ws:") endpoint.protocol = "http:";
      if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return null;
      return endpoint.origin;
    } catch { return null; }
  }
  const bufferRealtime = {
    active: () => [...bufferRuntimes.keys()],
    async start(boardId: string): Promise<boolean> {
      if (operationSync) return false;
      if (bufferRuntimes.has(boardId)) return true;
      if (!(await driveConnected())) return false;
      const origin = await bufferHttpOrigin();
      const security = origin ? await boardSecurityFor(boardId) : null;
      const role = security?.manifest.devices.find(device => device.deviceKeyId === security.signer.deviceKeyId)?.role;
      if (!origin || !security || (role !== "owner" && role !== "editor")) return false;
      const rx = await getRepository();
      if (!rx) return false;
      const drive = fetcher as unknown as DriveFetch;
      const store = createBufferSnapshotStore({ token: () => googleAuth.getAccessToken(), folderId: async () => await boardStore.boardFolder(boardId), fileName: BOARD_SNAPSHOT_FILENAME, fetcher: drive });
      const client = createBufferClient({ baseUrl: origin, authorizer: createGrantAuthorizer(boardSecurityFor, origin, drive) });
      const runtime = createBufferRuntime({
        boardId,
        // Server-side grant verification is authoritative; role revocation
        // mid-session surfaces as authentication failures, not local state.
        isWriter: () => true,
        contentKey: async () => {
          const key = await bufferContentKeys.get(boardId);
          if (key) return key;
          return await collaborationManager.requestContentKey() ? await bufferContentKeys.get(boardId) : undefined;
        },
        committedOps: async () => (await rx.journal.committedEntries())
          .filter(entry => entry.boardId === boardId)
          .map(entry => ({ opId: entry.id, document: entry.value as Record<string, unknown>, deleted: (entry.value as Record<string, unknown>)?.["deleted"] === true })),
        subscribe: next => rx.journal.subscribe(() => next()),
        client,
        drive: store
      });
      runtime.start();
      bufferRuntimes.set(boardId, runtime);
      return true;
    },
    async stop(boardId: string) {
      const runtime = bufferRuntimes.get(boardId);
      bufferRuntimes.delete(boardId);
      await runtime?.stop();
    }
  };
  return { operationService, driveSyncState, driveTombstones, projectSnapshots, driveTransport, googleDrive, authorizePrivatePersistence, privateErasureAccount, sharedProjects, drivePermissions, reestablishAuthorityFromDrive, sharePermissions, discoverSharedBoards, syncAccountPreferences, collaborationManager, bufferRealtime, experimentalEnrollment, renewBoardAuthorization, boardCollaboration: { ...boardCollaboration, identitySharing,
    async createCopy(projectId: string) { const rx = await getRepository(); if (!rx) throw new Error("Local RxDB is unavailable"); return createCollaborativeCopy(rx, projectId); },
    async identifyLegacyBoard(projectId: string) {
      if (!await legacyDriveTrust(projectId)) throw new Error("No legacy shared-board trust record for this board");
      const rx = await getRepository(); if (!rx) throw new Error("Local RxDB is unavailable");
      await identifyLegacyBoard(storage, projectId, { hasLegacyPin: await legacyHasPin(projectId), hasSharedProjectFile: true });
      return legacyTransitionFor(storage, projectId);
    },
    async legacyTransition(projectId: string) {
      if (!await legacyDriveTrust(projectId)) throw new Error("No legacy shared-board trust record for this board");
      const rx = await getRepository(); if (!rx) throw new Error("Local RxDB is unavailable");
      const existing = await legacyTransitionFor(storage, projectId);
      if (!existing) throw new Error("Identify the legacy board before its transition; trust records are never inferred");
      await identifyLegacyBoard(storage, projectId, { hasLegacyPin: await legacyHasPin(projectId), hasSharedProjectFile: true });
      return transitionLegacyBoard(storage, rx, projectId);
    },
    async legacyBoardTransitionState(projectId: string) { return legacyTransitionFor(storage, projectId); }
  } };
}
