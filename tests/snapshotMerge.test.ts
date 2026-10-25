import { describe, expect, it } from "vitest";
import type { BoardSnapshotV2 } from "../src/sync/snapshotV2";
import type { BoardItem } from "../src/types";
import { isStaleSnapshot, mergeSnapshotViews, type MergeResult } from "../src/sync/snapshotMerge";
import { getSnapshotMeta, publishSnapshotConditional, type DriveFetch } from "../src/sync/drivePublish";

const card = (id: string, updatedAt: string): BoardItem => ({ id, projectId: "b1", type: "task", content: "", status: "started", order: 0, createdAt: updatedAt, updatedAt });

const view = (overrides: Partial<BoardSnapshotV2>): BoardSnapshotV2 => ({
  format: "pboard-board-v2",
  schemaVersion: 2,
  boardId: "b1",
  appVersion: "0.11.0",
  exportedAt: "2026-01-01T00:00:00.000Z",
  snapshotSeq: 1,
  epoch: 1,
  writtenBy: { deviceKeyId: "d1", at: "2026-01-01T00:00:00.000Z" },
  checkpoints: {},
  watermarks: {},
  entities: { projects: [], cards: [], settings: [] },
  ...overrides
});

describe("split-brain snapshot repair", () => {
  it("keeps the higher-sequence base but never loses the other side's documents", () => {
    const leader = view({
      snapshotSeq: 9,
      epoch: 3,
      watermarks: { "device-A": 10, "device-B": 4 },
      entities: { projects: [], cards: [card("card-1", "2026-01-05T00:00:00.000Z"), card("card-2", "2026-01-02T00:00:00.000Z")], settings: [] }
    });
    // Stale leader overwrote Drive: lower sequence, but contains edits the
    // newer snapshot lost (card-3, newer card-2).
    const stale = view({
      snapshotSeq: 8,
      epoch: 2,
      watermarks: { "device-A": 12 },
      entities: { projects: [], cards: [card("card-2", "2026-01-03T00:00:00.000Z"), card("card-3", "2026-01-04T00:00:00.000Z")], settings: [] }
    });
    const merged = mergeSnapshotViews(leader, stale);
    const cards = Object.fromEntries(merged.entities.cards.map((card) => [card.id, card.updatedAt]));
    expect(cards).toEqual({ "card-1": "2026-01-05T00:00:00.000Z", "card-2": "2026-01-03T00:00:00.000Z", "card-3": "2026-01-04T00:00:00.000Z" });
    expect(merged.watermarks).toEqual({ "device-A": 12, "device-B": 4 });
    expect(merged.droppedVersions.filter((entry) => entry.id === "card-2")).toHaveLength(1);
  });

  it("is order-independent and idempotent", () => {
    const a = view({ snapshotSeq: 4, entities: { projects: [], cards: [card("x", "2026-01-01T00:00:00.000Z")], settings: [] } });
    const b = view({ snapshotSeq: 5, entities: { projects: [], cards: [card("x", "2026-01-02T00:00:00.000Z"), card("y", "2026-01-02T00:00:00.000Z")], settings: [] } });
    const key = (result: MergeResult) => JSON.stringify({ ...result, entities: { ...result.entities, cards: [...result.entities.cards].sort((l, r) => l.id.localeCompare(r.id)) } });
    expect(key(mergeSnapshotViews(a, b))).toBe(key(mergeSnapshotViews(b, a)));
    expect(key(mergeSnapshotViews(a, a))).toBe(key(mergeSnapshotViews(view({ snapshotSeq: 4, entities: a.entities }), a)));
    expect(isStaleSnapshot(b, a)).toBe(false);
    expect(isStaleSnapshot(a, b)).toBe(true);
  });
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("conditional Drive publishing", () => {
  it("maps Drive outcomes on the If-Match precondition", async () => {
    const cases: [number, string][] = [[200, "published"], [412, "conflict"], [409, "conflict"], [404, "missing"], [403, "forbidden"], [500, "error"]];
    for (const [status, expected] of cases) {
      const calls: { url: string; init?: Record<string, unknown> }[] = [];
      const fetcher: DriveFetch = async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(status, { id: "file-1", version: "rev-2" });
      };
      const outcome = await publishSnapshotConditional(fetcher, "file-1", "token", "rev-1", new Uint8Array([1, 2, 3]));
      expect(outcome.status).toBe(expected);
      expect((calls[0].init?.headers as Record<string, string>)["If-Match"]).toBe("rev-1");
      expect(calls[0].url).toContain("uploadType=media");
    }
  });

  it("reads metadata and treats a missing file as absent", async () => {
    const missing: DriveFetch = async () => jsonResponse(404, {});
    expect(await getSnapshotMeta(missing, "file-1", "token")).toBeNull();
    const found: DriveFetch = async () => jsonResponse(200, { id: "file-1", version: "rev-7", md5Checksum: "abc" });
    expect(await getSnapshotMeta(found, "file-1", "token")).toMatchObject({ version: "rev-7", md5Checksum: "abc" });
  });
});
