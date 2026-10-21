/** Human-approved pairing over existing public grant metadata; no relay mailbox. */
import type { KeyValueStorage } from '../storage/repository';
import type { BoardGrantBundle, BoardDeviceRequest, CollaborationSettings } from './boardGrants';
import { canonicalBytes, fromBase64Url, parseStrictJson, signedBytes, toBase64Url } from './security/canonical';
import { ensureDeviceKey, importSigningKey, publicKeyFingerprint, signBytes, verifyBytes, type DevicePublicKey } from './security/keys';
import { verifyManifest } from './security/manifest';
const PENDING = 'pboardPendingPairing';
const PREFIX = 'pboard-connect-v1:';
const LIMIT = 16_384;
type Invitation = { format: 'pboard-pair-invite-v1'; boardId: string; endpoint: string; authority: DevicePublicKey; issuedAt: number; expiresAt: number; nonce: string; signature: string };
type Request = { format: 'pboard-pair-request-v1'; invitation: Invitation; request: BoardDeviceRequest };
type Pending = { code: string; expiresAt: number };
const bytes = (value: unknown) => signedBytes('pboard-pair-invite-v1', value as never);
function encode(value: unknown) { return PREFIX + toBase64Url(canonicalBytes(value as never)); }
function decode(code: string): unknown {
  const text = code.trim();
  if (!text.startsWith(PREFIX) || text.length > LIMIT) throw new Error('Paste a Pboard connection code from the other browser');
  return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(text.slice(PREFIX.length))), LIMIT);
}
function exact(value: object, fields: string[]) { return Object.keys(value).sort().join(',') === fields.sort().join(','); }
export function createBoardPairing(options: {
  storage: KeyValueStorage; getKey: typeof ensureDeviceKey;
  settings: () => Promise<CollaborationSettings>;
  initialize: (board: string) => Promise<BoardGrantBundle>;
  deviceRequest: (raw: string) => Promise<BoardDeviceRequest>;
  approve: (raw: string, fingerprint: string, role: 'editor' | 'viewer') => Promise<BoardGrantBundle>;
  trust: (raw: string, fingerprint: string) => Promise<string>;
  read: (endpoint: string, authority: DevicePublicKey, board: string) => Promise<BoardGrantBundle>;
}) {
  async function validateInvitation(value: unknown): Promise<Invitation> {
    if (!value || typeof value !== 'object' || !exact(value, ['format','boardId','endpoint','authority','issuedAt','expiresAt','nonce','signature'])) throw new Error('Invalid Pboard invitation');
    const invitation = value as Invitation;
    const { signature, ...payload } = invitation;
    const selected = await options.settings();
    if (invitation.format !== 'pboard-pair-invite-v1' || !/^[A-Za-z0-9_-]{1,200}$/.test(invitation.boardId) ||
      selected.provider !== 'websocket' || invitation.endpoint !== selected.url ||
      !Number.isSafeInteger(invitation.issuedAt) || !Number.isSafeInteger(invitation.expiresAt) || invitation.issuedAt > Date.now()+30_000 || invitation.expiresAt <= Date.now() || invitation.expiresAt-invitation.issuedAt > 600_000 || invitation.expiresAt <= invitation.issuedAt ||
      !/^[A-Za-z0-9-]{36}$/.test(invitation.nonce) || !exact(invitation.authority, ['crv','kty','x','y']) ||
      !await verifyBytes(invitation.authority, signature, bytes(payload))) throw new Error('Invitation expired, invalid, or belongs to a different rendezvous service');
    return invitation;
  }
  async function verification(request: BoardDeviceRequest) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalBytes(request as never) as BufferSource));
    return Array.from(digest.slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join('-').toUpperCase();
  }
  async function parseRequest(code: string): Promise<Request> {
    const value = decode(code) as Request;
    if (!value || !exact(value, ['format','invitation','request']) || value.format !== 'pboard-pair-request-v1') throw new Error('Paste the joining browser’s device code');
    const invitation = await validateInvitation(value.invitation);
    const request = value.request;
    if (!request || !exact(request, ['format','boardId','authorityKeyId','publicKey','deviceKeyId','expiresAt','nonce','signature'])) throw new Error('Invalid device request');
    const { signature, ...payload } = request;
    if (request.format !== 'pboard-board-device-v1' || request.boardId !== invitation.boardId || request.authorityKeyId !== await publicKeyFingerprint(invitation.authority) ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Date.now() || request.expiresAt > Date.now()+3600_000 ||
      !exact(request.publicKey, ['crv','kty','x','y']) || request.deviceKeyId !== await publicKeyFingerprint(request.publicKey) ||
      !await verifyBytes(request.publicKey, signature, signedBytes('pboard-board-device-v1', payload as never))) throw new Error('Device request signature, expiry or board does not match');
    return value;
  }
  async function current(invitation: Invitation) {
    const bundle = await options.read(invitation.endpoint, invitation.authority, invitation.boardId);
    if (await publicKeyFingerprint(bundle.authority) !== await publicKeyFingerprint(invitation.authority)) throw new Error('Rendezvous returned another board authority');
    const latest = await verifyManifest(bundle.history.at(-1), invitation.authority, await publicKeyFingerprint(invitation.authority));
    if (latest.boardId !== invitation.boardId || latest.driveFolderId || latest.driveProjectFileId || latest.expiresAt <= Date.now()) throw new Error('Owner must open this board to publish a current invitation');
    return bundle;
  }
  return {
    async invite(board: string) {
      const bundle = await options.initialize(board);
      const authority = await options.getKey(`standalone-board-authority:${board}`);
      if (authority.keyId !== await publicKeyFingerprint(bundle.authority)) throw new Error('Only the original authority can invite devices');
      const issuedAt = Date.now();
      const payload = { format: 'pboard-pair-invite-v1' as const, boardId: board, endpoint: bundle.endpoint, authority: bundle.authority, issuedAt, expiresAt: issuedAt+600_000, nonce: crypto.randomUUID() };
      return encode({ ...payload, signature: await signBytes(await importSigningKey(authority.privateJwk), bytes(payload)) });
    },
    async request(invitationCode: string) {
      const invitation = await validateInvitation(decode(invitationCode));
      const bundle = await current(invitation);
      const request = await options.deviceRequest(JSON.stringify(bundle));
      const code = encode({ format: 'pboard-pair-request-v1', invitation, request });
      await options.storage.set({ [PENDING]: { code, expiresAt: invitation.expiresAt } });
      return { code, verification: await verification(request) };
    },
    async preview(code: string) {
      const value = await parseRequest(code);
      return { boardId: value.request.boardId, verification: await verification(value.request) };
    },
    async approve(code: string, expectedVerification: string, role: 'editor' | 'viewer') {
      const value = await parseRequest(code);
      if (await verification(value.request) !== expectedVerification) throw new Error('Device verification code changed; check both browsers again');
      await options.approve(JSON.stringify(value.request), value.request.deviceKeyId, role);
    },
    async pending() {
      const value = (await options.storage.get(PENDING))[PENDING] as Pending | null;
      if (!value) return null;
      const request = await parseRequest(value.code);
      return { code: value.code, verification: await verification(request.request) };
    },
    async finish() {
      const pending = (await options.storage.get(PENDING))[PENDING] as Pending | null;
      if (!pending) return null;
      const value = await parseRequest(pending.code);
      const bundle = await current(value.invitation);
      if (!bundle.history.at(-1)!.payload.devices.some(device => device.deviceKeyId === value.request.deviceKeyId)) return null;
      if (((await options.storage.get(PENDING))[PENDING] as Pending | null)?.code !== pending.code) return null;
      await validateInvitation(value.invitation);
      return options.trust(JSON.stringify(bundle), value.request.authorityKeyId);
    },
    async cancel() { await options.storage.set({ [PENDING]: null }); }
  };
}
