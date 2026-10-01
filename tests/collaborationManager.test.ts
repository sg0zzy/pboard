import "fake-indexeddb/auto";
import NodeDataChannel from "node-datachannel/polyfill";
import { afterEach, describe, expect, it } from "vitest";
import { createSimplePeerWrtc } from "rxdb/plugins/replication-webrtc";
import { createCollaborationManager, type CollaborationManager } from "../src/collab/manager";
import type { PboardRole } from "../src/sync/drivePermissions";
import { createMemorySignalingScope, type PboardSignaling } from "../src/collab/signaling";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";

const wrtc = createSimplePeerWrtc(NodeDataChannel);
const unique = () => `pboardcollab${crypto.randomUUID().replaceAll("-", "")}`;
const open = (name: string) => createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
// node-datachannel performs a genuine ICE/DTLS/data-channel handshake and RxDB
// replication polls over it, so the native stack must run on the real clock — fake
// timers would desync it. (ts-no-test-timers integration exception.) waitUntil polls
// the real DB state until a condition holds instead of guessing a fixed delay.
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitUntil: condition not met within timeout");
}

// Bounded real-timer wait for negative assertions (nothing to await for an
// absence). Short by design: the positive waitUntil gates already let the data
// channel establish, so this window only bounds the observation.
// (ts-no-test-timers integration exception, same rationale as waitUntil.)
const observeFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createCollaborationManager", () => {
  const repos: Awaited<ReturnType<typeof open>>[] = [];
  const managers: CollaborationManager[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.stop().catch(() => {});
    for (const repo of repos.splice(0)) await repo.db.close().catch(() => {});
  });

  async function makeRepo() {
    const repo = await open(unique());
    repos.push(repo);
    return repo;
  }

  function makeManager(
    repo: Awaited<ReturnType<typeof open>>,
    overrides: { role: PboardRole | null; fileId: string | null },
    sharedSource: Awaited<ReturnType<typeof open>>,
    scope: { create(topic: string): PboardSignaling }
  ) {
    let bootstrapped = false;
    const manager = createCollaborationManager({
      myRole: async () => overrides.role,
      getSharedFileId: async () => overrides.fileId,
      bootstrapFromDrive: async (projectId) => {
        const { project, items } = await sharedSource.exportProject(projectId);
        await repo.importProject(project, items);
        bootstrapped = true;
        return bootstrapped;
      },
      signalingFor: (topic) => scope.create(topic),
      getRepository: async () => repo,
      wrtc
    });
    managers.push(manager);
    return { manager, get bootstrapped() { return bootstrapped; } };
  }

  it("replicates bidirectionally over real WebRTC and scopes out private projects", { timeout: 20000 }, async () => {
    const ownerRepo = await makeRepo();
    const collabRepo = await makeRepo();
    const scope = createMemorySignalingScope();
    const owner = makeManager(ownerRepo, { role: "owner", fileId: "file-1" }, ownerRepo, scope);
    const collab = makeManager(collabRepo, { role: "editor", fileId: "file-1" }, ownerRepo, scope);

    const shared = await ownerRepo.createProject("Shared", "project");
    const a = await ownerRepo.addItem({ projectId: shared.id, content: "card A" });

    await owner.manager.start(shared.id);
    await collab.manager.start(shared.id);
    // Gate on the live data channel so the replication assertions below are
    // meaningful: a card created after start() can only arrive over the data
    // channel, not via bootstrap. `connectedPeers` is a list of signaling peer
    // ids (one logical peer appears once per room — cards and projects — so a
    // single collaborator yields > 0 ids); "a peer is connected" is `> 0`.
    await waitUntil(async () =>
      owner.manager.state().connectedPeers.length > 0 && collab.manager.state().connectedPeers.length > 0
    );

    // The collaborator bootstrapped the shared project from the owner's snapshot.
    expect(collab.bootstrapped).toBe(true);
    expect((await collabRepo.getProject(shared.id))?.name).toBe("Shared");
    expect((await collabRepo.listCards(shared.id)).map((card) => card.id)).toContain(a.id);
    // The owner's role resolves to owner; the collaborator to editor.
    expect(owner.manager.state().role).toBe("owner");
    expect(collab.manager.state().role).toBe("editor");
    // Both sides know the other peer is connected.
    expect(owner.manager.state().connectedPeers.length).toBeGreaterThan(0);
    expect(collab.manager.state().connectedPeers.length).toBeGreaterThan(0);

    // Owner edits -> collaborator receives.
    const b = await ownerRepo.addItem({ projectId: shared.id, content: "card B" });
    await waitUntil(async () => (await collabRepo.listCards(shared.id)).some((card) => card.id === b.id));
    expect((await collabRepo.listCards(shared.id)).map((card) => card.id)).toContain(b.id);

    // Collaborator edits -> owner receives.
    const c = await collabRepo.addItem({ projectId: shared.id, content: "card C" });
    await waitUntil(async () => (await ownerRepo.listCards(shared.id)).some((card) => card.id === c.id));
    expect((await ownerRepo.listCards(shared.id)).map((card) => card.id)).toContain(c.id);

    // The owner's private project is scoped out of the shared room.
    const privateProject = await ownerRepo.createProject("Private", "project");
    const hidden = await ownerRepo.addItem({ projectId: privateProject.id, content: "hidden" });
    await observeFor(2000);
    expect(await collabRepo.getProject(privateProject.id)).toBeNull();
    expect((await collabRepo.listCards(privateProject.id)).map((card) => card.id)).not.toContain(hidden.id);
    // The owner still has both its projects locally.
    expect((await ownerRepo.listProjects()).map((project) => project.id)).toEqual(
      expect.arrayContaining([shared.id, privateProject.id])
    );
  });

  it("keeps a viewer pull-only: receives remote changes, cannot publish local writes", { timeout: 20000 }, async () => {
    const ownerRepo = await makeRepo();
    const viewerRepo = await makeRepo();
    const scope = createMemorySignalingScope();
    const owner = makeManager(ownerRepo, { role: "owner", fileId: "file-2" }, ownerRepo, scope);
    const viewer = makeManager(viewerRepo, { role: "viewer", fileId: "file-2" }, ownerRepo, scope);

    const shared = await ownerRepo.createProject("Shared", "project");
    const seed = await ownerRepo.addItem({ projectId: shared.id, content: "seed" });

    await owner.manager.start(shared.id);
    await viewer.manager.start(shared.id);
    // Gate on the live data channel so the pull assertion below is meaningful.
    await waitUntil(async () =>
      owner.manager.state().connectedPeers.length > 0 && viewer.manager.state().connectedPeers.length > 0
    );

    expect(viewer.manager.state().role).toBe("viewer");
    expect((await viewerRepo.getProject(shared.id))?.name).toBe("Shared");
    expect((await viewerRepo.listCards(shared.id)).map((card) => card.id)).toContain(seed.id);

    // Owner edits -> viewer receives (pull path).
    const next = await ownerRepo.addItem({ projectId: shared.id, content: "next" });
    await waitUntil(async () => (await viewerRepo.listCards(shared.id)).some((card) => card.id === next.id));
    expect((await viewerRepo.listCards(shared.id)).map((card) => card.id)).toContain(next.id);

    // A direct local write on the viewer (the UI is read-only; this simulates a
    // programmatic mutation) must be rejected at the repository layer. The
    // manager gates the viewer's shared project, so no local write can exist to
    // be replicated — the authoritative viewer write-restriction. The pull-only
    // pool alone does not stop a viewer that is the WebRTC master, whose change
    // log the master streams unconditionally.
    await expect(viewerRepo.addItem({ projectId: shared.id, content: "local only" }))
      .rejects.toThrow("view-only");
    // The owner's board is unchanged: no stray viewer card ever arrives.
    await observeFor(500);
    expect((await ownerRepo.listCards(shared.id)).map((card) => card.content)).not.toContain("local only");
  });
});
