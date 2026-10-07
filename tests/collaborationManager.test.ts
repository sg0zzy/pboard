import "fake-indexeddb/auto";
import NodeDataChannel from "node-datachannel/polyfill";
import { afterEach, describe, expect, it } from "vitest";
import { createSimplePeerWrtc } from "rxdb/plugins/replication-webrtc";
import { createCollaborationManager, type CollaborationManager } from "../src/collab/manager";
import type { PboardRole } from "../src/sync/drivePermissions";
import { createDriveSignaling, createMemorySignalingScope, type PboardDriveSignalRecord, type PboardSignaling } from "../src/collab/signaling";
import { createRxRepository } from "../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import type { SharedImageTransport } from "../src/collab/imageSync";
import type { BoardImage } from "../src/types";

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
    scope: { create(topic: string): PboardSignaling },
    imageTransport?: SharedImageTransport,
    account?: string
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
      wrtc,
      imageTransport,
      getAccountId: async () => account ?? null
    });
    managers.push(manager);
    return { manager, get bootstrapped() { return bootstrapped; } };
  }

  it("syncs the whole project order only between sessions of the same account, including private projects", { timeout: 20000 }, async () => {
    const firstRepo = await makeRepo();
    const secondRepo = await makeRepo();
    const otherRepo = await makeRepo();
    const a = await firstRepo.createProject("A");
    const b = await firstRepo.createProject("B");
    const c = await firstRepo.createProject("C");
    for (const repo of [secondRepo, otherRepo]) {
      for (const project of [a, b, c]) {
        const snapshot = await firstRepo.exportProject(project.id);
        await repo.importProject(snapshot.project, snapshot.items);
      }
    }
    const scope = createMemorySignalingScope();
    const access = { role: null, fileId: null };
    const first = makeManager(firstRepo, access, firstRepo, scope, undefined, "pippo");
    const second = makeManager(secondRepo, access, firstRepo, scope, undefined, "pippo");
    const other = makeManager(otherRepo, access, firstRepo, scope, undefined, "pluto");
    // Account order does not depend on having the same current project or a shared board.
    await first.manager.start(a.id);
    await secondRepo.selectProject(b.id);
    await second.manager.start(b.id);
    await other.manager.start(c.id);
    const order = async (repo: typeof firstRepo) => (await repo.listProjects()).map((project) => project.id).join(",");
    const reordered = [c.id, a.id, b.id];
    await firstRepo.reorderProjects(reordered);
    await waitUntil(async () => await order(secondRepo) === reordered.join(","));
    expect(await order(otherRepo)).toBe([a.id, b.id, c.id].join(","));
    const reverse = [b.id, c.id, a.id];
    await secondRepo.reorderProjects(reverse);
    await waitUntil(async () => await order(firstRepo) === reverse.join(","));
    await otherRepo.reorderProjects([b.id, a.id, c.id]);
    await observeFor(500);
    expect(await order(firstRepo)).toBe(reverse.join(","));
    expect(await otherRepo.db.settings.findOne("projectOrder:pippo").exec()).toBeNull();
    expect(await firstRepo.db.settings.findOne("projectOrder:pluto").exec()).toBeNull();
    expect((await secondRepo.getCurrentProject())?.id).toBe(b.id);
    await second.manager.stop();
    expect(await order(secondRepo)).toBe(reverse.join(","));
  });

  it("connects two owner sessions through periodic Drive signaling when the second browser opens later", { timeout: 20000 }, async () => {
    const firstRepo = await makeRepo();
    const secondRepo = await makeRepo();
    const rooms = new Map<string, Map<string, PboardDriveSignalRecord>>();
    function scope(peerId: string) {
      return { create(topic: string) {
        const records = rooms.get(topic) ?? new Map<string, PboardDriveSignalRecord>();
        rooms.set(topic, records);
        return createDriveSignaling({ pollMs: 50, store: {
          peerId, now: Date.now,
          readPeer: async (id) => structuredClone(records.get(id) ?? null),
          writeOwn: async (record) => { records.set(peerId, structuredClone(record)); },
          listPeers: async () => structuredClone(Object.fromEntries(records)),
          deleteOwn: async () => { records.delete(peerId); }
        } });
      } };
    }
    const project = await firstRepo.createProject("Same account in two browsers");
    const images = new Map<string, BoardImage>();
    const imageTransport: SharedImageTransport = {
      readImage: async (_projectId, imageId) => structuredClone(images.get(imageId) ?? null),
      writeImage: async (_projectId, imageId, image) => { images.set(imageId, structuredClone(image)); }
    };
    const first = makeManager(firstRepo, { role: "owner", fileId: "same-account-file" }, firstRepo, scope("firefox-session"), imageTransport);
    const second = makeManager(secondRepo, { role: "owner", fileId: "same-account-file" }, firstRepo, scope("chrome-session"), imageTransport);
    await first.manager.start(project.id);
    await observeFor(250);
    await second.manager.start(project.id);
    await waitUntil(() => first.manager.state().connectedPeers.length > 0 && second.manager.state().connectedPeers.length > 0);
    const firstCard = await firstRepo.addItem({ projectId: project.id, content: "Created after connection in Firefox" });
    await waitUntil(async () => (await secondRepo.getCard(firstCard.id))?.content === firstCard.content);
    const secondCard = await secondRepo.addItem({ projectId: project.id, content: "Created after connection in Chrome" });
    await waitUntil(async () => (await firstRepo.getCard(secondCard.id))?.content === secondCard.content);
    const firstImage = await firstRepo.addItem({ projectId: project.id, content: "Image added while connected", image: {
      dataUrl: "data:image/png;base64,AAECAwQ=", mimeType: "image/png", width: 1, height: 1
    } });
    await waitUntil(async () => (await secondRepo.getCard(firstImage.id))?.imageId === firstImage.imageId && await secondRepo.hasImage(firstImage.imageId!));
    expect((await secondRepo.exportProject(project.id)).items.find((card) => card.id === firstImage.id)?.image?.dataUrl).toBe("data:image/png;base64,AAECAwQ=");
    const secondImage = await secondRepo.addItem({ projectId: project.id, content: "Image from the other browser", image: {
      dataUrl: "data:image/png;base64,BQQDAgEA", mimeType: "image/png", width: 1, height: 1
    } });
    await waitUntil(async () => (await firstRepo.getCard(secondImage.id))?.imageId === secondImage.imageId && await firstRepo.hasImage(secondImage.imageId!));
  });

  it("starts live pools when a private project's access becomes shared without switching projects", { timeout: 20000 }, async () => {
    const firstRepo = await makeRepo();
    const secondRepo = await makeRepo();
    const project = await firstRepo.createProject("Enable live later");
    const access: { role: PboardRole | null; fileId: string | null } = { role: null, fileId: null };
    const scope = createMemorySignalingScope();
    const first = makeManager(firstRepo, access, firstRepo, scope);
    const second = makeManager(secondRepo, { role: "owner", fileId: "enabled-file" }, firstRepo, scope);
    await first.manager.start(project.id);
    expect(first.manager.state().role).toBe("private");
    access.role = "owner"; access.fileId = "enabled-file";
    await first.manager.refreshRole();
    await second.manager.start(project.id);
    await waitUntil(() => first.manager.state().connectedPeers.length > 0 && second.manager.state().connectedPeers.length > 0);
    expect(first.manager.state().role).toBe("owner");
    const card = await firstRepo.addItem({ projectId: project.id, content: "Live after enabling" });
    await waitUntil(async () => (await secondRepo.getCard(card.id))?.content === card.content);
  });

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
    await collabRepo.deleteProject(shared.id);
    expect(await collabRepo.getProject(shared.id)).toBeNull();
    await observeFor(500);
    expect((await ownerRepo.getProject(shared.id))?.name).toBe("Shared");
    expect((await ownerRepo.listCards(shared.id)).map((card) => card.id)).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(await collabRepo.db.projects.findOne(shared.id).exec()).not.toBeNull();
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
    await viewerRepo.deleteProject(shared.id);
    expect(await viewerRepo.getProject(shared.id)).toBeNull();
    await observeFor(500);
    expect((await ownerRepo.getProject(shared.id))?.name).toBe("Shared");
    expect((await ownerRepo.listCards(shared.id)).map((card) => card.id)).toEqual(expect.arrayContaining([seed.id, next.id]));
    expect(await viewerRepo.db.projects.findOne(shared.id).exec()).not.toBeNull();
  });

  it("replicates project category, card state, card category, card creation and card deletion between two sessions of the same account in both directions", { timeout: 120000 }, async () => {
    const firstRepo = await makeRepo();
    const secondRepo = await makeRepo();
    const scope = createMemorySignalingScope();
    const first = makeManager(firstRepo, { role: "owner", fileId: "file-3" }, firstRepo, scope, undefined, "pippo");
    const second = makeManager(secondRepo, { role: "owner", fileId: "file-3" }, firstRepo, scope, undefined, "pippo");
    const shared = await firstRepo.createProject("Shared", "project");
    await first.manager.start(shared.id);
    await second.manager.start(shared.id);
    // Gate on the live data channel per collection: `state().connectedPeers` skips the
    // settings pool and each collection has its own connection, so two peers per session
    // proves both the cards and the projects rooms are live. Every assertion below can
    // then only be satisfied by replication over those connections, not by the bootstrap
    // snapshot.
    await waitUntil(
      async () =>
        first.manager.state().connectedPeers.length >= 2 && second.manager.state().connectedPeers.length >= 2,
      30000
    );
    const cardIn = async (repo: typeof firstRepo, id: string) => (await repo.listCards(shared.id)).find((card) => card.id === id);
    const tombstoneIn = async (repo: typeof firstRepo, id: string) => (await repo.db.cards.findOne(id).exec())?.toJSON();
    async function replicated(read: () => Promise<unknown>, expected: unknown, timeoutMs = 15000): Promise<void> {
      await waitUntil(async () => (await read()) === expected, timeoutMs);
      expect(await read()).toBe(expected);
    }

    // Project category: a card type the new template does not support is remapped, and
    // both the template and the remapped card have to arrive on the other session.
    const remapped = await firstRepo.addItem({ projectId: shared.id, content: "goal card", type: "goal" });
    await firstRepo.changeProjectTemplate(shared.id, "idea");
    // Both rooms are already connected by the gate, so this is replication latency.
    await replicated(async () => (await secondRepo.getProject(shared.id))?.template, "idea");
    await replicated(async () => (await cardIn(secondRepo, remapped.id))?.type, "note");
    await secondRepo.changeProjectTemplate(shared.id, "software_project");
    await replicated(async () => (await firstRepo.getProject(shared.id))?.template, "software_project");

    // Card creation.
    const one = await firstRepo.addItem({ projectId: shared.id, content: "from the first session" });
    await replicated(async () => (await cardIn(secondRepo, one.id))?.content, "from the first session");
    const two = await secondRepo.addItem({ projectId: shared.id, content: "from the second session" });
    await replicated(async () => (await cardIn(firstRepo, two.id))?.content, "from the second session");

    // Card state.
    await firstRepo.updateItem(one.id, { status: "done" });
    await replicated(async () => (await cardIn(secondRepo, one.id))?.status, "done");
    await secondRepo.updateItem(two.id, { status: "rejected" });
    await replicated(async () => (await cardIn(firstRepo, two.id))?.status, "rejected");

    // Card category.
    await firstRepo.updateItem(one.id, { type: "issue" });
    await replicated(async () => (await cardIn(secondRepo, one.id))?.type, "issue");
    await secondRepo.updateItem(two.id, { type: "feature" });
    await replicated(async () => (await cardIn(firstRepo, two.id))?.type, "feature");

    // Card deletion: the tombstone, not just the live list, has to replicate.
    await firstRepo.deleteItem(one.id);
    await replicated(async () => Boolean((await tombstoneIn(secondRepo, one.id))?.deletedAt), true);
    expect((await secondRepo.listCards(shared.id)).map((card) => card.id)).not.toContain(one.id);
    await secondRepo.deleteItem(two.id);
    await replicated(async () => Boolean((await tombstoneIn(firstRepo, two.id))?.deletedAt), true);
    expect((await firstRepo.listCards(shared.id)).map((card) => card.id)).not.toContain(two.id);
  });
});
