import { collaborationSecurityFixture } from "./helpers/collaborationSecurity";
import { describe, expect, it, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import type { PboardWebRTCConnectionOptions } from "../src/collab/webrtcHandler";
import type { RxRepository } from "../src/storage/rxdbRepository";

const mock = vi.hoisted(() => ({ handlers: [] as PboardWebRTCConnectionOptions[], cancellations: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("../src/collab/webrtcHandler", () => ({
  createPboardWebRTCConnectionHandler: (options: PboardWebRTCConnectionOptions) => {
    mock.handlers.push(options);
    return async () => ({});
  }
}));
vi.mock("rxdb/plugins/replication-webrtc", () => ({
  replicateWebRTC: async (options: { collection: unknown }) => {
    const cancel = vi.fn(async () => {});
    mock.cancellations.push(cancel);
    return {
    collection: options.collection,
    masterReplicationHandler: { masterChangesSince: vi.fn() },
    error$: new Subject(), subs: [],
    connectionHandler: { connect$: new Subject() },
    peerStates$: new BehaviorSubject(new Map()),
    cancel
  }; }
}));
import { createCollaborationManager } from "../src/collab/manager";

it("shares one read-only refresh across rooms and invalidates it on project switch", async () => {
  mock.handlers = [];
  mock.cancellations = [];
  let complete!: () => void;
  let isActive!: () => boolean;
  const refreshFromDrive = vi.fn((_projectId: string, active: () => boolean) => {
    isActive = active;
    return new Promise<void>(resolve => { complete = resolve; });
  });
  const repo = {
    setProjectOrderAccount: vi.fn(async () => {}), setMutatorRole: vi.fn(), admitPendingWork: vi.fn(async () => {}),
    getProject: vi.fn(async () => ({ id: "shared" })),
    db: { cards: { name: "cards" }, projects: { name: "projects" } }
  } as unknown as RxRepository;
  const manager = createCollaborationManager({
      ...collaborationSecurityFixture(),
    myRole: async () => "owner", getSharedFileId: async () => "file",
    bootstrapFromDrive: async () => false, getRepository: async () => repo,
    signalingFor: () => ({}) as never, refreshFromDrive
  });
  try {
    await manager.start("shared");
    expect(mock.cancellations).toHaveLength(2);
    const first = mock.handlers[0].beforeReconnect!();
    const second = mock.handlers[1].beforeReconnect!();
    expect(refreshFromDrive).toHaveBeenCalledTimes(1);
    expect(refreshFromDrive.mock.calls[0][0]).toBe("shared");
    expect(isActive()).toBe(true);
    await manager.start("other");
    expect(mock.cancellations).toHaveLength(4);
    expect(mock.cancellations.slice(0, 2).every(cancel => cancel.mock.calls.length === 1)).toBe(true);
    expect(mock.cancellations.slice(2).every(cancel => cancel.mock.calls.length === 0)).toBe(true);
    expect(isActive()).toBe(false);
    // Finishing the old read must not clear the new session's pending refresh.
    const finishOld = complete;
    const next = mock.handlers[2].beforeReconnect!();
    const finishNext = complete;
    finishOld();
    await Promise.all([first, second]);
    const nextRoom = mock.handlers[3].beforeReconnect!();
    expect(refreshFromDrive).toHaveBeenCalledTimes(2);
    finishNext();
    await Promise.all([next, nextRoom]);
  } finally { await manager.stop(); }
  expect(mock.cancellations.every(cancel => cancel.mock.calls.length === 1)).toBe(true);
});
