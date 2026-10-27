import { sealAuthorityRecovery, openAuthorityRecovery } from "./security/authorityRecovery";
import { collaborationCounters } from "./counters";
/** Owner-approved board grants. This path never reads Google identity or ACLs. */
import type { KeyValueStorage } from "../storage/repository";
import type { CollaborationSecurityOptions } from "./manager";
import { ensureDeviceKey, loadPurposeKey, saveRecoveredPurposeKey, importSigningKey, publicKeyFingerprint, signBytes, verifyBytes, type DevicePublicKey } from "./security/keys";
import { canonicalBytes, fromBase64Url, parseStrictJson, signedBytes, toBase64Url, type Json } from "./security/canonical";
import { acceptManifest, manifestHash, signManifest, verifyManifest, type SignedManifest, type ManifestDevice, type ManifestRole } from "./security/manifest";
import { storageManifestEpochs } from "./security/enrollment";
import { AUTHORITY_TRANSITION_FORMAT, OWNERSHIP_PROOF_FRESHNESS_MS, TRANSITION_MIN_CLIENT_VERSION, signTransition, type AuthorityTransitionRecord, type DriveOwnershipProof } from "./security/authorityTransition";
import { prepareRelayAdmission } from "./security/relayAdmission";
import { validateWebSocketEndpoint } from "./security/endpoint";
import { collaborationDiagnostic } from "./diagnostics";
import { createBoardPairing } from "./boardPairing";
import { withStorageLock } from "../storage/lock";

export const COLLABORATION_SETTINGS = "pboardCollaborationSettings";
const GRANTS = "pboardBoardGrants";
const MAX_BUNDLE = 4 * 1024 * 1024;
export const DEFAULT_RENDEZVOUS = "wss://pboard.cecosl.ovh/ws";
export type CollaborationSettings = { provider: "drive" | "websocket"; url: string };
export type BoardGrantBundle = { format: "pboard-board-grants-v1"; endpoint: string; authority: DevicePublicKey; history: SignedManifest[] };
type RecordEntry = { bundle: BoardGrantBundle; bootstrap: boolean; blockedDevices?: string[];
  /** Set only by a Drive-ownership-verified re-key; never overwrites an older record. */
  transition?: AuthorityTransitionRecord;
  /** Authority fingerprints this record succeeded, kept for audit. */
  superseded?: { previousAuthorityKeyId: string | null; note: string }[] };
export type BoardDeviceRequest = { format: "pboard-board-device-v1"; boardId: string; authorityKeyId: string; publicKey: DevicePublicKey; deviceKeyId: string; expiresAt: number; nonce: string; signature: string };
const validId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
const encode = (value: unknown) => value as Json;
export function validateRendezvous(endpoint: string) {
  const url = new URL(endpoint);
  const loopback = import.meta.env.DEV && url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!loopback && validateWebSocketEndpoint(endpoint).check !== "ok") || url.username || url.password || url.search || url.hash || url.pathname !== "/ws") throw new Error("Use a WSS rendezvous URL ending in /ws");
  return url.href;
}
export function rendezvousOrigin(endpoint: string) {
  const url = new URL(validateRendezvous(endpoint));
  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.hostname}/*`;
}
const proofBytes = (request: Omit<BoardDeviceRequest, "signature">) => signedBytes("pboard-board-device-v1", encode(request));

export function createBoardGrantService(options: { storage: KeyValueStorage; fetcher?: typeof fetch; getKey?: typeof ensureDeviceKey; peekKey?: (purpose: string) => Promise<import("./security/keys").StoredDeviceKey | null>; canAccessEndpoint?: (origin: string) => Promise<boolean>; recoveryKeys?: { load: typeof loadPurposeKey; save: typeof saveRecoveredPurposeKey }; recoveryHistory?: (board: string) => Promise<SignedManifest[]>; publicGrantHistory?: (board: string) => Promise<SignedManifest[]>; validateRecoveryData?: (board: string, bundle: BoardGrantBundle) => Promise<void>; onAuthorization?: (board: string, permission: import("../storage/changeJournal").OfflinePermission, authorityReplacementAuthorized?: boolean) => Promise<void>; onTransition?: (board: string, record: AuthorityTransitionRecord) => Promise<void> }) {
  const fetcher = options.fetcher ?? fetch;
  const key = options.getKey ?? ensureDeviceKey;
  const peekKey = options.peekKey ?? loadPurposeKey;
  const recoveryKeys = options.recoveryKeys ?? { load: loadPurposeKey, save: saveRecoveredPurposeKey };
  async function authorityKey(board: string, pin?: string) {
    const entry = await record(board);
    pin ??= entry?.bundle.history.at(-1)?.payload.authorityKeyId;
    if (pin) { const recovered = await recoveryKeys.load(`recovered-board-authority:${board}:${pin}`); if (recovered) return recovered; }
    // A re-keyed record signs with its own fresh root; the legacy standalone
    // root is never used again (and never deleted) once a transition exists.
    if (entry?.transition) { const rekeyed = await peekKey(`rekeyed-board-authority:${board}`); if (rekeyed) return rekeyed; }
    return key(`standalone-board-authority:${board}`);
  }
  const epochs = storageManifestEpochs(options.storage);
  const cache = new Map<string, CollaborationSecurityOptions>();
  const polledManifests = new Map<string, string>();
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => { const result = chain.then(work, work); chain = result.catch(() => {}); return result; };
  async function settings(): Promise<CollaborationSettings> {
    const stored = (await options.storage.get(COLLABORATION_SETTINGS))[COLLABORATION_SETTINGS] as CollaborationSettings | undefined;
    if (!stored) return { provider: "drive", url: DEFAULT_RENDEZVOUS };
    if (stored.provider !== "drive" && stored.provider !== "websocket") throw new Error("Invalid collaboration setting; no transport fallback permitted");
    return { provider: stored.provider, url: validateRendezvous(stored.url) };
  }
  async function configure(next: CollaborationSettings) {
    if (next.provider !== "drive" && next.provider !== "websocket") throw new Error("Invalid collaboration provider");
    await options.storage.set({ [COLLABORATION_SETTINGS]: { ...next, url: validateRendezvous(next.url) } });
    cache.clear(); polledManifests.clear();
  }
  async function records() { return ((await options.storage.get(GRANTS))[GRANTS] ?? {}) as Record<string, RecordEntry>; }
  async function record(id: string) { return (await records())[id] ?? null; }
  // The whole map is re-read under a cross-context lock: the sidebar and the
  // background worker each save records for other boards, and an unguarded
  // read-modify-write silently clobbers the other context's grant records —
  // one way a board loses its authority while keeping its signed history.
  async function save(id: string, value: RecordEntry) {
    await withStorageLock(options.storage, GRANTS, async () => {
      await options.storage.set({ [GRANTS]: { ...await records(), [id]: value } });
    });
  }
  async function checkEndpoint(endpoint: string) {
    validateRendezvous(endpoint);
    if (options.canAccessEndpoint && !await options.canAccessEndpoint(rendezvousOrigin(endpoint))) throw new Error("Allow access to this rendezvous service using Enable WebSocket collaboration");
    const url = new URL(endpoint); url.protocol = url.protocol === "wss:" ? "https:" : "http:"; return url;
  }
  async function requestHttp(endpoint: string, path: string, body?: unknown) {
    const url = await checkEndpoint(endpoint); url.pathname = path;
    const send = () => fetcher(url, { method: body ? "POST" : "GET", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15_000) });
    let response = await send();
    for (let attempt = 0; response.status === 429 && attempt < 2; attempt++) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 1100 + Math.random() * 400));
      response = await send();
    }
    if (!response.ok) throw new Error(`Board grant service unavailable (HTTP ${response.status}). No Google or unrestricted fallback is used.`);
    if (response.status === 204) return null;
    const reader = response.body?.getReader(); if (!reader) throw new Error("Missing grant response");
    let length = 0; const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > MAX_BUNDLE) { await reader.cancel(); throw new Error("Board grant history capacity reached"); } chunks.push(value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseStrictJson(new TextDecoder().decode(bytes), MAX_BUNDLE) as unknown as { version: number; authority: DevicePublicKey; history: { payload: string; signature: string }[] };
  }
  async function verified(bundle: BoardGrantBundle, pin: string, previous?: BoardGrantBundle, authorizeReplacement = false) {
    if (bundle.format !== "pboard-board-grants-v1" || Object.keys(bundle.authority).sort().join(",") !== "crv,kty,x,y" || await publicKeyFingerprint(bundle.authority) !== pin || !bundle.history.length || bundle.history.length > 4096 || JSON.stringify(bundle).length > MAX_BUNDLE) throw new Error("Invalid board grant or authority fingerprint");
    validateRendezvous(bundle.endpoint);
    const history = new Map<number, Awaited<ReturnType<typeof verifyManifest>>>();
    let board = "", last = -1;
    for (const signed of bundle.history) {
      const m = await verifyManifest(signed, bundle.authority, pin);
      if (!validId(m.boardId) || m.driveProjectFileId !== "" || m.driveFolderId !== "" || (board && board !== m.boardId) || m.epoch <= last || m.issuedAt > Date.now() + 30_000) throw new Error("Board grant history binding or epoch mismatch");
      for (const member of m.devices) if (Object.keys(member.publicKey).sort().join(",") !== "crv,kty,x,y" || await publicKeyFingerprint(member.publicKey) !== member.deviceKeyId) throw new Error("Invalid grant device key");
      board = m.boardId; last = m.epoch; history.set(last, m);
    }
    for (const old of previous?.history ?? []) if (!bundle.history.some(next => manifestHash(next.payload) === manifestHash(old.payload) && next.signature === old.signature)) throw new Error("Board grant history fork or truncation rejected");
    const current = bundle.history.at(-1)!;
    if (current.payload.expiresAt <= Date.now()) throw new Error("Board grant expired. The original authority browser must be online to renew it.");
    const own = await key(`board-device:${board}`);
    // New namespace never overwrites legacy Drive or Google-broker trust records.
    await acceptManifest({ ...current.payload, boardId: `board-grant:${pin}:${board}` }, epochs, Date.now());
    cache.delete(board);
    const role = current.payload.devices.find(d => d.deviceKeyId === own.keyId)?.role;
    await options.onAuthorization?.(board, { id: board, role: role ?? "revoked", deviceKeyId: own.keyId, authorityKeyId: pin }, authorizeReplacement);
    if (!role) throw new Error("This device has no owner-approved board grant");
    return { board, history, own, current };
  }
  async function publish(bundle: BoardGrantBundle) {
    collaborationCounters.countEvent("grant.publish");
    const own = await key(`board-device:${bundle.history.at(-1)!.payload.boardId}`);
    const topic = `pboard-collab-${bundle.history.at(-1)!.payload.boardId}-cards`;
    const admission = await prepareRelayAdmission(topic, { authority: bundle.authority, manifest: bundle.history.at(-1)! }, own.keyId);
    const authority = await authorityKey(bundle.history.at(-1)!.payload.boardId, await publicKeyFingerprint(bundle.authority));
    if (authority.keyId !== await publicKeyFingerprint(bundle.authority)) throw new Error("Only the original authority device can publish board grants");
    const hello = await requestHttp(bundle.endpoint, "/grants/challenge", { version: 2 }) as unknown as {version:number;challenge:string};
    if (hello?.version!==2 || !/^[A-Za-z0-9_-]{43}$/.test(hello.challenge)) throw new Error("Rendezvous does not support replay-resistant grant publication; no legacy fallback is allowed");
    const authoritySignature = await signBytes(await importSigningKey(authority.privateJwk), new TextEncoder().encode(JSON.stringify(["pboard-grant-publish-v2",hello.challenge,authority.keyId,bundle.history.at(-1)!.payload.boardId,admission.digest])));
    const signature = await signBytes(await importSigningKey(own.privateJwk), new TextEncoder().encode(JSON.stringify(["pboard-ws-auth-v2", "publish", "publish", admission.room, own.keyId, admission.digest])));
    await requestHttp(bundle.endpoint, "/grants/publish", { version: 2, challenge: hello.challenge, authoritySignature, bundle: { version: 1, authority: bundle.authority, history: bundle.history.map(signed => ({ payload: toBase64Url(canonicalBytes(encode(signed.payload))), signature: signed.signature })) }, deviceKeyId: own.keyId, signature });
  }
  async function refreshAuthorityRecord(board: string, previous: RecordEntry) {
    const pin = await publicKeyFingerprint(previous.bundle.authority);
    const scope = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['pboard-board-grants-v1', pin, board])))));
    let received: Awaited<ReturnType<typeof requestHttp>>;
    try { received = await requestHttp(previous.bundle.endpoint, `/grants/${scope}`); }
    catch (error) { if (error instanceof Error && error.message.includes('(HTTP 404)')) return previous; throw error; }
    if (!received || received.version !== 1 || await publicKeyFingerprint(received.authority) !== pin || !Array.isArray(received.history) || !received.history.length || received.history.length > 4096) throw new Error('Current authority history is unavailable');
    const history = received.history.map(e => ({ payload: parseStrictJson(new TextDecoder().decode(fromBase64Url(e.payload))) as unknown as SignedManifest['payload'], signature: e.signature }));
    let epoch = -1;
    for (const entry of history) { const m = await verifyManifest(entry, previous.bundle.authority, pin); if (m.boardId !== board || m.driveFolderId !== '' || m.driveProjectFileId !== '' || m.epoch <= epoch) throw new Error('Invalid current authority history'); epoch = m.epoch; }
    // A failed publication can leave a newer local prefix. Republish it only if
    // the server history is an exact prefix, never merge a fork by timestamp.
    if (epoch < previous.bundle.history.at(-1)!.payload.epoch) {
      if (history.every(old => previous.bundle.history.some(e => e.signature === old.signature && manifestHash(e.payload) === manifestHash(old.payload)))) return previous;
      throw new Error('Authority history fork rejected');
    }
    for (const old of previous.bundle.history) if (!history.some(e => e.signature === old.signature && manifestHash(e.payload) === manifestHash(old.payload))) throw new Error('Authority history rollback or fork rejected');
    if (epoch === previous.bundle.history.at(-1)!.payload.epoch) return previous;
    const next = { ...previous, bundle: { ...previous.bundle, history } }; await save(board, next); cache.delete(board); return next;
  }
  async function write(board: string, devices: ManifestDevice[], previous?: RecordEntry) {
    if (previous) {
      const latest = await refreshAuthorityRecord(board, previous);
      if (manifestHash(latest.bundle.history.at(-1)!.payload) !== manifestHash(previous.bundle.history.at(-1)!.payload)) throw new Error('Authority membership changed; refresh and review before changing grants');
      const own = await key(`board-device:${board}`);
      if (latest.bundle.history.at(-1)!.payload.devices.find(d => d.role === 'owner')?.deviceKeyId !== own.keyId) throw new Error('Authority management moved to another recovered owner device');
    }
    const authority = await authorityKey(board);
    if (previous && await publicKeyFingerprint(previous.bundle.authority) !== authority.keyId) throw new Error("Only the original board authority device may issue grants");
    const now = Date.now();
    const manifest = await signManifest({ protocol: 2, boardId: board, driveProjectFileId: "", driveFolderId: "", authorityKeyId: authority.keyId,
      epoch: (previous?.bundle.history.at(-1)?.payload.epoch ?? 0) + 1, issuedAt: now, expiresAt: now + 300_000, devices }, authority);
    const bundle: BoardGrantBundle = { format: "pboard-board-grants-v1", endpoint: previous?.bundle.endpoint ?? (await settings()).url, authority: authority.publicJwk, history: [...previous?.bundle.history ?? [], manifest] };
    await verified(bundle, authority.keyId, previous?.bundle);
    // Persist first. A network error cannot discard a newly issued grant/epoch.
    await save(board, { ...previous, bundle, bootstrap: previous?.bootstrap ?? true });
    await publish(bundle); cache.delete(board); return bundle;
  }
  const initialize = (board: string) => exclusive(async () => {
    if (!validId(board)) throw new Error("Select a local board first");
    const previous = await record(board); const own = await key(`board-device:${board}`);
    return write(board, previous?.bundle.history.at(-1)!.payload.devices ?? [{ deviceKeyId: own.keyId, publicKey: own.publicJwk, role: "owner" }], previous ?? undefined);
  });
  // Drive-verified authority re-key (Phase 2): establishes a NEW authority on a
  // device that holds no grant record, only when the caller just completed a
  // fresh authenticated Drive ACL read proving this account owns the board
  // folder. Refuses whenever this device already pins an authority (restore or
  // renew own those cases; an existing record is never silently replaced) —
  // historical chains and their key slots are never modified or deleted. The
  // new root lives in its own purpose slot so the legacy root stays intact.
  const reestablishAuthority = (board: string, proof: DriveOwnershipProof) => exclusive(async () => {
    if (!validId(board)) throw new Error("Select a local board first");
    const now = Date.now();
    if (!proof || typeof proof.folderFileId !== "string" || !proof.folderFileId || typeof proof.ownerEmailHash !== "string" || !proof.ownerEmailHash || typeof proof.aclDigest !== "string" || !proof.aclDigest
      || !Number.isSafeInteger(proof.verifiedAt) || now - proof.verifiedAt > OWNERSHIP_PROOF_FRESHNESS_MS || proof.verifiedAt - now > OWNERSHIP_PROOF_FRESHNESS_MS)
      throw new Error("A fresh live Drive ownership proof is required; cached metadata cannot authorize a re-key");
    if (await record(board)) throw new Error("This device already pins a board authority; re-establishment never replaces it — restore or renew instead");
    const retained = await peekKey(`standalone-board-authority:${board}`);
    const authority = await key(`rekeyed-board-authority:${board}`);
    const own = await key(`board-device:${board}`);
    const manifest = await signManifest({ protocol: 2, boardId: board, driveProjectFileId: "", driveFolderId: "", authorityKeyId: authority.keyId,
      epoch: 1, issuedAt: now, expiresAt: now + 300_000, devices: [{ deviceKeyId: own.keyId, publicKey: own.publicJwk, role: "owner" }] }, authority);
    const bundle: BoardGrantBundle = { format: "pboard-board-grants-v1", endpoint: (await settings()).url, authority: authority.publicJwk, history: [manifest] };
    // Self-verification pins the fresh epoch scope; conflicting signed chains
    // under any pre-existing pin are rejected by that pin's own epoch floor.
    // A Drive-verified transition explicitly authorizes replacing the locally
    // cached permission row; other verified() callers keep the guard.
    await verified(bundle, authority.keyId, undefined, true);
    const transition = await signTransition({ format: AUTHORITY_TRANSITION_FORMAT, boardId: board,
      previousAuthorityKeyId: retained?.keyId ?? null, previousAuthorityPublicKey: retained?.publicJwk ?? null,
      newAuthorityKeyId: authority.keyId, newAuthorityPublicKey: authority.publicJwk,
      driveFolderFileId: proof.folderFileId, driveOwnerEmailHash: proof.ownerEmailHash, aclDigest: proof.aclDigest,
      minClientVersion: TRANSITION_MIN_CLIENT_VERSION, issuedAt: now }, authority.privateJwk);
    // Persist first; a publish error cannot discard the re-key. Publication then
    // retries through ordinary renew/security refresh, so it is best-effort here.
    await save(board, { bundle, bootstrap: true, transition, ...(retained ? { superseded: [{ previousAuthorityKeyId: retained.keyId, note: "authority re-established after verified Drive ownership" }] } : {}) });
    await options.onTransition?.(board, transition);
    try { await publish(bundle); } catch { collaborationDiagnostic("board_grant.rekey_publish_deferred", { count: 1 }); }
    cache.delete(board);
    collaborationCounters.countEvent("grant.rekeyed");
    return transition;
  });
  async function deviceRequest(raw: string): Promise<BoardDeviceRequest> {
    const invitation = parseStrictJson(raw, MAX_BUNDLE) as unknown as BoardGrantBundle;
    const m = invitation.history?.at(-1)?.payload;
    if (invitation.format !== "pboard-board-grants-v1" || !m || !validId(m.boardId) || await publicKeyFingerprint(invitation.authority) !== m.authorityKeyId) throw new Error("Paste the owner's public invitation first");
    // This is a request, not trust or room admission. The authority is pinned
    // independently only after explicit fingerprint verification in trust().
    await verifyManifest(invitation.history.at(-1), invitation.authority, m.authorityKeyId);
    const own = await key(`board-device:${m.boardId}`);
    const payload: Omit<BoardDeviceRequest, "signature"> = { format: "pboard-board-device-v1", boardId: m.boardId, authorityKeyId: m.authorityKeyId,
      publicKey: own.publicJwk, deviceKeyId: own.keyId, expiresAt: Date.now() + 3600_000, nonce: crypto.randomUUID() };
    return { ...payload, signature: await signBytes(await importSigningKey(own.privateJwk), proofBytes(payload)) };
  }
  const approve = (raw: string, fingerprint: string, role: Exclude<ManifestRole, "owner">) => exclusive(async () => {
    const req = parseStrictJson(raw) as unknown as BoardDeviceRequest;
    const { signature, ...payload } = req;
    if (Object.keys(req).sort().join(",") !== "authorityKeyId,boardId,deviceKeyId,expiresAt,format,nonce,publicKey,signature" || req.format !== "pboard-board-device-v1" || !validId(req.boardId) || !["editor", "viewer"].includes(role) || !Number.isSafeInteger(req.expiresAt) || req.expiresAt <= Date.now() || req.expiresAt > Date.now() + 3600_000 || req.deviceKeyId !== fingerprint.trim() || await publicKeyFingerprint(req.publicKey) !== req.deviceKeyId || !await verifyBytes(req.publicKey, signature, proofBytes(payload))) throw new Error("Invalid request or independently verified device fingerprint");
    const previous = await record(req.boardId);
    if (!previous || req.authorityKeyId !== await publicKeyFingerprint(previous.bundle.authority)) throw new Error("Device request belongs to another authority");
    const devices = previous.bundle.history.at(-1)!.payload.devices;
    if (devices.some(d => d.deviceKeyId === req.deviceKeyId && d.role === "owner")) throw new Error("Cannot change the authority owner's role");
    return write(req.boardId, [...devices.filter(d => d.deviceKeyId !== req.deviceKeyId), { deviceKeyId: req.deviceKeyId, publicKey: req.publicKey, role }], previous);
  });
  const trust = (raw: string, fingerprint: string) => exclusive(async () => {
    const bundle = parseStrictJson(raw, MAX_BUNDLE) as unknown as BoardGrantBundle;
    const id = bundle.history?.at(-1)?.payload.boardId; const previous = id ? await record(id) : null;
    if (previous && await publicKeyFingerprint(previous.bundle.authority) !== fingerprint.trim()) throw new Error("Authority already pinned; automatic replacement is forbidden");
    const v = await verified(bundle, fingerprint.trim(), previous?.bundle);
    if (bundle.endpoint !== (await settings()).url) throw new Error("The invitation's rendezvous differs from your explicitly selected service");
    await save(v.board, { ...previous, bundle, bootstrap: previous?.bootstrap ?? false });
    cache.delete(v.board); return v.board;
  });
  const revoke = (board: string, deviceKeyId: string) => exclusive(async () => {
    const previous = await record(board);
    if (!previous) throw new Error("Board grant not found");
    const devices = previous.bundle.history.at(-1)!.payload.devices;
    if (!devices.some(d => d.deviceKeyId === deviceKeyId) || devices.some(d => d.deviceKeyId === deviceKeyId && d.role === "owner")) throw new Error("Cannot remove an unknown device or the authority owner");
    return write(board, devices.filter(d => d.deviceKeyId !== deviceKeyId), { ...previous, blockedDevices: [...new Set([...previous.blockedDevices ?? [], deviceKeyId])] });
  });
  const security = (board: string, refresh = false) => exclusive(async (): Promise<CollaborationSecurityOptions | null> => {
    let previous = await record(board); if (!previous) return null;
    if (!refresh && cache.has(board) && cache.get(board)!.manifest.expiresAt - Date.now() > 120_000) return cache.get(board)!;
    const localRoot = await authorityKey(board);
    if (localRoot.keyId === await publicKeyFingerprint(previous.bundle.authority)) previous = await refreshAuthorityRecord(board, previous);
    const { bundle } = previous; const pin = await publicKeyFingerprint(bundle.authority);
    if ((await settings()).url !== bundle.endpoint) throw new Error("Board is pinned to a different rendezvous; no automatic service migration");
    const authority = await authorityKey(board);
    let next = bundle;
    const manages = authority.keyId === pin && bundle.history.at(-1)!.payload.devices.find(d => d.role === "owner")?.deviceKeyId === (await key(`board-device:${board}`)).keyId;
    if (manages) {
      if (bundle.history.at(-1)!.payload.expiresAt - Date.now() < 120_000) next = await write(board, bundle.history.at(-1)!.payload.devices, previous);
      else await publish(bundle);
    } else {
      const scope = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["pboard-board-grants-v1", pin, board])))));
      let received: Awaited<ReturnType<typeof requestHttp>>;
      try { received = await requestHttp(bundle.endpoint, `/grants/${scope}`); }
      // The service answers 404 when a grant is not currently published:
      // grants live only while the authority browser renews them, so a board
      // its owner has not opened recently is absent from the service cache.
      // That is the expired-grant state, not an unavailable service.
      catch (error) {
        if (error instanceof Error && error.message.includes('(HTTP 404)'))
          throw new Error("Board grant expired. The original authority browser must be online to renew it.");
        throw error;
      }
      if (!received || received.version !== 1) throw new Error("Board authority metadata unavailable or unsupported");
      next = { ...bundle, authority: received.authority, history: received.history.map(entry => ({ payload: parseStrictJson(new TextDecoder().decode(fromBase64Url(entry.payload))) as unknown as SignedManifest["payload"], signature: entry.signature })) };
    }
    const v = await verified(next, pin, bundle);
    await save(board, { ...previous, bundle: next });
    const result: CollaborationSecurityOptions = { signer: { privateJwk: v.own.privateJwk, deviceKeyId: v.own.keyId }, boardId: board, manifest: v.current.payload,
      ownSessionId: crypto.randomUUID(), manifestHistory: v.history, grantHistory: next.history,
      ...(manages ? { historyAuthority: { privateJwk: authority.privateJwk, deviceKeyId: authority.keyId } } : {}), relayAuthorization: { authority: next.authority, manifest: v.current } };
    cache.set(board, result);
    if (!polledManifests.has(board)) polledManifests.set(board, manifestHash(result.manifest));
    collaborationDiagnostic("board_grant.verified", { count: result.manifest.devices.length }); return result;
  });
  /**
   * Restores a lost local grant record from the original cryptographic
   * evidence only, so a legitimate authority device is never asked to
   * re-initialize (and never replaces) its own authority. Requires that this
   * device still holds the board's root authority key and an enrolled device
   * key, that the service copy verifies against that exact root, and that
   * adopting its head manifest never rolls back a locally pinned epoch.
   * An expired head is acceptable: the owner renews it on the next security
   * pass, continuing the same signed chain. Any failure leaves no trace.
   */
  const restoreAuthorityRecord = (board: string) => exclusive(async (): Promise<boolean> => {
    try {
      if (!validId(board) || await record(board)) return false;
      const root = await peekKey(`standalone-board-authority:${board}`);
      const own = await peekKey(`board-device:${board}`);
      if (!root || !own) return false;
      const pin = root.keyId;
      const endpoint = (await settings()).url;
      const candidates: { authority: DevicePublicKey; history: SignedManifest[] }[] = [];
      try {
        const scope = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["pboard-board-grants-v1", pin, board])))));
        const received = await requestHttp(endpoint, `/grants/${scope}`);
        if (received && received.version === 1 && Array.isArray(received.history) && received.history.length && received.history.length <= 4096
          && await publicKeyFingerprint(received.authority) === pin)
          candidates.push({ authority: received.authority,
            history: received.history.map(entry => ({ payload: parseStrictJson(new TextDecoder().decode(fromBase64Url(entry.payload))) as unknown as SignedManifest["payload"], signature: entry.signature })) });
      } catch { /* service unreachable or malformed: only the verified local copy can restore */ }
      // The journal keeps every manifest this device verified at guard install
      // (publicGrants). A locally retained chain restores without relying on
      // the disposable service cache; it still verifies against the retained
      // root and may not roll back a pinned epoch.
      const local = await options.publicGrantHistory?.(board) ?? [];
      if (local.length) candidates.push({ authority: root.publicJwk, history: [...local].sort((a, b) => a.payload.epoch - b.payload.epoch) });
      for (const candidate of candidates) {
        let last = 0, ok = true;
        for (const signed of candidate.history) {
          let head: Awaited<ReturnType<typeof verifyManifest>>;
          try { head = await verifyManifest(signed, candidate.authority, pin); } catch { ok = false; break; }
          if (head.boardId !== board || head.driveProjectFileId !== "" || head.driveFolderId !== "" || head.epoch <= last) { ok = false; break; }
          last = head.epoch;
        }
        if (!ok || !candidate.history.length) continue;
        const tail = candidate.history.at(-1)!.payload;
        if (tail.devices.find(d => d.role === "owner")?.deviceKeyId !== own.keyId) continue;
        try { await acceptManifest({ ...tail, boardId: `board-grant:${pin}:${board}` }, epochs, Date.now()); } catch { continue; }
        await save(board, { bundle: { format: "pboard-board-grants-v1", endpoint, authority: candidate.authority, history: candidate.history }, bootstrap: true });
        cache.delete(board);
        collaborationDiagnostic("board_grant.restored", { count: tail.epoch });
        return true;
      }
      return false;
    } catch { return false; }
  });
  async function role(board: string) { const context = await security(board); return context?.manifest.devices.find(d => d.deviceKeyId === context.signer.deviceKeyId)?.role ?? null; }
  async function poll(board: string) {
    const old = polledManifests.get(board);
    collaborationCounters.countEvent("grant.poll");
    const next = await collaborationCounters.timed("grant.security", () => security(board, true));
    if (!next) return false;
    const hash = manifestHash(next.manifest);
    polledManifests.set(board, hash);
    return old !== hash;
  }
  const pairing = createBoardPairing({ storage: options.storage, getKey: key, settings, initialize, deviceRequest, approve, trust,
    read: async (endpoint, authority, board) => {
      const pin = await publicKeyFingerprint(authority);
      const scope = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["pboard-board-grants-v1", pin, board])))));
      const received = await requestHttp(endpoint, `/grants/${scope}`);
      if (!received || received.version !== 1 || !Array.isArray(received.history) || received.history.length > 4096) throw new Error("Owner must open the board to publish its grant");
      return { format: "pboard-board-grants-v1", endpoint, authority: received.authority, history: received.history.map(entry => ({ payload: parseStrictJson(new TextDecoder().decode(fromBase64Url(entry.payload))) as unknown as SignedManifest["payload"], signature: entry.signature })) };
    } });
  async function recoveryPayload(raw: string, passphrase: string, fingerprint: string) {
    const payload = await openAuthorityRecovery(raw, passphrase, fingerprint);
    if (payload.bundle?.format !== 'pboard-board-grants-v1' || payload.bundle.endpoint !== (await settings()).url || await publicKeyFingerprint(payload.bundle.authority) !== fingerprint
      || !Array.isArray(payload.bundle.history) || !payload.bundle.history.length || payload.bundle.history.length > 4096) throw new Error('Recovery file differs from the selected board authority or service');
    let epoch = -1;
    for (const entry of payload.bundle.history) {
      const manifest = await verifyManifest(entry, payload.bundle.authority, fingerprint);
      if (manifest.boardId !== payload.boardId || manifest.driveFolderId !== '' || manifest.driveProjectFileId !== '' || manifest.epoch <= epoch) throw new Error('Invalid recovery grant history');
      epoch = manifest.epoch;
    }
    const supplement = await options.recoveryHistory?.(payload.boardId) ?? [];
    for (const signed of supplement) {
      const m = await verifyManifest(signed, payload.bundle.authority, fingerprint);
      if (m.boardId !== payload.boardId || m.driveFolderId !== '' || m.driveProjectFileId !== '') throw new Error('Recovery grant belongs to another board');
      const known = payload.bundle.history.find(e => e.payload.epoch === m.epoch);
      if (known && (manifestHash(known.payload) !== manifestHash(m) || known.signature !== signed.signature)) throw new Error('Recovered grant history fork rejected');
      if (!known) payload.bundle.history.push(signed);
    }
    payload.bundle.history.sort((a, b) => a.payload.epoch - b.payload.epoch);
    epoch = payload.bundle.history.at(-1)!.payload.epoch;
    if (payload.bundle.history.length > 4096) throw new Error('Recovered grant history exceeds capacity');
    const previous = await record(payload.boardId);
    if (previous && await publicKeyFingerprint(previous.bundle.authority) !== fingerprint) throw new Error('Existing authority cannot be replaced by recovery');
    // A recovered root may resume its own namespace, never replace a newer local grant history.
    for (const old of previous?.bundle.history ?? []) if (!payload.bundle.history.some(e => e.signature === old.signature && manifestHash(e.payload) === manifestHash(old.payload))) {
      if (previous!.bundle.history.at(-1)!.payload.epoch > epoch) payload.bundle = previous!.bundle;
      else throw new Error('Recovery grant history forks from local trust');
    }
    const scope = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['pboard-board-grants-v1', fingerprint, payload.boardId])))));
    try {
      const remote = await requestHttp(payload.bundle.endpoint, `/grants/${scope}`);
      if (!remote || remote.version !== 1 || await publicKeyFingerprint(remote.authority) !== fingerprint || !Array.isArray(remote.history)) throw new Error('Invalid current recovery history');
      const history = remote.history.map(e => ({ payload: parseStrictJson(new TextDecoder().decode(fromBase64Url(e.payload))) as unknown as SignedManifest['payload'], signature: e.signature }));
      let last = -1;
      for (const entry of history) { const m = await verifyManifest(entry, payload.bundle.authority, fingerprint); if (m.boardId !== payload.boardId || m.epoch <= last || m.driveFolderId !== '' || m.driveProjectFileId !== '') throw new Error('Invalid remote recovery history'); last = m.epoch; }
      for (const old of payload.bundle.history) if (!history.some(e => e.signature === old.signature && manifestHash(e.payload) === manifestHash(old.payload))) throw new Error('Recovery history is incomplete or forked; retain the original recovery file');
      const currentIds = new Set(history.at(-1)!.payload.devices.map(d => d.deviceKeyId));
      payload.blockedDevices = [...new Set([...payload.blockedDevices, ...payload.bundle.history.at(-1)!.payload.devices.filter(d => !currentIds.has(d.deviceKeyId)).map(d => d.deviceKeyId)])];
      payload.bundle = { ...payload.bundle, history };
    } catch (error) {
      // Only an explicit empty service cache permits manual roster recovery.
      if (!(error instanceof Error) || !error.message.includes('(HTTP 404)')) throw error;
    }
    return payload;
  }
  async function inspectRecovery(raw: string, passphrase: string, fingerprint: string) {
    const payload = await recoveryPayload(raw, passphrase, fingerprint);
    return { boardId: payload.boardId, authorityKeyId: fingerprint, reviewedHash: manifestHash(payload.bundle.history.at(-1)!.payload), devices: payload.bundle.history.at(-1)!.payload.devices, members: (payload.policy as any)?.members ?? [] };
  }
  const restoreAuthority = (raw: string, passphrase: string, fingerprint: string, reviewedHash: string, approvedDevices: string[], approvedEmails: string[] = []) => exclusive(async () => {
    const payload = await recoveryPayload(raw, passphrase, fingerprint), previous = await record(payload.boardId), last = payload.bundle.history.at(-1)!.payload;
    if (manifestHash(last) !== reviewedHash || !Array.isArray(approvedDevices) || new Set(approvedDevices).size !== approvedDevices.length || approvedDevices.some(id => !last.devices.some(d => d.deviceKeyId === id))) throw new Error('Recovery membership changed; review the current roster again');
    await options.validateRecoveryData?.(payload.boardId, payload.bundle);
    const recoveryPolicy = payload.policy as any;
    if (recoveryPolicy && (typeof recoveryPolicy.ownerEmail !== 'string' || recoveryPolicy.ownerEmail.length > 254 || !Array.isArray(recoveryPolicy.members) || recoveryPolicy.members.length > 16 || !Array.isArray(approvedEmails)
      || approvedEmails.some(email => !recoveryPolicy.members.some((m: any) => m.email === email && ['viewer', 'editor'].includes(m.role))) || !Number.isSafeInteger(recoveryPolicy.revision))) throw new Error('Review valid recovered email invitations explicitly');
    const own = await key(`board-device:${payload.boardId}`);
    await recoveryKeys.save(`recovered-board-authority:${payload.boardId}:${fingerprint}`, payload.root);
    // A new device proves original-root possession. Its own device key remains unique.
    const devices = [{ deviceKeyId: own.keyId, publicKey: own.publicJwk, role: 'owner' as const }, ...last.devices.filter(d => approvedDevices.includes(d.deviceKeyId) && d.deviceKeyId !== own.keyId)];
    const now = Date.now();
    const signed = await signManifest({ ...last, epoch: Math.max(last.epoch + 1, now), issuedAt: now, expiresAt: now + 300000, devices }, payload.root);
    const bundle = { ...payload.bundle, history: [...payload.bundle.history, signed] };
    const blockedDevices = [...new Set([...payload.blockedDevices, ...previous?.blockedDevices ?? [], ...last.devices.filter(d => !approvedDevices.includes(d.deviceKeyId)).map(d => d.deviceKeyId)])].filter(id => !devices.some(d => d.deviceKeyId === id));
    await verified(bundle, fingerprint, previous?.bundle);
    await save(payload.boardId, { bundle, bootstrap: false, blockedDevices });
    // Restoring policy is explicit local recovery, not identity-based ownership.
    if (payload.policy) {
      const policies = ((await options.storage.get('pboardGoogleBoardPolicies')).pboardGoogleBoardPolicies ?? {}) as Record<string, unknown>;
      const policy = recoveryPolicy;
      if (!policies[payload.boardId]) await options.storage.set({ pboardGoogleBoardPolicies: { ...policies, [payload.boardId]: {
        ...policy, members: policy.members.filter((m: any) => approvedEmails.includes(m.email)),
        devices: Object.fromEntries(Object.entries(policy.devices ?? {}).filter(([id]) => approvedDevices.includes(id))), revision: Math.max(now, Number(policy.revision) + 1)
      } } });
    }
    await publish(bundle); cache.delete(payload.boardId); return payload.boardId;
  });
  return { settings, configure, initialize, deviceRequest, approve, trust, revoke, security, role, poll, pairing, inspectRecovery, restoreAuthority,
    reestablishAuthority,
    authorityTransitioned: async (board: string) => Boolean((await record(board))?.transition),
    async exportAuthorityRecovery(board: string, passphrase: string) {
      const saved = await record(board); if (!saved) throw new Error('No board authority to back up');
      const root = await authorityKey(board), pin = await publicKeyFingerprint(saved.bundle.authority);
      if (root.keyId !== pin) throw new Error('Only the original root authority may create a recovery file');
      const policies = ((await options.storage.get('pboardGoogleBoardPolicies')).pboardGoogleBoardPolicies ?? {}) as Record<string, Json>;
      return sealAuthorityRecovery({ boardId: board, root, bundle: saved.bundle, blockedDevices: saved.blockedDevices ?? [], ...(policies[board] ? { policy: policies[board] } : {}) }, passphrase);
    },
    async signAuthority(board: string, bytes: Uint8Array) {
      const previous = await record(board); if (!previous) throw new Error('Original board root authority is required');
      const saved = await refreshAuthorityRecord(board, previous), root = await authorityKey(board);
      if (saved.bundle.history.at(-1)!.payload.devices.find(d => d.role === 'owner')?.deviceKeyId !== (await key(`board-device:${board}`)).keyId) throw new Error('Authority management moved to a recovered owner device');
      if (!saved || root.keyId !== await publicKeyFingerprint(saved.bundle.authority)) throw new Error('Original board root authority is required');
      return signBytes(await importSigningKey(root.privateJwk), bytes);
    },
    updateAuthorizedDevices: (board: string, updates: Record<string, "editor" | "viewer" | null>) => exclusive(async () => {
      const previous = await record(board);
      if (!previous) throw new Error("Board grant not found");
      const devices = previous.bundle.history.at(-1)!.payload.devices;
      if (devices.some(d => d.role === "owner" && d.deviceKeyId in updates)) throw new Error("Cannot change the authority owner");
      const blocked = new Set(previous.blockedDevices ?? []);
      for (const [id, role] of Object.entries(updates)) { if (role === null) blocked.add(id); else blocked.delete(id); }
      return write(board, devices.flatMap(d => !(d.deviceKeyId in updates) ? [d] : updates[d.deviceKeyId] === null ? [] : [{ ...d, role: updates[d.deviceKeyId]! }]), { ...previous, blockedDevices: [...blocked] });
    }),
    async localBundle(board: string) { return (await record(board))?.bundle ?? null; },
    async ownsAuthority(board: string) { const value = await record(board); return Boolean(value && await publicKeyFingerprint(value.bundle.authority) === (await authorityKey(board)).keyId && value.bundle.history.at(-1)!.payload.devices.find(d => d.role === "owner")?.deviceKeyId === (await key(`board-device:${board}`)).keyId); },
    restoreAuthorityRecord,
    async automaticDeviceAllowed(board: string, device: string) { return !(await record(board))?.blockedDevices?.includes(device); },
    async exportBundle(board: string) { const value = await record(board); if (!value) throw new Error("Initialize this board's authority first"); return value.bundle; },
    markBootstrapped: (board: string) => exclusive(async () => { const value = await record(board); if (value?.bootstrap) await save(board, { ...value, bootstrap: false }); }),
    async canBootstrap(board: string) { return (await record(board))?.bootstrap ?? false; } };
}
