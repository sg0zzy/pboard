import { afterEach, describe, expect, it, vi } from "vitest";
import type { PboardSignaling } from "../src/collab/signaling";

const mock = vi.hoisted(() => {
  class Peer {
    static instances: Peer[] = [];
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    signal = vi.fn();
    send = vi.fn();
    destroy = vi.fn(() => this.emit("close"));
    constructor() { Peer.instances.push(this); }
    on(event: string, callback: (...args: any[]) => void) {
      this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]);
    }
    emit(event: string, ...args: unknown[]) { this.listeners.get(event)?.forEach(callback => callback(...args)); }
  }
  return { Peer };
});
vi.mock("simple-peer/simplepeer.min.js", () => ({ default: mock.Peer }));
import { createPboardWebRTCConnectionHandler } from "../src/collab/webrtcHandler";

async function session(beforeReconnect?: () => Promise<void>) {
  vi.useFakeTimers();
  mock.Peer.instances = [];
  let roster!: (ids: string[]) => void;
  let signal!: (from: string, data: unknown) => void;
  const signaling: PboardSignaling = {
    async join(callback) { roster = callback; return { peerId: "b", peers: ["a"] }; },
    onSignal(callback) { signal = callback; },
    sendSignal: vi.fn(async () => {}),
    leave: vi.fn(async () => {})
  };
  const handler = await createPboardWebRTCConnectionHandler({ signaling, beforeReconnect })();
  const errors: string[] = [];
  handler.error$.subscribe(error => errors.push(String(error.parameters.errorText)));
  return { handler, errors, signaling, roster, signal, peer: mock.Peer.instances[0] };
}

afterEach(() => { vi.useRealTimers(); });

describe("WebRTC automatic reconnection", () => {
  it("waits two seconds after failure, even with roster updates, and retains incoming offers", async () => {
    const s = await session();
    try {
      s.peer.emit("error", new Error("Connection failed"));
      expect(s.errors).toEqual(["Error: Connection failed"]);
      s.roster(["a"]);
      const offer = { type: "offer", sdp: "fresh offer" };
      s.signal("a", offer);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(mock.Peer.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mock.Peer.instances).toHaveLength(2);
      expect(mock.Peer.instances[1].signal).toHaveBeenCalledWith(offer);
      // A late callback from the failed instance must not discard its replacement.
      s.peer.emit("close");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mock.Peer.instances).toHaveLength(2);
      mock.Peer.instances[1].emit("error", new Error("Connection failed again"));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(mock.Peer.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mock.Peer.instances).toHaveLength(3);
    } finally { await s.handler.close(); }
  });

  it("recovers from an orderly remote SCTP close without surfacing an error", async () => {
    const s = await session();
    try {
      s.peer.emit("error", new Error("OperationError: User-Initiated Abort, reason=Close called"));
      expect(s.errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mock.Peer.instances).toHaveLength(2);
      mock.Peer.instances[1].emit("error", new Error("OperationError: transport failed"));
      expect(s.errors).toEqual(["Error: OperationError: transport failed"]);
    } finally { await s.handler.close(); }
  });

  it("awaits Drive catch-up before recreating a peer, buffering offers while it reads", async () => {
    let complete!: () => void;
    const refresh = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const s = await session(refresh);
    try {
      s.peer.emit("close");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      s.roster(["a"]);
      const offer = { type: "offer", sdp: "offer during Drive read" };
      s.signal("a", offer);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mock.Peer.instances).toHaveLength(1);
      complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.Peer.instances).toHaveLength(2);
      expect(mock.Peer.instances[1].signal).toHaveBeenCalledWith(offer);
    } finally { await s.handler.close(); }
  });

  it("still retries WebRTC after a failed Drive read and reports the refresh failure", async () => {
    const s = await session(async () => { throw new Error("Drive offline"); });
    try {
      s.peer.emit("close");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mock.Peer.instances).toHaveLength(2);
      expect(s.errors).toEqual(["Drive refresh before reconnect failed: Error: Drive offline"]);
    } finally { await s.handler.close(); }
  });

  it("does not recreate a peer when closed during the Drive request", async () => {
    let complete!: () => void;
    const s = await session(() => new Promise<void>(resolve => { complete = resolve; }));
    s.peer.emit("close");
    await vi.advanceTimersByTimeAsync(2_000);
    await s.handler.close();
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.Peer.instances).toHaveLength(1);
    expect(s.errors).toEqual([]);
  });

  it("cancels pending retries and ignores late errors/signals during shutdown", async () => {
    const s = await session();
    s.peer.emit("close");
    await s.handler.close();
    s.peer.emit("error", new Error("OperationError: User-Initiated Abort, reason=Close called"));
    s.peer.emit("signal", { type: "offer" });
    s.roster(["a"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.Peer.instances).toHaveLength(1);
    expect(s.signaling.sendSignal).not.toHaveBeenCalled();
    expect(s.errors).toEqual([]);
  });
});
