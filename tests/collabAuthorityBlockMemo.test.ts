import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import type { RxRepository } from "../src/storage/rxdbRepository";
import type { CollaborationManager, CollaborationManagerOptions } from "../src/collab/manager";
import { BoardExistingSignedDataError } from "../src/collab/authorityErrors";
import { collaborationSecurityFixture } from "./helpers/collaborationSecurity";

/**
 * A board with signed history but no local authority is a deterministic
 * block: the role refresh must record it once and answer later ticks from
 * the memo instead of repeating the identity-service round trips, while any
 * other role failure keeps retrying every tick.
 */
const mock = vi.hoisted(() => ({ pools: [] as { topic: string; release: () => void }[] }));

vi.mock("../src/collab/webrtcHandler", () => ({
  createPboardWebRTCConnectionHandler: () => async () => ({})
}));

vi.mock("rxdb/plugins/replication-webrtc", () => ({
  replicateWebRTC: async (options: { collection: unknown; topic: string }) => {
    let release!: () => void;
    const teardown = new Promise<void>(resolve => { release = resolve; });
    mock.pools.push({ topic: options.topic, release });
    return {
      collection: options.collection,
      masterReplicationHandler: { masterChangesSince: vi.fn() },
      error$: new Subject(), subs: [],
      connectionHandler: { connect$: new Subject() },
      peerStates$: new BehaviorSubject(new Map()),
      cancel: () => teardown
    };
  }
}));

import { createCollaborationManager } from "../src/collab/manager";

const BLOCKED = "This board has existing signed collaboration data. Keep its original authority; automatic initialization cannot replace it.";

let manager: CollaborationManager;
let roleAttempts = 0;
let authorityAppears = false;
let failure: Error = new Error("network down");

beforeEach(() => {
  mock.pools = [];
  roleAttempts = 0;
  authorityAppears = false;
  failure = new Error("network down");
  const repo = {
    setProjectOrderAccount: vi.fn(async () => {}), setMutatorRole: vi.fn(async () => {}), admitPendingWork: vi.fn(async () => {}),
    getProject: vi.fn(async () => ({ id: "shared" })),
    db: { cards: { name: "cards" }, projects: { name: "projects" }, settings: { name: "settings" } }
  } as unknown as RxRepository;
  const options: CollaborationManagerOptions = {
    ...collaborationSecurityFixture(),
    myRole: async () => {
      roleAttempts += 1;
      if (authorityAppears) return "owner";
      throw failure;
    },
    getSharedFileId: async () => "file",
    bootstrapFromDrive: async () => false, getRepository: async () => repo,
    signalingFor: vi.fn(() => ({}) as never),
    securityChanged: async () => authorityAppears
  };
  manager = createCollaborationManager(options);
});
afterEach(async () => {
  for (const pool of mock.pools) pool.release();
  await manager?.stop();
});

it("answers repeat refreshes of the deterministic authority block from the memo", async () => {
  failure = new BoardExistingSignedDataError(BLOCKED);
  await expect(manager.start("shared")).rejects.toThrow(BLOCKED);
  expect(manager.state().error).toContain(BLOCKED);
  const attempts = roleAttempts;
  await manager.refreshRole();
  await manager.refreshRole();
  await manager.refreshRole();
  expect(roleAttempts).toBe(attempts); // No identity round trip while deterministically blocked.
  expect(manager.state().error).toContain(BLOCKED); // The diagnostic stays visible.
  // Once the security poll reports that authority appeared, the refresh path
  // retries and the board opens normally.
  authorityAppears = true;
  await manager.refreshRole();
  expect(roleAttempts).toBeGreaterThan(attempts);
  expect(manager.state().error).toBeNull();
  expect(manager.state().ready).toBe(true);
});

it("keeps retrying transient role failures on every refresh tick", async () => {
  await expect(manager.start("shared")).rejects.toThrow("network down");
  await expect(manager.refreshRole()).rejects.toThrow("network down");
  await expect(manager.refreshRole()).rejects.toThrow("network down");
  expect(roleAttempts).toBe(3);
});

it("clears the recorded block when the board changes", async () => {
  failure = new BoardExistingSignedDataError(BLOCKED);
  await expect(manager.start("shared")).rejects.toThrow(BLOCKED);
  failure = new Error("network down");
  await expect(manager.start("other")).rejects.toThrow("network down"); // The other board resolves normally.
  expect(roleAttempts).toBe(2);
});
