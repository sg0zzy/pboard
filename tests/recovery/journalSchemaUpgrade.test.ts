import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';

// v11 → v12 upgrade: the new `version` index must be created on an existing DB
// and the store's rows must survive untouched.
it('creates the version index when upgrading an existing v11 journal database', async () => {
  const name = `upgrade${crypto.randomUUID()}`;
  // Build a v11 database the way the old code did.
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.open(`${name}-change-journal-v1`, 11);
    r.onupgradeneeded = () => {
      const entries = r.result.createObjectStore("entries", { keyPath: "id" });
      entries.createIndex("boardId", "boardId"); entries.createIndex("state", "state");
      entries.createIndex("[collection+documentId]", ["collection", "documentId"]);
      entries.put({ id: "e1", boardId: "b", collection: "cards", documentId: "d", state: "committed",
        origin: "local", parents: [], ancestry: "unknown", value: { id: "d", updatedAt: "T1" } });
    };
    r.onsuccess = () => { r.result.close(); resolve(); };
    r.onerror = () => reject(r.error);
  });
  // Now open with the shipped code, which asks for 12.
  const { ChangeJournal } = await import('../../src/storage/changeJournal');
  const journal = new ChangeJournal(name);
  await journal.open();
  const rows = await journal.entries.toArray();
  expect(rows).toHaveLength(1);
  // the new index exists and answers for the pre-existing row
  const versionRows = await (journal as unknown as { read: <T>(n: string, op: (s: IDBObjectStore) => IDBRequest<T>) => Promise<T> })
    .read<unknown[]>("entries", store => store.index("version").getAll(["cards", "d", "T1"]) as IDBRequest<unknown[]>);
  expect(versionRows).toHaveLength(1);
  journal.close();
});
