import { describe, expect, it } from "vitest";
import { planStartup, watermarksFromOpIds } from "../../src/sync/startupReconcile";

describe("startup reconciliation ladder", () => {
  it("bootstraps an empty board and flags the first writer as leader candidate", () => {
    const empty = planStartup({ snapshot: null, snapshotEtag: null, lastSeenEtag: null, localWatermarks: {}, hasLocalData: false });
    expect(empty).toEqual({ pullSnapshot: false, collectBuffer: false, leaderCandidate: false, bootstrap: true });
    const local = planStartup({ snapshot: null, snapshotEtag: null, lastSeenEtag: null, localWatermarks: {}, hasLocalData: true });
    expect(local).toEqual({ pullSnapshot: false, collectBuffer: false, leaderCandidate: true, bootstrap: false });
  });

  it("pulls only when a device published beyond the local watermarks", () => {
    const facts = {
      snapshot: { snapshotSeq: 4, watermarks: { "device-a": 12, "device-b": 3 } },
      snapshotEtag: "v4", lastSeenEtag: "v4",
      localWatermarks: { "device-a": 12, "device-b": 3 }, hasLocalData: true
    };
    expect(planStartup(facts)).toEqual({ pullSnapshot: false, collectBuffer: false, leaderCandidate: false, bootstrap: false });
    expect(planStartup({ ...facts, localWatermarks: { "device-a": 12 } }).pullSnapshot).toBe(true);
    expect(planStartup({ ...facts, localWatermarks: { "device-a": 12, "device-b": 2 } }).pullSnapshot).toBe(true);
  });

  it("touches the buffer only when the snapshot revision moved or a pull is needed", () => {
    const facts = {
      snapshot: { snapshotSeq: 4, watermarks: { "device-a": 12 } },
      snapshotEtag: "v4", lastSeenEtag: "v3",
      localWatermarks: { "device-a": 12 }, hasLocalData: true
    };
    expect(planStartup(facts).collectBuffer).toBe(true);
    expect(planStartup({ ...facts, lastSeenEtag: "v4" }).collectBuffer).toBe(false);
    // A needed pull always collects buffered ops too.
    const behind = { ...facts, lastSeenEtag: "v4", localWatermarks: {} as Record<string, number> };
    const plan = planStartup(behind);
    expect(plan.pullSnapshot && plan.collectBuffer).toBe(true);
  });

  it("parses device:seq watermarks and ignores non-sequence op ids", () => {
    expect(watermarksFromOpIds(["dev-1:3", "dev-1:9", "dev-2:1", "plainhash", ":5", "x:notanumber"])).toEqual({ "dev-1": 9, "dev-2": 1 });
  });
});
