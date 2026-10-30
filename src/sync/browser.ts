import { browser } from "../platform/browser";
import { createGoogleAuthProvider } from "./googleAuth";
import { createChromiumGoogleAuthProvider } from "./googleChromeAuth";
import { toFirefoxLoopbackRedirect } from "./redirectUri";
import { googleDriveConfig, type GoogleDriveBrowser, type GoogleDriveStage } from "./googleDriveConfig";
import type { RxRepository } from "../storage/rxdbRepository";
import { createDriveRuntime } from "./runtime";
import { PENDING_BOARD_LEAVES_KEY } from "./drivePermissions";
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
export const { operationService, driveSyncState, driveTombstones, projectSnapshots, driveTransport, googleDrive, authorizePrivatePersistence, privateErasureAccount, sharedProjects, drivePermissions, sharePermissions, discoverSharedBoards, syncAccountPreferences, collaborationManager, experimentalEnrollment, renewBoardAuthorization, boardCollaboration } = createDriveRuntime({ auth: googleAuth, storage: browser.storage.local, getRepository: () => rxRepositoryResolver(),
  hasSignalingHostPermission: (origin) => browser.permissions.contains({ origins: [origin] }),
  onReconciled: () => retryPendingLeaves() });

/**
 * Boards whose collaborator ACL revocation (self-removal after a non-owner
 * "delete") could not be delivered yet — e.g. the editor hid the board while
 * offline. Keyed by projectId in browser.storage.local so the intent survives
 * restarts; retried after every successful reconcile round.
 */
export { PENDING_BOARD_LEAVES_KEY };

/** Record a non-owner's departure and flush it immediately when possible. */
export async function leaveSharedBoard(projectId: string): Promise<void> {
  const stored = await browser.storage.local.get(PENDING_BOARD_LEAVES_KEY);
  const pending = { ...((stored[PENDING_BOARD_LEAVES_KEY] ?? {}) as Record<string, true>), [projectId]: true };
  await browser.storage.local.set({ [PENDING_BOARD_LEAVES_KEY]: pending });
  await retryPendingLeaves().catch(() => undefined);
}

export async function retryPendingLeaves(): Promise<void> {
  const stored = await browser.storage.local.get(PENDING_BOARD_LEAVES_KEY);
  const pending = { ...((stored[PENDING_BOARD_LEAVES_KEY] ?? {}) as Record<string, true>) };
  let changed = false;
  for (const projectId of Object.keys(pending)) {
    try {
      await drivePermissions.removeSelfFromProject(projectId);
      delete pending[projectId];
      changed = true;
    } catch {
      // Transport failure: keep the marker; the next reconcile retries.
    }
  }
  if (changed) await browser.storage.local.set({ [PENDING_BOARD_LEAVES_KEY]: pending });
}
