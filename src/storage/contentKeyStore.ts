/**
 * Local persistence for per-board buffer content keys (Sync v2).
 *
 * A separate IndexedDB database on purpose: it must survive independently of
 * the journal database's lifecycle (board erasure clears journal tables, but a
 * content key may still be needed to decrypt buffered ops recorded against
 * it), and it must never be swept into board exports or grant bundles.
 *
 * Keys exist only for boards the device can *edit*: provisioning is invoked
 * from editor-gated paths only, and peers exchange keys over the authenticated
 * device channel. Viewers never obtain or request a key.
 */
import { exportBoardContentKey, generateBoardContentKey, importBoardContentKey, type BoardContentKey } from "../sync/bufferCrypto";

const DB_NAME = "pboard-content-keys";
const STORE = "keys";

type StoredKey = { boardId: string; material: string; keyId: string; createdAt: string };

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "boardId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Content key store failed to open"));
    });
  }
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | Promise<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result: T;
    let pending = false;
    const request = run(store);
    if (request instanceof IDBRequest) {
      pending = true;
      request.onsuccess = () => {
        result = request.result as T;
      };
    } else {
      pending = false;
      Promise.resolve(request as Promise<T>).then((value) => {
        result = value;
      }, reject);
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Content key store transaction aborted"));
    void pending;
  });
}

export type ContentKeyStore = {
  get(boardId: string): Promise<BoardContentKey | undefined>;
  loadRaw(boardId: string): Promise<{ material: string; keyId: string } | undefined>;
  ensure(boardId: string): Promise<BoardContentKey>;
  put(boardId: string, material: string): Promise<BoardContentKey>;
  remove(boardId: string): Promise<void>;
};

export function createContentKeyStore(): ContentKeyStore {
  return {
    async get(boardId) {
      const stored = await tx<StoredKey | undefined>("readonly", (store) => store.get(boardId));
      if (!stored) return undefined;
      return importBoardContentKey(stored.material);
    },
    async loadRaw(boardId) {
      const stored = await tx<StoredKey | undefined>("readonly", (store) => store.get(boardId));
      return stored ? { material: stored.material, keyId: stored.keyId } : undefined;
    },
    async ensure(boardId) {
      const existing = await this.get(boardId);
      if (existing) return existing;
      const created = await generateBoardContentKey();
      const material = await exportBoardContentKey(created.key);
      await tx("readwrite", (store) => store.put({ boardId, material, keyId: created.keyId, createdAt: new Date().toISOString() } satisfies StoredKey));
      return created;
    },
    async put(boardId, material) {
      const imported = await importBoardContentKey(material);
      await tx("readwrite", (store) => store.put({ boardId, material, keyId: imported.keyId, createdAt: new Date().toISOString() } satisfies StoredKey));
      return imported;
    },
    async remove(boardId) {
      await tx("readwrite", (store) => store.delete(boardId));
    }
  };
}
