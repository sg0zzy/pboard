// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), configure: vi.fn(), stop: vi.fn(async () => {}), initialize: vi.fn() }));
vi.mock("../src/platform/browser", () => ({ browser: { permissions: { request: mocks.request } } }));
vi.mock("../src/storage/browser", () => ({ repository: {} }));
vi.mock("../src/sync/browser", () => ({ healRelay: async () => "idle:no-room", boardCollaboration: { settings: async () => ({ provider: "drive", url: "wss://pboard.cecosl.ovh/ws" }), configure: mocks.configure, initialize: mocks.initialize, ownsAuthority: async () => false, identitySharing: { sync: async () => ({ email: "", boards: [], ready: [] }), collaborators: async () => [] }, pairing: { pending: async () => null } }, collaborationManager: { stop: mocks.stop, state: () => ({ready:false,error:null,connectedPeers:[],role:"private"}) },
  // The panel's account section reads the account channel; these scenarios are
  // about the rendezvous opt-in, so it reports a healthy channel and offers
  // nothing to do.
  accountChannel: { status: () => ({ account: null, state: "connected", reason: "ready", authority: { state: "adopted", reason: "the account authority pin was reused" }, outbox: 0 }), subscribe: () => () => {}, repinPublishedAuthority: async () => { throw new Error("unused"); } },
  // The retention disclosure nested in these controls resolves its owner
  // through these; the tests below are about pairing, so nobody is the owner.
  googleDrive: { getConnectionState: async () => "disconnected" },
  operationService: { subscribeRole: async (_: string, __: (owner: boolean) => void) => () => {}, role: async () => "editor", previewGardening: async () => { throw new Error("unused"); }, garden: async () => { throw new Error("unused"); } } }));
import { BoardCollaborationControls } from "../src/sidebar/components/BoardCollaborationControls";
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubEnv("DEV", false); vi.clearAllMocks(); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const button = (label: string) => [...node.querySelectorAll("button")].find(button => button.textContent === label)!;
it("exposes production opt-in, requests only the selected host on a user gesture, and preserves Drive default until consent", async () => {
  let resolve!: (value: boolean) => void; mocks.request.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
  const changed = vi.fn(); await act(async () => { root.render(<BoardCollaborationControls projectId="board" onChanged={changed} />); });
  expect(node.textContent).toContain("Drive (default)");
  act(() => button("Enable WebSocket collaboration").click());
  expect(mocks.request).toHaveBeenCalledWith({ origins: ["https://pboard.cecosl.ovh/*"] });
  expect(mocks.configure).not.toHaveBeenCalled();
  await act(async () => resolve(true));
  expect(mocks.configure).toHaveBeenCalledWith({ provider: "websocket", url: "wss://pboard.cecosl.ovh/ws" });
  expect(changed).toHaveBeenCalledOnce();
  expect(button("Use Drive signaling")).toBeDefined();
  expect(node.textContent).toContain("Board access is managed through Google Drive sharing.");
});
it("keeps settings untouched when the browser refuses the rendezvous permission", async () => {
  mocks.request.mockResolvedValue(false);
  const changed = vi.fn(); await act(async () => { root.render(<BoardCollaborationControls projectId="board" onChanged={changed} />); });
  await act(async () => button("Enable WebSocket collaboration").click());
  expect(mocks.configure).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  expect(node.textContent).toContain("permission was not granted");
});
it("says what is outstanding and returns control when a queued command cannot finish", async () => {
  // The manager serialises commands, so a stop() parked behind a stalled WebRTC
  // negotiation used to disable this panel forever with no message at all.
  vi.useFakeTimers();
  mocks.request.mockResolvedValue(true);
  mocks.stop.mockReturnValue(new Promise<void>(() => {}));
  const changed = vi.fn();
  try {
    await act(async () => { root.render(<BoardCollaborationControls projectId="board" onChanged={changed} />); });
    await act(async () => { button("Enable WebSocket collaboration").click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(node.textContent).toContain("still processing an earlier command");
    expect(mocks.configure).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    expect(button("Enable WebSocket collaboration").disabled).toBe(false);
  } finally {
    vi.useRealTimers();
    mocks.stop.mockResolvedValue(undefined);
  }
});
