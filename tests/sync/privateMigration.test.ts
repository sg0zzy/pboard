/**
 * Legacy migration engine: resumability at every step boundary (now including
 * read-back verification), the flip happening exactly once and never over an
 * unverified snapshot, and the 90-day read-only window.
 */
import { describe, expect, it } from "vitest";
import { cleanupDue, finishMigration, migratePrivateBoard, READ_ONLY_WINDOW_MS, type MigrationDeps, type MigrationState } from "../../src/sync/privateMigration";

function harness(fault: { at: string | null; verifyFails?: number } = { at: null }) {
  let state: MigrationState | undefined;
  const calls: string[] = [];
  const boom = (step: string) => { if (fault.at === step) throw new Error("offline"); };
  let verifyAttempts = 0;
  const deps: MigrationDeps = {
    loadState: async () => state ? { ...state } : undefined,
    saveState: async (next) => { state = { ...next }; },
    clearState: async () => { state = undefined; },
    exportBoard: async () => { calls.push("export"); boom("export"); return new Uint8Array([1]); },
    ensureFolder: async () => { calls.push("folder"); boom("folder"); return "folder-1"; },
    uploadSnapshot: async () => { calls.push("snapshot"); boom("snapshot"); return `file-${calls.filter(c => c === "snapshot").length}`; },
    uploadHistory: async () => { calls.push("history"); boom("history"); },
    verifySnapshot: async () => {
      calls.push("verify"); boom("verify");
      verifyAttempts += 1;
      if (fault.verifyFails !== undefined && verifyAttempts <= fault.verifyFails) throw new Error("read-back mismatch");
    },
    flipTarget: async () => { calls.push("flip"); boom("flip"); },
    sealSource: async () => { calls.push("seal"); },
    now: () => 1_000
  };
  return { deps, calls, state: () => state };
}

describe("private board migration", () => {
  it("runs the full ladder once each, verifies before the flip, and seals with a timestamp", async () => {
    const h = harness();
    const final = await migratePrivateBoard(h.deps, "p1");
    expect(h.calls).toEqual(["folder", "export", "snapshot", "history", "verify", "flip", "seal"]);
    expect(final).toEqual({ projectId: "p1", step: "sealed", folderId: "folder-1", fileId: "file-1", sealedAt: 1_000 });
    // Re-running a finished migration does nothing.
    await migratePrivateBoard(h.deps, "p1");
    expect(h.calls).toEqual(["folder", "export", "snapshot", "history", "verify", "flip", "seal"]);
  });

  it("resumes from every failure point without repeating completed steps", async () => {
    for (const failAt of ["folder", "snapshot", "history", "verify", "flip"]) {
      const fault = { at: failAt as string | null };
      const h = harness(fault);
      await expect(migratePrivateBoard(h.deps, "p1")).rejects.toThrow("offline");
      fault.at = null;
      const final = await migratePrivateBoard(h.deps, "p1");
      expect(final.step).toBe("sealed");
      const counts = new Map<string, number>();
      for (const call of h.calls) counts.set(call, (counts.get(call) ?? 0) + 1);
      for (const [step, count] of counts) {
        // A failed snapshot upload re-exports (fresh bytes) on resume; a failed
        // verification additionally retries once inside the first pass (3
        // verify calls total); everything else runs exactly once.
        const expected = step === failAt
          ? failAt === "verify" ? 3 : 2
          : (failAt === "snapshot" && step === "export") || (failAt === "verify" && (step === "export" || step === "snapshot")) ? 2 : 1;
        expect(count, `${failAt}: ${step}`).toBe(expected);
      }
    }
  });

  it("re-uploads once when the read-back does not match, and only then flips", async () => {
    const h = harness({ at: null, verifyFails: 1 });
    const final = await migratePrivateBoard(h.deps, "p1");
    expect(final.step).toBe("sealed");
    expect(h.calls.filter(c => c === "verify")).toHaveLength(2);
    expect(h.calls.filter(c => c === "snapshot")).toHaveLength(2); // replacement upload
    expect(h.calls.indexOf("flip")).toBeGreaterThan(h.calls.lastIndexOf("verify"));
    expect(final.fileId).toBe("file-2");
  });

  it("never flips while verification keeps failing and leaves the step resumable", async () => {
    const h = harness({ at: null, verifyFails: 99 });
    await expect(migratePrivateBoard(h.deps, "p1")).rejects.toThrow("read-back mismatch");
    expect(h.state()!.step).toBe("history");
    expect(h.calls).not.toContain("flip");
    expect(h.calls).not.toContain("seal");
  });

  it("keeps the source read-only for the full window", async () => {
    const h = harness();
    const final = await migratePrivateBoard(h.deps, "p1");
    expect(cleanupDue(final, 1_000 + READ_ONLY_WINDOW_MS - 1)).toBe(false);
    expect(cleanupDue(final, 1_000 + READ_ONLY_WINDOW_MS)).toBe(true);
    await expect(finishMigration(h.deps, "p1", 1_000 + READ_ONLY_WINDOW_MS - 1)).rejects.toThrow(/window/);
    expect(await finishMigration(h.deps, "p1", 1_000 + READ_ONLY_WINDOW_MS)).toBe(true);
    expect(h.state()).toBeUndefined();
    expect(await finishMigration(h.deps, "p1", 1_000 + READ_ONLY_WINDOW_MS)).toBe(false);
  });
});
