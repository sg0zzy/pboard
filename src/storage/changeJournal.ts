import { portableJournalChanges, type JournalProof, type HistoryAdmission } from "../collab/security/journalProof";
import { canonicalize, type Json } from "../collab/security/canonical";

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

/** Small IndexedDB facade; no second Dexie runtime beside RxDB's pinned adapter. */
class JournalTable<T extends { id: string }> {
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
      const request = indexedDB.open(this.name, 4);
      request.onupgradeneeded = () => {
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
        for (const name of ["permissions", "pendingEdits", "admissions"]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
        }
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
    });
  }
  close(): void { this.channel?.close(); this.channel = null; this.listeners.clear(); this.changeListeners.clear(); this.database?.close(); this.database = undefined; }
  subscribe(listener: (tables: string[]) => void): () => void {
    this.listeners.add(listener);
    if (!this.channel && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`pboard:journal:${this.name}`);
      this.channel.onmessage = () => { for (const next of this.listeners) next([]); };
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.channel?.close(); this.channel = null; } };
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
    if (!tables.length || tables.includes("entries")) this.committedCache = null;
    for (const listener of this.changeListeners) listener(tables);
    for (const listener of this.listeners) listener(tables);
    const sender = this.channel ?? (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`pboard:journal:${this.name}`));
    sender?.postMessage("changed");
    if (sender !== this.channel) sender?.close();
  }
  async read<T>(name: string, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transaction = this.database!.transaction(name, "readonly");
      const request = operation(transaction.objectStore(name));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Journal transaction aborted"));
    });
  }
  async write(name: string, operation: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transaction = this.database!.transaction(name === 'receipts' ? [name] : [name, 'receipts'], "readwrite", { durability: "strict" });
      transaction.oncomplete = () => {
        resolve();
        // A receipts write can add or update a board-erasure marker, so the
        // shared marker copy is dropped even though no notification is sent.
        if (name === 'receipts') { this.erasureCache = null; return; }
        if (["entries", "pendingEdits", "permissions"].includes(name)) this.notify([name]);
      };
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Journal transaction aborted"));
      const run = (erased: Set<string>) => {
        const store = transaction.objectStore(name);
        const guarded = new Proxy(store, { get(target, key) {
          if (key === 'put' || key === 'add') return (value: any, id?: IDBValidKey) => {
            const boardId = name === 'permissions' ? value.id : name === 'drafts' ? JSON.parse(value.target)[0] : value.boardId;
            if (erased.has(boardId)) throw new Error('This board was permanently deleted');
            return id === undefined ? target[key](value) : target[key](value, id);
          };
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
        try { operation(guarded); } catch (error) { transaction.abort(); reject(error); }
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
    let parent: JournalEntry | undefined;
    if (local && previous && !resolution) {
      // RxDB's storage wrapper generates revisions after our WAL boundary.
      // Match the complete immutable previous value, never a timestamp.
      const previousValue = canonicalize(documentValue(previous));
      const matches = candidates.filter(c => c.boardId === boardId && c.state === "committed" && canonicalize(c.value) === previousValue
        && (!authenticated || !previous._sec || portable.has(c.id)));
      // Multiple indistinguishable payloads with different ancestry are not
      // evidence that this writer observed either specific branch.
      parent = matches.length === 1 ? matches[0] : undefined;
      if (!parent) {
        parent = { ...await makeChange({ ...common, parents: [], ancestry: "unknown", value: documentValue(previous) }),
          state: "committed", origin: "baseline" };
      }
    }
    const entry: JournalEntry = { ...await makeChange({ ...common, parents: resolution ?? (parent ? [parent.id] : []),
      ancestry: resolution || local && (!previous || parent) ? "known" : "unknown", value: documentValue(document) }),
      state: "prepared", origin: local ? "local" : "observed" };
    await this.write("entries", store => {
      for (const candidate of [...(parent ? [parent] : []), entry]) {
        const request = store.get(candidate.id);
        request.onsuccess = () => {
          if (!request.result || request.result.state === "rejected") store.put(candidate);
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
  /** Atomic batch admission, including references arriving before their parent. */
  async accept(entries: JournalEntry[]): Promise<void> {
    const erased = new Set((await this.boardErasures()).map(entry => entry.boardId));
    entries = entries.filter(entry => !erased.has(entry.boardId));
    await this.write("entries", store => {
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
      const tx = this.database!.transaction(['pendingEdits', 'receipts'], 'readwrite', { durability: 'strict' });
      let failure: Error | undefined;
      tx.oncomplete = () => { resolve(); this.notify(["pendingEdits", "receipts"]); };
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('Retained work could not be deleted'));
      const store = tx.objectStore('pendingEdits'), request = store.getAll();
      request.onsuccess = () => {
        const edits = (request.result as PendingEdit[]).filter(edit => edit.boardId === boardId);
        const superseded = new Set(edits.flatMap(edit => edit.supersedes ?? []));
        const heads = edits.filter(edit => !edit.admittedChangeId && !superseded.has(edit.id)).map(edit => edit.id).sort();
        if (canonicalize(heads) !== canonicalize([...new Set(reviewedIds)].sort()) || reviewedIds.length !== heads.length) {
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
  async beginBoardErasure(boardId: string, accountId: string | null, imageIds: string[], cardIds: string[]) {
    if (await this.boardErasure(boardId)) return;
    await this.receipts.put({ id: JSON.stringify([boardId, 'local-board-erasure']), changeId: boardId,
      destination: 'local-board-erasure', boardId, accountId, imageIds, cardIds, cloudPending: !!accountId } as BoardErasure);
    this.notify(["receipts"]);
  }
  async purgeBoardHistory(boardId: string) {
    const names = ['entries', 'pendingEdits', 'drafts', 'permissions', 'publicGrants', 'admissions'];
    await new Promise<void>((resolve, reject) => {
      const tx = this.database!.transaction([...names, 'receipts'], 'readwrite', { durability: 'strict' });
      tx.oncomplete = () => { resolve(); this.notify(["entries", "pendingEdits", "receipts"]); };
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Board erasure remains pending'));
      const removedIds = new Set<string>(); let remaining = names.length;
      const cleanupReceipts = () => {
        const request = tx.objectStore('receipts').openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) return;
          if (cursor.value.destination !== 'local-board-erasure' && (removedIds.has(cursor.value.changeId) || cursor.value.destination === `local-pending-discard:${boardId}`)) cursor.delete();
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
