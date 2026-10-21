/** Real extension API/storage, runtime, enrollment, guards, WebRTC and RxDB.
 * Only the external Google HTTP transport is a local deterministic fixture. */
import { createDriveRuntime } from "../../src/sync/runtime";
import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";
const chromeApi = (globalThis as any).chrome;
const config = await (await fetch(chromeApi.runtime.getURL("secure-config.json"))).json();
let fixtureEmail = "owner@example.test";
const stats = { frames: 0, leaked: false, errors: [] as string[] };
const NativeWebSocket = WebSocket;
class AuditedWebSocket extends NativeWebSocket {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    stats.frames++;
    if (typeof data === "string" && (data.includes("M02_PRIVATE_CONTENT") || data.includes("data:image/") || data.includes('"documents"') || data.includes('"method"'))) stats.leaked = true;
    super.send(data);
  }
}
Object.assign(globalThis, { WebSocket: AuditedWebSocket });
let rx: Awaited<ReturnType<typeof createRxRepository>>;
const runtime = createDriveRuntime({
  auth: { getAccessToken: async () => fixtureEmail, getConnectionState: async () => "connected", isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
  storage: chromeApi.storage.local,
  getRepository: async () => rx,
  fetcher: (input, init) => fetch(String(input).replace("https://www.googleapis.com", config.driveUrl), init)
});
rx = await createRxRepository({ name: "pboardsecureexperiment", blobs: createIndexedDbBlobStore() });
await rx.importProject({ id: "m02-board", name: "M02 secure test", template: "project", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, []);
await rx.importProject({ id: "private-board", name: "Private project", template: "project", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, []);
const enrollment = runtime.experimentalEnrollment!;
Object.assign(window, { secureProbe: { rx, runtime, enrollment, stats, useIdentity(email: string) { fixtureEmail = email; }, async start() { await runtime.collaborationManager.start("m02-board"); }, async stop() { await runtime.collaborationManager.stop(); } } });
