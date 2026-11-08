/**
 * The account room's authority, as it travels through private appDataFolder.
 *
 * A board's authority arrives with out-of-band verification: two people read a
 * fingerprint out loud. The account room has no second person — both devices
 * belong to the same verified Google account, and the folder they exchange this
 * file through (`appDataFolder`) is that account's own private storage, which
 * only its own devices can read or write. The bootstrap trust is therefore
 * **Google-account-based**, and it is stated as such in `docs/collaboration.md`:
 * a device that can write this folder already holds the account's whole Drive —
 * its private snapshots, its images and its board data — so the account room's
 * manifest cannot be the weakest link in that chain.
 *
 * Two shapes live here, and both are plain JSON so a person can read them in a
 * bug report without a decoder:
 *
 *  - the **authority file** (`pboard-account-manifest-<hash>.pboard`): the
 *    signed manifest *plus the public key that signed it*. The manifest payload
 *    carries only the authority's fingerprint, so without the key a second
 *    browser could not verify the signature it found — and a browser that
 *    cannot verify must mint a second authority, which is exactly the split the
 *    single-source rule forbids. The file therefore carries the key, and the
 *    only trust claimed for it is the folder's: the account's own private Drive.
 *  - a **device request** (`pboard-account-device-<hash>-<deviceKeyId>.pboard`):
 *    a same-account device that adopted an authority it is not listed in yet.
 *    The authority device reads these on its own bootstrap pass and re-signs
 *    the manifest with the requester added, so no person has to carry a code
 *    between two browsers of one account.
 *
 * Every parser is strict and total: it returns `null` for anything it does not
 * understand, never a partially trusted object, and never throws.
 */
import { parseStrictJson } from './canonical';
import { publicKeyFingerprint, type DevicePublicKey } from './keys';
import { verifyManifest, type BoardPermissionManifest, type SignedManifest } from './manifest';

export const ACCOUNT_AUTHORITY_FORMAT = 'pboard-account-authority-v1';
export const ACCOUNT_DEVICE_REQUEST_FORMAT = 'pboard-account-device-request-v1';
/** Transport file prefixes. `createDriveTransport` names a file `<prefix><id>.pboard`. */
export const ACCOUNT_AUTHORITY_PREFIX = 'pboard-account-manifest-';
export const ACCOUNT_DEVICE_PREFIX = 'pboard-account-device-';
/** A request older than this is ignored: it is a live handshake, not a queue. */
export const ACCOUNT_DEVICE_REQUEST_TTL_MS = 3_600_000;
/** The transport id of one device's request file. `createDriveTransport` names
 * a file `<prefix><id>.pboard` and sanitizes the id, so the id charset here is
 * the sanitizer's own (`[A-Za-z0-9_-]`) and the name round-trips. */
export const accountDeviceRequestId = (account: string, deviceKeyId: string) => `${account}-${deviceKeyId}`;
const MAX_BYTES = 262_144;
const PUBLIC_KEY_FIELDS = 'crv,kty,x,y';

const wellFormedKey = (value: unknown): value is DevicePublicKey => {
  const key = value as DevicePublicKey | null;
  return !!key && typeof key === 'object' && Object.keys(key).sort().join(',') === PUBLIC_KEY_FIELDS
    && key.kty === 'EC' && key.crv === 'P-256'
    && typeof key.x === 'string' && typeof key.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.x) && /^[A-Za-z0-9_-]{43}$/.test(key.y);
};

export type AccountAuthorityFile = { authority: DevicePublicKey; signed: SignedManifest };

/** The file a browser of this account publishes: the manifest and its signer. */
export function sealAccountAuthorityFile(authority: DevicePublicKey, signed: SignedManifest): string {
  if (!wellFormedKey(authority)) throw new Error('Account authority file needs a public authority key');
  if (Object.keys(signed ?? {}).sort().join(',') !== 'payload,signature') throw new Error('Account authority file needs a signed manifest');
  return JSON.stringify({ format: ACCOUNT_AUTHORITY_FORMAT, authority, manifest: { payload: signed.payload, signature: signed.signature } });
}

/** Reads the file without trusting it. Signature verification is the caller's
 * job, because only the caller knows what it is willing to pin. */
export function openAccountAuthorityFile(raw: string): AccountAuthorityFile | null {
  if (typeof raw !== 'string' || raw.length > MAX_BYTES) return null;
  let value: Record<string, unknown>;
  try { value = parseStrictJson(raw, MAX_BYTES) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'authority,format,manifest') return null;
  if (value.format !== ACCOUNT_AUTHORITY_FORMAT || !wellFormedKey(value.authority)) return null;
  const manifest = value.manifest as Partial<SignedManifest> | null;
  if (!manifest || typeof manifest !== 'object' || Object.keys(manifest).sort().join(',') !== 'payload,signature') return null;
  if (typeof manifest.signature !== 'string') return null;
  return { authority: value.authority, signed: { payload: manifest.payload, signature: manifest.signature } as SignedManifest };
}

/**
 * Verifies an authority file against the file itself, for the one caller that
 * legitimately has nothing else to verify it against: a browser of this account
 * that holds no pin yet. The checks are the ones that make the file
 * *self-consistent*, and the scope binding is what makes it *this account's*:
 *
 *  1. the signature verifies under the key the file carries;
 *  2. the manifest's authority fingerprint is that same key;
 *  3. the manifest names exactly `account:<hash>` with no Drive binding, so a
 *     board manifest can never be adopted as the account room's authority.
 *
 * It deliberately does **not** decide whether to trust the folder; that is the
 * caller's documented choice (the account's own private appDataFolder).
 */
export async function verifyAccountAuthorityFile(file: AccountAuthorityFile, account: string): Promise<BoardPermissionManifest | null> {
  try {
    const fingerprint = await publicKeyFingerprint(file.authority);
    const manifest = await verifyManifest(file.signed, file.authority, fingerprint);
    if (manifest.boardId !== `account:${account}`) return null;
    if (manifest.driveProjectFileId !== '' || manifest.driveFolderId !== '') return null;
    return manifest;
  } catch { return null; }
}

export type AccountDeviceRequest = { account: string; deviceKeyId: string; publicKey: DevicePublicKey; at: number };

/** What a same-account device asks for when it adopted an authority that does
 * not list it yet. Nothing here is a grant: the authority device re-signs the
 * manifest, and the relay still refuses a device the manifest does not name. */
export function sealAccountDeviceRequest(request: AccountDeviceRequest): string {
  return JSON.stringify({ format: ACCOUNT_DEVICE_REQUEST_FORMAT, account: request.account,
    deviceKeyId: request.deviceKeyId, publicKey: request.publicKey, at: request.at });
}

/** Reads a request and checks it is internally consistent and fresh. The
 * fingerprint check is what stops a file from naming somebody else's device. */
export async function openAccountDeviceRequest(raw: string, account: string, now: number): Promise<AccountDeviceRequest | null> {
  if (typeof raw !== 'string' || raw.length > MAX_BYTES) return null;
  let value: Record<string, unknown>;
  try { value = parseStrictJson(raw, MAX_BYTES) as Record<string, unknown>; } catch { return null; }
  if (!value || Object.keys(value).sort().join(',') !== 'account,at,deviceKeyId,format,publicKey') return null;
  if (value.format !== ACCOUNT_DEVICE_REQUEST_FORMAT || value.account !== account) return null;
  if (!wellFormedKey(value.publicKey) || typeof value.deviceKeyId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceKeyId)) return null;
  if (!Number.isSafeInteger(value.at) || Math.abs(now - (value.at as number)) > ACCOUNT_DEVICE_REQUEST_TTL_MS) return null;
  if (await publicKeyFingerprint(value.publicKey) !== value.deviceKeyId) return null;
  return { account, deviceKeyId: value.deviceKeyId, publicKey: value.publicKey, at: value.at as number };
}
