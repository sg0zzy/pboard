/**
 * Buffer runtime scheduling semantics: nothing happens until a journal
 * notification fires; one notification drains committed entries into the
 * buffer and arms exactly one publish cycle; non-writers send nothing; a
 * stopped runtime is inert.
 */
import { describe, expect, it } from "vitest";
import { createBufferRuntime } from "../../src/sync/bufferRuntime";
import { generateBoardContentKey, openOp, type SealedOp } from "../../src/sync/bufferCrypto";
import { deserializeBoardSnapshotV2 } from "../../src/sync/snapshotV2";
import type { BufferClient } from "../../src/sync/bufferClient";

type FakeServer = {
  ops: Map<string, SealedOp>;
  committed: string[];
  leaseTaken: boolean;
  snapshot: Uint8Array | null;
};

function fixture(options: { writer?: boolean; entries?: { opId: string; document: Record<string, unknown> }[] } = {}) {
  const server: FakeServer = { ops: new Map(), committed: [], leaseTaken: false, snapshot: null };
  const keyRef: { keyId: string; key: CryptoKey } = { keyId: "0123456789abcdef", key: null as unknown as CryptoKey };
  const entries = [...(options.entries ?? [
    { opId: "device-1:0", document: { id: "project-1", collection: "projects", updatedAt: "2026-01-01T00:00:00.000Z" } },
    { opId: "device-1:1", document: { id: "card-1", projectId: "project-1", collection: "cards", updatedAt: "2026-01-01T00:00:00.000Z" } }
  ])];
  const listeners: (() => void)[] = [];
  const scheduled: (() => void)[] = [];
  const client: BufferClient = {
    transport: () => ({ send: async (_board: string, batch: SealedOp[]) => { for (const op of batch) server.ops.set(op.opId, op); } }),
    listOps: async () => [...server.ops.values()].filter(op => !server.committed.includes(op.opId)),
    commitOps: async (_board, _epoch, ids) => { server.committed.push(...ids); ids.forEach(id => server.ops.delete(id)); return ids.length; },
    claim: async () => {
      if (server.leaseTaken) return null;
      server.leaseTaken = true;
      return { epoch: 7, expiresAt: Date.now() + 45000 };
    },
    observe: async () => undefined,
    leaderCommit: async () => ({ stale: false })
  };
  const runtime = createBufferRuntime({
    boardId: "board-1",
    isWriter: () => options.writer ?? true,
    contentKey: async () => keyRef.key ? keyRef : undefined,
    committedOps: async () => entries,
    subscribe: (next) => { listeners.push(next); return () => { const i = listeners.indexOf(next); if (i >= 0) listeners.splice(i, 1); }; },
    client,
    drive: {
      meta: async () => null,
      download: async () => server.snapshot,
      publish: async (_board, _etag, bytes) => { server.snapshot = bytes; return { status: "published" as const, version: "2" }; }
    },
    schedule: (fn) => { scheduled.push(fn); return () => { const i = scheduled.indexOf(fn); if (i >= 0) scheduled.splice(i, 1); }; },
    publishIntervalMs: 10
  });
  return { server, keyRef, runtime, scheduled, notify: () => listeners.forEach(l => l()) };
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 10));
}

describe("buffer runtime", () => {
  it("stays silent until the journal fires, then buffers and publishes once", async () => {
    const f = fixture();
    const real = await generateBoardContentKey();
    f.keyRef.key = real.key;
    (f.keyRef as { keyId: string }).keyId = real.keyId;
    f.runtime.start();
    await flush();
    expect(f.server.ops.size).toBe(0);
    expect(f.scheduled.length).toBe(0);

    f.notify();
    await flush(40);
    expect(f.server.ops.size).toBe(2);
    // The wire copy is genuinely encrypted under the board key.
    const opened = await openOp(real, f.server.ops.get("device-1:1")!);
    expect((opened as { document: { id: string } }).document.id).toBe("card-1");
    // The armed scheduler holds the publish cycle; running it publishes and commits.
    expect(f.scheduled.length).toBe(1);
    f.scheduled.shift()!();
    await flush(30);
    expect(f.server.committed).toEqual(["device-1:0", "device-1:1"]);
    expect(f.server.snapshot).not.toBeNull();
    const snapshot = await deserializeBoardSnapshotV2(f.server.snapshot!, { expectBoardId: "board-1" });
    expect(snapshot.entities.cards).toHaveLength(1);
    expect(snapshot.entities.projects).toHaveLength(1);
    await f.runtime.stop();
  });

  it("does nothing for non-writers and after stop", async () => {
    const readOnly = fixture({ writer: false });
    readOnly.runtime.start();
    readOnly.notify();
    await flush();
    expect(readOnly.server.ops.size).toBe(0);
    expect(readOnly.scheduled.length).toBe(0);

    const f = fixture();
    const real = await generateBoardContentKey();
    f.keyRef.key = real.key;
    (f.keyRef as { keyId: string }).keyId = real.keyId;
    f.runtime.start();
    await f.runtime.stop();
    f.notify();
    await flush();
    expect(f.server.ops.size).toBe(0);
    expect(f.scheduled.length).toBe(0);
  });

  it("holds no unbounded queue: repeat notifications reuse one armed cycle", async () => {
    const f = fixture();
    const real = await generateBoardContentKey();
    f.keyRef.key = real.key;
    (f.keyRef as { keyId: string }).keyId = real.keyId;
    f.runtime.start();
    f.notify();
    await flush(40);
    const armedOnce = f.scheduled.length;
    f.notify();
    f.notify();
    await flush();
    // At most the original cycle plus the flush-triggered one; never per-event.
    expect(f.scheduled.length).toBeLessThanOrEqual(armedOnce + 1);
    await f.runtime.stop();
  });
});
