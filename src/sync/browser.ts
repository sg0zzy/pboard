import { browser } from "../platform/browser";
import { createDriveTransport } from "./driveTransport";
import { createGoogleAuthProvider } from "./googleAuth";
import { createChromiumGoogleAuthProvider } from "./googleChromeAuth";
import { createGoogleDriveProvider } from "./googleDriveProvider";
import { createBackendProjectSnapshotStore } from "./snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore } from "./state";
import { toFirefoxLoopbackRedirect } from "./redirectUri";
import { googleDriveConfig, type GoogleDriveBrowser, type GoogleDriveStage } from "./googleDriveConfig";
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
