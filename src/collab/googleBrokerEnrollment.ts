/** Explicit build-pinned Google enrollment. Never changes manual authority pins. */
import { ensureDeviceKey, importSigningKey, publicKeyFingerprint, signBytes, type DevicePublicKey } from "./security/keys";
import { acceptManifest, verifyManifest, manifestHash, type SignedManifest, type BoardPermissionManifest, type ManifestRole } from "./security/manifest";
import { storageManifestEpochs } from "./security/enrollment";
import type { KeyValueStorage } from "../storage/repository";
import type { CollaborationSecurityOptions } from "./manager";
import { collaborationDiagnostic } from "./diagnostics";
import { validateWebSocketEndpoint } from "./security/endpoint";

export const googleBrokerEnabled = () => import.meta.env.DEV && import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER === "websocket" && import.meta.env.VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT === "1";
type Identity = { kind: "account" | "board"; scope: string; file: string; folder: string; role: ManifestRole };
function enrollmentEndpoint() {
  const endpoint = import.meta.env.VITE_PBOARD_SIGNALING_WS_URL;
  const url = new URL(endpoint);
  const loopback = url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!loopback && validateWebSocketEndpoint(endpoint).check !== "ok") || url.username || url.password || url.search || url.hash) throw new Error("Invalid Google enrollment endpoint");
  url.protocol = loopback ? "http:" : "https:"; url.pathname = "/experiment/";
  return url;
}
export function googleBrokerPermissionOrigin() {
  if (!googleBrokerEnabled()) throw new Error("Google enrollment is disabled in this build");
  const url = enrollmentEndpoint();
  return `${url.protocol}//${url.hostname}/*`;
}
export function createGoogleBrokerEnrollment(options: { storage: KeyValueStorage; getAccessToken: () => Promise<string>; fetcher: typeof fetch; canAccessEndpoint?: (origin: string) => Promise<boolean> }) {
  // Native Firefox fetch requires a Window receiver (or an unbound call). Calling
  // options.fetcher(...) supplies this options object and throws before any HTTP.
  const fetcher = options.fetcher;
  const cache = new Map<string, { id: Identity; security: CollaborationSecurityOptions; at: number }>();
  const inflight = new Map<string, Promise<CollaborationSecurityOptions>>();
  const epochStore = storageManifestEpochs(options.storage);
  const histories = new Map<string, Map<number, { signed: SignedManifest; manifest: BoardPermissionManifest }>>();
  function config() {
    if (!googleBrokerEnabled()) throw new Error("Google enrollment is disabled in this build");
    const url = enrollmentEndpoint();
    const authority = JSON.parse(import.meta.env.VITE_PBOARD_SIGNALING_AUTHORITY || "null") as DevicePublicKey;
    if (!authority || Object.keys(authority).sort().join(",") !== "crv,kty,x,y" || authority.kty !== "EC" || authority.crv !== "P-256" || !/^[A-Za-z0-9_-]{43}$/.test(authority.x) || !/^[A-Za-z0-9_-]{43}$/.test(authority.y)) throw new Error("This experimental build has no pinned enrollment authority");
    return { url, authority };
  }
  async function prepare(id: Identity): Promise<CollaborationSecurityOptions> {
    let phase = "configuration";
    try {
      const { url, authority } = config();
      phase = "host_permission";
      if (options.canAccessEndpoint && !await options.canAccessEndpoint(googleBrokerPermissionOrigin())) {
        throw new Error("Pboard needs browser permission to access the signaling service. Click Connect / reconnect with Google and allow access to this service. In Firefox you can also enable it in about:addons → Pboard → Permissions.");
      }
      const authorityId = await publicKeyFingerprint(authority);
      phase = "device_key";
      const key = await ensureDeviceKey(`${id.kind}-device:${id.scope}`);
      collaborationDiagnostic(`google.${id.kind}.verifying`);
      async function request(path: string, body: object, token?: string) {
        const response = await fetcher(new URL(path, url), { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body), cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20_000) });
        if (!response.ok) {
          let code = "unavailable";
          try { const value = await response.json(); if (typeof value.code === "string" && /^[a-z_]{1,48}$/.test(value.code)) code = value.code; } catch { /* fixed fallback */ }
          collaborationDiagnostic(`google.${id.kind}.rejected`);
          throw new Error(`Google enrollment rejected (${code}, HTTP ${response.status}). Check the connected Google account and Drive board sharing; the board owner must connect first.`);
        }
        const raw = await response.text();
        if (raw.length > 2 * 1024 * 1024) throw new Error("Oversized enrollment response");
        return JSON.parse(raw);
      }
      phase = "challenge";
      const hello = await request("challenge", {});
      if (typeof hello.challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(hello.challenge)) throw new Error("Invalid enrollment challenge");
      collaborationDiagnostic(`google.${id.kind}.challenge_received`);
      phase = "device_proof";
      const bytes = new TextEncoder().encode(JSON.stringify(["pboard-google-enroll-v1", hello.challenge, key.keyId, id.kind, id.scope, id.file, id.folder]));
      const signature = await signBytes(await importSigningKey(key.privateJwk), bytes);
      phase = "google_token";
      const token = await options.getAccessToken();
      phase = "enrollment";
      const body = await request("enroll", { challenge: hello.challenge, kind: id.kind, scope: id.scope,
        driveProjectFileId: id.file, driveFolderId: id.folder, publicKey: key.publicJwk, signature }, token);
      phase = "authority";
      if (await publicKeyFingerprint(body.authority) !== authorityId || body.deviceKeyId !== key.keyId || !Array.isArray(body.history) || !body.history.length || body.history.length > 256) throw new Error("Enrollment authority or device mismatch");
      const boardId = id.kind === "account" ? `account:${id.scope}` : id.scope;
      const previous = histories.get(boardId) ?? new Map();
      const verified = new Map<number, { signed: SignedManifest; manifest: BoardPermissionManifest }>();
      phase = "history";
      for (const signed of body.history as SignedManifest[]) {
        const prior = previous.get(signed.payload?.epoch);
        const manifest = prior && JSON.stringify(prior.signed) === JSON.stringify(signed) ? prior.manifest : await verifyManifest(signed, authority, authorityId);
        if (prior && manifestHash(prior.manifest) !== manifestHash(manifest)) throw new Error("Enrollment history fork rejected");
        if (manifest.boardId !== boardId || manifest.driveProjectFileId !== id.file || manifest.driveFolderId !== id.folder || verified.has(manifest.epoch)) throw new Error("Enrollment history binding or epoch mismatch");
        verified.set(manifest.epoch, { signed, manifest });
      }
      phase = "manifest";
      const manifest = await verifyManifest(body.manifest, authority, authorityId);
      if (JSON.stringify(verified.get(manifest.epoch)?.signed) !== JSON.stringify(body.manifest) ||
          manifest.epoch !== Math.max(...verified.keys()) || manifest.expiresAt <= Date.now() || manifest.issuedAt > Date.now() + 30_000 ||
          manifest.devices.find(member => member.deviceKeyId === key.keyId)?.role !== id.role) throw new Error("Enrollment is expired or conflicts with current Drive permissions");
      // Namespaced anti-rollback records preserve existing manual enrollment history.
      phase = "save";
      await acceptManifest({ ...manifest, boardId: `broker:${authorityId}:${boardId}` }, epochStore, Date.now());
      histories.set(boardId, verified);
      collaborationDiagnostic(`google.${id.kind}.verified`, { count: manifest.devices.length });
      return { signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId }, manifest, boardId,
        ownSessionId: crypto.randomUUID(), relayAuthorization: { authority, manifest: body.manifest },
        manifestHistory: new Map([...verified].map(([epoch, entry]) => [epoch, entry.manifest])) };
    } catch (error) {
      // Phase labels are fixed here; never log raw network/OAuth/crypto errors.
      collaborationDiagnostic(`google.${id.kind}.failed.${phase}`);
      throw error;
    }
  }
  async function security(id: Identity, force = false) {
    const slot = `${id.kind}:${id.scope}:${id.file}:${id.folder}`;
    const existing = cache.get(slot);
    if (!force && existing && existing.id.role === id.role && Date.now() - existing.at < 5_000) return existing.security;
    let pending = inflight.get(slot);
    if (!pending) {
      pending = prepare(id).then(security => { cache.set(slot, { id, security, at: Date.now() }); return security; }).finally(() => inflight.delete(slot));
      inflight.set(slot, pending);
    }
    return pending;
  }
  return { security, async poll(projectId: string, account: string | null) {
    let changed = false;
    for (const entry of [...cache.values()]) {
      if (entry.id.scope !== (entry.id.kind === "account" ? account : projectId)) continue;
      const next = await security(entry.id, true);
      changed ||= manifestHash(next.manifest) !== manifestHash(entry.security.manifest);
    }
    if (changed) collaborationDiagnostic("google.authorization_changed");
    return changed;
  } };
}
