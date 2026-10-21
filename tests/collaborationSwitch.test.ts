import { collaborationSecurityFixture } from "./helpers/collaborationSecurity";
import { describe, expect, it, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import type { PboardWebRTCConnectionOptions } from "../src/collab/webrtcHandler";
import type { RxRepository } from "../src/storage/rxdbRepository";

/**
 * A board switch must not wait for the previous board's transports to close:
 * the old rooms are retired in the background while the new board opens its
 * own signaling and DataChannel.
 */
const mock = vi.hoisted(() => ({
  handlers: [] as PboardWebRTCConnectionOptions[],
  /** One entry per created pool, with a deferred teardown the test controls. */
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
      // The teardown only completes when the test releases it: this models a
      // DataChannel close that does not finish immediately.
      cancel: () => { pool.cancelCalled = true; return teardown; }
    };
  }
}));

import { createCollaborationManager } from "../src/collab/manager";

function repository(): RxRepository {
  return {
    setProjectOrderAccount: vi.fn(async () => {}), setMutatorRole: vi.fn(async () => {}), admitPendingWork: vi.fn(async () => {}),
    getProject: vi.fn(async () => ({ id: "board" })),
    db: { cards: { name: "cards" }, projects: { name: "projects" }, settings: { name: "settings" } }
  } as unknown as RxRepository;
}

function managerFor(repo: RxRepository) {
  return createCollaborationManager({
    ...collaborationSecurityFixture(),
    myRole: async () => "owner", getSharedFileId: async () => "file",
    bootstrapFromDrive: async () => false, getRepository: async () => repo,
    signalingFor: () => ({}) as never
  });
}

describe("board switch lifecycle", () => {
  it("opens the new board while the previous board's rooms are still closing", async () => {
    mock.handlers = [];
    mock.pools = [];
    const manager = managerFor(repository());
    try {
      await manager.start("first");
      expect(mock.pools.map(pool => pool.topic)).toEqual([
        "pboard-collab-first-cards", "pboard-collab-first-projects"
      ]);
      // The old board's rooms are closed but not finished.
      const firstPools = [...mock.pools];

      // A switch must not block on the old teardown.
      await manager.start("second");
      expect(mock.pools.map(pool => pool.topic)).toEqual([
        "pboard-collab-first-cards", "pboard-collab-first-projects",
        "pboard-collab-second-cards", "pboard-collab-second-projects"
      ]);
      // The old rooms are still closing; the new board is already open.
      expect(firstPools.every(pool => pool.cancelCalled)).toBe(true);
      expect(manager.state().ready).toBe(true);
      expect(manager.state().error).toBeNull();

      // Releasing the old teardown finishes it without disturbing the new board.
      for (const pool of firstPools) pool.release();
      await vi.waitFor(() => expect(firstPools.every(pool => pool.cancelCalled)).toBe(true));
      expect(manager.state().ready).toBe(true);
      expect(manager.state().error).toBeNull();
    } finally {
      for (const pool of mock.pools) pool.release();
      await manager.stop();
    }
  });

  it("waits for the previous room of the same board before reopening it", async () => {
    mock.handlers = [];
    mock.pools = [];
    const manager = managerFor(repository());
    try {
      await manager.start("board");
      const [cards, projects] = mock.pools;
      // The same board is reopened while its old rooms are still closing. The
      // rendezvous admits one session per device and room, so the new rooms
      // wait for the old ones instead of overlapping them.
      const restart = manager.start("board");
      await vi.waitFor(() => expect(cards.cancelCalled).toBe(true));
      expect(projects.cancelCalled).toBe(true);
      // No replacement room opened while the old ones are still closing.
      expect(mock.pools).toHaveLength(2);

      cards.release();
      await vi.waitFor(() => expect(mock.pools).toHaveLength(3));
      expect(mock.pools[2].topic).toBe("pboard-collab-board-cards");
      // The projects room still waits for its own release.
      expect(mock.pools).toHaveLength(3);
      projects.release();
      await vi.waitFor(() => expect(mock.pools).toHaveLength(4));
      expect(mock.pools[3].topic).toBe("pboard-collab-board-projects");
      await restart;
    } finally {
      for (const pool of mock.pools) pool.release();
      await manager.stop();
    }
  });
});
