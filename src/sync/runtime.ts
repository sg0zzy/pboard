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
import { createSharedProjectSync } from "./sharedSync";
import { createAccountPreferenceSync } from "./accountPreferences";
import type { GoogleAuthProvider } from "./googleAuth";

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

  const collaborationManager: CollaborationManager = createCollaborationManager({
    getAccountId: connectedAccountId,
    myRole: async (projectId) => (await driveConnected() ? drivePermissions.myRole(projectId) : null),
    getSharedFileId: async (projectId) => (await driveConnected() ? drivePermissions.projectFileId(projectId) : null),
    bootstrapFromDrive,
    signalingFor: driveSignalingFor,
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
