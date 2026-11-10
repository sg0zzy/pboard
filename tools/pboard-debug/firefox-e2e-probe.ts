/**
 * Firefox E2E probe page entry: builds the *real* drive runtime, the real
 * collaboration manager, the real RxDB store, and the real debug SDK — the
 * same composition `src/background/index.ts` performs — behind a small
 * `window.e2e` surface the WebDriver script drives. Nothing here is a
 * substitute object: bridge events come out of the same instrumentation the
 * extension emits in production-DEV builds, which is the point of the test.
 */
import { createDriveRuntime } from "../../src/sync/runtime";
import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";
import { browser as extensionBrowser } from "../../src/platform/browser";
import { configureDebugForContext, emit as debugEmit, registerDebugStateInspection, roomViewSource } from "../../src/debug";
import { markBridgeWatching } from "../../src/sync/transportDiagnostics";
import { roomSnapshots } from "../../src/sync/realtimeDiagnostics";

const api = (globalThis as unknown as { chrome: typeof extensionBrowser }).chrome;
const config: { driveUrl: string } = await (await fetch(api.runtime.getURL("e2e-config.json"))).json();

let connected = false;
let identity = "owner@example.test";
const rx = await createRxRepository({ name: "pboarde2edebag", blobs: createIndexedDbBlobStore() });

const runtime = createDriveRuntime({
  auth: {
    getAccessToken: async () => {
      if (!connected) throw Error("No Google credential is available");
      return identity;
    },
    // The operation-sync build opens its relay room only with Drive identity
    // credentials; the fixture returns the same stub token (the loopback
    // relay admits by board grant, and no real Google is contacted).
    getDriveIdentityCredentials: async () => {
      if (!connected) throw Error("No Google credential is available");
      return { accessToken: identity, idToken: `fixture-id-token-for-${identity}` };
    },
    getConnectionState: async () => (connected ? "connected" : "disconnected"),
    isConfigured: () => true,
    connect: async () => {
      connected = true;
    },
    disconnect: async () => {
      connected = false;
    },
  },
  storage: api.storage.local,
  getRepository: async () => rx,
  // Same fixture posture as the proven smokes: googleapis requests answer
  // from the loopback Drive stub, so the Drive-connected operation-log path
  // runs with zero real Google contact.
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => {
    const text = String(input);
    if (text.startsWith("https://www.googleapis.com")) return fetch(text.replace("https://www.googleapis.com", config.driveUrl), init as never);
    return fetch(input as never, init as never);
  },
});

/** Enables the real bridge channel *before* any socket dials: same storage
 * key the shipping extension reads, then the real composition wiring. */
async function debugEnable(options: { clientId: string; url: string; token?: string }): Promise<{ clientId: string }> {
  await api.storage.local.set({
    pboardDebugBridge: { enabled: true, url: options.url, ...(options.token ? { token: options.token } : {}), clientId: options.clientId },
  });
  const handle = await configureDebugForContext("sidebar");
  if (!handle) throw new Error("debug bridge did not activate from storage settings");
  registerDebugStateInspection(handle, "sidebar", {
    listBoards: async () => (await rx.listProjects()).map((project) => project.id),
    countCards: async (boardId) => (await rx.listCards(boardId)).length,
    rooms: roomViewSource(roomSnapshots),
  });
  markBridgeWatching();
  debugEmit({ component: "lifecycle", event: "runtime.initialized", severity: "info", details: { context: "e2e-probe", clientId: handle.clientId } });
  return { clientId: handle.clientId };
}

Object.assign(globalThis, {
  e2e: {
    rx,
    runtime,
    debugEnable,
    // Fixture posture: the owner profile behaves as a signed-in account, so
    // authority adoption sees an examinable (stubbed, loopback-only) grant
    // mirror instead of refusing blind. No real Google contact.
    signIn() {
      connected = true;
    },
    signOut() {
      connected = false;
    },
    status: async () => (globalThis as unknown as { pboardDebug?: { status(): unknown } }).pboardDebug?.status?.() ?? null,
    async configure(url: string) {
      await runtime.boardCollaboration.configure({ provider: "websocket", url });
    },
    async create() {
      await rx.importProject({ id: "e2e-board", name: "E2E debug board", template: "project", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, []);
      return "e2e-board";
    },
    invite: () => runtime.boardCollaboration.initialize("e2e-board"),
    request: (invitation: string) => runtime.boardCollaboration.deviceRequest(invitation),
    approve: (request: string, deviceKeyId: string, role: "editor" | "viewer") => runtime.boardCollaboration.approve(request, deviceKeyId, role),
    trust: (bundle: string, authorityKeyId: string) => runtime.boardCollaboration.trust(bundle, authorityKeyId),
    start: () => runtime.collaborationManager.start("e2e-board"),
    stop: () => runtime.collaborationManager.stop(),
    peers: async () => (await runtime.collaborationManager.state()).connectedPeers.length,
    addCard: async (content: string) => await rx.addItem({ projectId: "e2e-board", content }),
    cards: async () => rx.listCards("e2e-board"),
  },
});
