import { canonicalize, parseStrictJson, fromBase64Url, toBase64Url, type Json } from './canonical';
import { importSigningKey, publicKeyFingerprint, signBytes, verifyBytes, type StoredDeviceKey } from './keys';
import type { BoardGrantBundle } from '../boardGrants';

export type AuthorityRecoveryPayload = { boardId: string; root: StoredDeviceKey; bundle: BoardGrantBundle; blockedDevices: string[]; policy?: Json };
const FORMAT = 'pboard-authority-recovery-v1';
const LIMIT = 8 * 1024 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text);
async function encryptionKey(passphrase: string, salt: Uint8Array) {
  if (typeof passphrase !== 'string' || passphrase.length < 16 || passphrase.length > 1024) throw new Error('Use a recovery passphrase of 16–1024 characters and keep it separately from the file');
  const material = await crypto.subtle.importKey('raw', bytes(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: new Uint8Array(salt) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealAuthorityRecovery(payload: AuthorityRecoveryPayload, passphrase: string): Promise<string> {
  const authorityKeyId = await publicKeyFingerprint(payload.root.publicJwk), boardId = payload.boardId;
  if (payload.root.keyId !== authorityKeyId) throw new Error('Authority fingerprint mismatch');
  const plaintext = bytes(canonicalize(payload as unknown as Json));
  if (plaintext.length > LIMIT / 2) throw new Error('Authority history exceeds the recovery file limit');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = bytes(JSON.stringify([FORMAT, boardId, authorityKeyId]));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await encryptionKey(passphrase, salt), plaintext);
  return JSON.stringify({ format: FORMAT, boardId, authorityKeyId, salt: toBase64Url(salt), iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) });
}
export async function openAuthorityRecovery(raw: string, passphrase: string, expectedFingerprint: string): Promise<AuthorityRecoveryPayload> {
  const value = parseStrictJson(raw, LIMIT) as unknown as Record<string, unknown>;
  if (!value || Object.keys(value).sort().join(',') !== 'authorityKeyId,boardId,ciphertext,format,iv,salt' || value.format !== FORMAT
    || value.authorityKeyId !== expectedFingerprint || !/^[A-Za-z0-9_-]{43}$/.test(expectedFingerprint) || typeof value.boardId !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/.test(value.boardId) || typeof value.salt !== 'string' || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string') throw new Error('Invalid authority recovery envelope or independently verified fingerprint');
  const salt = fromBase64Url(value.salt), iv = fromBase64Url(value.iv), ciphertext = fromBase64Url(value.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid authority recovery encryption parameters');
  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: bytes(JSON.stringify([FORMAT, value.boardId, expectedFingerprint])) }, await encryptionKey(passphrase, salt), new Uint8Array(ciphertext));
  } catch { throw new Error('Recovery file could not be decrypted; check the passphrase and fingerprint'); }
  const payload = parseStrictJson(new TextDecoder().decode(decrypted), LIMIT) as unknown as AuthorityRecoveryPayload;
  if (!payload || payload.boardId !== value.boardId || !payload.root || payload.root.keyId !== expectedFingerprint
    || await publicKeyFingerprint(payload.root.publicJwk) !== expectedFingerprint || !Array.isArray(payload.blockedDevices) || payload.blockedDevices.length > 4096
    || payload.blockedDevices.some(id => !/^[A-Za-z0-9_-]{43}$/.test(id))) throw new Error('Invalid recovered authority identity');
  const proof = bytes('pboard-authority-recovery-key-v1');
  if (!await verifyBytes(payload.root.publicJwk, await signBytes(await importSigningKey(payload.root.privateJwk), proof), proof)) throw new Error('Recovered private key does not match the original authority');
  return payload;
}
