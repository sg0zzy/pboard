import { createDriveTransport } from "./driveTransport";
import { createGoogleDriveProvider } from "./googleDriveProvider";
import { createBackendProjectSnapshotStore, deserializeProjectSnapshot, serializeProjectSnapshot } from "./snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore } from "./state";
import {
  createDrivePermissionTransport,
  createDrivePermissionService,
  createDriveSignalStore,
  type DriveSharedProjectRecord,
  type DriveSharedProjectStore
} from "./drivePermissions";
import { createCollaborationManager, type CollaborationManager } from "../collab/manager";
import { createDriveSignaling, type PboardSignaling } from "../collab/signaling";
import type { KeyValueStorage } from "../storage/repository";
import type { RxRepository } from "../storage/rxdbRepository";
import { hashBlob, imageToBlob } from "../storage/blobStore";
import { createAccountSignalStore } from "./accountSignaling";
import { createSharedBoardDiscovery } from "./sharedDiscovery";
import { createSharedProjectSync, createSharedProjectRefresh } from "./sharedSync";
import { createAccountPreferenceSync } from "./accountPreferences";
import type { GoogleAuthProvider } from "./googleAuth";
import { ensureDeviceKey, publicKeyFingerprint } from "../collab/security/keys";
import { verifyManifest, acceptManifest, createInMemoryManifestEpochStore } from "../collab/security/manifest";
import { parseStrictJson } from "../collab/security/canonical";
import { installCollectionMutationGuard, createMutationReplayCache, verifyMutation, type MutationGuardInstall, type ForkGuard } from "../collab/security/mutation";
import type { CollaborationSecurityOptions } from "../collab/manager";

/** Platform-independent Drive and WebRTC wiring shared by browser and Android. */
export function createDriveRuntime({ auth: googleAuth, storage, getRepository }: {
  auth: GoogleAuthProvider; storage: KeyValueStorage; getRepository: () => Promise<RxRepository | null>;
}) {
  const driveSyncState = createDriveSyncStateStore(storage);
  const driveTombstones = createDriveTombstoneStore(storage);
  const isSharedProject = async (projectId: string) => Boolean((await sharedProjects.get(projectId)).projectFileId);
  const projectSnapshots = createBackendProjectSnapshotStore(storage, () => getRepository(),
    async (projectId) => !await isSharedProject(projectId));
  const driveTransport = createDriveTransport(googleAuth);
  const googleDrive = createGoogleDriveProvider({
    auth: googleAuth,
    transport: driveTransport,
    snapshots: projectSnapshots,
    syncState: driveSyncState,
    tombstones: driveTombstones,
    beforeReconcile: () => discoverSharedBoardSnapshots(),
    isSharedProject,
    syncSharedProject: (projectId, changeToken) => syncSharedProject(projectId, changeToken),
    syncPreferences: () => syncAccountPreferences(),
    isDeletedProject: async (projectId) => await (await getRepository())?.isDeletedProject(projectId) ?? false
  });

  const SHARED_PROJECTS_KEY = "pboardDriveSharedProjects";

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
          realtimeFolderId: record?.realtimeFolderId ?? null
        };
      },
      async set(projectId, patch) {
        const all = await readAll();
        const existing = all[projectId] ?? { folderId: null, projectFileId: null, realtimeFolderId: null };
        all[projectId] = { ...existing, ...patch };
        await writeAll(all);
      },
      async delete(projectId) {
        const all = await readAll();
        delete all[projectId];
        await writeAll(all);
      }
    };
  }

  const sharedProjects = createSharedProjectStore(storage);

  const drivePermissions = createDrivePermissionService({
    transport: createDrivePermissionTransport(googleAuth),
    sharedProjects,
    readSnapshot: async (projectId) => {
      const rx = await getRepository();
      if (!rx) throw new Error("Sharing requires the RxDB storage backend");
      const { project, items } = await rx.exportProject(projectId);
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
      Boolean(await (await getRepository())?.isDeletedProject(projectId))
  });

  async function discoverSharedBoards() {
    await syncAccountPreferences();
    await discoverSharedBoardSnapshots();
  }

  /**
   * Live collaboration for shared projects, driven by the RxDB repository.
   *
   * Each platform runtime owns one manager. The App calls `start(projectId)`
   * when a project becomes current and `stop()` on unmount; `start()` stops the
   * previous project first. Private projects have no content replication pool;
   * an independent account room can still synchronize the project list order.
   *
   * Signaling is Drive-hosted (ephemeral per-peer records in the shared project's
   * `realtime/` folder). Each pool's connection handler owns one signaling
   * instance. Account-order signaling instead uses private appDataFolder records;
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
        transport: createDriveTransport(googleAuth, fetch, "account-signal-"),
        account, peerId: collaborationPeerId
      }) });
    }
    const projectId = topic.split("-").slice(2, -1).join("-");
    const store = createDriveSignalStore({
      transport: createDrivePermissionTransport(googleAuth),
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

  async function resolveManifest(
    pin: SecurityPins[string],
    collection: "cards" | "projects" | "accountOrder",
    identity: { boardId: string; driveProjectFileId: string; driveFolderId: string } | null
  ): Promise<CollaborationSecurityOptions | null> {
    const key = await ensureDeviceKey(`${pin.kind}-device:${pin.scope}`);
    // Fetch the newest manifest for the room: board manifests live in the shared
    // folder; account manifests in appDataFolder.
    const raw = pin.kind === "board" && identity
      ? await readBoardManifest(identity.driveProjectFileId, identity.driveFolderId)
      : await readAccountManifest(pin.scope);
    if (!raw) return null;
    try {
      const manifest = await verifyManifest(parseStrictJson(raw), pin.authorityPublicKey, pin.authorityKeyId);
      if (pin.kind === "board" && identity) {
        if (manifest.boardId !== identity.boardId || manifest.driveProjectFileId !== identity.driveProjectFileId || manifest.driveFolderId !== identity.driveFolderId) return null;
      }
      if (pin.kind === "account" && manifest.boardId !== `account:${pin.scope}`) return null;
      const accepted = await acceptManifest(manifest, manifestEpochStore, Date.now());
      void accepted;
      return {
        signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId },
        manifest,
        boardId: manifest.boardId,
        ownSessionId: collaborationPeerId
      };
    } catch {
      // An unverified or unverifiable manifest must not produce a security context.
      return null;
    }
  }

  async function boardSecurityFor(projectId: string): Promise<CollaborationSecurityOptions | null> {
    if (!await driveConnected()) return null;
    const pins = await readPins();
    const pin = pins[`board:${projectId}`];
    if (!pin) return null; // No pinned authority: stay offline rather than fall back.
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
    const pins = await readPins();
    const pin = pins[`account:${account}`];
    if (!pin) return null;
    return resolveManifest(pin, "accountOrder", null);
  }

  // Manifest fetch helpers: board manifests are stored as signed envelope JSON.
  async function readBoardManifest(projectFileId: string, folderId: string): Promise<string | null> {
    const transport = createDrivePermissionTransport(googleAuth);
    const name = "pboard-manifest.json";
    const direct = await transport.findFile(name, folderId).catch(() => null);
    if (direct) return transport.downloadFileOrNull(direct.id);
    void projectFileId;
    return null;
  }

  async function readAccountManifest(account: string): Promise<string | null> {
    const transport = createDriveTransport(googleAuth, fetch, "pboard-account-manifest-");
    const file = await transport.findProjectFile(account).catch(() => null);
    return file ? transport.download(file.id).catch(() => null) : null;
  }

  const manifestEpochStore = createInMemoryManifestEpochStore();

  // Per-project mutation verification (protocol 2): a document that arrives
  // through any persistence path for this project must carry valid signed
  // provenance or the write is rejected with a 422-equivalent storage error.
  const activeGuards = new Map<string, { install: MutationGuardInstall; projectId: string }>();

  async function installBoardMutationGuard(projectId: string): Promise<MutationGuardInstall | null> {
    const securityContext = await boardSecurityFor(projectId);
    if (!securityContext) return null;
    const rx = await getRepository();
    if (!rx) return null;
    const replay = createMutationReplayCache();
    const guardFor = async (document: Record<string, unknown>): Promise<ForkGuard | null> => {
      if (typeof document.projectId !== "string" || document.projectId !== projectId) return null;
      return {
        verify: async (document) => {
          try {
            await verifyMutation(document, {
              manifest: securityContext.manifest,
              boardId: securityContext.boardId,
              collection: "cards"
            }, replay);
            return "accept";
          } catch {
            return "reject";
          }
        }
      };
    };
    const installs: MutationGuardInstall[] = [];
    const cardsGuard = installCollectionMutationGuard(rx.db.cards as never, guardFor);
    const projectsGuard = installCollectionMutationGuard(rx.db.projects as never, async (document) => {
      if (typeof document.id !== "string" || document.id !== projectId) return null;
      return {
        verify: async (document) => {
          try {
            await verifyMutation(document, {
              manifest: securityContext.manifest,
              boardId: securityContext.boardId,
              collection: "projects", now: () => Date.now()
            }, replay);
            return "accept";
          } catch {
            return "reject";
          }
        }
      };
    });
    installs.push(cardsGuard, projectsGuard);
    const install: MutationGuardInstall = {
      projectId,
      async uninstall() { for (const entry of installs) await entry.uninstall(); }
    };
    activeGuards.set(projectId, { install, projectId });
    return install;
  }

  async function removeBoardMutationGuard(projectId: string): Promise<void> {
    const active = activeGuards.get(projectId);
    if (!active) return;
    activeGuards.delete(projectId);
    await active.install.uninstall();
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

  async function connectedAccountId(): Promise<string | null> {
    if (!await driveConnected()) return null;
    const identity = await createDrivePermissionTransport(googleAuth).currentIdentity();
    if (!identity) throw new Error("Could not identify the Google Drive account");
    return hashBlob(new Blob([identity.email.trim().toLowerCase()]));
  }

  const syncAccountPreferences = createAccountPreferenceSync({
    transport: createDriveTransport(googleAuth, fetch, "account-preferences-"),
    getAccountId: connectedAccountId,
    getRepository: () => getRepository()
  });

  const refreshFromDrive = createSharedProjectRefresh({
    connected: driveConnected, permissions: drivePermissions,
    getRepository: () => getRepository(),
    isDeleted: async (projectId) => Boolean(await driveTombstones.get(projectId)) ||
      Boolean(await (await getRepository())?.isDeletedProject(projectId))
  });

  const collaborationManager: CollaborationManager = createCollaborationManager({
    getAccountId: connectedAccountId,
    myRole: async (projectId) => (await driveConnected() ? drivePermissions.myRole(projectId) : null),
    getSharedFileId: async (projectId) => (await driveConnected() ? drivePermissions.projectFileId(projectId) : null),
    bootstrapFromDrive,
    refreshFromDrive,
    signalingFor: driveSignalingFor,
    boardSecurity: boardSecurityFor,
    accountSecurity: accountSecurityFor,
    installMutationGuard: (projectId) => installBoardMutationGuard(projectId),
    removeMutationGuard: (projectId) => removeBoardMutationGuard(projectId),
    imageTransport: {
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
    },
    getRepository: () => getRepository()
  });

  return { driveSyncState, driveTombstones, projectSnapshots, driveTransport, googleDrive, sharedProjects, drivePermissions, discoverSharedBoards, syncAccountPreferences, collaborationManager };
}
