import { describe, expect, it } from "vitest";
import { createBufferClient, BufferClientError, type AuthMaterial } from "../src/sync/bufferClient";
import { BufferBackpressureError } from "../src/sync/bufferProtocol";
import { runPublishCycle, type PublishCycle } from "../src/sync/leaderLoop";
import { generateBoardContentKey, sealOp } from "../src/sync/bufferCrypto";
import { serializeBoardSnapshotV2 } from "../src/sync/snapshotV2";
import type { BoardItem, Project } from "../src/types";

const auth: AuthMaterial = {
  deviceKeyId: "device-A",
  session: "s1",
  signature: "sig",
  authority: { kty: "EC", crv: "P-256", x: "QQ", y: "RQ" },
  manifestPayload: "payload",
  manifestSignature: "manifest-sig"
};

const project: Project = { id: "b1", name: "Board", template: "project", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const card = (id: string, updatedAt = "2026-01-01T00:00:00.000Z"): BoardItem => ({ id, projectId: "b1", type: "task", content: "", status: "started", order: 0, createdAt: updatedAt, updatedAt });

describe("buffer client", () => {
  const routes = (handlers: Record<string, (body: Record<string, unknown>) => Response>) => async (url: string, init?: Record<string, unknown>) => {
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    return handler(JSON.parse(String((init?.body as string) ?? "{}")));
  };

  it("sends sealed ops without the local version marker and maps 429 to backpressure", async () => {
    let received: Record<string, unknown> | undefined;
    const client = createBufferClient({
      baseUrl: "https://signal.test",
      authorizer: { authorize: async () => auth },
      fetcher: routes({
        "/buffer/ops": (body) => {
          received = body;
          return new Response(JSON.stringify({ code: "buffer_full" }), { status: 429 });
        }
      })
    });
    await expect(client.transport().send("b1", [{ v: 1, opId: "device-A:1", keyId: "k", iv: "a", ct: "c" }])).rejects.toBeInstanceOf(BufferBackpressureError);
    const ops = received?.["ops"] as Record<string, unknown>[];
    expect(Object.keys(ops[0]).sort()).toEqual(["ct", "iv", "keyId", "opId"]);
    expect(received?.["deviceKeyId"]).toBe("device-A");
  });

  it("treats a busy lease as 'not now' and surfaces real errors", async () => {
    const client = createBufferClient({
      baseUrl: "https://signal.test",
      authorizer: { authorize: async () => auth },
      fetcher: routes({
        "/leader/claim": (body) => {
          if (body["board"] === "busy") return new Response(JSON.stringify({ code: "lease_busy" }), { status: 409 });
          if (body["board"] === "boom") return new Response(JSON.stringify({ code: "server_error" }), { status: 500 });
          return new Response(JSON.stringify({ epoch: 3, expiresAt: 1234 }), { status: 200 });
        }
      })
    });
    expect(await client.claim("b1")).toEqual({ epoch: 3, expiresAt: 1234 });
    expect(await client.claim("busy")).toBeNull();
    await expect(client.claim("boom")).rejects.toBeInstanceOf(BufferClientError);
  });
});

const makeCycle = async (overrides: Partial<PublishCycle> = {}) => {
  const key = await generateBoardContentKey();
  const calls: string[] = [];
  const op = await sealOp(key, "device-A:7", { document: { id: "card-9", projectId: "b1", type: "task", content: "buffered", status: "started", order: 1, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" } });
  const cycle: PublishCycle = {
    async claim() {
      calls.push("claim");
      return { epoch: 4 };
    },
    async meta() {
      calls.push("meta");
      return { etag: "rev-9", version: "rev-9" };
    },
    async download(board) {
      calls.push("download");
      return serializeBoardSnapshotV2({ projects: [project], cards: [card("card-1")], settings: [] }, { boardId: board, appVersion: "t", snapshotSeq: 5, epoch: 4, writtenBy: { deviceKeyId: "d0" } });
    },
    async listBuffered() {
      calls.push("list");
      return [op];
    },
    async contentKey() {
      return key;
    },
    async publish(_board, knownEtag) {
      calls.push(`publish:${knownEtag}`);
      return { status: "published", version: "rev-10" };
    },
    async commitOps(_board, epoch, ids) {
      calls.push(`commitOps:${epoch}:${ids.join(",")}`);
    },
    async leaderCommit(_board, epoch, snapshotSeq, driveEtag) {
      calls.push(`leaderCommit:${epoch}:${snapshotSeq}:${driveEtag}`);
      return { stale: false };
    },
    nowIso: () => "2026-01-03T00:00:00.000Z",
    ...overrides
  };
  return { cycle, calls };
};

describe("leader publish cycle", () => {
  it("merges buffered ops into the next snapshot and commits in order", async () => {
    const { cycle, calls } = await makeCycle();
    const outcome = await runPublishCycle("b1", cycle);
    expect(outcome).toEqual({ status: "published", snapshotSeq: 6, stale: false });
    expect(calls).toEqual([
      "claim",
      "meta",
      "download",
      "list",
      "publish:rev-9",
      "commitOps:4:device-A:7",
      "leaderCommit:4:6:rev-10"
    ]);
  });

  it("does not commit anything when the conditional upload conflicts", async () => {
    const { cycle, calls } = await makeCycle({
      async publish() {
        calls.push("publish");
        return { status: "conflict" };
      }
    });
    expect(await runPublishCycle("b1", cycle)).toEqual({ status: "conflict" });
    expect(calls.filter((call) => call.startsWith("commitOps") || call.startsWith("leaderCommit"))).toEqual([]);
  });

  it("stays silent without a lease and reports forbidden when Drive revokes writes", async () => {
    const busy = await makeCycle({ async claim() { return null; } });
    expect(await runPublishCycle("b1", busy.cycle)).toEqual({ status: "idle", reason: "lease-busy" });
    const forbidden = await makeCycle({
      async publish() {
        return { status: "forbidden" };
      }
    });
    expect(await runPublishCycle("b1", forbidden.cycle)).toEqual({ status: "forbidden" });
  });

  it("treats a clean board with an empty buffer as idle work", async () => {
    const { cycle } = await makeCycle({ async listBuffered() { return []; } });
    expect(await runPublishCycle("b1", cycle)).toEqual({ status: "idle", reason: "clean" });
  });
});
