import { hasJournalOrigin, proveJournalChange, certifyLocalHistory } from "../collab/security/journalProof";
import type { RxCollection, RxStorageBulkWriteResponse, RxStorageWriteErrorValidation } from "rxdb";
import { isUntrustedImport } from "../collab/security/liveMutations";
import { ChangeJournal, documentValue, type Change, type JournalEntry } from "./changeJournal";
import { canonicalize } from "../collab/security/canonical";
import { resolutionParents } from "./resolutionOrigin";
import { isJournalMaterialization } from "./journalMaterialization";

// Explicit allowlist: replication/storage maintenance must never invent ancestry.
const localContexts = new Set(["rx-collection-bulk-insert", "rx-collection-bulk-remove", "rx-document-save-data", "incremental-write"]);

/** RxDB's per-row write error plus the journal cause the caller must reject with. */
export type JournalWriteFailure<T> = RxStorageWriteErrorValidation<T> & { error: Error };

/** A fully rejected batch. RxDB's published response has no success field (its
 * write queue derives the written documents from the input rows minus the error
 * ids), so the empty array here is this wrapper's explicit statement that the
 * batch committed nothing. */
export type JournalWriteResponse<T> = RxStorageBulkWriteResponse<T> & { success: T[] };

/** Install before collaboration guards, so rejected remote writes never enter the WAL. */
export function installJournalStorage<T>(collection: RxCollection<T>, name: Change["collection"], journal: ChangeJournal, committed?: (entries: JournalEntry[]) => void | Promise<void>): void {
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
      // Snapshot/bootstrap imports replicate remote state; they are not
      // authored changes and must never fabricate journal heads (each pull
      // would otherwise become an unrelated-history conflict). Genuine
      // history arrives through the verified exchange or the first local
      // edit, which anchors on the imported bytes as its baseline.
      if (isJournalMaterialization(collection, row.document as Record<string, unknown>) || isUntrustedImport(collection)) continue;
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
    if (entries.length) {
      await journal.finish(entries, new Set(result.error.map(error => error.documentId)));
      const conversion = committed?.(entries);
      if (conversion) await conversion;
    }
    return result;
    } catch (cause) {
      // A rejected bulkWrite leaves RxDB's incremental write queue marked as
      // running, so every later write on this collection waits forever; the
      // queue settles a caller only from the response it hands back. Convert the
      // failure into a complete response instead — documentId must be the primary
      // key, because the queue resolves each error back to its caller by looking
      // up that id in the batch it just ran — and keep the original cause on every
      // row so the caller rejects with it.
      const failure = cause instanceof Error ? cause : new Error("Local change journal could not complete; write outcome requires recovery");
      const errors: JournalWriteFailure<T>[] = rows.map(row => ({
        status: 422,
        isError: true,
        context,
        schema: collection.schema.jsonSchema,
        validationErrors: [],
        error: failure,
        documentId: String(row.document[collection.schema.primaryPath]),
        writeRow: row
      }));
      const response: JournalWriteResponse<T> = { error: errors, success: [] };
      return response;
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
