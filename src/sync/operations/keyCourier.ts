/**
 * Key courier crypto (Sync v3): wraps a board content key to one device.
 *
 * The courier is what lets a second device of the same account pick up a
 * board's AES content key with no user action: the writer wraps the key to
 * the peer's ECDH P-256 wrap identity, and the relay stores only the
 * resulting envelope — opaque to it, openable only by the addressed device.
 * This module is the pure half: derivation, sealing and opening, never a
 * socket, never storage, never a log line that could carry key material.
 * The wire plumbing lives in `keyCourierTransport.ts`, and the byte format
 * matches the Rust service field for field.
 *
 * Envelope: ECDH(own private, peer public) → the raw P-256 shared secret
 * (`deriveBits`, no KDF) → HKDF-SHA-256 with salt = the board room id (the
 * same string every sync frame names as `board`) and info =
 * `pboard-key-courier-v1` → AES-256-GCM over the base64url content-key
 * material. Random 12-byte IV per envelope; transmitted envelope =
 * base64url-no-padding of `iv ‖ ciphertext`, canonical like every other id
 * on this wire. Reading accepts padded or standard base64 too, so a
 * hand-copied value never fails for the wrong reason.
 *
 * Failure paths throw fixed strings. An error message that interpolates key
 * material, plaintext or a decoded envelope is how a diagnostic log leaks a
 * board, so nothing here ever builds a message from an input.
 */
import { fromBase64Url, toBase64Url } from '../../collab/security/canonical';
import type { DevicePublicKey } from '../../collab/security/keys';

/** HKDF domain separator, fixed by the contract; both halves must agree. */
export const KEY_COURIER_INFO = 'pboard-key-courier-v1';
/** Caps on DECODED bytes, pre-checked here so the client never relies on the
 * server being the first to complain (the server enforces the same numbers). */
export const MAX_ENVELOPE_BYTES = 1024;
export const MAX_PUBLIC_KEY_BYTES = 128;

const text = (value: string) => new TextEncoder().encode(value);

/** A P-256 SPKI is 91 bytes; the cap leaves room for the curve to grow. */
export async function exportCourierPublicKey(publicJwk: DevicePublicKey): Promise<string> {
  // Extractable on purpose: this is a public key, re-encoded from a JWK that
  // is already fully public; non-extractability would only block the export.
  const key = await crypto.subtle.importKey('jwk', { ...publicJwk, key_ops: [] }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key));
  if (!spki.length || spki.length > MAX_PUBLIC_KEY_BYTES) throw new Error('Courier public key exceeds the wire cap');
  return toBase64Url(spki);
}

/** Imports a peer's wire public key. Rejects anything that is not a P-256
 * SPKI without repeating the rejected value. */
export async function importCourierPeerKey(publicKey: string): Promise<CryptoKey> {
  let spki: Uint8Array;
  try { spki = fromBase64Url(publicKey); } catch { throw new Error('Courier public key is not base64url'); }
  if (!spki.length || spki.length > MAX_PUBLIC_KEY_BYTES) throw new Error('Courier public key exceeds the wire cap');
  try {
    return await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new Error('Courier public key is not a P-256 SPKI');
  }
}

/**
 * ECDH → HKDF-SHA-256 → AES-256-GCM, chained entirely inside WebCrypto so
 * the raw shared secret never exists as bytes this process could log. The
 * server performs the same construction with the raw shared secret, and
 * `board` (the admitted room id, never a Drive id) is the salt: an envelope
 * sealed for one board cannot open on another even between the same pair of
 * devices.
 */
async function deriveCourierKey(board: string, privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: text(board) as BufferSource, info: text(KEY_COURIER_INFO) as BufferSource },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Seals base64url content-key material for one peer device. */
export async function sealKeyEnvelope(options: {
  board: string; privateKey: CryptoKey; peerPublicKey: CryptoKey; material: string;
}): Promise<string> {
  const key = await deriveCourierKey(options.board, options.privateKey, options.peerPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, text(options.material) as BufferSource);
  const envelope = new Uint8Array(12 + ciphertext.byteLength);
  envelope.set(iv);
  envelope.set(new Uint8Array(ciphertext), 12);
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new Error('Key envelope exceeds the wire cap');
  return toBase64Url(envelope);
}

/**
 * Opens an envelope addressed to this device. Returns the base64url material
 * or throws a fixed string — a wrong device key, a wrong board (the salt
 * changes, so the tag fails) or a tampered envelope are the same failure
 * here, and none of them may report what was tried.
 */
export async function openKeyEnvelope(options: {
  board: string; privateKey: CryptoKey; peerPublicKey: CryptoKey; envelope: string;
}): Promise<string> {
  let raw: Uint8Array;
  try { raw = fromBase64Url(options.envelope); } catch { throw new Error('Key envelope is not base64url'); }
  // 12-byte IV + a GCM tag is the floor; anything smaller cannot be valid.
  if (raw.length < 29 || raw.length > MAX_ENVELOPE_BYTES) throw new Error('Key envelope has an invalid length');
  const key = await deriveCourierKey(options.board, options.privateKey, options.peerPublicKey);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12) as BufferSource }, key, raw.subarray(12) as BufferSource);
    const material = new TextDecoder().decode(plaintext);
    // The payload is key material, never arbitrary text; anything that does
    // not decode to a base64url string was not sealed by a courier client.
    if (!/^[A-Za-z0-9_-]+$/.test(material)) throw new Error('Key envelope has an invalid payload');
    return material;
  } catch {
    throw new Error('Key envelope could not be opened');
  }
}
