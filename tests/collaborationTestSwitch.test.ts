import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import type { PboardWebRTCConnectionOptions } from "../src/collab/webrtcHandler";
import type { RxRepository } from "../src/storage/rxdbRepository";
import type { CollaborationManager, CollaborationManagerOptions } from "../src/collab/manager";
import { collaborationSecurityFixture } from "./helpers/collaborationSecurity";

/**
 * The header's testing switch: while disabled, start() must not open any
 * signaling or DataChannel, and re-enabling must start normally again.
 */
const mock = vi.hoisted(() => ({
  handlers: [] as PboardWebRTCConnectionOptions[],
  pools: [] as { topic: string; release: () => void; cancelCalled: boolean }[]
}));

vi.mock("../src/collab/webrtcHandler", () => ({
  createPboardWebRTCConnectionHandler: (options: PboardWebRTCConnectionOptions) => {
    mock.handlers.push(options);
    return async () => ({});
  }
}));

vi.mock("rxdb/plugins/replication-webrtc", () => ({
  replicateWebRTC: async (options: { collection: unknown; topic: string }) => {
    let release!: () => void;
    const teardown = new Promise<void>(resolve => { release = resolve; });
    const pool = { topic: options.topic, release, cancelCalled: false };
    mock.pools.push(pool);
    return {
      collection: options.collection,
      masterReplicationHandler: { masterChangesSince: vi.fn() },
      error$: new Subject(), subs: [],
      connectionHandler: { connect$: new Subject() },
      peerStates$: new BehaviorSubject(new Map()),
      cancel: () => { pool.cancelCalled = true; return teardown; }
    };
  }
}));

import { createCollaborationManager } from "../src/collab/manager";

let manager: CollaborationManager;
beforeEach(() => {
  mock.handlers = [];
  mock.pools = [];
  const repo = {
    setProjectOrderAccount: vi.fn(async () => {}), setMutatorRole: vi.fn(async () => {}), admitPendingWork: vi.fn(async () => {}),
    getProject: vi.fn(async () => ({ id: "shared" })),
    db: { cards: { name: "cards" }, projects: { name: "projects" }, settings: { name: "settings" } }
  } as unknown as RxRepository;
  const options: CollaborationManagerOptions = {
    ...collaborationSecurityFixture(),
    myRole: async () => "owner", getSharedFileId: async () => "file",
    bootstrapFromDrive: async () => false, getRepository: async () => repo,
    signalingFor: vi.fn(() => ({}) as never)
  };
  manager = createCollaborationManager(options);
});
afterEach(async () => {
  for (const pool of mock.pools) pool.release();
  await manager?.stop();
});

it("opens rooms normally until the test switch turns collaboration off", async () => {
  await manager.start("shared");
  expect(manager.state().ready).toBe(true);
  for (const pool of mock.pools) pool.release(); // Let the mocked transports close.
  await manager.setEnabled(false);
  expect(manager.state().ready).toBe(false);
  const pools = mock.pools.length;
  await manager.start("shared");
  expect(mock.pools).toHaveLength(pools); // No new rooms on the re-start attempt.
  expect(manager.state()).toMatchObject({ ready: false, connectedPeers: [], error: null });
});

it("accepts a fresh start again once the test switch is back on", async () => {
  await manager.setEnabled(false);
  await manager.start("shared");
  expect(mock.pools).toHaveLength(0);
  expect(manager.state().ready).toBe(false);
  await manager.setEnabled(true);
  await manager.start("shared");
  expect(manager.state().ready).toBe(true);
  expect(mock.pools.map(pool => pool.topic)).toEqual(["pboard-collab-shared-cards", "pboard-collab-shared-projects"]);
});
