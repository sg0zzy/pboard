/** Verified Google identity bootstraps owner-signed grants, never Drive ACLs.
 * Public policies/requests are volatile on the explicitly selected TLS service.
 * No account identity, board content or token travels through signaling frames. */
import type { KeyValueStorage } from '../storage/repository';
import type { GoogleAuthProvider } from '../sync/googleAuth';
import { createBoardGrantService, rendezvousOrigin, validateRendezvous, type BoardGrantBundle, type BoardDeviceRequest } from './boardGrants';
import { ensureDeviceKey, importSigningKey, publicKeyFingerprint, signBytes, verifyBytes, type DevicePublicKey } from './security/keys';
import { canonicalBytes, fromBase64Url, parseStrictJson, toBase64Url, type Json } from './security/canonical';
import { manifestHash, type SignedManifest } from './security/manifest';
import { storageManifestEpochs } from './security/enrollment';
import { collaborationDiagnostic } from './diagnostics';
import { identityRejection, IdentityServiceError } from './identityErrors';
import { collaborationCounters } from './counters';

type Role = 'editor' | 'viewer';
export type EmailPolicy = { version: 1; boardId: string; authority: DevicePublicKey; ownerEmail: string; members: { email: string; role: Role }[]; issuedAt: number; expiresAt: number };
type Publication = { policy: EmailPolicy; signature: string };
type Entry = { publication: Publication; pending: { email: string; request: BoardDeviceRequest }[] };
type CapacityIssue = { boardId: string; code: 'directory_capacity' | 'pending_capacity' };
type Reply = { version: 1; email: string; boards: Entry[] };
type Local = { ownerEmail: string; members: { email: string; role: Role }[]; devices: Record<string, string>; revision: number };
export const IDENTITY_REFRESH_MS = 5_000;
const STORE = 'pboardGoogleBoardPolicies';
const json = (v: unknown) => v as Json;
const normalizedEmail = (s: string) => s.trim().toLowerCase();
export function createGoogleIdentitySharing(options: {
  storage: KeyValueStorage; auth: GoogleAuthProvider; grants: ReturnType<typeof createBoardGrantService>;
  fetcher?: typeof fetch; getKey?: typeof ensureDeviceKey; canAccessEndpoint?: (origin: string) => Promise<boolean>;
  /** Refuse automatic authority creation over signed legacy/imported data. */
  canInitialize: (board: string) => Promise<boolean>;
  canReceive: (board: string, owner: string, currentEmail: string) => Promise<boolean>;
}) {
  const key = options.getKey ?? ensureDeviceKey, fetcher = options.fetcher ?? fetch;
  let chain: Promise<unknown> = Promise.resolve();
  const publications = new Map<string, { email: string; retryAt: number }>();
  const requests = new Map<string, { email: string; at: number }>();
  // Cache only digests of bundles verified by trust(), never just an epoch or
  // head signature: an altered history prefix must still be rejected.
  const trusted = new Map<string, { digest: string; device: string }>();
  const epochs = storageManifestEpochs(options.storage);
  async function bundleDigest(bundle: BoardGrantBundle) {
    const bytes = new Uint8Array(canonicalBytes(json(bundle)));
    return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }
  let last: { at: number; selected?: string; reply: Reply; ready: string[]; issues: CapacityIssue[] } | null = null;
  const exclusive = <T>(work: () => Promise<T>) => { const result = chain.then(work, work); chain = result.catch(() => {}); return result; };
  const local = async () => ((await options.storage.get(STORE))[STORE] ?? {}) as Record<string, Local>;
  async function save(board: string, value: Local) { await options.storage.set({ [STORE]: { ...await local(), [board]: value } }); }
  async function http(path: string, body?: unknown, token?: string, limit = 1024 * 1024) {
    const setting = await options.grants.settings();
    if (setting.provider !== 'websocket') throw new Error('WebSocket collaboration is not enabled');
    const endpoint = new URL(validateRendezvous(setting.url));
    if (options.canAccessEndpoint && !await options.canAccessEndpoint(rendezvousOrigin(setting.url))) throw new Error('Enable access to the rendezvous service first');
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'; endpoint.pathname = path;
    const send = () => fetcher(endpoint, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    let response = await send();
    for (let attempt = 0; response.status === 429 && attempt < 2; attempt++) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 1100 + Math.random() * 400));
      response = await send();
    }
    if (!response.ok) throw await identityRejection(response, path.startsWith('/grants/') ? 'grant' : 'identity');
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing identity response');
    let length = 0; const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); throw new Error('Identity response capacity reached'); } chunks.push(value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    return parseStrictJson(new TextDecoder().decode(bytes), limit) as unknown;
  }
  async function exchange(operation: unknown, deviceScope = 'google-identity-device'): Promise<Reply> {
    const hello = await http('/identity/challenge', { version: 1 }) as { version: number; challenge: string };
    if (hello.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(hello.challenge)) throw new Error('Invalid identity challenge');
    const device = await key(deviceScope);
    const signature = await signBytes(await importSigningKey(device.privateJwk), canonicalBytes(json(['pboard-identity-v1', hello.challenge, device.keyId, operation])));
    const token = await options.auth.getAccessToken();
    const reply = await http('/identity/exchange', { version: 1, challenge: hello.challenge, publicKey: device.publicJwk, operation, signature }, token) as Reply;
    if (reply.version !== 1 || typeof reply.email !== 'string' || !Array.isArray(reply.boards) || reply.boards.length > 64) throw new Error('Invalid identity directory response');
    return reply;
  }
  async function publication(board: string, email: string, members?: Local['members']): Promise<Publication> {
    const bundle = await options.grants.localBundle(board);
    if (!bundle || !await options.grants.ownsAuthority(board)) throw new Error('Only the original authority browser can manage email sharing');
    const previous = (await local())[board];
    if (previous && previous.ownerEmail !== email) throw new Error('This board belongs to a different Google account. Its authority will not be reassigned.');
    const value: Local = { ownerEmail: email, members: members ?? previous?.members ?? [], devices: previous?.devices ?? {}, revision: Math.max(Date.now(), (previous?.revision ?? 0) + 1) };
    const policy: EmailPolicy = { version: 1, boardId: board, authority: bundle.authority, ownerEmail: email, members: value.members, issuedAt: value.revision, expiresAt: value.revision + 600_000 };
    const signature = await options.grants.signAuthority(board, canonicalBytes(json(['pboard-identity-policy-v1', policy])));
    await save(board, value); return { policy, signature };
  }
  async function check(entry: Entry, email: string) {
    const { policy, signature } = entry.publication;
    if (policy.version !== 1 || !/^[A-Za-z0-9_-]{1,200}$/.test(policy.boardId) || policy.expiresAt <= Date.now() || policy.issuedAt > Date.now() + 30_000 || policy.expiresAt - policy.issuedAt > 600_000
      || !Array.isArray(policy.members) || policy.members.length > 16 || !Array.isArray(entry.pending) || entry.pending.length > 16
      || (policy.ownerEmail !== email && !policy.members.some(m => m.email === email && ['editor','viewer'].includes(m.role)))
      || !await verifyBytes(policy.authority, signature, canonicalBytes(json(['pboard-identity-policy-v1', policy])))) throw new Error('Invalid or unauthorized board identity policy');
    const ownerPolicy = (await local())[policy.boardId];
    if (ownerPolicy && await options.grants.ownsAuthority(policy.boardId) && (policy.ownerEmail !== ownerPolicy.ownerEmail || policy.issuedAt < ownerPolicy.revision || JSON.stringify(policy.members) !== JSON.stringify(ownerPolicy.members))) throw new Error('Stale sharing policy rejected; open this board in its original authority browser to republish current invitations');
    const previous = await options.grants.localBundle(policy.boardId);
    // A Drive-verified authority transition replaces the local authority on
    // purpose; the stale directory policy (signed by the old authority) is
    // then republished from the new chain instead of blocking sync.
    if (previous && await publicKeyFingerprint(previous.authority) !== await publicKeyFingerprint(policy.authority) && !await options.grants.authorityTransitioned(policy.boardId)) throw new Error('Existing board authority differs from the directory; automatic replacement is forbidden');
    return policy;
  }
  async function readBundle(policy: EmailPolicy): Promise<BoardGrantBundle> {
    const pin = await publicKeyFingerprint(policy.authority);
    const scope = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['pboard-board-grants-v1', pin, policy.boardId])))));
    const received = await http(`/grants/${scope}`, undefined, undefined, 4 * 1024 * 1024) as { version: number; authority: DevicePublicKey; history: { payload: string; signature: string }[] };
    if (received.version !== 1 || !Array.isArray(received.history) || await publicKeyFingerprint(received.authority) !== pin) throw new Error('Missing signed board manifest');
    const last = received.history.at(-1);
    if (!last || (parseStrictJson(new TextDecoder().decode(fromBase64Url(last.payload))) as unknown as SignedManifest['payload']).boardId !== policy.boardId) throw new Error('Board identity differs from its grant');
    return { format: 'pboard-board-grants-v1', endpoint: (await options.grants.settings()).url, authority: received.authority,
      history: received.history.map(s => ({ payload: parseStrictJson(new TextDecoder().decode(fromBase64Url(s.payload))) as unknown as SignedManifest['payload'], signature: s.signature })) };
  }
  async function syncWork(selected?: string, force = false) {
    if ((await options.grants.settings()).provider !== 'websocket' || await options.auth.getConnectionState() !== 'connected') { last = null; requests.clear(); publications.clear(); trusted.clear(); return { email: '', boards: [] as Entry[], ready: [] as string[], issues: [] as CapacityIssue[] }; }
    if (!force && last && last.selected === selected && Date.now() - last.at < IDENTITY_REFRESH_MS - 1000) return { ...last.reply, ready: last.ready, issues: last.issues };
    collaborationCounters.countEvent("identity.sync.full");
    let reply = await exchange({ type: 'sync', publication: null });
    for (const board of trusted.keys()) if (!reply.boards.some(entry => entry.publication.policy.boardId === board)) trusted.delete(board);
    for (const [board, request] of requests) {
      if (request.email !== reply.email || !reply.boards.some(entry => entry.publication.policy.boardId === board)) requests.delete(board);
    }
    // A signed directory entry for this account takes precedence over creating a
    // new authority, including on a device restored from its private Drive backup.
    const selectedEntry = reply.boards.find(e => e.publication.policy.boardId === selected);
    if (selected && !await options.grants.localBundle(selected) && !selectedEntry && await options.canInitialize(selected)) await options.grants.initialize(selected);
    // Validate advertised policies before republishing anything; a replay or
    // authority mismatch must never be hidden by an automatic renewal.
    for (const entry of reply.boards) await check(entry, reply.email);
    const issues: CapacityIssue[] = [];
    const policies = await local();
    const owned = new Set([...Object.entries(policies).filter(([, p]) => p.ownerEmail === reply.email).map(([board]) => board), ...(selected ? [selected] : [])]);
    for (const board of owned) {
      if (!await options.grants.ownsAuthority(board) || !await options.canReceive(board, reply.email, reply.email)) continue;
      await options.grants.security(board); // renew every owned board, not only the selected one
      const advertised = reply.boards.find(e => e.publication.policy.boardId === board)?.publication.policy;
      if (!advertised || advertised.expiresAt - Date.now() < 120_000) {
        const deferred = publications.get(board);
        if (!force && !advertised && deferred?.email === reply.email && deferred.retryAt > Date.now()) {
          issues.push({ boardId: board, code: 'directory_capacity' }); continue;
        }
        try {
          reply = await exchange({ type: 'sync', publication: await publication(board, reply.email) });
          publications.delete(board);
        } catch (error) {
          if (!(error instanceof IdentityServiceError) || error.status !== 403 || error.code !== 'directory_capacity') throw error;
          publications.set(board, { email: reply.email, retryAt: Date.now() + 30_000 });
          issues.push({ boardId: board, code: 'directory_capacity' });
          // No room is admitted for this failure. Continue processing valid
          // existing policies and their pending devices independently.
        }
      }
    }
    const ready: string[] = [];
    for (const entry of reply.boards) {
      const policy = await check(entry, reply.email);
      if (!await options.canReceive(policy.boardId, policy.ownerEmail, reply.email)) continue;
      const pin = await publicKeyFingerprint(policy.authority);
      if (await options.grants.ownsAuthority(policy.boardId)) {
        const own = await key(`board-device:${policy.boardId}`);
        const bindings = (await local())[policy.boardId];
        for (const pending of entry.pending) {
          const role: Role | undefined = pending.email === policy.ownerEmail ? 'editor' : policy.members.find(m => m.email === pending.email)?.role;
          if (!role || pending.request.authorityKeyId !== pin || pending.request.boardId !== policy.boardId || pending.request.deviceKeyId === own.keyId || !await options.grants.automaticDeviceAllowed(policy.boardId, pending.request.deviceKeyId)) continue;
          const current = (await options.grants.localBundle(policy.boardId))!.history.at(-1)!.payload.devices.find(d => d.deviceKeyId === pending.request.deviceKeyId);
          if (!current || current.role !== role) await options.grants.approve(JSON.stringify(pending.request), pending.request.deviceKeyId, role);
          if (bindings) bindings.devices[pending.request.deviceKeyId] = pending.email;
        }
        if (bindings) await save(policy.boardId, bindings);
        ready.push(policy.boardId);
      } else {
        const bundle = await readBundle(policy);
        const own = await key(`board-device:${policy.boardId}`);
        if (!bundle.history.at(-1)!.payload.devices.some(d => d.deviceKeyId === own.keyId)) {
          const previous = requests.get(policy.boardId);
          // Requests live for an hour on the service. Avoid replacing them on
          // every poll; retry after a bounded interval or an explicit refresh.
          if (force || previous?.email !== reply.email || Date.now() - previous.at >= 30_000) {
            const request = await options.grants.deviceRequest(JSON.stringify(bundle));
            try { await exchange({ type: 'request', request }, `board-device:${policy.boardId}`); }
            catch (error) {
              if (!(error instanceof IdentityServiceError) || error.status !== 403 || error.code !== 'pending_capacity') throw error;
              issues.push({ boardId: policy.boardId, code: 'pending_capacity' }); continue;
            }
            requests.set(policy.boardId, { email: reply.email, at: Date.now() });
          }
        } else {
          requests.delete(policy.boardId);
          const digest = await bundleDigest(bundle), cached = trusted.get(policy.boardId);
          const current = await options.grants.localBundle(policy.boardId);
          const head = bundle.history.at(-1)!.payload;
          const scoped = { ...head, boardId: `board-grant:${pin}:${policy.boardId}` };
          const accepted = await epochs.read(scoped.boardId);
          // Still fetch policies and grants on every refresh, so membership
          // changes are visible. Avoid rewriting permissions/storage and
          // invalidating the live security cache for identical verified data.
          if (!cached || cached.digest !== digest || cached.device !== own.keyId || !current
            || head.expiresAt <= Date.now() || head.issuedAt > Date.now() + 30_000
            || !accepted || accepted.epoch !== head.epoch || accepted.hash !== manifestHash(scoped) || accepted.expiresAt !== head.expiresAt
            || await bundleDigest(current) !== digest) {
            trusted.delete(policy.boardId);
            await options.grants.trust(JSON.stringify(bundle), pin);
            trusted.set(policy.boardId, { digest, device: own.keyId });
          }
          ready.push(policy.boardId);
        }
      }
    }
    last = { at: Date.now(), selected, reply, ready, issues };
    collaborationDiagnostic('google.identity.sharing', { count: ready.length });
    return { ...reply, ready, issues };
  }
  async function change(board: string, email: string, role: Role | null) {
    email = normalizedEmail(email);
    if (!/^[\x21-\x7e]+@[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address');
    const reply = await exchange({ type: 'sync', publication: null });
    const existing = (await local())[board];
    if (!existing || existing.ownerEmail !== reply.email || email === existing.ownerEmail) throw new Error('Only the original board owner may change invitations');
    const members = [...existing.members.filter(m => m.email !== email), ...(role ? [{ email, role }] : [])];
    if (members.length > 16) throw new Error('Board email membership limit reached');
    // Withdraw/downgrade device grants before changing the advertised policy.
    // Failure stops the action; it never leaves an advertised removal with an
    // unchanged active manifest. Existing downloaded data cannot be erased.
    const updates = Object.fromEntries(Object.entries(existing.devices).filter(([, account]) => account === email).map(([id]) => [id, role]));
    if (Object.keys(updates).length) await options.grants.updateAuthorizedDevices(board, updates);
    await exchange({ type: 'sync', publication: await publication(board, reply.email, members) });
    last = null;
  }
  async function admitService(request: import('./experimentalWebSocketSignaling').ServiceAdmissionRequest): Promise<string> {
    if (await options.auth.getConnectionState() !== 'connected') throw new Error('Google service admission requires a connected account');
    const hello = await http('/identity/challenge', { version: 1 }) as { version: number; challenge: string };
    if (hello.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(hello.challenge)) throw new Error('Invalid service admission challenge');
    const operation = { type: 'admit', challenge: request.challenge, session: request.session, room: request.room };
    const signature = await signBytes(await importSigningKey(request.key.privateJwk), canonicalBytes(json(['pboard-identity-v1', hello.challenge, request.key.keyId, operation])));
    const reply = await http('/identity/exchange', { version: 1, challenge: hello.challenge, publicKey: request.key.publicJwk, operation, signature }, await options.auth.getAccessToken()) as { version: number; admission: string; expiresAt: number };
    if (reply.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(reply.admission) || !Number.isSafeInteger(reply.expiresAt) || reply.expiresAt <= Date.now() || reply.expiresAt > Date.now() + 330_000) throw new Error('Invalid service admission response');
    return reply.admission;
  }
  return {
    admitService,
    sync: (selected?: string, force = false) => exclusive(() => collaborationCounters.timed("identity.sync", () => syncWork(selected, force))),
    invite: (board: string, email: string, role: Role) => exclusive(() => change(board, email, role)),
    remove: (board: string, email: string) => exclusive(() => change(board, email, null)),
    async collaborators(board: string) { const value = (await local())[board] ?? last?.reply.boards.find(e => e.publication.policy.boardId === board)?.publication.policy; return value ? [{ email: value.ownerEmail, role: 'owner' as const }, ...value.members] : []; },
  };
}
