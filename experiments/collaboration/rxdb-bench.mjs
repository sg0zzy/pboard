import "fake-indexeddb/auto";
import { performance } from "node:perf_hooks";
import { randomFillSync } from "node:crypto";
import { createRxDatabase, addRxPlugin } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";

addRxPlugin(RxDBAttachmentsPlugin);

const schema = {
  title: "pboard card experiment",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    projectId: { type: "string", maxLength: 100 },
    content: { type: "string" },
    status: { type: "string" },
    orderKey: { type: "string", maxLength: 100 },
    updatedAt: { type: "number" }
  },
  required: ["id", "projectId", "content", "status", "orderKey", "updatedAt"],
  indexes: [["projectId", "orderKey"]],
  attachments: {}
};

const storage = getRxStorageDexie({ indexedDB, IDBKeyRange });
const clock = async (action) => {
  const start = performance.now();
  const result = await action();
  return { ms: +(performance.now() - start).toFixed(2), result };
};
const memory = () => ({
  rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
  heapMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1)
});

async function open(name) {
  const db = await createRxDatabase({ name, storage, multiInstance: false });
  await db.addCollections({ cards: { schema } });
  return db;
}

async function run(count) {
  const name = `pboardbench${count}`;
  const before = memory();
  const opened = await clock(() => open(name));
  let db = opened.result;
  const cards = Array.from({ length: count }, (_, i) => ({
    id: `card-${String(i).padStart(6, "0")}`,
    projectId: "project-1",
    content: `Card ${i}: ${"text ".repeat(16)}`,
    status: "candidate",
    orderKey: String(i).padStart(8, "0"),
    updatedAt: i
  }));
  const inserted = await clock(() => db.cards.bulkInsert(cards));
  if (inserted.result.error.length) throw inserted.result.error[0];

  const imageBytes = new Uint8Array(128 * 1024);
  randomFillSync(imageBytes);
  const image = new Blob([imageBytes], { type: "image/webp" });
  const attached = await clock(async () => {
    for (let i = 0; i < 10; i++) {
      const doc = await db.cards.findOne(`card-${String(i).padStart(6, "0")}`).exec();
      await doc.putAttachment({ id: "screenshot.webp", data: image, type: "image/webp" });
    }
  });

  const query = db.cards.find({ selector: { projectId: "project-1" }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] });
  let emissions = 0;
  const subscription = query.$.subscribe(() => { emissions++; });
  const update = await clock(async () => {
    const doc = await db.cards.findOne("card-000050").exec();
    await doc.incrementalPatch({ content: "Edited card", updatedAt: count + 1 });
  });
  const status = await clock(async () => {
    const doc = await db.cards.findOne("card-000050").exec();
    await doc.incrementalPatch({ status: "done", updatedAt: count + 2 });
  });
  const reorder = await clock(async () => {
    const doc = await db.cards.findOne("card-000050").exec();
    await doc.incrementalPatch({ orderKey: "00000000.5", updatedAt: count + 3 });
  });
  const queryTime = await clock(() => query.exec());
  const countLoaded = queryTime.result.length;
  const blob = await (await db.cards.findOne("card-000000").exec()).getAttachment("screenshot.webp").getData();
  await new Promise((resolve) => setTimeout(resolve, 0));
  subscription.unsubscribe();
  await db.close();
  const reopened = await clock(() => open(name));
  db = reopened.result;
  const reloaded = await clock(() => db.cards.find({ selector: { projectId: "project-1" } }).exec());
  const after = memory();
  console.log(JSON.stringify({ count, openMs: opened.ms, insertMs: inserted.ms, attachTenMs: attached.ms,
    editMs: update.ms, statusMs: status.ms, reorderMs: reorder.ms,
    queryMs: queryTime.ms, queryCount: countLoaded, reactiveEmissions: emissions,
    reopenMs: reopened.ms, reloadMs: reloaded.ms, reloadCount: reloaded.result.length,
    attachmentBytes: blob.size, estimatedPlainJsonBytes: Buffer.byteLength(JSON.stringify(cards)),
    totalAttachmentBytes: image.size * 10, memoryBefore: before, memoryAfter: after }));
  await db.close();
}

for (const count of [100, 1000, 5000]) await run(count);
