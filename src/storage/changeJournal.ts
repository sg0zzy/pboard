import { portableJournalChanges, type JournalProof, type HistoryAdmission } from "../collab/security/journalProof";
import { canonicalize, type Json } from "../collab/security/canonical";
import { collaborationCounters } from "../collab/counters";
import { emit } from "../debug/bus";
import { dominates, latestFact, mergeFacts,
  type BoardDeletionState, type BoardTombstoneFact, type BoardTombstoneKind, type CausalContext, type DeletionRole } from "./boardTombstone";
import { confirmedBoardCleanup, failedBoardCleanup, pendingBoardCleanup, type BoardCleanupState } from "./boardCleanup";

const PERMANENTLY_DELETED = 'This board was permanently deleted';
/** Tombstone cache key: the account list a fact speaks for, then the board. */
const tombstoneKey = (boardId: string, accountId: string | null) => `${accountId ?? ""}\u0000${boardId}`;

export type PublicGrant = { id: string; boardId: string; authority: import('../collab/security/keys').DevicePublicKey; manifest: import('../collab/security/manifest').SignedManifest };
export type DocumentValue = Record<string, Json>;
export type Change = {
  version: 1;
  id: string;
  boardId: string;
  collection: "cards" | "projects";
  documentId: string;
  parents: string[];
  /** Unknown legacy ancestry is never interpreted as an independent creation. */
  ancestry: "known" | "unknown";
  value: DocumentValue;
};
export type JournalEntry = Change & {
  state: "prepared" | "committed" | "uncertain" | "rejected";
  origin: "local" | "observed" | "baseline";
  /** Detached author proof; not part of the content-addressed change value. */
  proof?: JournalProof;
  admission?: HistoryAdmission;
};
export type ConflictDraft = { id: string; target: string; writerId: string; heads: string[]; variantId: string; title: string; content: string };
/** Local entitlement is not a remotely usable grant. Logout never erases it. */
export type OfflinePermission = { id: string; role: "owner" | "editor" | "viewer" | "revoked"; deviceKeyId?: string; authorityKeyId?: string };
export type PendingEdit = { id: string; boardId: string; base: Change; value: DocumentValue; deviceKeyId: string; authorityKeyId: string; admittedChangeId?: string; projected?: boolean; creation?: boolean; parents?: string[]; supersedes?: string[] };
type Receipt = { id: string; changeId: string; destination: string };
export type BoardErasure = Receipt & { boardId: string; accountId: string | null; imageIds: string[]; cardIds: string[]; cloudPending: boolean; localPurged?: boolean };
export type { BoardTombstoneFact, BoardDeletionState, CausalContext, BoardTombstoneKind, DeletionRole };
export type { BoardCleanupState, BoardCleanupStage } from "./boardCleanup";
/**
 * One row per board. `facts` is the replicated deletion record (ordered by the
 * causal rule in `storage/boardTombstone.ts`); `cleanup` is this device's
 * Drive-side progress on it, which is deliberately outside the facts so the
 * ordering rule never has to reason about Drive at all.
 */
export type BoardTombstoneRow = { boardId: string; facts: BoardTombstoneFact[]; cleanup?: BoardCleanupState };
/** What a caller knows when it asks for a tombstone to be recorded. The
 *  globally unique `opId`, the per-device `seq`, the Lamport `clock` and the
 *  deleting device id are allocated by the journal inside the same transaction
 *  as the write, so two writers can never mint the same identity. */
export type BoardDeletionInput = {
  boardId: string;
  /** The account list this decision belongs to; `null` for the local scope. */
  accountId: string | null;
  /** The operation vector the writer had observed before the action. */
  context: CausalContext;
  role: DeletionRole;
  at: string;
  evidence: string;
  kind?: BoardTombstoneKind;
  /** The writer's own Lamport clock, if it has one; the journal keeps the max. */
  clock?: number;
};
/** Device-local audit trail row for Drive-verified authority re-keys (D1/D4). */
export type AuthorityTransitionRow = { id: string; boardId: string; record: Record<string, unknown>; storedAt: number };

/**
 * What merging a received fact did to the board's decision. `duplicate` means
 * the deciding fact is the same one that decided before — a replay, an older
 * fact, or a concurrent loser — so the caller must not turn it into a second
 * decision; `deleted` is that decision after the merge, for the account list
 * the fact speaks for.
 */
export type BoardTombstoneMerge = { duplicate: boolean; deleted: boolean };

/** Strip only RxDB implementation fields. Signed provenance is immutable data. */
export function documentValue(document: Record<string, unknown>): DocumentValue {
  return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(document)
    .filter(([key, value]) => !["_rev", "_meta", "_attachments"].includes(key) && value !== undefined)))) as DocumentValue;
}
export async function changeId(change: Omit<Change, "id">): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(change as unknown as Json));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
export async function makeChange(input: Omit<Change, "version" | "id">): Promise<Change> {
  const { boardId, collection, documentId, ancestry, value } = input;
  const change = { version: 1 as const, boardId, collection, documentId, ancestry, value,
    parents: [...new Set(input.parents)].sort() };
  return { ...change, id: await changeId(change) };
}
export function scope(change: Pick<Change, "boardId" | "collection" | "documentId">): string {
  return JSON.stringify([change.boardId, change.collection, change.documentId]);
}

/** Pending-review checkpoint and operation rows the confirmation guard reads. */
export type PendingReviewRecord = { boardId: string; operationId: string; reviewedIds: string[] };
export type OperationRecord = { id: string; boardId: string; sourceId?: string };

/** Current heads: the edits nothing else supersedes and that no delivery has admitted. */
export function pendingHeads(edits: PendingEdit[]): PendingEdit[] {
  const superseded = new Set(edits.flatMap(e => e.supersedes ?? []));
  return edits.filter(e => !e.admittedChangeId && !superseded.has(e.id));
}
/** Drafts a pending review already adopted as an operation. Adoption only shows in the pending
 *  list for a bound board, so a checkpoint from an unbound board never excuses a head. */
export function adoptedPendingIds(reviews: PendingReviewRecord[], operations: OperationRecord[], boundBoards: Set<string>): Set<string> {
  const adopted = new Set<string>();
  for (const review of reviews) {
    if (!boundBoards.has(review.boardId)) continue;
    const operation = operations.find(row => row.id === review.operationId);
    if (operation?.boardId === review.boardId && operation.sourceId?.startsWith('pending:')) for (const id of review.reviewedIds) adopted.add(id);
  }
  return adopted;
}
/** The retained work a caller can confirm: heads minus what a pending review already adopted. */
export function confirmableIds(edits: PendingEdit[], reviews: PendingReviewRecord[], operations: OperationRecord[], boundBoards: Set<string>): string[] {
  const adopted = adoptedPendingIds(reviews, operations, boundBoards);
  return pendingHeads(edits).filter(edit => !adopted.has(edit.id)).map(edit => edit.id).sort();
}

/** Small IndexedDB facade; no second Dexie runtime beside RxDB's pinned adapter.
 *  The table's key is `id`, except `boardTombstones`, which is keyed by
 *  `boardId` so there is exactly one row per board. */
class JournalTable<T extends object> {
  constructor(private journal: ChangeJournal, readonly name: string) {}
  get(id: string): Promise<T | undefined> { return this.journal.read(this.name, store => store.get(id)); }
  toArray(): Promise<T[]> { return this.journal.read(this.name, store => store.getAll()); }
  async count() { return (await this.toArray()).length; }
  async put(value: T) { await this.journal.write(this.name, store => { store.put(value); }); }
  async update(id: string, changes: Partial<T>) {
    await this.journal.write(this.name, store => {
      const request = store.get(id);
      request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...changes }); };
    });
  }
  where(index: string) {
    return { equals: (value: string | string[]) => {
      const query = () => this.journal.read<T[]>(this.name, store => store.index(index).getAll(value));
      return { toArray: query, count: async () => (await query()).length };
    } };
  }
}

/** Local-only WAL; deliberately separate from replicated settings and wire schemas. */
export class ChangeJournal {
  readonly name: string;
  readonly entries = new JournalTable<JournalEntry>(this, "entries");
  readonly receipts = new JournalTable<Receipt>(this, "receipts");
  readonly drafts = new JournalTable<ConflictDraft>(this, "drafts");
  readonly permissions = new JournalTable<OfflinePermission>(this, "permissions");
  readonly pendingEdits = new JournalTable<PendingEdit>(this, "pendingEdits");
  /** Device-local verification evidence; never accepted from backup or peers. */
  readonly publicGrants = new JournalTable<PublicGrant>(this, "publicGrants");
  readonly admissions = new JournalTable<{ id: string; boardId: string; authorityKeyId: string; epoch: number }>(this, "admissions");
  /** Device-local audit trail of Drive-verified authority re-keys. */
  readonly authorityTransitions = new JournalTable<AuthorityTransitionRow>(this, "authorityTransitions");
  /**
   * Durable `board.deleted` tombstones, keyed by board id and living outside
   * the board folder they outlive. Retained indefinitely: see
   * `storage/boardTombstone.ts` for the ordering rule and the retention rule.
   *
   * The same row carries the device-local Drive cleanup record (`cleanup`),
   * which is *not* a fact: it never participates in the deleted/restored
   * ordering, it is written by the device that is actually moving the folder,
   * and it is cleared — not retained — when the board is restored. See
   * `storage/boardCleanup.ts` for the state machine.
   */
  readonly tombstones = new JournalTable<BoardTombstoneRow>(this, "boardTombstones");
  private listeners = new Set<(tables: string[]) => void>();
  private changeListeners = new Set<(tables: string[]) => void>();
  /**
   * Counts journal changes. A cached table is only kept when the generation
   * did not move while it was being read: a value read before a change must
   * not be published as if it were read after it.
   */
  private generation = 0;

  private channel: BroadcastChannel | null = null;
  private database?: IDBDatabase;
  constructor(name: string) { this.name = `${name}-change-journal-v1`; }
  async open(): Promise<void> {
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 11);
      request.onupgradeneeded = () => {
        // Transport-independent operation WAL shares the existing journal DB.
        for (const name of ["operations", "operationStreams", "operationOutbox", "operationSegments", "operationCheckpoints"]) {
          if (!request.result.objectStoreNames.contains(name)) {
            const store = request.result.createObjectStore(name, { keyPath: "id" });
            store.createIndex("boardId", "boardId");
            if (["operationOutbox", "operationSegments"].includes(name)) store.createIndex("pendingBoard", "pendingBoard");
          }
        }
        // v11: durable board-deletion tombstones. One row per board, keyed by the
        // board id, so a duplicate tombstone is an idempotent merge of facts.
        if (!request.result.objectStoreNames.contains("boardTombstones")) request.result.createObjectStore("boardTombstones", { keyPath: "boardId" });
        const operationMetadata = request.transaction!.objectStore('operationCheckpoints');
        if (!operationMetadata.indexNames.contains('kind')) operationMetadata.createIndex('kind', 'kind');
        if (!operationMetadata.indexNames.contains('kindBoard')) operationMetadata.createIndex('kindBoard', ['kind', 'boardId']);
        const operationRows = request.transaction!.objectStore('operations');
        if (!operationRows.indexNames.contains('sourceId')) operationRows.createIndex('sourceId', 'sourceId', { unique: true });
        if (!operationRows.indexNames.contains('stream')) operationRows.createIndex('stream', ['boardId', 'operation.actorId', 'operation.seq']);
        if (!request.result.objectStoreNames.contains("entries")) {
        const entries = request.result.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("boardId", "boardId"); entries.createIndex("state", "state");
        entries.createIndex("[collection+documentId]", ["collection", "documentId"]);
        const receipts = request.result.createObjectStore("receipts", { keyPath: "id" });
        receipts.createIndex("destination", "destination");
        }
        if (!request.result.objectStoreNames.contains("drafts")) {
          request.result.createObjectStore("drafts", { keyPath: "id" }).createIndex("target", "target");
        }
        if (!request.result.objectStoreNames.contains("publicGrants")) request.result.createObjectStore("publicGrants", { keyPath: "id" }).createIndex("boardId", "boardId");
        if (!request.result.objectStoreNames.contains("boardFlags")) request.result.createObjectStore("boardFlags");
        if (!request.result.objectStoreNames.contains("authorityTransitions")) request.result.createObjectStore("authorityTransitions", { keyPath: "id" }).createIndex("boardId", "boardId");
        for (const name of ["permissions", "pendingEdits", "admissions"]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
        }
        const sources = request.transaction!.objectStore('entries');
        if (!sources.indexNames.contains('localBoard')) sources.createIndex('localBoard', ['boardId', 'state', 'origin']);
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
    });
  }
  close(): void {
    this.channel?.close(); this.channel = null;
    // Listeners a closed journal still held are gone with it; the gauge must
    // not keep reporting readers of a database nobody can read.
    if (this.listeners.size) collaborationCounters.adjustActive("journal.listeners", -this.listeners.size);
    this.listeners.clear(); this.changeListeners.clear(); this.signedHistory.clear(); this.database?.close(); this.database = undefined;
  }
  subscribe(listener: (tables: string[]) => void): () => void {
    this.listeners.add(listener);
    // Live gauge: how many journal readers this context holds. One per board
    // session, one per repository subscription and one per open panel, so a
    // board switch that never releases its reader leaves this climbing.
    collaborationCounters.adjustActive("journal.listeners", 1);
    if (!this.channel && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`pboard:journal:${this.name}`);
      // The tables that changed travel with the message, so a reader that
      // mirrors one store is not re-read because an unrelated store changed in
      // another context. A message without table names means "everything
      // changed", which is what an older peer sends.
      this.channel.onmessage = (event: MessageEvent) => {
        collaborationCounters.countEvent("journal.remote");
        const tables = Array.isArray(event.data?.tables)
          ? (event.data.tables as string[]).filter((table) => typeof table === "string")
          : [];
          // A signed entry committed in another context raises the monotonic
          // bit there; drop this context's negative answers so the next read
          // re-reads the flag instead of trusting a stale scan.
          if (!tables.length || tables.includes("entries")) for (const [board, bit] of [...this.signedHistory])
            void bit.then((signed) => { if (!signed && this.signedHistory.get(board) === bit) this.signedHistory.delete(board); });
          // A tombstone written in another context (the worker, a second tab) is
          // this context's answer too: drop the shared copy so the next
          // `isDeletedProject` re-reads it instead of trusting a pre-delete scan.
          if (!tables.length || tables.includes("boardTombstones")) this.tombstoneCache = null;
        for (const next of this.listeners) next(tables);
      };
    }
    return () => {
      if (this.listeners.delete(listener)) collaborationCounters.adjustActive("journal.listeners", -1);
      if (!this.listeners.size) { this.channel?.close(); this.channel = null; }
    };
  }
  /**
   * Runs on every journal change, including changes another browser made.
   * The listener receives the names of the stores that changed, so a reader
   * that mirrors one store is not forced to re-read it because an unrelated
   * store changed.
   */
  onChange(listener: (tables: string[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }
  /**
   * Notifies listeners that the journal changed. `tables` names the stores
   * that actually changed, so a reader that mirrors one store is not forced
   * to re-read it because an unrelated store changed.
   */
  private notify(tables: string[] = []): void {
    this.generation++;
    // Only the store that holds the cached data invalidates it. An erasure
    // marker lives in the receipts store, so a change to the change log
    // leaves the marker copy valid.
    if (!tables.length || tables.includes("receipts")) this.erasureCache = null;
    if (!tables.length || tables.includes("boardTombstones")) this.tombstoneCache = null;
    if (!tables.length || tables.includes("entries")) this.committedCache = null;
    for (const listener of this.changeListeners) listener(tables);
    collaborationCounters.countEvent("journal.notify");
    for (const listener of this.listeners) listener(tables);
    const sender = this.channel ?? (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`pboard:journal:${this.name}`));
    // The table names travel with the message. A reader in another context
    // that mirrors one store is then not re-read because an unrelated store
    // changed there.
    sender?.postMessage({ tables });
    if (sender !== this.channel) sender?.close();
  }
  /** One strict transaction for operation identity, WAL and publication intent.
   * The callback must enqueue IDB requests synchronously; never await network or
   * WebCrypto while an IndexedDB transaction is active. */
  operationTransaction<T>(boardId: string, names: string[], run: (transaction: IDBTransaction, result: (value: T) => void) => void, notifications?: string[]): Promise<T> {
    const allowed = new Set(["operations", "operationStreams", "operationOutbox", "operationSegments", "operationCheckpoints", "entries"]);
    if (!names.length || names.some(name => !allowed.has(name))) return Promise.reject(new Error("Invalid operation transaction"));
    return new Promise<T>((resolve, reject) => {
      const tx = this.database!.transaction([...names, "receipts"], "readwrite", { durability: "strict" });
      let value: T;
      tx.oncomplete = () => { this.notify([...(notifications ?? names), `operation-board:${boardId}`]); resolve(value); };
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Operation transaction aborted"));
      const marker = tx.objectStore('receipts').get(JSON.stringify([boardId, 'local-board-erasure']));
      marker.onsuccess = () => {
        if (marker.result) { tx.abort(); return; }
        try { run(tx, result => { value = result; }); } catch (error) { tx.abort(); reject(error); }
      };
    });
  }
  async read<T>(name: string, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transaction = this.database!.transaction(name, "readonly");
      const request = operation(transaction.objectStore(name));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Journal transaction aborted"));
    });
  }
  async write(name: string, operation: (store: IDBObjectStore, erasedBoards: Set<string>) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transaction = this.database!.transaction(name === 'receipts' ? [name] : name === 'entries' ? [name, 'receipts', 'boardFlags', 'operationCheckpoints'] : [name, 'receipts'], "readwrite", { durability: "strict" });
      transaction.oncomplete = () => {
        resolve();
        // A receipts write can add or update a board-erasure marker, so the
        // shared marker copy is dropped even though no notification is sent.
        if (name === 'receipts') { this.erasureCache = null; return; }
        if (["entries", "pendingEdits", "permissions", "boardTombstones"].includes(name)) this.notify([name]);
      };
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Journal transaction aborted"));
      const signedHistory = this.signedHistory;
      const run = (erased: Set<string>) => {
        const store = transaction.objectStore(name);
        const guarded = new Proxy(store, { get(target, key) {
          if (key === 'put' || key === 'add') return (value: any, id?: IDBValidKey) => {
            const boardId = name === 'permissions' ? value.id : name === 'drafts' ? JSON.parse(value.target)[0] : value.boardId;
            if (erased.has(boardId)) throw new Error(PERMANENTLY_DELETED);
            if (name === 'entries' && value.state === 'committed' && value.origin === 'local') {
              const metadata = transaction.objectStore('operationCheckpoints');
              const binding = metadata.get(`binding:${boardId}`);
              binding.onsuccess = () => { if (binding.result?.pendingIndexed) metadata.put({ id: `source-pending:${value.id}`, kind: 'operation-source-pending', boardId, entryId: value.id }); };
            }
            if (name === 'entries' && value.value?._sec && value.state === 'committed') {
              // Persist the monotonic signed-history bit inside the transaction
              // that commits the entry, so authorization checks answer from one
              // record instead of scanning the whole journal on every write.
              transaction.objectStore('boardFlags').put(true, value.boardId);
              signedHistory.set(value.boardId, Promise.resolve(true));
            }
            return id === undefined ? target[key](value) : target[key](value, id);
          };
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
        try { operation(guarded, erased); } catch (error) { transaction.abort(); reject(error); }
      };
      if (name === 'receipts') run(new Set());
      else {
        // The write guard refuses to write to a permanently deleted board. The
        // markers are read inside the same transaction as the write, so a
        // board erased concurrently cannot be written to.
        const request = transaction.objectStore('receipts').index('destination').getAll('local-board-erasure');
        request.onsuccess = () => run(new Set(request.result.map(value => value.boardId)));
      }
    });
  }
  async prepare(collection: Change["collection"], document: Record<string, unknown>, previous: Record<string, unknown> | undefined, local: boolean, resolution?: string[], authenticated = false): Promise<JournalEntry> {
    const boardId = String(collection === "projects" ? document.id : document.projectId);
    const common = { boardId, collection, documentId: String(document.id) };
    const candidates = await this.entries.where("[collection+documentId]").equals([collection, common.documentId]).toArray();
    if (!local) {
      const exact = candidates.find(c => c.boardId === boardId && c.state === "committed" && canonicalize(c.value) === canonicalize(documentValue(document)) && !!c.proof);
      if (exact) return exact;
    }
    const portable = authenticated ? portableJournalChanges(candidates) : new Set<string>();
    const recorded = candidates.filter(c => c.boardId === boardId && (c.state === "committed" || c.state === "prepared"));
    const claims = new Set<JournalEntry>();
    // Prepare states its ancestry claim in two forms: an explicit resolution set, or the
    // single recorded entry it matched from the stored bytes. Either claim must be the head
    // this journal recorded for this document; a claim on an entry this journal already
    // superseded is the anonymous fork that would only surface as a conflict at confirm
    // time, so it is refused here, before the entry is constructed or written, leaving the
    // recorded head intact and nothing stranded. Unattributable content is not a claim on a
    // specific entry, so it still synthesizes the honest unknown baseline root.
    if (resolution) for (const claim of resolution) { const found = recorded.find(c => c.id === claim); if (found) claims.add(found); }
    let parent: JournalEntry | undefined;
    if (local && previous && !resolution) {
      // RxDB's storage wrapper generates revisions after our WAL boundary.
      // Match the complete immutable previous value, never a timestamp.
      const previousValue = canonicalize(documentValue(previous));
      // Entries include state "prepared": a write whose durable document
      // committed but whose journal finish never ran (interrupted worker)
      // would otherwise strand the next write into a baseline fork.
      const matches = candidates.filter(c => c.boardId === boardId && (c.state === "committed" || c.state === "prepared")
        && canonicalize(c.value) === previousValue
        // A portable chain proves ancestry to a root; independently, an entry
        // this board's own authority signed AND proved IS evidence for these
        // exact bytes. Without that second form, an attested board — whose
        // pre-signing root is unsigned and therefore never portable — would
        // invent a duplicate baseline root on every signed write, and the
        // resulting unrelated chains surface as a conflict once the board is
        // deleted ("retained conflict evidence on removed boards").
        && (!authenticated || !previous._sec || portable.has(c.id) || (!!c.value._sec && !!c.proof)));
      // Multiple indistinguishable payloads with different ancestry are not
      // evidence that this writer observed either specific branch.
      parent = matches.length === 1 ? matches[0] : undefined;

      // A remove write bumps updatedAt and re-signs the document in place,
      // so RxDB hands those mutations back as previous and no journal entry
      // can byte-match them. Anchor removals on content identity instead:
      // everything except the two fields the delete path itself rewrites.
      // Ambiguous content still synthesizes a baseline root.
      if (!parent && document._deleted === true && previous._sec) {
        const content = (value: DocumentValue) => canonicalize(documentValue(
          Object.fromEntries(Object.entries(value).filter(([k]) => k !== "_sec" && k !== "updatedAt"))));
        const previousContent = content(previous as unknown as DocumentValue);
        const found = candidates.filter(c => c.boardId === boardId && (c.state === "committed" || c.state === "prepared")
          && content(c.value) === previousContent
          && (!authenticated || portable.has(c.id) || (!!c.value._sec && !!c.proof)));
        if (found.length === 1) parent = found[0];
      }

      if (!parent) {
        parent = { ...await makeChange({ ...common, parents: [], ancestry: "unknown", value: documentValue(previous) }),
          state: "committed", origin: "baseline" };
      }
    }
    if (parent) claims.add(parent);
    for (const claim of claims) if (recorded.some(c => c !== claim && c.parents.includes(claim.id))) throw new Error("Change must anchor on the recorded change journal head");

    const entry: JournalEntry = { ...await makeChange({ ...common, parents: resolution ?? (parent ? [parent.id] : []),
      ancestry: resolution || local && (!previous || parent) ? "known" : "unknown", value: documentValue(document) }),
      state: "prepared", origin: local ? "local" : "observed" };
    await this.write("entries", store => {
      for (const candidate of [...(parent ? [parent] : []), entry]) {
        const request = store.get(candidate.id);
        request.onsuccess = () => {
          if (!request.result || request.result.state === "rejected") store.put(candidate);
          // A parent matched from a never-finished write commits now: the
          // byte match proves its document is durable, and reconcile only
          // walks committed entries, so a child must never reference one
          // still marked prepared.
          else if (candidate === parent && parent.state === "prepared" && request.result.state === "prepared")
            store.put({ ...parent, state: "committed" });
        };
      }
    });
    return entry;
  }
  async finish(entries: JournalEntry[], failedIds: Set<string>): Promise<void> {
    await this.write("entries", store => {
      for (const entry of entries) {
        const request = store.get(entry.id);
        request.onsuccess = () => {
          if (request.result?.state !== "committed") store.put({ ...entry,
            state: failedIds.has(entry.documentId) ? "rejected" : "committed" });
        };
      }
    });
  }
  async recoverEntry(id: string, committed: boolean): Promise<void> {
    await this.write("entries", store => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result?.state === "prepared") store.put({ ...request.result, state: committed ? "committed" : "uncertain" });
      };
    });
  }
  /** Atomic batch admission, including references arriving before their parent. Callers
   * that tolerate a partially-applied batch drop retired-board entries from the shared
   * marker copy; reconciliation intake asks for refusal instead, so the decision is made
   * from the markers read inside this same strict transaction. */
  async accept(entries: JournalEntry[], refuseRetired = false): Promise<void> {
    if (!refuseRetired) {
      const erased = new Set((await this.boardErasures()).map(entry => entry.boardId));
      entries = entries.filter(entry => !erased.has(entry.boardId));
    }
    await this.write("entries", (store, erasedBoards) => {
      if (refuseRetired && entries.some(entry => erasedBoards.has(entry.boardId))) throw new Error(PERMANENTLY_DELETED);
      const request = store.getAll();
      request.onsuccess = () => {
        const existing = request.result as JournalEntry[];
        const graph = new Map([...existing, ...entries].map(c => [c.id, c]));
        for (const entry of graph.values()) {
          for (const parentId of entry.parents) {
            const parent = graph.get(parentId);
            if (parent && scope(parent) !== scope(entry)) { store.transaction.abort(); return; }
          }
        }
        for (const entry of entries) {
          const previous = existing.find(c => c.id === entry.id && c.state === "committed");
          // `observed` entries reaching durable commit here are the posture's
          // applied-change signal: peer replication, reconciliation receive and
          // Drive history archive all land through this method (local origins
          // are authored writes, already signalled at the storage hook).
          // Content-free — identity and provenance only.
          if (!previous && entry.origin === "observed")
            emit({ component: "sync", event: "operation.applied", severity: "info", boardId: entry.boardId, operationId: entry.id,
              details: { journal: entry.collection, documentId: entry.documentId, parents: entry.parents.length } });
          if (!previous) store.put(entry);
          else if ((!previous.proof && entry.proof) || (!previous.admission && entry.admission)) store.put({ ...previous,
            ...(entry.proof ? { proof: entry.proof } : {}), ...(entry.admission ? { admission: entry.admission } : {}) });
        }
      };
    });
  }
  /** No transport may acknowledge work until it has verified durable delivery. */
  async acknowledge(changeId: string, destination: string): Promise<void> {
    return this.acknowledgeMany([changeId], destination);
  }
  async acknowledgeMany(ids: string[], destination: string): Promise<void> {
    if (ids.length > 128) throw new Error("Receipt batch exceeds 128 changes");
    return new Promise<void>((resolve, reject) => {
      const tx = this.database!.transaction(["entries", "receipts"], "readwrite", { durability: "strict" });
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Cannot acknowledge uncommitted change"));
      for (const changeId of ids) {
        const request = tx.objectStore("entries").get(changeId);
        request.onsuccess = () => {
          if (request.result?.state !== "committed") { tx.abort(); return; }
          tx.objectStore("receipts").put({ id: JSON.stringify([changeId, destination]), changeId, destination });
        };
      }
    });
  }
  async pending(destination: string): Promise<JournalEntry[]> {
    const delivered = new Set((await this.receipts.where("destination").equals(destination).toArray()).map(r => r.changeId));
    // Received variants and legacy baselines also need private persistence and
    // delivery to other authorized peers; receipt state is per destination.
    return (await this.entries.where("state").equals("committed").toArray()).filter(e => !delivered.has(e.id));
  }
  /** Explicit local disposal. Receipt markers never leave this device. */
  async discardPendingWork(boardId: string, reviewedIds: string[], erasure?: { accountId: string | null; imageIds: string[]; cardIds: string[] }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.database!.transaction(['pendingEdits', 'receipts', 'operationCheckpoints', 'operations'], 'readwrite', { durability: 'strict' });
      let failure: Error | undefined;
      tx.oncomplete = () => { resolve(); this.notify(["pendingEdits", "receipts"]); };
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('Retained work could not be deleted'));
      const store = tx.objectStore('pendingEdits'), checkpoints = tx.objectStore('operationCheckpoints'), operationRows: OperationRecord[] = [], bound = new Set<string>();
      const confirm = (edits: PendingEdit[], reviews: PendingReviewRecord[]) => {
        const expected = confirmableIds(edits, reviews, operationRows, bound);
        const confirmed = new Set(reviewedIds);
        if (confirmed.size !== expected.length || confirmed.size !== reviewedIds.length || canonicalize([...confirmed].sort()) !== canonicalize(expected)) {
          failure = new Error('Retained work changed. Review it again before deleting.'); tx.abort(); return;
        }
        if (erasure) tx.objectStore('receipts').put({ id: JSON.stringify([boardId, 'local-board-erasure']), changeId: boardId,
          destination: 'local-board-erasure', boardId, ...erasure, cloudPending: !!erasure.accountId });
        for (const edit of edits) {
          const destination = `local-pending-discard:${boardId}`;
          tx.objectStore('receipts').put({ id: JSON.stringify([edit.id, destination]), changeId: edit.id, destination });
          store.delete(edit.id);
        }
      };
      const request = store.getAll();
      request.onsuccess = () => {
        const edits = (request.result as PendingEdit[]).filter(edit => edit.boardId === boardId);
        const reviews = checkpoints.index('kindBoard').getAll(['operation-pending-review', boardId]);
        const binding = checkpoints.index('kindBoard').get(['operation-binding', boardId]);
        let outstanding = 2;
        const settle = () => { if (!outstanding) confirm(edits, reviews.result as PendingReviewRecord[]); };
        binding.onsuccess = () => { if (binding.result) bound.add(boardId); outstanding--; settle(); };
        reviews.onsuccess = () => {
          for (const review of reviews.result as PendingReviewRecord[]) {
            outstanding++;
            const operation = tx.objectStore('operations').get(review.operationId);
            const done = () => { if (operation.result) operationRows.push(operation.result as OperationRecord); outstanding--; settle(); };
            operation.onsuccess = done; operation.onerror = done;
          }
          outstanding--; settle();
        };
      };
    });
  }
  /** Atomic with disposal so a concurrent private restore cannot resurrect it. */
  async restorePendingWork(edit: PendingEdit, checkExisting: (existing: PendingEdit) => void): Promise<void> {
    if (await this.boardErasure(edit.boardId)) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.database!.transaction(['pendingEdits', 'receipts'], 'readwrite', { durability: 'strict' });
      let failure: unknown, changed = false;
      tx.oncomplete = () => { resolve(); if (changed) this.notify(["pendingEdits"]); };
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('Pending work could not be restored'));
      const boardMarker = tx.objectStore('receipts').get(JSON.stringify([edit.boardId, 'local-board-erasure']));
      const marker = tx.objectStore('receipts').get(JSON.stringify([edit.id, `local-pending-discard:${edit.boardId}`]));
      marker.onsuccess = () => {
        if (marker.result || boardMarker.result) return;
        const store = tx.objectStore('pendingEdits'), request = store.get(edit.id);
        request.onsuccess = () => {
          try {
            if (request.result) checkExisting(request.result);
            else { const { admittedChangeId: _, projected: __, ...held } = edit; store.put(held); changed = true; }
          } catch (error) { failure = error; tx.abort(); }
        };
      };
    });
  }
  /**
   * Board-erasure markers live in the receipts table. Every card and project
   * read asks for one, so the markers are read once and shared, and the
   * shared copy is dropped whenever the journal changes.
   */
  private erasureCache: Map<string, BoardErasure> | null = null;
  private erasureLoad: Promise<Map<string, BoardErasure>> | null = null;
  private erasureGeneration = -1;
  private async erasureMarkers(): Promise<Map<string, BoardErasure>> {
    if (this.erasureCache && this.erasureGeneration === this.generation) return this.erasureCache;
    const generation = this.generation;
    this.erasureLoad ??= this.receipts.where('destination').equals('local-board-erasure').toArray().then(markers => {
      const map = new Map<string, BoardErasure>();
      for (const marker of markers) {
        const erasure = marker as unknown as BoardErasure;
        if (typeof erasure.boardId === "string") map.set(erasure.boardId, erasure);
      }
      // A change that landed during the read invalidates the copy.
      if (generation === this.generation) { this.erasureCache = map; this.erasureGeneration = generation; }
      this.erasureLoad = null;
      return map;
    });
    return this.erasureLoad;
  }
  async boardErasure(boardId: string): Promise<BoardErasure | undefined> {
    return (await this.erasureMarkers()).get(boardId);
  }
  async boardErasures(): Promise<BoardErasure[]> {
    return [...(await this.erasureMarkers()).values()];
  }
  /**
   * The committed change log. The conflict panel reconciles the whole log,
   * and the private backup reads it, so the committed rows are read once and
   * shared, and the shared copy is dropped whenever the journal changes.
   */
  private committedCache: JournalEntry[] | null = null;
  private committedLoad: Promise<JournalEntry[]> | null = null;
  async committedEntries(): Promise<JournalEntry[]> {
    if (this.committedCache) return this.committedCache;
    this.committedLoad ??= this.entries.where("state").equals("committed").toArray().then(value => {
      this.committedCache = value;
      this.committedLoad = null;
      return value;
    });
    return this.committedLoad;
  }
  async localSourceIds(boardId: string): Promise<string[]> {
    return (await this.read<IDBValidKey[]>('entries', store => store.index('localBoard').getAllKeys([boardId, 'committed', 'local']))).map(String);
  }
  /** Enumerate board keys first so operation boards never load/reconcile their
   * legacy document histories just to refresh the old conflict panel. */
  async committedEntriesExcept(excluded: ReadonlySet<string>): Promise<JournalEntry[]> {
    const boards = await new Promise<string[]>((resolve, reject) => {
      const tx = this.database!.transaction('entries', 'readonly'), ids: string[] = [];
      const cursor = tx.objectStore('entries').index('boardId').openKeyCursor(null, 'nextunique');
      cursor.onsuccess = () => { if (cursor.result) { const id = String(cursor.result.key); if (!excluded.has(id)) ids.push(id); cursor.result.continue(); } };
      tx.oncomplete = () => resolve(ids); tx.onerror = tx.onabort = () => reject(tx.error);
    });
    return (await Promise.all(boards.map(id => this.entries.where('boardId').equals(id).toArray()))).flat().filter(entry => entry.state === 'committed');
  }
  /**
   * Whether this board's committed journal history holds signed entries.
   * A board never loses its signed history, so the bit is monotonic: the
   * write guard raises it in the transaction that commits a signed entry,
   * and only the bootstrap scan below may persist a negative answer. The
   * per-write authorization checks answer from this one record instead of
   * reading the whole change log, which made every card edit expensive
   * once a profile had months of journal.
   */
  private signedHistory = new Map<string, Promise<boolean>>();
  hasSignedHistory(boardId: string): Promise<boolean> {
    const cached = this.signedHistory.get(boardId);
    if (cached) return cached;
    const pending = (async () => {
      const flag = await this.read("boardFlags", (store) => store.get(boardId) as IDBRequest<boolean | undefined>);
      if (flag !== undefined) return flag;
      const entries = await this.read("entries", (store) => store.index("boardId").getAll(boardId) as IDBRequest<JournalEntry[]>);
      const signed = entries.some((entry) => entry.state === "committed" && !!entry.value._sec);
      await this.write("boardFlags", (store) => { store.put(signed, boardId); });
      return signed;
    })();
    this.signedHistory.set(boardId, pending);
    return pending;
  }
  /**
   * The durable `board.deleted` tombstone. This is the first thing a deletion
   * writes and the last thing that ever forgets it — see
   * `storage/boardTombstone.ts` for the record and its ordering rule.
   *
   * The writer identity, the fact's `seq` and its Lamport `clock` are allocated
   * in the same strict transaction as the row, so two contexts can never mint
   * the same `opId`; and the context is widened to everything this device has
   * already observed (its own vector plus every stored fact), which is what
   * makes a later restore dominate the deletion it reverses and a re-deletion
   * dominate that restore.
   *
   * The transaction touches three stores: `boardTombstones` (the fact),
   * `operationCheckpoints` (the writer row: actor id, sequence, clock) and
   * `receipts` (the permanent-erasure marker that must not be raced).
   */
  async recordBoardDeletion(input: BoardDeletionInput): Promise<BoardTombstoneFact> {
    let recorded!: BoardTombstoneFact;
    await new Promise<void>((resolve, reject) => {
      const tx = this.database!.transaction(["boardTombstones", "operationCheckpoints", "receipts"], "readwrite", { durability: "strict" });
      tx.oncomplete = () => { this.notify(["boardTombstones"]); resolve(); };
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Board tombstone was not recorded"));
      const writerStore = tx.objectStore("operationCheckpoints"), tombstoneStore = tx.objectStore("boardTombstones");
      const writerRequest = writerStore.get("tombstone-writer");
      writerRequest.onsuccess = () => {
        const storedWriter = writerRequest.result as { id: string; kind: string; actorId: string; seq: number; clock: number } | undefined;
        const writer = storedWriter ?? { id: "tombstone-writer", kind: "tombstone-writer", actorId: crypto.randomUUID(), seq: 0, clock: 0 };
        const rowRequest = tombstoneStore.get(input.boardId);
        rowRequest.onsuccess = () => {
          try {
            const row = rowRequest.result as BoardTombstoneRow | undefined;
            const existing = row?.facts ?? [];
            const observed: CausalContext = { ...input.context };
            for (const [actor, seq] of Object.entries(input.context)) observed[actor] = Math.max(observed[actor] ?? 0, seq);
            for (const fact of existing) {
              observed[fact.actorId] = Math.max(observed[fact.actorId] ?? 0, fact.seq);
              for (const [actor, seq] of Object.entries(fact.context)) observed[actor] = Math.max(observed[actor] ?? 0, seq);
            }
            const seq = writer.seq + 1, clock = Math.max(writer.clock, input.clock ?? 0, ...existing.map(fact => fact.clock)) + 1;
            const fact: BoardTombstoneFact = { kind: input.kind ?? "deleted", accountId: input.accountId,
              opId: `${writer.actorId}:${seq}`, actorId: writer.actorId,
              seq, clock, context: observed, deviceId: writer.actorId, role: input.role, at: input.at, evidence: input.evidence };
            // The Drive cleanup record travels in the same row as the facts but
            // is not one of them: it never participates in the ordering rule.
            // A restore drops it (a live board's folder must never be trashed);
            // a later deletion keeps whatever progress the earlier one made, so
            // a confirmed Trash is never repeated. Minting the record itself is
            // `beginBoardCleanup`, which is a separate strict write made once
            // the deletion is known to destroy content — the fact's role is a
            // hint at this point, not the resolved verdict.
            const cleanup = input.kind === "restored" ? undefined : row?.cleanup;
            tombstoneStore.put({ boardId: input.boardId, facts: mergeFacts(existing, [fact]), ...(cleanup ? { cleanup } : {}) });
            writerStore.put({ ...writer, seq, clock });
            recorded = fact;
          } catch (error) { tx.abort(); reject(error); }
        };
        rowRequest.onerror = () => { tx.abort(); reject(rowRequest.error); };
      };
      writerRequest.onerror = () => { tx.abort(); reject(writerRequest.error); };
    });
    return recorded;
  }
  async boardTombstoneFacts(boardId: string): Promise<BoardTombstoneFact[]> {
    const row = await this.tombstones.get(boardId);
    return row?.facts ?? [];
  }
  /**
   * Merges one fact received from a peer into the same durable record the
   * local delete/restore path writes, through the same ordering rule.
   *
   * There is no second merge anywhere: the union is `mergeFacts` (dedupe by
   * `opId`, sort by the total order), the decision is `latestFact`, and the
   * Lamport receive rule is applied to the writer row in the same transaction
   * so a later locally written fact dominates everything this device has
   * observed — exactly as if the received fact had been written here.
   *
   * `duplicate` reports that the *deciding* fact did not change: a replay of a
   * stored `opId`, an older fact, or a concurrent fact that lost the tie. The
   * fact is still unioned in (it is evidence a later restore must be able to
   * dominate, and keeping the whole set is what makes two receivers that got
   * the same facts in different orders store the same bytes), but the board's
   * state did not move, so the caller must not treat it as a new decision.
   */
  async mergeBoardTombstone(input: { boardId: string; fact: BoardTombstoneFact }): Promise<BoardTombstoneMerge> {
    let outcome: BoardTombstoneMerge = { duplicate: true, deleted: false };
    await new Promise<void>((resolve, reject) => {
      const tx = this.database!.transaction(["boardTombstones", "operationCheckpoints"], "readwrite", { durability: "strict" });
      tx.oncomplete = () => { this.notify(["boardTombstones"]); resolve(); };
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Board tombstone was not recorded"));
      const writerStore = tx.objectStore("operationCheckpoints"), tombstoneStore = tx.objectStore("boardTombstones");
      const writerRequest = writerStore.get("tombstone-writer");
      writerRequest.onsuccess = () => {
        const stored = writerRequest.result as { id: string; kind: string; actorId: string; seq: number; clock: number } | undefined;
        const rowRequest = tombstoneStore.get(input.boardId);
        rowRequest.onsuccess = () => {
          try {
            const row = rowRequest.result as BoardTombstoneRow | undefined;
            const existing = row?.facts ?? [];
            const before = latestFact(existing, input.fact.accountId);
            if (existing.some(fact => fact.opId === input.fact.opId)) {
              // The same fact again: still evidence, already stored. Nothing to
              // write, so the record's bytes cannot drift on a replay.
              outcome = { duplicate: true, deleted: before?.kind === "deleted" };
              return;
            }
            const facts = mergeFacts(existing, [input.fact]);
            const after = latestFact(facts, input.fact.accountId);
            // The Drive-cleanup record in this row belongs to this device, not
            // to the fact, and a received fact must never touch it: a peer's
            // deletion does not make *this* device owe a Trash.
            tombstoneStore.put({ ...(row ?? { boardId: input.boardId }), facts });
            // Lamport receive: this device has now observed the sender's clock,
            // so a fact it writes next is ordered after it.
            if (!stored) writerStore.put({ id: "tombstone-writer", kind: "tombstone-writer", actorId: crypto.randomUUID(), seq: 0, clock: input.fact.clock });
            else if (input.fact.clock > stored.clock) writerStore.put({ ...stored, clock: input.fact.clock });
            outcome = { duplicate: before?.opId === after?.opId, deleted: after?.kind === "deleted" };
          } catch (error) { tx.abort(); reject(error); }
        };
        rowRequest.onerror = () => { tx.abort(); reject(rowRequest.error); };
      };
      writerRequest.onerror = () => { tx.abort(); reject(writerRequest.error); };
    });
    return outcome;
  }
  /**
   * This device's Drive-cleanup progress for a board, or null when it owes
   * none. Deliberately a separate read from `boardTombstone`: the cleanup is
   * not a fact, and a board can be tombstoned with no cleanup record at all
   * (a deletion adopted from a legacy preference before this build, or one the
   * user restored and re-deleted across versions).
   */
  async boardCleanup(boardId: string): Promise<BoardCleanupState | null> {
    const row = await this.tombstones.get(boardId);
    return row?.cleanup ?? null;
  }
  /**
   * Every board whose folder this device still owes a move to Trash. Read by
   * the reconcile round's cleanup pass, so a browser that closed between the
   * tombstone and the Trash resumes exactly those boards — no Drive listing,
   * no enumeration of the account.
   */
  async pendingBoardCleanups(): Promise<{ boardId: string; cleanup: BoardCleanupState }[]> {
    // One row per *deleted* board — bounded by how many boards this device ever
    // deleted, not by how many it holds — and read through the same store the
    // tombstone cache already reads wholesale. No second index: an added index
    // would force a schema bump, and a bump fires `versionchange` on every
    // other open context of this browser.
    const rows = await this.tombstones.toArray();
    return rows.flatMap(row => row.cleanup && row.cleanup.stage !== "trashed" ? [{ boardId: row.boardId, cleanup: row.cleanup }] : []);
  }
  /**
   * Records that this device owes the board's Drive folder a move to Trash.
   *
   * Called by the repository on the one path that destroys a board's content —
   * and therefore only for the owner — and **after** `recordBoardDeletion`
   * resolved, never before: the tombstone is what authorises the folder move,
   * and the executor re-reads it before writing to Drive. It is a single-store
   * strict write, so it cannot half-succeed, and it is idempotent: a second
   * deletion of a board whose Trash was already confirmed leaves the terminal
   * record alone.
   */
  async beginBoardCleanup(boardId: string, accountId: string | null, at: string, now: number, name?: string): Promise<BoardCleanupState | null> {
    const row = await this.tombstones.get(boardId);
    // No row means no tombstone: a caller that reached here out of order gets
    // nothing, rather than a cleanup record with no deletion behind it.
    if (!row) return null;
    if (row.cleanup?.stage === "trashed") return row.cleanup;
    const cleanup = pendingBoardCleanup(accountId, at, now, name ?? row.cleanup?.name);
    await this.tombstones.put({ ...row, cleanup });
    return cleanup;
  }
  /**
   * Records that the move to Trash is confirmed. Written through the plain
   * table write (one store, one row): it is device-local progress, never part
   * of the tombstone transaction, and a lost confirmation costs one idempotent
   * retry against a folder Drive already holds in Trash.
   */
  async confirmBoardCleanup(boardId: string, folderIds: readonly string[], at: string): Promise<BoardCleanupState | null> {
    const row = await this.tombstones.get(boardId);
    if (!row) return null;
    const record = row.cleanup ?? pendingBoardCleanup(null, at, 0);
    const next = confirmedBoardCleanup(record, folderIds, at);
    await this.tombstones.put({ ...row, cleanup: next });
    return next;
  }
  /**
   * Records a failed attempt: the stage becomes `failed`, the reason is kept
   * for the UI, and the next attempt is scheduled by the bounded ladder in
   * `storage/boardCleanup.ts`. The tombstone and the board's hidden state are
   * untouched — a failure here is not a reason to resurrect a board.
   */
  async failBoardCleanup(boardId: string, reason: string, at: string, now: number, folderId?: string): Promise<BoardCleanupState | null> {
    const row = await this.tombstones.get(boardId);
    if (!row) return null;
    const record = row.cleanup ?? pendingBoardCleanup(null, at, now);
    const next = failedBoardCleanup(folderId ? { ...record, folderId } : record, reason, at, now);
    await this.tombstones.put({ ...row, cleanup: next });
    return next;
  }
  /** The deletion state a stored fact row implies for one account list. No
   *  wall clock is consulted. */
  async boardTombstone(boardId: string, accountId: string | null = null): Promise<BoardDeletionState> {
    const fact = (await this.tombstoneStates()).get(tombstoneKey(boardId, accountId));
    return fact ? { deleted: true, fact } : { deleted: false };
  }
  /**
   * Whether a copy of the board that observed `context` may be admitted.
   * The default (an empty context) is the answer every import path needs: a
   * Drive file, an old snapshot, a legacy row or a replayed segment carries no
   * causal context, so it never dominates a tombstone.
   */
  async boardDeletionBlocks(boardId: string, context: CausalContext = {}, accountId: string | null = null): Promise<boolean> {
    const latest = (await this.tombstoneStates()).get(tombstoneKey(boardId, accountId));
    return !!latest && !dominates(context, latest);
  }
  /** Every tombstoned board, cached like the erasure markers and dropped when the
   *  store changes (including a change another browser made). */
  private tombstoneCache: Map<string, BoardTombstoneFact> | null = null;
  private tombstoneLoad: Promise<Map<string, BoardTombstoneFact>> | null = null;
  private tombstoneGeneration = -1;
  private async tombstoneStates(): Promise<Map<string, BoardTombstoneFact>> {
    if (this.tombstoneCache && this.tombstoneGeneration === this.generation) return this.tombstoneCache;
    const generation = this.generation;
    this.tombstoneLoad ??= this.tombstones.toArray().then(rows => {
      const map = new Map<string, BoardTombstoneFact>();
      for (const row of rows) {
        const accounts = new Set<string | null>((row.facts ?? []).map(fact => fact.accountId ?? null));
        for (const accountId of accounts) {
          const latest = latestFact(row.facts ?? [], accountId);
          if (latest && latest.kind === "deleted") map.set(tombstoneKey(row.boardId, accountId), latest);
        }
      }
      if (generation === this.generation) { this.tombstoneCache = map; this.tombstoneGeneration = generation; }
      this.tombstoneLoad = null;
      return map;
    });
    return this.tombstoneLoad;
  }
  /** Boards whose latest tombstone fact is a deletion in one account list. */
  async deletedBoards(accountId: string | null = null): Promise<Set<string>> {
    const boards = new Set<string>();
    for (const key of (await this.tombstoneStates()).keys()) {
      const split = key.indexOf("\u0000");
      if (key.slice(0, split) === (accountId ?? "")) boards.add(key.slice(split + 1));
    }
    return boards;
  }
  /** Every board with any tombstone fact, deleted or restored. Migration uses
   *  this: a board that was once deleted and then restored must not be adopted
   *  from a stale preference marker again. */
  async boardTombstoneBoards(): Promise<Set<string>> {
    const rows = await this.tombstones.toArray();
    return new Set(rows.filter(row => (row.facts ?? []).length > 0).map(row => row.boardId));
  }
  async beginBoardErasure(boardId: string, accountId: string | null, imageIds: string[], cardIds: string[]) {
    if (await this.boardErasure(boardId)) return;
    await this.receipts.put({ id: JSON.stringify([boardId, 'local-board-erasure']), changeId: boardId,
      destination: 'local-board-erasure', boardId, accountId, imageIds, cardIds, cloudPending: !!accountId } as BoardErasure);
    this.notify(["receipts"]);
  }
  async purgeBoardHistory(boardId: string) {
    const names = ['entries', 'pendingEdits', 'drafts', 'permissions', 'publicGrants', 'admissions', 'operations', 'operationStreams', 'operationOutbox', 'operationSegments', 'operationCheckpoints'];
    await new Promise<void>((resolve, reject) => {
      const tx = this.database!.transaction([...names, 'receipts'], 'readwrite', { durability: 'strict' });
      tx.oncomplete = () => { resolve(); this.notify(["entries", "pendingEdits", "receipts", "operationBindings"]); };
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Board erasure remains pending'));
      const removedIds = new Set<string>(); let remaining = names.length;
      const cleanupReceipts = () => {
        const request = tx.objectStore('receipts').openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) return;
          if (cursor.value.destination !== 'local-board-erasure' && (removedIds.has(cursor.value.changeId) || cursor.value.destination === `local-pending-discard:${boardId}` || cursor.value.destination === `operation-download:${boardId}` || cursor.value.destination === `operation-source-covered:${boardId}`)) cursor.delete();
          cursor.continue();
        };
      };
      for (const name of names) {
        const store = tx.objectStore(name), request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) { if (--remaining === 0) cleanupReceipts(); return; }
          const value = cursor.value;
          if (value.boardId === boardId || name === 'permissions' && value.id === boardId
            || name === 'drafts' && JSON.parse(value.target)[0] === boardId) { removedIds.add(value.id); cursor.delete(); }
          cursor.continue();
        };
      }
    });
  }
}
