import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { rxStorageInstanceToReplicationHandler } from "rxdb";
import { replicateRxCollection } from "rxdb/plugins/replication";
import { createIndexedDbBlobStore } from "../src/storage/blobStore";
import { createRxRepository, type RxRepository } from "../src/storage/rxdbRepository";

const unique = () => `pboardtest${crypto.randomUUID().replaceAll("-", "")}`;
const open = (name: string) => createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replicates one collection from `fork` to `master` with the conflict handler that
 * `createRxRepository` installed on that collection. `resolve` runs on the master side,
 * so the handler handed to the replication handler must be the master collection's.
 * `autoStart: false` lets the test write before the fork has any assumed master state,
 * which is the state a real session reaches when both peers created the same document
 * independently (bootstrap import on one side, create on the other).
 */
function link(fork: RxRepository, master: RxRepository, collection: "projects" | "cards", id: string) {
  const target = collection === "projects" ? fork.db.projects : fork.db.cards;
  const source = collection === "projects" ? master.db.projects : master.db.cards;
  const handler = rxStorageInstanceToReplicationHandler<any, string | undefined>(source.storageInstance, source.conflictHandler, master.db.name);
  return replicateRxCollection<any, string | undefined>({
    replicationIdentifier: id,
    collection: target,
    pull: { handler: (checkpoint, batchAmount) => handler.masterChangesSince(checkpoint, batchAmount) },
    push: { handler: (rows) => handler.masterWrite(rows) },
    waitForLeadership: false,
    autoStart: false
  });
}

/** The free RxDB build caps concurrently open collections, so each case closes its own. */
async function close(fork: RxRepository, master: RxRepository) {
  for (const repo of [fork, master]) {
    await repo.db.projects.close();
    await repo.db.cards.close();
    await repo.db.settings.close();
  }
}

describe("cross-peer conflict resolution", () => {
  it("keeps the fork write when the master already holds a different state for the same document", async () => {
    const master = await open(unique());
    const fork = await open(unique());
    const project = await master.createProject("Shared", "project");
    await fork.importProject(project, []);
    const replication = link(fork, master, "projects", "pboard-test-projects-first-write");
    await fork.changeProjectTemplate(project.id, "idea");
    await replication.start();
    await replication.awaitInitialReplication();
    expect((await fork.getProject(project.id))?.template).toBe("idea");
    expect((await master.getProject(project.id))?.template).toBe("idea");
    await replication.cancel();
    await close(fork, master);
  });

  it("does not let an older fork write overwrite a newer master write", async () => {
    const master = await open(unique());
    const fork = await open(unique());
    const project = await master.createProject("Shared", "project");
    await fork.importProject(project, []);
    const replication = link(fork, master, "projects", "pboard-test-projects-older-write");
    await fork.changeProjectTemplate(project.id, "idea");
    await wait(20);
    await master.changeProjectTemplate(project.id, "brainstorming");
    await replication.start();
    await replication.awaitInitialReplication();
    expect((await fork.getProject(project.id))?.template).toBe("brainstorming");
    expect((await master.getProject(project.id))?.template).toBe("brainstorming");
    await replication.cancel();
    await close(fork, master);
  });

  it("keeps a card deletion that is newer than the master's edit of the same card", async () => {
    const master = await open(unique());
    const fork = await open(unique());
    const project = await master.createProject("Shared", "project");
    const card = await master.addItem({ projectId: project.id, content: "Card", type: "note", status: "confirmed" });
    await fork.importProject(project, [card]);
    const replication = link(fork, master, "cards", "pboard-test-cards-deletion");
    await master.updateItem(card.id, { content: "Renamed" });
    await wait(20);
    await fork.deleteItem(card.id);
    await replication.start();
    await replication.awaitInitialReplication();
    expect(await fork.getCard(card.id)).toBeNull();
    expect(await master.getCard(card.id)).toBeNull();
    await replication.cancel();
    await close(fork, master);
  });
});
