import { browser } from "../platform/browser";
import { createDriveTransport } from "./driveTransport";
import { createGoogleAuthProvider } from "./googleAuth";
import { createChromiumGoogleAuthProvider } from "./googleChromeAuth";
import { createGoogleDriveProvider } from "./googleDriveProvider";
import { createBackendProjectSnapshotStore, serializeProjectSnapshot } from "./snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore } from "./state";
import { toFirefoxLoopbackRedirect } from "./redirectUri";
import { googleDriveConfig, type GoogleDriveBrowser, type GoogleDriveStage } from "./googleDriveConfig";
import { createDrivePermissionTransport, createDrivePermissionService, type DrivePermissionService, type DriveSharedProjectRecord, type DriveSharedProjectStore } from "./drivePermissions";
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

export const drivePermissions = createDrivePermissionService({
  transport: createDrivePermissionTransport(googleAuth),
  sharedProjects,
  readSnapshot: async (projectId) => {
    const rx = await rxRepositoryResolver();
    if (!rx) throw new Error("Sharing requires the RxDB storage backend");
    const { project, items } = await rx.exportProject(projectId);
    return serializeProjectSnapshot(project, items);
  }
});
