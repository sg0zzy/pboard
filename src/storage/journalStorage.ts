import { hasJournalOrigin, proveJournalChange, certifyLocalHistory } from "../collab/security/journalProof";
import type { RxCollection } from "rxdb";
import { isUntrustedImport } from "../collab/security/liveMutations";
import { ChangeJournal, documentValue, type Change, type JournalEntry } from "./changeJournal";
import { canonicalize } from "../collab/security/canonical";
import { resolutionParents } from "./resolutionOrigin";
import { isJournalMaterialization } from "./journalMaterialization";

// Explicit allowlist: replication/storage maintenance must never invent ancestry.
const localContexts = new Set(["rx-collection-bulk-insert", "rx-collection-bulk-remove", "rx-document-save-data", "incremental-write"]);

/** Install before collaboration guards, so rejected remote writes never enter the WAL. */
export function installJournalStorage<T>(collection: RxCollection<T>, name: Change["collection"], journal: ChangeJournal): void {
  const storage = collection.storageInstance;
  const original = storage.bulkWrite;
  storage.bulkWrite = async (rows, context) => {
    try {
    const entries: JournalEntry[] = [];
    const local = localContexts.has(context) && !isUntrustedImport(collection);
    for (const row of rows) {
      const board = String(name === 'projects' ? (row.document as any).id : (row.document as any).projectId);
      if (await journal.boardErasure(board)) {
        if (context === 'pboard-local-erasure' && isJournalMaterialization(collection, row.document as any) && row.document._deleted) continue;
        throw new Error('This board was permanently deleted');
      }
      if (isJournalMaterialization(collection, row.document as Record<string, unknown>)) continue;
      const parents = local ? resolutionParents(collection, row.document as Record<string, unknown>) : undefined;
      if (parents && !local) throw new Error("Resolution origin is not a local command");
      const boardId = String(name === "projects" ? (row.document as Record<string, unknown>).id : (row.document as Record<string, unknown>).projectId);
      const entry = await journal.prepare(name, row.document as Record<string, unknown>,
        row.previous as Record<string, unknown> | undefined, local, parents, hasJournalOrigin(collection, boardId));
      if (!entry.proof) {
        const proof = await proveJournalChange(collection, entry);
        if (proof) { entry.proof = proof; await journal.entries.update(entry.id, { proof }); }
      }
      if (!entry.admission) {
        const admission = await certifyLocalHistory(collection, entry);
        if (admission) { entry.admission = admission; await journal.entries.update(entry.id, { admission }); }
      }
      entries.push(entry);
    }
    // A thrown/ambiguous storage error leaves prepared rows for startup recovery.
    const result = await original.call(storage, rows, context);
    await journal.finish(entries, new Set(result.error.map(error => error.documentId)));
    return result;
    } catch {
      // RxDB incremental queues expect per-row errors, not a rejected bulkWrite
      // promise (which leaves their callers waiting indefinitely).
      return { error: rows.map(row => ({ documentId: String((row.document as Record<string, unknown>).id),
        writeRow: row, status: 422, isError: true, context, schema: collection.schema.jsonSchema, validationErrors: [],
        error: new Error("Local change journal could not complete; write outcome requires recovery") })) } as Awaited<ReturnType<typeof original>>;
    }
  };
}

/** Resolve a crash between WAL and document commit without replaying an unverified write. */
export async function recoverJournal(journal: ChangeJournal, collections: { cards: RxCollection<any>; projects: RxCollection<any> }): Promise<void> {
  const prepared = await journal.entries.where("state").equals("prepared").toArray();
  for (const entry of prepared) {
    const documents = await collections[entry.collection].storageInstance.findDocumentsById([entry.documentId], true);
    const document = documents[0];
    const matches = document && canonicalize(documentValue(document)) === canonicalize(entry.value);
    await journal.recoverEntry(entry.id, !!matches);
  }
}
