import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createCollaborationManager } from "../../src/collab/manager";
import { createDriveSignaling } from "../../src/collab/signaling";
import { createDrivePermissionTransport, createDriveSignalStore } from "../../src/sync/drivePermissions";
import { createDriveTransport } from "../../src/sync/driveTransport";
import { createAccountSignalStore } from "../../src/sync/accountSignaling";

// Both isolated profiles represent the same owner. Only Drive HTTP is faked;
// IndexedDB, the WebRTC connection and RxDB replication run in native Chromium.
const auth = {
  getAccessToken: async () => "test", getConnectionState: async () => "connected" as const,
  isConfigured: () => true, connect: async () => {}, disconnect: async () => {}
};
const cloudFetch: typeof fetch = (input, init) =>
  fetch(String(input).replace("https://www.googleapis.com", location.origin), init);
const transport = createDrivePermissionTransport(auth, cloudFetch);
const accountTransport = createDriveTransport(auth, cloudFetch, "account-signal-");
const peerId = crypto.randomUUID();
const sharedProjects = {
  get: async () => ({ folderId: "folder", projectFileId: "shared", realtimeFolderId: "room" }),
  set: async () => {}, delete: async () => {}
};
const rx = await createRxRepository({ name: "livebrowsersmoke" });
const project = {
  id: "shared-project", name: "Live test", template: "project" as const, revision: 1,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
};
await rx.importProject(project, []);
await rx.importProject({ ...project, id: "private-project", name: "Private board" }, []);
const manager = createCollaborationManager({
  myRole: async (id) => id === project.id ? "owner" : null,
  getSharedFileId: async (id) => id === project.id ? "shared" : null,
  bootstrapFromDrive: async () => false, getRepository: async () => rx, getAccountId: async () => "account-A",
  signalingFor: (topic) => createDriveSignaling({ pollMs: 150, store: topic.startsWith("pboard-account-")
    ? createAccountSignalStore({ transport: accountTransport, account: "account-A", peerId })
    : createDriveSignalStore({
      transport, sharedProjects, projectId: project.id, peerId, topic, realtimeFolderId: async () => "room"
    }) })
});
const testWindow = window as typeof window & {
  probe: { rx: typeof rx; manager: typeof manager; peerId: string; errors: string[]; done: boolean }
};
testWindow.probe = { rx, manager, peerId, errors: [], done: false };
manager.start(project.id).then(() => { testWindow.probe.done = true; })
  .catch((error) => testWindow.probe.errors.push(String(error)));
