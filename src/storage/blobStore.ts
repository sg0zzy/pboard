export type StoredBlob = { imageId: string; blob: Blob; mimeType: string; width: number; height: number; size: number };
export type ImageAvailability = "available" | "missing" | "invalid";

export interface BlobStore {
  putBlob(blob: Blob, metadata: { mimeType: string; width: number; height: number }): Promise<string>;
  getBlob(imageId: string): Promise<StoredBlob | null>;
  hasBlob(imageId: string): Promise<boolean>;
  deleteBlob(imageId: string): Promise<void>;
  imageAvailability(imageId: string): Promise<ImageAvailability>;
}

const STORE = "images";

export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createIndexedDbBlobStore(name = "pboard-images-v1"): BlobStore {
  let opening: Promise<IDBDatabase> | null = null;
  function open(): Promise<IDBDatabase> {
    return opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "imageId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      run(tx.objectStore(STORE), (value) => { result = value; });
    });
  }
  const getBlob = (imageId: string) => transaction<StoredBlob | null>("readonly", (store, done) => {
    const request = store.get(imageId);
    request.onsuccess = () => done((request.result as StoredBlob | undefined) ?? null);
  });
  return {
    async putBlob(blob, metadata) {
      const imageId = await hashBlob(blob);
      await transaction<void>("readwrite", (store, done) => {
        store.put({ imageId, blob, mimeType: metadata.mimeType, width: metadata.width, height: metadata.height, size: blob.size } satisfies StoredBlob);
        done();
      });
      return imageId;
    },
    getBlob,
    async hasBlob(imageId) { return (await getBlob(imageId)) !== null; },
    async deleteBlob(imageId) { await transaction<void>("readwrite", (store, done) => { store.delete(imageId); done(); }); },
    async imageAvailability(imageId) {
      const entry = await getBlob(imageId);
      if (!entry) return "missing";
      return await hashBlob(entry.blob) === imageId ? "available" : "invalid";
    }
  };
}

export async function imageToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("Image data URL could not be decoded");
  return response.blob();
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
