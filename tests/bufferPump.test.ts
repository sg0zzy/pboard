import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  exportBoardContentKey,
  generateBoardContentKey,
  importBoardContentKey,
  openOp,
  sealOp
} from "../src/sync/bufferCrypto";
import { BufferBackpressureError, createBufferPump, type BufferTransport } from "../src/sync/bufferProtocol";
import type { SealedOp } from "../src/sync/bufferCrypto";
import { createContentKeyStore } from "../src/storage/contentKeyStore";

const manualSchedule = () => {
  const pending: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      pending.push(fn);
      return () => undefined;
    },
    runPending: () => pending.splice(0, pending.length).forEach((fn) => fn())
  };
};

describe("buffer op encryption envelope", () => {
  it("round-trips, binds the op id, and rejects foreign or tampered records", async () => {
    const key = await generateBoardContentKey();
    const sealed = await sealOp(key, "device-A:1", { value: 7 });
    expect(await openOp(key, sealed)).toEqual({ value: 7 });

    const other = await generateBoardContentKey();
    await expect(openOp(other, sealed)).rejects.toThrow(/different content key/);

    const tampered = { ...sealed, ct: sealed.ct.slice(0, -4) + (sealed.ct.endsWith("A") ? "B" : "A") + sealed.ct.slice(-2) };
    await expect(openOp(key, tampered)).rejects.toThrow();

    const rebound = { ...sealed, opId: "device-A:2" };
    await expect(openOp(key, rebound)).rejects.toThrow();
  });

  it("exports and re-imports keys to the same fingerprint", async () => {
    const key = await generateBoardContentKey();
    const material = await exportBoardContentKey(key.key);
    const restored = await importBoardContentKey(material);
    expect(restored.keyId).toBe(key.keyId);
    const sealed = await sealOp(restored, "x:1", { ok: true });
    expect(await openOp(key, sealed)).toEqual({ ok: true });
  });
});

describe("buffer pump", () => {
  const fakeSeal = async (opId: string): Promise<SealedOp> => ({ v: 1, opId, keyId: "k", iv: "a", ct: "c" });

  it("batches, preserves order, and drops only acknowledged ops", async () => {
    const sent: string[][] = [];
    let resolveSend: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const transport: BufferTransport = {
      async send(_board, ops) {
        await gate;
        sent.push(ops.map((op) => op.opId));
      }
    };
    const pump = createBufferPump({ boardId: "b", seal: fakeSeal, transport, maxBatchOps: 3 });
    for (let i = 1; i <= 7; i += 1) pump.enqueue(`a:${i}`, { i });
    pump.enqueue("a:3", { i: 3 });
    expect(pump.pending()).toBe(7);
    resolveSend?.();
    await pump.flush();
    expect(sent).toEqual([["a:1", "a:2", "a:3"], ["a:4", "a:5", "a:6"], ["a:7"]]);
    expect(pump.pending()).toBe(0);
  });

  it("retries in order after failure and honors backpressure without dropping", async () => {
    const attempts: string[][] = [];
    let failures = 2;
    const scheduler = manualSchedule();
    const transport: BufferTransport = {
      async send(_board, ops) {
        attempts.push(ops.map((op) => op.opId));
        if (failures === 1 && attempts.length === 2) throw new BufferBackpressureError("b");
        if (failures > 0) {
          failures -= 1;
          throw new Error("network");
        }
      }
    };
    const pump = createBufferPump({ boardId: "b", seal: fakeSeal, transport, maxBatchOps: 2, schedule: scheduler.schedule });
    pump.enqueue("a:1", { i: 1 });
    pump.enqueue("a:2", { i: 2 });
    pump.enqueue("a:3", { i: 3 });
    // Pump scheduling is injected (fake); microtasks alone settle each retry hop.
    for (let i = 0; i < 4; i += 1) {
      for (let hop = 0; hop < 8; hop += 1) await Promise.resolve();
      scheduler.runPending();
    }
    await pump.flush();
    expect(attempts[0]).toEqual(["a:1", "a:2"]);
    expect(attempts[1]).toEqual(["a:1", "a:2"]);
    expect(attempts[attempts.length - 1]).toEqual(["a:3"]);
    expect(pump.pending()).toBe(0);
  });

  it("stop keeps pending ops for the next session instead of dropping mid-queue", async () => {
    const scheduler = manualSchedule();
    let attempted = 0;
    const transport: BufferTransport = {
      async send() {
        attempted += 1;
        throw new Error("offline");
      }
    };
    const pump = createBufferPump({ boardId: "b", seal: fakeSeal, transport, schedule: scheduler.schedule });
    pump.enqueue("a:1", {});
    for (let round = 0; round < 3; round += 1) {
      for (let hop = 0; hop < 8; hop += 1) await Promise.resolve();
      scheduler.runPending();
    }
    expect(attempted).toBeGreaterThanOrEqual(3);
    expect(pump.pending()).toBe(1);
    await pump.stop();
    expect(pump.pending()).toBe(1);
    expect(() => pump.enqueue("a:2", {})).toThrow(/stopped/);
  });
});

describe("content key store", () => {
  it("ensures a stable key per board, restores it, and accepts shared material", async () => {
    const store = createContentKeyStore();
    const created = await store.ensure("board-x");
    const again = await store.ensure("board-x");
    expect(again.keyId).toBe(created.keyId);
    const material = await exportBoardContentKey(created.key);
    const other = createContentKeyStore();
    const imported = await other.put("board-x", material);
    expect(imported.keyId).toBe(created.keyId);
    await other.remove("board-x");
    expect(await store.get("board-x")).toBeUndefined();
  });
});
