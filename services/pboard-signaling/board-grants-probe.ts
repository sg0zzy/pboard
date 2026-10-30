/** Native-extension entry: real collaboration auth/guards/replication. The
 * separately labelled private conflict fixture constructs local causal branches. */
import { createDriveRuntime } from "../../src/sync/runtime";
import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";
import { makeChange } from "../../src/storage/changeJournal";
import { verifyPendingAdmission } from "../../src/collab/security/journalProof";
import { pendingHeads } from "../../src/storage/changeJournal";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConflictResolutionControls } from "../../src/sidebar/components/ConflictResolutionControls";
import "../../src/sidebar/styles/index.css";
const api = (globalThis as any).chrome;
const config = await (await fetch(api.runtime.getURL("secure-config.json"))).json();
const stats = { frames: 0, leaked: false, google: 0, grantHttp: 0, sdpShape: [] as string[], historyOps: {} as Record<string, number> };
const nativeChannelSend = RTCDataChannel.prototype.send;
RTCDataChannel.prototype.send = function(data: any) {
  if (typeof data === 'string') {
    try { const frame = JSON.parse(data); if (frame.kind === 'pboard-history' && typeof frame.op === 'string') stats.historyOps[frame.op] = (stats.historyOps[frame.op] ?? 0) + 1; } catch { /* No payload logging. */ }
  }
  return nativeChannelSend.call(this, data);
};
const Native = WebSocket;
class Audited extends Native {
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    stats.frames++; if (typeof value === "string" && /PRIVATE_BOARD_TEXT|data:image|"documents"/.test(value)) stats.leaked = true;
    if (typeof value === "string") {
      const message = JSON.parse(value); const sdp = message.data?.payload?.signal?.sdp;
      // Test-only structural names, never SDP values/addresses or board data.
      if (typeof sdp === "string") stats.sdpShape = sdp.split(/\r?\n/).filter(Boolean).map(line => line.startsWith("a=") ? `a=${line.slice(2).split(":")[0]}` : `${line.slice(0,2)}(${line.split(" ").length} fields)`);
    }
    super.send(value);
  }
}
Object.assign(globalThis, { WebSocket: Audited });
let connected = false;
let identity = "owner@example.test";
let rx: Awaited<ReturnType<typeof createRxRepository>>;
const runtime = createDriveRuntime({
  auth: { getAccessToken: async () => { if (!connected) throw Error("No Google credential is available"); return identity; }, getConnectionState: async () => connected ? "connected" : "disconnected", isConfigured: () => true, connect: async () => { connected = true; }, disconnect: async () => { connected = false; } },
  storage: api.storage.local, getRepository: async () => rx,
  fetcher: async (input, init) => {
    const text = String(input);
    if (text.startsWith("https://www.googleapis.com")) {
      stats.google++; if (!connected) throw Error("Collaboration attempted to access Google");
      if (text.includes("/permissions")) throw Error("Standalone collaboration must not consult Drive ACLs");
      return fetch(text.replace("https://www.googleapis.com", config.driveUrl), init);
    }
    stats.grantHttp++;
    if (/PRIVATE_BOARD_TEXT|data:image|"documents"/.test(String(init?.body))) stats.leaked = true;
    const response = await fetch(input, init);
    if (/PRIVATE_BOARD_TEXT|data:image|"documents"/.test(await response.clone().text())) stats.leaked = true;
    return response;
  }
});
rx = await createRxRepository({ name: "pboardstandalonegranttest", blobs: createIndexedDbBlobStore() });
Object.assign(window, { secureProbe: { rx, runtime, stats, useIdentity: (email: string) => { identity = email; connected = true; }, connectDrive: async () => { connected = true; await runtime.authorizePrivatePersistence(); },
  async pendingAdmissionDiagnostics(board: string) {
    const entries = await rx.journal.entries.where('boardId').equals(board).toArray();
    return Promise.all(pendingHeads((await rx.journal.pendingEdits.toArray()).filter(edit => edit.boardId === board)).map(async edit => {
      const candidates = entries.filter(entry => (entry.value._sec as any)?.provenance?.operationId === `pending:${edit.id}`);
      const checks = await Promise.all(candidates.map(async entry => {
        try { await verifyPendingAdmission(rx.db[edit.base.collection], edit, entry); return 'verified'; }
        catch (error) { return error instanceof Error ? error.message : 'verification failed'; }
      }));
      return { collection: edit.base.collection, candidates: candidates.length, checks };
    }));
  },
  async showConflictFixture(existing?: { boardId: string; cardId: string }) {
    // Private, locally constructed branch fixture. It does not simulate receiving
    // authenticated causal history over either production transport.
    let ids = existing;
    if (!ids) {
      const board = await rx.createProject("Native conflict recovery", "project");
      const card = await rx.addItem({ projectId: board.id, content: "Native common ancestor" });
      const target = { boardId: board.id, collection: "cards" as const, documentId: card.id };
      const ancestor = (await rx.reconciliation.inspect(target)).variants[0];
      await rx.updateItem(card.id, { content: "Native local variant" });
      const branch = await makeChange({ ...target, ancestry: "known", parents: [ancestor.id], value: { ...ancestor.value, content: "Native other variant" } });
      await rx.reconciliation.receive([branch], async () => true);
      ids = { boardId: board.id, cardId: card.id };
    }
    const boardId = ids.boardId;
    const list = async () => (await rx.listConflicts()).filter(c => c.boardId === boardId);
    const container = document.createElement("div"); document.body.append(container);
    createRoot(container).render(createElement(ConflictResolutionControls, { api: {
      listConflicts: list, saveConflictDraft: rx.saveConflictDraft, resolveConflict: rx.resolveConflict, getImage: rx.getImage,
      subscribeConflicts: async (listener, onError) => {
        let active = true, generation = 0;
        const refresh = () => { const current = ++generation; void list().then(records => { if (active && current === generation) listener(records); }).catch(onError); };
        const stop = rx.journal.subscribe(refresh); refresh(); return () => { active = false; stop(); };
      }
    } }));
    return ids;
  },
  async authorityState(board: string) { return { ownsAuthority: await runtime.boardCollaboration.ownsAuthority(board), bundle: await runtime.boardCollaboration.localBundle(board), security: await runtime.boardCollaboration.security(board) }; },
  async create() { await rx.importProject({ id: "standalone-board", name: "PRIVATE_BOARD_TEXT board name", template: "project", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, []); },
  async configure(url: string) { await runtime.boardCollaboration.configure({ provider: "websocket", url }); },
  async start() { await runtime.collaborationManager.start("standalone-board"); }, async stop() { await runtime.collaborationManager.stop(); } } });
