import { expect, it, describe } from "vitest";
import { mergeProjectOrder, parseProjectOrder } from "../src/storage/projectOrder";

const pref = (ids: string[], updatedAt: string, deleted: string[] = [], restoreEvents?: Record<string, string>) =>
  ({ ids, updatedAt, ...(deleted.length ? { deletedProjectIds: deleted } : {}), ...(restoreEvents ? { restoreEvents } : {}) });

describe("project order preference merge with restore events", () => {
  it("a timestamped restore keeps the board visible against older deletion markers from any device", () => {
    const current = pref(["a", "b"], "2026-10-19T10:00:00.000Z", ["b"]);
    const incoming = pref(["a", "b"], "2026-10-20T09:00:00.000Z", ["b"], { b: "2026-10-20T12:00:00.000Z" });
    const merged = mergeProjectOrder(current, incoming);
    expect(merged.deletedProjectIds ?? []).not.toContain("b");
    expect(merged.ids).toContain("b");
    expect(merged.restoreEvents?.b).toBe("2026-10-20T12:00:00.000Z");
  });

  it("a deletion newer than the last restore wins again", () => {
    const current = pref(["a", "b"], "2026-10-20T12:00:00.000Z", [], { b: "2026-10-20T09:00:00.000Z" });
    const incoming = pref(["a", "b"], "2026-10-20T13:00:00.000Z", ["b"]);
    const merged = mergeProjectOrder(current, incoming);
    expect(merged.deletedProjectIds).toContain("b");
    expect(merged.ids).not.toContain("b");
  });

  it("legacy permanent deletion markers without restore events keep their old semantics", () => {
    const current = pref(["a", "b"], "2026-10-01T00:00:00.000Z", ["b"]);
    const incoming = pref(["a", "b"], "2026-10-18T00:00:00.000Z");
    const merged = mergeProjectOrder(current, incoming);
    expect(merged.deletedProjectIds).toContain("b");
    // And parsing old data still round-trips without restore keys.
    expect(parseProjectOrder(JSON.stringify(merged)).restoreEvents).toBeUndefined();
  });

  it("concurrent restores keep the latest restore time and both visibility outcomes agree", () => {
    const a = pref(["a", "b"], "2026-10-20T08:00:00.000Z", ["b"], { b: "2026-10-20T10:00:00.000Z" });
    const b = pref(["a", "b"], "2026-10-20T08:00:00.000Z", ["b"], { b: "2026-10-20T11:00:00.000Z" });
    const merged = mergeProjectOrder(a, b);
    expect(merged.restoreEvents?.b).toBe("2026-10-20T11:00:00.000Z");
    expect(merged.ids).toContain("b");
  });
});