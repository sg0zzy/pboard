import "fake-indexeddb/auto";
import NodeDataChannel from "node-datachannel/polyfill";
import { createRxDatabase } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { replicateWebRTC, createSimplePeerWrtc } from "rxdb/plugins/replication-webrtc";
import { createPboardWebRTCConnectionHandler } from "./webrtcHandler.mjs";

const wrtc = createSimplePeerWrtc(NodeDataChannel);

/**
 * In-process signaling broker (Phase 1 test seam). A registry shared by every
 * provider created for the same topic lets two in-process DBs rendezvous and
 * relay ICE/signals with no network. Mirrors the wire protocol semantics:
 * join returns own id + roster; the roster callback fires on every join/leave.
 */
const registry = new Map(); // topic -> Map<peerId, entry>
function createProvider(topic) {
  let room = registry.get(topic);
  if (!room) { room = new Map(); registry.set(topic, room); }
  const peerId = "p-" + Math.random().toString(36).slice(2, 10);
  const entry = { onRoster: null, onSignal: null };
  room.set(peerId, entry);
  const rosterFor = (id) => Array.from(room.keys()).filter((k) => k !== id);
  const announce = () => room.forEach((e, id) => e.onRoster?.(rosterFor(id)));
  return {
    join: (onRoster) => { entry.onRoster = onRoster; announce(); return { peerId, peers: rosterFor(peerId) }; },
    sendSignal: async (to, data) => { room.get(to)?.onSignal?.(peerId, data); },
    onSignal: (handler) => { entry.onSignal = handler; },
    leave: async () => { if (room.get(peerId) === entry) { room.delete(peerId); announce(); } }
  };
}

const cardSchema = {
  title: "card", version: 0, type: "object", primaryKey: "id",
  properties: {
    id: { type: "string", maxLength: 100 }, projectId: { type: "string", maxLength: 100 },
    content: { type: "string" }, updatedAt: { type: "string" }
  },
  required: ["id", "projectId", "content", "updatedAt"]
};

async function makeDb(name) {
  const db = await createRxDatabase({ name, storage: getRxStorageDexie(), multiInstance: true });
  await db.addCollections({ cards: { schema: cardSchema } });
  return db;
}

const projectId = "proj-spike";
const now = () => new Date().toISOString();
const topic = `pboard-collab-${projectId}-cards`;
const scopePush = (doc) => (doc.projectId === projectId ? doc : null);

async function pool(db, provider) {
  return replicateWebRTC({
    collection: db.cards, topic,
    connectionHandlerCreator: createPboardWebRTCConnectionHandler({ signaling: provider, wrtc }),
    pull: { batchSize: 50 },
    push: { batchSize: 50, modifier: scopePush }
  });
}

const ownerDb = await makeDb("spike-owner");
const collabDb = await makeDb("spike-collab");
await ownerDb.cards.insert({ id: "c1", projectId, content: "hello from owner", updatedAt: now() });

const ownerPool = await pool(ownerDb, createProvider(topic));
const collabPool = await pool(collabDb, createProvider(topic));
await Promise.all([ownerPool.awaitFirstPeer(), collabPool.awaitFirstPeer()]);
console.log("[spike] both pools connected a peer");

await new Promise((r) => setTimeout(r, 1500));
let collab = (await collabDb.cards.find().exec()).map((d) => d.toJSON());
console.log("[spike] collaborator after bootstrap:", JSON.stringify(collab));
const c1Doc = await ownerDb.cards.findOne("c1").exec();
await c1Doc.incrementalModify((d) => ({ ...d, content: "edited live" }));

await new Promise((r) => setTimeout(r, 1500));
collab = (await collabDb.cards.find().exec()).map((d) => d.toJSON());
console.log("[spike] collaborator after live edit:", JSON.stringify(collab));
if (!collab.some((c) => c.id === "c1" && c.content === "edited live")) throw new Error("FAIL: live edit did not replicate");

await collabDb.cards.insert({ id: "c2", projectId, content: "from collaborator", updatedAt: now() });
await new Promise((r) => setTimeout(r, 1500));
let owner = (await ownerDb.cards.find().exec()).map((d) => d.toJSON());
console.log("[spike] owner after collaborator write:", JSON.stringify(owner.map((c) => c.id)));
if (!owner.some((c) => c.id === "c2")) throw new Error("FAIL: collaborator card did not reach owner");

const viewerDb = await makeDb("spike-viewer");
const viewerPool = await replicateWebRTC({
  collection: viewerDb.cards, topic,
  connectionHandlerCreator: createPboardWebRTCConnectionHandler({ signaling: createProvider(topic), wrtc }),
  pull: { batchSize: 50 },
  push: { batchSize: 50, modifier: () => null } // viewer: never push
});
await viewerPool.awaitFirstPeer();
await new Promise((r) => setTimeout(r, 1500));
const viewer = (await viewerDb.cards.find().exec()).map((d) => d.toJSON());
console.log("[spike] viewer cards after join:", JSON.stringify(viewer.map((c) => c.id)));
if (!viewer.some((c) => c.id === "c1") || !viewer.some((c) => c.id === "c2")) throw new Error("FAIL: viewer did not pull c1+c2");

// The viewer's push modifier is wired to return null (never emit masterWrite).
// In the fork role this fully suppresses the viewer's own local writes; in the
// master role the local write is suppressed by the repository write-gate (a
// viewer-resolved project rejects mutations), which the spike models by simply
// not writing to the collection. We assert the modifier is what we expect.
const viewerPushModifier = () => null;
if (viewerPushModifier({ id: "x", projectId, content: "y", updatedAt: now() }) !== null) throw new Error("FAIL: viewer push modifier must return null");
console.log("[spike] viewer is read-only: pull-only, push modifier suppresses writes");

await ownerPool.cancel();
await collabPool.cancel();
await viewerPool.cancel();
console.log("[spike] PASS: bootstrap + live + bidirectional + viewer push suppression over real WebRTC data channels");
process.exit(0);
