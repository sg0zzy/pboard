import { describe, expect, it } from "vitest";
import type { BoardItem, Project } from "../src/types";
import {
  BOARD_SNAPSHOT_FORMAT,
  collectionDigests,
  deserializeBoardSnapshotV2,
  serializeBoardSnapshotV2,
  v1SnapshotToEntities,
  v2EntitiesToV1
} from "../src/sync/snapshotV2";
import type { ProjectSnapshot } from "../src/sync/snapshot";
const project: Project = {
  id: "board-1",
  name: "Roadmap",
  template: "project",
  revision: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z"
};

const items: BoardItem[] = [
  { id: "card-2", projectId: "board-1", type: "task", title: "B", content: "", status: "done", order: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
  { id: "card-1", projectId: "board-1", type: "task", title: "A", content: "", status: "started", order: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }
];

const entities = { projects: [project], cards: items, settings: [] };
const meta = { boardId: "board-1", appVersion: "0.11.0", snapshotSeq: 7, epoch: 2, writtenBy: { deviceKeyId: "device-A" } };

describe("board snapshot v2 codec", () => {
  it("round-trips through gzip preserving documents and metadata", async () => {
    const bytes = await serializeBoardSnapshotV2(entities, { ...meta, watermarks: { "device-A": 41, "device-B": 3 } });
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    const parsed = await deserializeBoardSnapshotV2(bytes, { expectBoardId: "board-1" });
    expect(parsed.format).toBe(BOARD_SNAPSHOT_FORMAT);
    expect(parsed.snapshotSeq).toBe(7);
    expect(parsed.epoch).toBe(2);
    expect(parsed.watermarks).toEqual({ "device-A": 41, "device-B": 3 });
    expect(parsed.entities.cards.map((card) => card.id)).toEqual(["card-2", "card-1"]);
    expect(parsed.entities.projects[0].id).toBe("board-1");
  });

  it("compresses repetitive board text", async () => {
    const big = { projects: [project], cards: Array.from({ length: 2000 }, (_, i) => ({ ...items[0], id: `card-${i}`, title: "a title repeated many times" })), settings: [] };
    const bytes = await serializeBoardSnapshotV2(big, meta);
    const json = JSON.stringify(big).length;
    expect(bytes.byteLength * 4 < json).toBe(true);
  });

  it("produces order-stable digests and rejects foreign or corrupt payloads", async () => {
    const a = await collectionDigests({ projects: [], cards: [items[0], items[1]], settings: [] });
    const b = await collectionDigests({ projects: [], cards: [items[1], items[0]], settings: [] });
    expect(a.cards.digest).toBe(b.cards.digest);
    expect(a.cards.digest.startsWith("sha256:")).toBe(true);

    const bytes = await serializeBoardSnapshotV2(entities, meta);
    await expect(deserializeBoardSnapshotV2(bytes, { expectBoardId: "other-board" })).rejects.toThrow(/different board/);
    await expect(deserializeBoardSnapshotV2(new TextEncoder().encode(JSON.stringify({ format: "pboard-project", version: 1 })))).rejects.toThrow(/pboard-board-v2/);
    await expect(deserializeBoardSnapshotV2(bytes.slice(0, bytes.byteLength - 8))).rejects.toThrow();
    await expect(deserializeBoardSnapshotV2(bytes, { maxFileBytes: 64 })).rejects.toThrow(/size limit/);
  });

  it("accepts an uncompressed v2 body (externally edited Drive file)", async () => {
    const bytes = await serializeBoardSnapshotV2(entities, meta);
    const parsed = await deserializeBoardSnapshotV2(bytes, { expectBoardId: "board-1" });
    const plain = new TextEncoder().encode(JSON.stringify(parsed));
    const reparsed = await deserializeBoardSnapshotV2(plain);
    expect(reparsed.entities.cards.length).toBe(2);
  });

  it("upgrades v1 to v2 entities and back without loss", async () => {
    const v1: ProjectSnapshot = { format: "pboard-project", version: 1, exportedAt: "2026-01-02T00:00:00.000Z", project, items };
    const upgraded = v1SnapshotToEntities(v1);
    const bytes = await serializeBoardSnapshotV2(upgraded, meta);
    const parsed = await deserializeBoardSnapshotV2(bytes);
    expect(parsed.entities.projects[0].name).toBe("Roadmap");
    const back = v2EntitiesToV1(parsed.entities, v1.exportedAt);
    expect(back.items.map((item) => item.id)).toEqual(v1.items.map((item) => item.id));
    expect(back.project).toEqual(project);
    expect(() => v2EntitiesToV1({ projects: [], cards: [], settings: [] }, "x")).toThrow(/single-project/);
  });
});
