import NodeDataChannel from "node-datachannel/polyfill";
import { createSimplePeerWrtc } from "rxdb/plugins/replication-webrtc";
import { createPboardWebRTCConnectionHandler } from "./webrtcHandler.mjs";

const wrtc = createSimplePeerWrtc(NodeDataChannel);
const registry = new Map();
function createProvider(topic) {
  let room = registry.get(topic);
  if (!room) { room = new Map(); registry.set(topic, room); }
  const peerId = "p-" + Math.random().toString(36).slice(2, 10);
  const entry = { onRoster: null, onSignal: null };
  room.set(peerId, entry);
  const rosterFor = (id) => Array.from(room.keys()).filter((k) => k !== id);
  const announce = () => room.forEach((e, id) => e.onRoster?.(rosterFor(id)));
  return {
    join: (onRoster) => { entry.onRoster = onRoster; announce(); console.log("[broker]", peerId, "join, roster:", rosterFor(peerId)); return { peerId, peers: rosterFor(peerId) }; },
    sendSignal: async (to, data) => { console.log("[broker]", peerId, "sendSignal to", to, "type:", data?.type); room.get(to)?.onSignal?.(peerId, data); },
    onSignal: (handler) => { entry.onSignal = handler; },
    leave: async () => { if (room.get(peerId) === entry) { room.delete(peerId); announce(); } }
  };
}

const topic = "t";
const hA = await createPboardWebRTCConnectionHandler({ signaling: createProvider(topic), wrtc, trickle: false })();
const hB = await createPboardWebRTCConnectionHandler({ signaling: createProvider(topic), wrtc, trickle: false })();

let connected = 0;
hA.connect$.subscribe((p) => { connected++; console.log("A connected"); });
hB.connect$.subscribe((p) => { connected++; console.log("B connected"); });
hA.message$.subscribe((m) => console.log("A got", JSON.stringify(m.message)));
hB.message$.subscribe((m) => console.log("B got", JSON.stringify(m.message)));
hA.error$.subscribe((e) => console.log("A error", String(e.message ?? e)));
hB.error$.subscribe((e) => console.log("B error", String(e.message ?? e)));

setTimeout(async () => {
  console.log("TIMEOUT: only", connected, "connected");
  process.exit(1);
}, 12000);
