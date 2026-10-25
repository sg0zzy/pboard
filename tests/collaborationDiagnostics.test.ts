import { afterEach, expect, it, vi } from "vitest";
import { collaborationDiagnostic, collaborationDiagnostics } from "../src/collab/diagnostics";

afterEach(() => { collaborationDiagnostics.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("keeps diagnostics local, bounded, and projects only safe metadata", () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const listener = vi.fn(); const unsubscribe = collaborationDiagnostics.subscribe(listener);
  const fields = { session: "123456789012secret", peer: "abcdefghijklmnop", room: "cards", token: "PRIVATE_TOKEN", sdp: "PRIVATE_SDP", documents: "PRIVATE_DOCS" };
  for (let i = 0; i < 110; i++) collaborationDiagnostic("relay.joined", fields);
  const snapshot = collaborationDiagnostics.snapshot();
  expect(snapshot).toHaveLength(100);
  expect(snapshot[0].session).toBe("123456789012");
  expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|secret/);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|secret/);
  expect(listener).toHaveBeenCalledTimes(110);
  unsubscribe(); collaborationDiagnostics.clear(); expect(listener).toHaveBeenCalledTimes(110);
});
it("records only when the websocket provider is built in, never for other builds", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("DEV", false); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "drive");
  collaborationDiagnostic("relay.joined");
  vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "");
  collaborationDiagnostic("relay.joined");
  expect(collaborationDiagnostics.snapshot()).toEqual([]); expect(log).not.toHaveBeenCalled();
  vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket");
  collaborationDiagnostic("relay.joined");
  expect(collaborationDiagnostics.snapshot()).toHaveLength(1);
});
