// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), configure: vi.fn(), stop: vi.fn(async () => {}), initialize: vi.fn() }));
vi.mock("../src/platform/browser", () => ({ browser: { permissions: { request: mocks.request } } }));
vi.mock("../src/storage/browser", () => ({ repository: {} }));
vi.mock("../src/sync/browser", () => ({ boardCollaboration: { settings: async () => ({ provider: "drive", url: "wss://pboard.cecosl.ovh/ws" }), configure: mocks.configure, initialize: mocks.initialize, ownsAuthority: async () => false, identitySharing: { sync: async () => ({ email: "", boards: [], ready: [] }), collaborators: async () => [] }, pairing: { pending: async () => null } }, collaborationManager: { stop: mocks.stop, state: () => ({ready:false,error:null,connectedPeers:[],role:"private"}) } }));
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
  expect(node.querySelector('textarea[aria-label="Board grant input"]')).not.toBeNull();
  expect(button("Owner: approve device request").disabled).toBe(true);
  expect(button("Create / renew board invitation").disabled).toBe(true);
});
it("keeps settings untouched when the browser refuses the rendezvous permission", async () => {
  mocks.request.mockResolvedValue(false);
  const changed = vi.fn(); await act(async () => { root.render(<BoardCollaborationControls projectId="board" onChanged={changed} />); });
  await act(async () => button("Enable WebSocket collaboration").click());
  expect(mocks.configure).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  expect(node.textContent).toContain("permission was not granted");
});
