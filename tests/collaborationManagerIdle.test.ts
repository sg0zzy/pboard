import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { createCollaborationManager } from "../src/collab/manager";
import { createRxRepository, type RxRepository } from "../src/storage/rxdbRepository";
import { collaborationSecurityFixture } from "./helpers/collaborationSecurity";

/**
 * A shared board whose collaboration security is not available cannot open a
 * live room. The manager must report that failure and must NOT keep re-opening
 * it.
 *
 * The sidebar calls `refreshRole()` every 10 seconds to notice a remote change
 * of the board's role. If every one of those calls restarts a session that
 * cannot start, the sidebar repeats the whole start-up path — several Drive
 * round trips, a teardown and a fresh start — every 10 seconds, for as long as
 * the sidebar stays open.
 */
const repos: RxRepository[] = [];
const managers: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop().catch(() => {});
  for (const repo of repos.splice(0)) await repo.db.close().catch(() => {});
});

async function openRepository() {
  const repo = await createRxRepository({ name: `idle${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(repo);
  return repo;
}

describe("collaboration manager", () => {
  it("does not retry a board that cannot open a room on every role refresh", async () => {
    const repo = await openRepository();
    let starts = 0;
    let securityChanged = false;

    const manager = createCollaborationManager({
      myRole: async () => "editor",
      getSharedFileId: async () => null,
      bootstrapFromDrive: async () => { starts++; return false; },
      getRepository: async () => repo,
      // A shared board whose security manifest is not available: the manager
      // cannot open a room for it.
      boardSecurity: async () => null,
      // The board's authorization has not changed since the failed attempt.
      securityChanged: async () => securityChanged,
      signalingFor: () => { throw new Error("must not open a room"); }
    });
    managers.push(manager);

    await manager.start("board").catch(() => undefined);
    console.log("starts after the first attempt:", starts);
    console.log("state after start:", JSON.stringify(manager.state()));

    // The sidebar's role-refresh timer.
    for (let round = 0; round < 5; round++) {
      await manager.refreshRole().catch(() => undefined);
    }

    console.log("starts after 5 refreshes:", starts);
    console.log("state:", JSON.stringify(manager.state()));

    // The full start-up path must not be repeated on every tick while nothing
    // relevant changed. The role refresh runs every 10 seconds.
    expect(starts).toBeLessThanOrEqual(1);
  });

  it("tries again once the board's authorization becomes available", async () => {
    const repo = await openRepository();
    let starts = 0;
    let trusted = false;
    const fixture = collaborationSecurityFixture();

    const manager = createCollaborationManager({
      myRole: async () => "editor",
      getSharedFileId: async () => null,
      bootstrapFromDrive: async () => { starts++; return false; },
      getRepository: async () => repo,
      boardSecurity: async () => trusted ? await fixture.boardSecurity("board") : null,
      signalingFor: () => { throw new Error("must not open a room"); }
    });
    managers.push(manager);

    await manager.start("board").catch(() => undefined);
    const afterStart = starts;
    await manager.refreshRole().catch(() => undefined);
    expect(starts).toBe(afterStart);

    // The board's authorization becomes available.
    trusted = true;
    await manager.refreshRole().catch(() => undefined);
    console.log("starts after the authorization changed:", starts);
    expect(starts).toBeGreaterThan(afterStart);
  });

  it("reports the same failure instead of a new one on every refresh", async () => {
    const repo = await openRepository();
    const manager = createCollaborationManager({
      myRole: async () => "editor",
      getSharedFileId: async () => null,
      bootstrapFromDrive: async () => false,
      getRepository: async () => repo,
      boardSecurity: async () => null,
      signalingFor: () => { throw new Error("must not open a room"); }
    });
    managers.push(manager);

    await manager.start("board").catch(() => undefined);
    const first = manager.state();
    await manager.refreshRole().catch(() => undefined);
    const second = manager.state();

    console.log("first state:", JSON.stringify(first));
    console.log("second state:", JSON.stringify(second));
    // The reported failure must be the same, not a new one each tick.
    expect(second.error).toBe(first.error);
  });

  it("tries again after a deliberate stop", async () => {
    const repo = await openRepository();
    let securityResolves = 0;
    const manager = createCollaborationManager({
      myRole: async () => "editor",
      getSharedFileId: async () => null,
      bootstrapFromDrive: async () => false,
      getRepository: async () => repo,
      boardSecurity: async () => { securityResolves++; return null; },
      signalingFor: () => { throw new Error("must not open a room"); }
    });

    await manager.start("board").catch(() => undefined);
    const afterStart = securityResolves;
    await manager.stop();
    await manager.start("board").catch(() => undefined);
    console.log("securityResolves after start =", afterStart, "after stop+start =", securityResolves);

    // A deliberate stop ends the collaboration; the next start must try again.
    expect(securityResolves).toBeGreaterThan(afterStart);
  });
});
