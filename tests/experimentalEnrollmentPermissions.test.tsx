// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const permission = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/platform/browser", () => ({ browser: { permissions: permission } }));
vi.mock("../src/sync/browser", () => ({ experimentalEnrollment: {}, collaborationManager: { stop: vi.fn() } }));
import { ExperimentalEnrollment } from "../src/sidebar/components/ExperimentalEnrollment";
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket");
  vi.stubEnv("VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT", "1"); vi.stubEnv("VITE_PBOARD_SIGNALING_WS_URL", "wss://relay.example.test/ws");
  permission.request.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function connectButton(onChanged: () => void) {
  act(() => root.render(<ExperimentalEnrollment projectId="board" onChanged={onChanged} />));
  return [...container.querySelectorAll("button")].find(button => button.textContent === "Connect / reconnect with Google")!;
}
it("requests only the configured service synchronously on click and connects after a grant", async () => {
  let grant!: (value: boolean) => void;
  permission.request.mockImplementation(() => new Promise<boolean>(resolve => { grant = resolve; }));
  const changed = vi.fn(); const button = connectButton(changed);
  act(() => button.click());
  expect(permission.request).toHaveBeenCalledWith({ origins: ["https://relay.example.test/*"] });
  expect(changed).not.toHaveBeenCalled(); expect(button.disabled).toBe(true);
  await act(async () => grant(true));
  expect(changed).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(false);
});
it("shows a useful denial or API failure without starting collaboration or leaking errors", async () => {
  const changed = vi.fn(); const button = connectButton(changed);
  permission.request.mockResolvedValueOnce(false);
  await act(async () => button.click());
  expect(container.textContent).toContain("access was not granted"); expect(changed).not.toHaveBeenCalled();
  permission.request.mockRejectedValueOnce(new Error("PRIVATE_ERROR_SENTINEL"));
  await act(async () => button.click());
  expect(container.textContent).toContain("Browser permission could not be requested");
  expect(container.textContent).not.toContain("PRIVATE_ERROR_SENTINEL"); expect(changed).not.toHaveBeenCalled();
});
