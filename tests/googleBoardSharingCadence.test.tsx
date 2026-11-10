// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sync: vi.fn(async () => ({ email: "", boards: [], ready: [] })),
  collaborators: vi.fn(async () => []),
  ownsAuthority: vi.fn(async () => false),
}));
vi.mock("../src/storage/browser", () => ({ repository: { getProject: async () => null } }));
vi.mock("../src/sync/browser", () => ({
  boardCollaboration: { identitySharing: { sync: mocks.sync, collaborators: mocks.collaborators }, ownsAuthority: mocks.ownsAuthority },
  collaborationManager: { start: async () => {}, state: () => ({}) },
}));
import { GoogleBoardSharing } from "../src/sidebar/components/GoogleBoardSharing";
import { IDENTITY_REFRESH_MS } from "../src/collab/googleIdentitySharing";

// The panel is mounted whenever the collaboration provider resolves to the
// relay — which the development posture makes *always*, including when no one
// ever opens the disclosure. Its refresh drives a real Google identity
// enrolment against the relay, so the closed panel must idle: production
// measured an `identity_enrollment_verified` journal entry roughly every five
// seconds per open board from a component nobody was reading.
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubEnv("DEV", false); vi.clearAllMocks(); vi.useFakeTimers(); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("polls the sharing inbox at the idle cadence while the panel is closed and at full speed while it is open", async () => {
  await act(async () => { root.render(<GoogleBoardSharing projectId="board" onChanged={() => {}} />); });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  // Minutes of an unread panel must not enrol identities at the five-second
  // cadence — three refresh intervals' worth of idle time fires nothing.
  await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_REFRESH_MS * 3); });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  // The idle cadence still drains the inbox.
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000 - IDENTITY_REFRESH_MS * 3); });
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  // Opening the disclosure refreshes immediately and restores the fast
  // cadence: the person is looking at pending requests now.
  const details = node.querySelector("details")!;
  details.open = true;
  await act(async () => { details.dispatchEvent(new Event("toggle")); });
  expect(mocks.sync).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_REFRESH_MS * 2); });
  expect(mocks.sync).toHaveBeenCalledTimes(5);
});
