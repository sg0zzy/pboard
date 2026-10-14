import { describe, expect, it, vi } from "vitest";
import type { RxReplicationHandler } from "rxdb";
import { scopeMasterChanges } from "../src/collab/scopedPull";

type Doc = { id: string; projectId: string; _deleted: boolean };
function source(projects: string[]) {
  const rows = projects.map((projectId, index): Doc => ({ id: String(index), projectId, _deleted: false }));
  const read = vi.fn(async (checkpoint: number | undefined, batchSize: number) => {
    const start = checkpoint ?? 0;
    return { documents: rows.slice(start, start + batchSize), checkpoint: Math.min(start + batchSize, rows.length) };
  });
  const handler: Pick<RxReplicationHandler<Doc, number>, "masterChangesSince"> = { masterChangesSince: read };
  scopeMasterChanges(handler, doc => (doc as Doc).projectId === "shared");
  return { handler, read };
}

describe("project-scoped catch-up", () => {
  it("passes full unrelated batches and fills a mixed batch before returning", async () => {
    const { handler, read } = source([...Array<string>(201).fill("private"), "shared", "private", "shared", "shared"]);
    const first = await handler.masterChangesSince(undefined, 2);
    expect(first.documents.map(doc => doc.id)).toEqual(["201", "203"]);
    expect(first.checkpoint).toBe(204);
    const last = await handler.masterChangesSince(first.checkpoint, 2);
    expect(last.documents.map(doc => doc.id)).toEqual(["204"]);
    expect(last.checkpoint).toBe(205);
    expect(read.mock.calls.length).toBeGreaterThan(100);
  });

  it("returns an empty batch at the end when no documents match", async () => {
    const { handler } = source(Array<string>(200).fill("private"));
    const result = await handler.masterChangesSince(undefined, 100);
    expect(result).toEqual({ documents: [], checkpoint: 200 });
  });

  it("keeps tombstones and checkpoints while preserving the requested batch size", async () => {
    const { handler, read } = source(["private", "shared", "shared", "shared"]);
    // A soft/hard deletion is still a replication document in its project.
    read.mockImplementationOnce(async () => ({ documents: [
      { id: "0", projectId: "private", _deleted: false },
      { id: "1", projectId: "shared", _deleted: true }
    ], checkpoint: 2 }));
    const result = await handler.masterChangesSince(undefined, 2);
    expect(result.documents).toEqual([
      { id: "1", projectId: "shared", _deleted: true },
      { id: "2", projectId: "shared", _deleted: false }
    ]);
    expect(result.checkpoint).toBe(3);
    expect((await handler.masterChangesSince(result.checkpoint, 2)).documents.map(doc => doc.id)).toEqual(["3"]);
  });
});
