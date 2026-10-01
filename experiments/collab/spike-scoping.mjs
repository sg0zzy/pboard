import "fake-indexeddb/auto";
import NodeDataChannel from "node-datachannel/polyfill";
import { createRxDatabase } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { replicateWebRTC, createSimplePeerWrtc } from "rxdb/plugins/replication-webrtc";
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

const P1 = "proj-shared";
const P2 = "proj-private";
const now = () => new Date().toISOString();
const topic = `pboard-collab-${P1}-cards`;

const ownerDb = await makeDb("scope-owner");
const collabDb = await makeDb("scope-collab");

// Owner has cards in BOTH the shared project and a private project.
await ownerDb.cards.insert({ id: "s1", projectId: P1, content: "shared card", updatedAt: now() });
await ownerDb.cards.insert({ id: "x1", projectId: P2, content: "PRIVATE card", updatedAt: now() });

// Scoping push modifier: only push shared-project cards.
const scopePush = (doc) => (doc.projectId === P1 ? doc : null);

// Try a pull modifier that returns null for non-matching docs to see if it crashes.
const scopePull = (doc) => (doc.projectId === P1 ? doc : null);

const ownerPool = await replicateWebRTC({
  collection: ownerDb.cards, topic,
  connectionHandlerCreator: createPboardWebRTCConnectionHandler({ signaling: createProvider(topic), wrtc }),
  pull: { batchSize: 50, modifier: scopePull },
  push: { batchSize: 50, modifier: scopePush }
});
const collabPool = await replicateWebRTC({
  collection: collabDb.cards, topic,
  connectionHandlerCreator: createPboardWebRTCConnectionHandler({ signaling: createProvider(topic), wrtc }),
  pull: { batchSize: 50, modifier: scopePull },
  push: { batchSize: 50, modifier: scopePush }
});

await Promise.all([ownerPool.awaitFirstPeer(), collabPool.awaitFirstPeer()]);
await new Promise((r) => setTimeout(r, 2000));
const collabCards = (await collabDb.cards.find().exec()).map((d) => d.toJSON());
const ownerCards = (await ownerDb.cards.find().exec()).map((d) => d.toJSON());
console.log("[scoping] owner DB intact:", ownerCards.length, "docs | collaborator sees:", JSON.stringify(collabCards.map((c) => c.id)));
const hasPrivate = collabCards.some((c) => c.projectId === P2);
const hasShared = collabCards.some((c) => c.id === "s1");
console.log("[scoping] shared card present:", hasShared, "| private card leaked:", hasPrivate);

await ownerPool.cancel();
await collabPool.cancel();
if (hasPrivate) console.log("[scoping] RESULT: PULL LEAK — private project replicated despite pull modifier");
else console.log("[scoping] RESULT: scoping holds — pull modifier null is safe and private project excluded");
process.exit(0);
