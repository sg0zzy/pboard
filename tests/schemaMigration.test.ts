import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { createRxDatabase } from "rxdb";
import { addRxPlugin } from "rxdb";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
addRxPlugin(RxDBMigrationSchemaPlugin);

it("migrates a stored v0 card collection to the v1 protocol-2 schema", async () => {
  // The v0 card schema exactly as it was before `_sec` was added.
  const v0Schema = {
    title: "pboard card", version: 0, primaryKey: "id", type: "object",
    properties: {
      id: { type: "string", maxLength: 100 }, projectId: { type: "string", maxLength: 100 },
      type: { type: "string" }, title: { type: "string" }, content: { type: "string" },
      status: { type: "string", maxLength: 100 }, displayMode: { type: "string" },
      orderKey: { type: "string", maxLength: 100 },
      source: { type: "object", properties: { provider: { type: "string" }, conversationUrl: { type: "string" }, sourceText: { type: "string" } }, additionalProperties: true },
      imageId: { type: "string" }, imageMimeType: { type: "string" },
      imageWidth: { type: "number" }, imageHeight: { type: "number" },
      createdAt: { type: "string" }, updatedAt: { type: "string" }, deletedAt: { type: "string" }
    },
    required: ["id", "projectId", "type", "content", "status", "orderKey", "createdAt", "updatedAt"],
    indexes: ["projectId", ["projectId", "orderKey"], ["projectId", "status"]]
  };
  const v1Schema = JSON.parse(JSON.stringify(v0Schema));
  v1Schema.version = 1;
  v1Schema.properties._sec = {
    type: "object",
    properties: { provenance: { type: "object" }, signature: { type: "string", maxLength: 120 } },
    required: ["provenance", "signature"]
  };

  // Phase 1: create with the old schema and store data (simulates the installed app).
  const dbOld = await createRxDatabase({ name: "mig-probe", storage: getRxStorageDexie(), multiInstance: false });
  await dbOld.addCollections({ cards: { schema: v0Schema } });
  await dbOld.cards.insert({ id: "card-1", projectId: "p", type: "note", content: "stored", status: "candidate", orderKey: "a0", createdAt: "x", updatedAt: "x" });
  await dbOld.close();

  // Phase 2: reopen with the new schema; the migration must run transparently.
  const dbNew = await createRxDatabase({ name: "mig-probe", storage: getRxStorageDexie(), multiInstance: false });
  await dbNew.addCollections({
    cards: { schema: v1Schema, migrationStrategies: { 1: (doc: Record<string, unknown>) => doc } }
  });
  const doc = await dbNew.cards.findOne("card-1").exec();
  expect(doc?.content).toBe("stored");
  await dbNew.cards.insert({ id: "card-2", projectId: "p", type: "note", content: "new", status: "candidate", orderKey: "a1", createdAt: "y", updatedAt: "y" });
  expect((await dbNew.cards.find().exec()).length).toBe(2);
  await dbNew.close();
});
