/**
 * Device signing keys for the collaboration security protocol (protocol 2).
 *
 * Every device (board authority or ordinary member) owns an ECDSA P-256 key pair.
 * Private keys are non-extractable `CryptoKey` objects; the persistable form is a
 * wrapped/serialized JWK private key kept in IndexedDB under a storage-scoped
 * record, separate from Google OAuth storage. A fingerprint binds a public key to
 * its canonical JWK bytes (SHA-256, base64url) — this is what a human compares
 * during out-of-band enrollment and what a client pins for its board authority.
 *
 * Possession of a private key proves only device identity; permission comes from
 * an authority-signed manifest that lists the key.
 */
import { canonicalize, fromBase64Url, toBase64Url, type Json } from "./canonical";

/** The public half of a device key as distributed in manifests and envelopes. */
export type DevicePublicKey = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

/** Persistable private material. Never written to shared Drive data. */
export type StoredDeviceKey = {
  keyId: string;
  /** Private JWK; non-extractable at runtime, serialized only through this store. */
  privateJwk: JsonWebKey & { kty: "EC"; crv: "P-256" };
  publicJwk: DevicePublicKey;
  createdAt: number;
};

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const DATABASE_NAME = "pboard-security-keys";
const STORE_NAME = "device-keys";

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Deterministic key id: base64url of SHA-256 over the canonical public JWK. */
export async function publicKeyFingerprint(publicJwk: DevicePublicKey): Promise<string> {
  const canonical = canonicalize(publicJwk as unknown as Json);
  const digest = await crypto.subtle.digest("SHA-256", textBytes(canonical).buffer as ArrayBuffer);
  return toBase64Url(new Uint8Array(digest));
}

export async function fingerprintOfKey(key: StoredDeviceKey): Promise<string> {
  return publicKeyFingerprint(key.publicJwk);
}

/**
 * Generates a fresh device signing key pair.
 *
 * The private scalar is exported exactly once, at generation, for persistence in
 * the device key store (IndexedDB/localStorage). Non-extractability is enforced on
 * the imported-and-used `CryptoKey` (`importSigningKey`), which bounds accidental
 * in-memory export; see the security plan for the exact threat coverage.
 */
export async function generateDeviceKey(): Promise<StoredDeviceKey> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey & { kty: "EC"; crv: "P-256" };
  const publicExported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk: DevicePublicKey = {
    kty: "EC", crv: "P-256",
    x: String(publicExported.x), y: String(publicExported.y)
  };
  return {
    keyId: await publicKeyFingerprint(publicJwk),
    privateJwk: exported,
    publicJwk,
    createdAt: Date.now()
  };
}

/** Imports a generated/stored private JWK as a usable signing key. */
export async function importSigningKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { ...privateJwk, key_ops: ["sign"] }, ALGORITHM, false, ["sign"]);
}

export async function importVerifyingKey(publicJwk: DevicePublicKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { ...publicJwk, key_ops: ["verify"] }, ALGORITHM, false, ["verify"]);
}

/** Signs bytes; returns base64url of the raw 64-byte r||s signature. */
export async function signBytes(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign(SIGN_ALGORITHM, key, bytes as BufferSource);
  return toBase64Url(new Uint8Array(signature));
}

/** Verifies a base64url raw r||s signature over bytes; constant-algorithm. */
export async function verifyBytes(publicJwk: DevicePublicKey, signature: string, bytes: Uint8Array): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false; // 64 bytes => 86 base64url chars
  let raw: Uint8Array;
  try { raw = fromBase64Url(signature); } catch { return false; }
  if (raw.length !== 64) return false;
  try {
    const verifyingKey = await importVerifyingKey(publicJwk);
    return await crypto.subtle.verify(SIGN_ALGORITHM, verifyingKey, raw as BufferSource, bytes as BufferSource);
  } catch {
    // Malformed JWK coordinates or unsupported key: fail closed.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistence: IndexedDB with a localStorage fallback. Keys live outside the
// replication database and outside Google OAuth storage by name and database.
// ---------------------------------------------------------------------------

interface MinimalIdb {
  open(name: string, version?: number): {
    onupgradeneeded: ((event: { target: { result: IDBDatabase } }) => void) | null;
    onsuccess: ((event: { target: { result: IDBDatabase } }) => void) | null;
    onerror: ((event: unknown) => void) | null;
  };
}

function openKeyDatabase(storage: MinimalIdb): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = storage.open(DATABASE_NAME, 1);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event);
  });
}

const indexedDbLike: MinimalIdb | null = typeof indexedDB !== "undefined" ? (indexedDB as unknown as MinimalIdb) : null;

async function idbGet(id: string): Promise<StoredDeviceKey | null> {
  if (!indexedDbLike) return null;
  const database = await openKeyDatabase(indexedDbLike);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as StoredDeviceKey | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function idbPut(id: string, value: StoredDeviceKey): Promise<void> {
  if (!indexedDbLike) return;
  const database = await openKeyDatabase(indexedDbLike);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, id);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => reject(transaction.error);
  });
}

const LS_PREFIX = "pboard-device-key:";

/** localStorage is absent in test/web-worker-like runtimes; IndexedDB covers those. */
function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function lsGet(id: string): StoredDeviceKey | null {
  if (!hasLocalStorage()) return null;
  const raw = localStorage.getItem(LS_PREFIX + id);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredDeviceKey; } catch { return null; }
}

function lsPut(id: string, value: StoredDeviceKey): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(LS_PREFIX + id, JSON.stringify(value));
}

/** Loads a stored device key, or null when the device has none. */
export async function loadDeviceKey(keyId: string): Promise<StoredDeviceKey | null> {
  return (await idbGet(keyId)) ?? lsGet(keyId) ?? null;
}

export async function saveDeviceKey(key: StoredDeviceKey): Promise<void> {
  if (indexedDbLike) {
    try { await idbPut(key.keyId, key); return; } catch { /* fall through to localStorage */ }
  }
  lsPut(key.keyId, key);
}

/**
 * Returns this device's signing key for `purpose`, creating one on first use.
 * `purpose` namespaces keys, e.g. `board-authority:<boardId>` or `device:<boardId>`
 * or `account-authority:<accountHash>`.
 */
export async function ensureDeviceKey(purpose: string): Promise<StoredDeviceKey> {
  const existing = await idbGet(`purpose:${purpose}`) ?? lsGet(`purpose:${purpose}`);
  if (existing) return existing;
  const key = await generateDeviceKey();
  await saveDeviceKey({ ...key, keyId: `purpose:${purpose}` });
  // The fingerprint stays in `publicJwk`; `keyId` is the storage slot here.
  return key;
}

/** Signs canonical protocol bytes with a stored device key. */
export async function signWithStored(stored: StoredDeviceKey, bytes: Uint8Array): Promise<string> {
  const signingKey = await importSigningKey(stored.privateJwk as JsonWebKey);
  return signBytes(signingKey, bytes);
}