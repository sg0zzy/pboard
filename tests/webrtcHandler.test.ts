import NodeDataChannel from "node-datachannel/polyfill";
import { afterEach, describe, expect, it } from "vitest";
import type { SimplePeerWrtc, WebRTCConnectionHandler, WebRTCMessage } from "rxdb/plugins/replication-webrtc";
import { createPboardWebRTCConnectionHandler, type PboardPeer } from "../src/collab/webrtcHandler";
import { createMemorySignalingScope, type PboardSignaling, type PboardSignal } from "../src/collab/signaling";

// libwebrtc JSEP state numbering (kUnknown = 0). The sidebar error
// "Cannot set a local answer in 0" is an answer applied while the state machine was
// still `new`: the instance had no pending offer, so nothing could answer it.
// node-datachannel auto-creates an offer at construction and skips the state check for
// non-offer descriptions, so the violation is only observable through an explicit check.
const STATE_INDEX: Record<string, number> = {
  new: 0,
  stable: 1,
  "have-local-offer": 2,
  "have-remote-offer": 3,
  "have-local-pranswer": 4,
  "have-remote-pranswer": 5,
  closed: 6
};

class SpecPeerConnection extends NodeDataChannel.RTCPeerConnection {
  jsepState = "new";

  async createOffer(): Promise<globalThis.RTCSessionDescriptionInit> {
    if (!["new", "stable", "have-local-pranswer"].includes(this.jsepState)) {
      throw new DOMException(`Cannot create a local offer in ${STATE_INDEX[this.jsepState]}`, "InvalidStateError");
    }
    const offer = await super.createOffer();
    return { type: "offer", sdp: offer.sdp };
  }

  async createAnswer(): Promise<globalThis.RTCSessionDescriptionInit> {
    if (this.jsepState !== "have-remote-offer") {
      throw new DOMException(`Cannot set a local answer in ${STATE_INDEX[this.jsepState]}`, "InvalidStateError");
    }
    const answer = await super.createAnswer();
    return { type: "answer", sdp: answer.sdp };
  }

  async setLocalDescription(description: globalThis.RTCSessionDescriptionInit): Promise<void> {
    if (description?.type === "answer") {
      if (this.jsepState !== "have-remote-offer") {
        throw new DOMException(`Cannot set a local answer in ${STATE_INDEX[this.jsepState]}`, "InvalidStateError");
      }
      this.jsepState = "stable";
    } else if (description?.type === "offer") {
      if (!["new", "stable", "have-local-pranswer"].includes(this.jsepState)) {
        throw new DOMException(`Cannot set a local offer in ${STATE_INDEX[this.jsepState]}`, "InvalidStateError");
      }
      this.jsepState = "have-local-offer";
    }
    await super.setLocalDescription(description);
  }

  async setRemoteDescription(description: globalThis.RTCSessionDescriptionInit): Promise<void> {
    if (description?.type === "answer") {
      if (this.jsepState !== "have-local-offer") {
        throw new DOMException(`Cannot set a remote answer in ${STATE_INDEX[this.jsepState]}`, "InvalidStateError");
      }
      this.jsepState = "stable";
    } else if (description?.type === "offer") {
      if (!["new", "stable", "have-remote-pranswer"].includes(this.jsepState)) {
        throw new DOMException(`Cannot set a remote offer in ${STATE_INDEX[this.jsepState]}`, "InvalidStateError");
      }
      this.jsepState = "have-remote-offer";
    }
    await super.setRemoteDescription(description);
  }
}

// The polyfill classes carry private fields, so they do not structurally match the DOM
// interfaces simple-peer's `wrtc` type expects; the runtime shape is what matters.
const specWrtc = {
  RTCPeerConnection: SpecPeerConnection,
  RTCSessionDescription: NodeDataChannel.RTCSessionDescription,
  RTCIceCandidate: NodeDataChannel.RTCIceCandidate
} as unknown as SimplePeerWrtc;

function signalType(signal: PboardSignal): string | null {
  if (signal && typeof signal === "object" && "type" in signal && typeof signal.type === "string") return signal.type;
  return null;
}

const probe = (id: string) => ({ id, method: "token", params: [] }) satisfies WebRTCMessage;

type Recorded = { from: string; signal: PboardSignal };

// Wraps one shared memory scope so every emitted signal is recorded with its sender and
// any captured signal can be re-injected into the installed handler, the way a Drive
// outbox replays a signal after a peer re-joins a room.
function recording(scope: ReturnType<typeof createMemorySignalingScope>, topic: string, log: Recorded[]) {
  const inner = scope.create(topic);
  let ownId = "";
  let handler: ((from: string, signal: PboardSignal) => void) | null = null;
  const signaling: PboardSignaling = {
    join: async (onRoster) => {
      const joined = await inner.join(onRoster);
      ownId = joined.peerId;
      return joined;
    },
    sendSignal: async (to, signal) => {
      log.push({ from: ownId, signal });
      return inner.sendSignal(to, signal);
    },
    onSignal: (h) => {
      handler = h;
      inner.onSignal(h);
    },
    leave: () => inner.leave()
  };
  return {
    signaling,
    id: () => ownId,
    deliver: (from: string, signal: PboardSignal) => handler?.(from, signal)
  };
}

// node-datachannel performs a genuine ICE/DTLS/data-channel handshake, so the native
// stack must run on the real clock; fake timers would desync it.
// (ts-no-test-timers integration exception, same rationale as collaborationManager.test.ts.)
async function waitUntil(predicate: () => boolean, timeoutMs = 15000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitUntil: condition not met within timeout");
}

// Bounded real-timer wait for negative assertions (nothing to await for an absence).
const observeFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createPboardWebRTCConnectionHandler", () => {
  const sessions: {
    id: () => string;
    deliver: (from: string, signal: PboardSignal) => void;
    handler: WebRTCConnectionHandler<PboardPeer>;
    errors: string[];
    peers: PboardPeer[];
    messages: unknown[];
  }[] = [];

  async function openSession(scope: ReturnType<typeof createMemorySignalingScope>, topic: string, log: Recorded[]) {
    const rec = recording(scope, topic, log);
    const handler = await createPboardWebRTCConnectionHandler({ signaling: rec.signaling, wrtc: specWrtc })();
    const session = {
      id: rec.id,
      deliver: rec.deliver,
      handler,
      errors: [] as string[],
      peers: [] as PboardPeer[],
      messages: [] as unknown[]
    };
    handler.error$.subscribe((error) => session.errors.push(String(error.parameters?.errorText ?? error.message)));
    handler.connect$.subscribe((peer) => session.peers.push(peer));
    handler.message$.subscribe(({ message }) => session.messages.push(message));
    sessions.push(session);
    return session;
  }

  afterEach(async () => {
    for (const session of sessions.splice(0, sessions.length)) await session.handler.close().catch(() => {});
  });

  it("handshakes with an offer from the designated initiator and an answer from the other side", { timeout: 30000 }, async () => {
    const scope = createMemorySignalingScope();
    const log: Recorded[] = [];
    const a = await openSession(scope, "handler-handshake", log);
    const b = await openSession(scope, "handler-handshake", log);
    await waitUntil(() => a.peers.length > 0 && b.peers.length > 0);

    const offers = log.filter((entry) => signalType(entry.signal) === "offer");
    const answers = log.filter((entry) => signalType(entry.signal) === "answer");
    expect(offers.length).toBe(1);
    expect(answers.length).toBe(1);
    // `initiator = remotePeerId > ownPeerId`, so the peer with the smaller id opens.
    expect(offers[0].from).toBe(a.id() < b.id() ? a.id() : b.id());
    expect(answers[0].from).toBe(offers[0].from === a.id() ? b.id() : a.id());

    await a.handler.send(a.peers[0], probe("m1"));
    await waitUntil(() => b.messages.length > 0);
    expect(b.messages[0]).toEqual(probe("m1"));
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    await a.handler.close();
    await expect(a.handler.send(a.peers[0], probe("after-close"))).resolves.toBeUndefined();
  });

  it.each(["bytes", "frames"])("bounds queued input before asynchronous verification: %s", { timeout: 30000 }, async limit => {
    const scope = createMemorySignalingScope(), log: Recorded[] = [];
    const a = await openSession(scope, `handler-input-${limit}`, log);
    const b = await openSession(scope, `handler-input-${limit}`, log);
    await waitUntil(() => a.peers.length > 0 && b.peers.length > 0);
    const receiver = b.peers[0];
    // Exercise the actual handler input event after a native connection. Avoid
    // asking SCTP to allocate an oversized network packet just to test our gate.
    if (limit === "bytes") receiver.emit("data", new Uint8Array(16 * 1024 * 1024 + 1));
    else {
      const frame = new TextEncoder().encode(JSON.stringify(probe("queued-flood")));
      for (let index = 0; index < 129; index++) receiver.emit("data", frame);
    }
    await waitUntil(() => receiver.destroyed);
    await expect(b.handler.send(receiver, probe("after-quota"))).resolves.toBeUndefined();
  });

  it("drops an answer that arrives before this instance has sent an offer", { timeout: 30000 }, async () => {
    const scope = createMemorySignalingScope();
    const log: Recorded[] = [];
    const first = await openSession(scope, "handler-capture", log);
    const second = await openSession(scope, "handler-capture", log);
    await waitUntil(() => first.peers.length > 0 && second.peers.length > 0);
    const answer = log.find((entry) => signalType(entry.signal) === "answer")?.signal;
    expect(answer).toBeDefined();

    // A fresh instance is still in the `new` state, so the captured answer answers
    // nothing; it must be dropped instead of applied.
    const a = await openSession(scope, "handler-fresh", log);
    const b = await openSession(scope, "handler-fresh", log);
    a.deliver(b.id(), answer!);
    await waitUntil(() => a.peers.length > 0 && b.peers.length > 0);
    await observeFor(1000);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    await a.handler.send(a.peers[0], probe("m2"));
    await waitUntil(() => b.messages.length > 0);
  });

  it("keeps the error stream empty when an instance is recreated and a stale answer is replayed", { timeout: 30000 }, async () => {
    const scope = createMemorySignalingScope();
    const log: Recorded[] = [];
    const a = await openSession(scope, "handler-replay", log);
    const b = await openSession(scope, "handler-replay", log);
    await waitUntil(() => a.peers.length > 0 && b.peers.length > 0);
    const offers = log.filter((entry) => signalType(entry.signal) === "offer");
    const answers = log.filter((entry) => signalType(entry.signal) === "answer");
    const offerer = offers[0].from === a.id() ? a : b;
    const answerer = offers[0].from === a.id() ? b : a;

    // Closing the offerer's instance recreates it in `new`; the answer its completed
    // handshake already produced must not be applied to the recreated instance.
    offerer.peers[0].destroy();
    await waitUntil(() => offerer.peers.length > 1);
    offerer.deliver(answerer.id(), answers[0].signal);
    await observeFor(1500);
    expect(offerer.errors).toEqual([]);
    expect(offerer.peers.length).toBe(2);

    // Recovery must still work: the recreated instance carries data.
    await offerer.handler.send(offerer.peers[1], probe("m3"));
    await waitUntil(() => answerer.messages.length > 0);
  });
});
