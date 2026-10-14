import { browser } from "../platform/browser";
import { createGoogleAuthProvider } from "./googleAuth";
import { createChromiumGoogleAuthProvider } from "./googleChromeAuth";
import { toFirefoxLoopbackRedirect } from "./redirectUri";
import { googleDriveConfig, type GoogleDriveBrowser, type GoogleDriveStage } from "./googleDriveConfig";
import type { RxRepository } from "../storage/rxdbRepository";
import { createDriveRuntime } from "./runtime";
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

export const SHARED_PROJECTS_KEY = "pboardDriveSharedProjects";
export const { driveSyncState, driveTombstones, projectSnapshots, driveTransport, googleDrive, sharedProjects, drivePermissions, discoverSharedBoards, syncAccountPreferences, collaborationManager } = createDriveRuntime({ auth: googleAuth, storage: browser.storage.local, getRepository: () => rxRepositoryResolver() });
