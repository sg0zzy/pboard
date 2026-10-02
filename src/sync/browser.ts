import { browser } from "../platform/browser";
import { createDriveTransport } from "./driveTransport";
import { createGoogleAuthProvider } from "./googleAuth";
import { createChromiumGoogleAuthProvider } from "./googleChromeAuth";
import { createGoogleDriveProvider } from "./googleDriveProvider";
import { createBackendProjectSnapshotStore, deserializeProjectSnapshot, serializeProjectSnapshot } from "./snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore } from "./state";
import { toFirefoxLoopbackRedirect } from "./redirectUri";
import { googleDriveConfig, type GoogleDriveBrowser, type GoogleDriveStage } from "./googleDriveConfig";
import { createDrivePermissionTransport, createDrivePermissionService, createDriveSignalStore, type DrivePermissionService, type DriveSharedProjectRecord, type DriveSharedProjectStore } from "./drivePermissions";
import { createCollaborationManager } from "../collab/manager";
import { createDriveSignaling, createMemorySignalingScope } from "../collab/signaling";
import type { KeyValueStorage } from "../storage/repository";
import type { RxRepository } from "../storage/rxdbRepository";
const extensionOrigin = browser.runtime.getURL("");
const isFirefox = extensionOrigin.startsWith("moz-extension://");
const browserKey: GoogleDriveBrowser = isFirefox ? "firefox" : "chromium";
const stage: GoogleDriveStage = import.meta.env.DEV ? "dev" : "production";
export const GOOGLE_DRIVE_CLIENT_ID = googleDriveConfig[browserKey][stage].trim();
const GOOGLE_DRIVE_CLIENT_SECRET = isFirefox
  ? (import.meta.env.VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET ?? "").trim()
  : "";

function firefoxRedirectUri(): string {
  const generated = browser.identity.getRedirectURL("google-drive");
  return toFirefoxLoopbackRedirect(generated);
}

export const driveSyncState = createDriveSyncStateStore(browser.storage.local);
export const driveTombstones = createDriveTombstoneStore(browser.storage.local);
export const googleAuth = isFirefox
  ? createGoogleAuthProvider({
      clientId: GOOGLE_DRIVE_CLIENT_ID,
      clientSecret: GOOGLE_DRIVE_CLIENT_SECRET,
      identity: browser.identity,
      storage: browser.storage.local,
      redirectUri: firefoxRedirectUri
    })
  : createChromiumGoogleAuthProvider({
      clientId: GOOGLE_DRIVE_CLIENT_ID,
      identity: browser.identity
    });
let rxRepositoryResolver: () => Promise<RxRepository | null> = async () => null;
export function registerRxRepositoryResolver(resolver: () => Promise<RxRepository | null>) {
  rxRepositoryResolver = resolver;
}
export const projectSnapshots = createBackendProjectSnapshotStore(browser.storage.local, () => rxRepositoryResolver());
export const driveTransport = createDriveTransport(googleAuth);
export const googleDrive = createGoogleDriveProvider({
  auth: googleAuth,
  transport: driveTransport,
  snapshots: projectSnapshots,
  syncState: driveSyncState,
  tombstones: driveTombstones
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

export const sharedProjects = createSharedProjectStore(browser.storage.local);

const permissionTransport = createDrivePermissionTransport(googleAuth);
export const drivePermissions = createDrivePermissionService({
  transport: permissionTransport,
  sharedProjects,
  readSnapshot: async (projectId) => {
    const rx = await rxRepositoryResolver();
    if (!rx) throw new Error("Sharing requires the RxDB storage backend");
    const { project, items } = await rx.exportProject(projectId);
    return serializeProjectSnapshot(project, items);
  }
});

/**
 * One stable peer id per session/tab. Each tab gets its own signaling file in
 * the shared project's realtime/ folder, so concurrent tabs never write the
 * same file. A reloaded tab gets a fresh id; the old id's file goes stale past
 * the presence TTL and is filtered out of the roster.
 */
const sessionPeerId = crypto.randomUUID();

/** `pboard-collab-<projectId>-<collection>` → the project it belongs to. */
const TOPIC_REGEX = /^pboard-collab-(.+)-(cards|projects)$/;
function parseCollabTopic(
  topic: string,
): { projectId: string; collection: "cards" | "projects" } | null {
  const match = TOPIC_REGEX.exec(topic);
  if (!match) return null;
  return { projectId: match[1], collection: match[2] as "cards" | "projects" };
}

const collaborationManager = createCollaborationManager({
  myRole: (projectId) => drivePermissions.myRole(projectId),
  getSharedFileId: (projectId) => drivePermissions.projectFileId(projectId),
  bootstrapFromDrive: async (projectId) => {
    const rx = await rxRepositoryResolver();
    if (!rx) return false;
    try {
      const { project, items } = deserializeProjectSnapshot(await drivePermissions.readSharedSnapshot(projectId));
      await rx.importProject(project, items);
      return true;
    } catch {
      // No (valid) shared snapshot yet, or Drive unavailable. Nothing to import;
      // live replication still pulls whatever the owner has published.
      return false;
    }
  },
  signalingFor: (topic) => {
    const parsed = parseCollabTopic(topic);
    if (!parsed) {
      // A topic we don't recognize joins an inert in-process room instead of
      // hitting Drive. The manager only ever passes well-formed topics, so this
      // is purely defensive.
      return createMemorySignalingScope().create(topic);
    }
    return createDriveSignaling({
      store: createDriveSignalStore({
        transport: permissionTransport,
        sharedProjects,
        projectId: parsed.projectId,
        peerId: sessionPeerId,
        topic,
        realtimeFolderId: () => drivePermissions.realtimeFolderId(parsed.projectId),
      }),
    });
  },
  getRepository: rxRepositoryResolver,
});

export { collaborationManager };

/**
 * Imports any shared project this account can access (discovered from Drive) that
 * has no local copy yet, so shared projects appear in the project picker. Safe
 * to call on every load; only missing projects are imported. Returns the ids
 * that were imported.
 */
export async function loadSharedProjects(): Promise<string[]> {
  const rx = await rxRepositoryResolver();
  if (!rx) return [];
  const imported: string[] = [];
  for (const entry of await drivePermissions.discoverSharedProjects()) {
    const existing = await rx.getProject(entry.projectId);
    if (existing) continue;
    try {
      const { project, items } = deserializeProjectSnapshot(
        await drivePermissions.readSharedSnapshot(entry.projectId),
      );
      await rx.importProject(project, items);
      imported.push(entry.projectId);
    } catch {
      // A project whose snapshot can't be bootstrapped is skipped rather than
      // failing the whole batch.
    }
  }
  return imported;
}
