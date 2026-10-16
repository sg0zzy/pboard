import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import type { RxRepository } from "../src/storage/rxdbRepository";
import type { CollaborationManager, CollaborationManagerOptions } from "../src/collab/manager";
import { collaborationSecurityFixture } from "./helpers/collaborationSecurity";

const transport = vi.hoisted(() => ({ create: vi.fn(), cancel: vi.fn() }));
vi.mock("../src/collab/webrtcHandler", () => ({
  createPboardWebRTCConnectionHandler: (options: unknown) => {
    transport.create(options);
    return async () => ({});
  }
}));
vi.mock("rxdb/plugins/replication-webrtc", () => ({
  replicateWebRTC: async (options: { collection: unknown }) => ({
    collection: options.collection, masterReplicationHandler: { masterChangesSince: vi.fn() },
    error$: new Subject(), subs: [], connectionHandler: { connect$: new Subject() },
    peerStates$: new BehaviorSubject(new Map()), cancel: transport.cancel
  })
}));
import { createCollaborationManager } from "../src/collab/manager";

let manager: CollaborationManager;
let options: CollaborationManagerOptions;
beforeEach(() => {
  vi.clearAllMocks();
  const repo = {
    setProjectOrderAccount: vi.fn(async () => {}), setMutatorRole: vi.fn(),
    getProject: vi.fn(async () => ({ id: "shared" })),
    db: { cards: { name: "cards" }, projects: { name: "projects" }, settings: { name: "settings" } }
  } as unknown as RxRepository;
  options = {
    ...collaborationSecurityFixture(),
    myRole: async () => "owner", getSharedFileId: async () => "file",
    getRepository: async () => repo, bootstrapFromDrive: vi.fn(async () => false),
    signalingFor: vi.fn(() => ({}) as never)
  };
});
afterEach(async () => { await manager?.stop(); });

async function blocked(message = /trusted security manifest/) {
  manager = createCollaborationManager(options);
  await expect(manager.start("shared")).rejects.toThrow(message);
  expect(transport.create).not.toHaveBeenCalled();
  expect(options.signalingFor).not.toHaveBeenCalled();
  expect(manager.state()).toMatchObject({ ready: false, connectedPeers: [], error: expect.any(String) });
}

describe("collaboration security admission", () => {
  it.each(["missing", "null", "rejected"] as const)("blocks a %s board security provider", async mode => {
    options.boardSecurity = mode === "missing" ? undefined : mode === "null"
      ? async () => null : async () => { throw new Error("Manifest verification failed"); };
    await blocked(mode === "rejected" ? /verification failed/ : undefined);
    expect(options.bootstrapFromDrive).not.toHaveBeenCalled();
  });

  it.each(["missing", "null", "rejected"] as const)("blocks a %s account security provider on a private board", async mode => {
    options.myRole = async () => null;
    options.getAccountId = async () => "account-A";
    options.accountSecurity = mode === "missing" ? undefined : mode === "null"
      ? async () => null : async () => { throw new Error("Manifest verification failed"); };
    await blocked(mode === "rejected" ? /verification failed/ : undefined);
  });

  it.each(["expired", "wrong room", "unknown device", "malformed"])("rejects a %s context before signaling", async mode => {
    const context = await options.boardSecurity!("shared");
    if (!context) throw new Error("Missing test context");
    const invalid = structuredClone(context);
    if (mode === "expired") { invalid.manifest.issuedAt = Date.now() - 400_000; invalid.manifest.expiresAt = Date.now() - 100_000; }
    if (mode === "wrong room") invalid.boardId = "another-board";
    if (mode === "unknown device") invalid.signer.deviceKeyId = "unknown";
    if (mode === "malformed") invalid.manifest.devices = [];
    options.boardSecurity = async () => invalid;
    await blocked(/manifest/i);
  });

  it("rejects a board context reused for the account room", async () => {
    options.getAccountId = async () => "account-A";
    options.accountSecurity = async () => options.boardSecurity!("shared");
    await blocked(/does not authorize/);
  });

  it.each(["missing", "null", "wrong project"])("blocks %s mutation protection before starting any room", async mode => {
    options.getAccountId = async () => "account-A";
    options.installMutationGuard = mode === "missing" ? undefined : mode === "null" ? async () => null
      : async () => ({ projectId: "another-board", uninstall: vi.fn(async () => {}) });
    await blocked(/mutation protection/);
  });

  it("keeps a private local board usable without any account or security provider", async () => {
    options.myRole = async () => null;
    options.boardSecurity = options.accountSecurity = undefined;
    manager = createCollaborationManager(options);
    await manager.start("private");
    expect(manager.state()).toMatchObject({ ready: true, error: null, connectedPeers: [] });
    expect(transport.create).not.toHaveBeenCalled();
  });

  it("can retry after account trust becomes available", async () => {
    const accountSecurity = options.accountSecurity;
    options.myRole = async () => null;
    options.getAccountId = async () => "account-A";
    options.accountSecurity = async () => null;
    await blocked();
    options.accountSecurity = accountSecurity;
    await manager.refreshRole();
    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(transport.create.mock.calls[0][0].security.boardId).toBe("account:account-A");
    expect(manager.state()).toMatchObject({ ready: true, error: null });
  });

  it("cleans up active rooms when a role refresh cannot resolve trust", async () => {
    manager = createCollaborationManager(options);
    await manager.start("shared");
    expect(transport.create).toHaveBeenCalledTimes(2);
    options.myRole = async () => "viewer";
    options.boardSecurity = async () => null;
    await expect(manager.refreshRole()).rejects.toThrow(/trusted security manifest/);
    expect(transport.cancel).toHaveBeenCalledTimes(2);
    expect(manager.state()).toMatchObject({ ready: false, connectedPeers: [], error: expect.any(String) });
  });
});
