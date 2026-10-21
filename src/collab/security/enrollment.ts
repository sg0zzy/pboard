/** Explicit out-of-band enrollment. Public bundles never carry private keys. */
import type { KeyValueStorage } from "../../storage/repository";
import { ensureDeviceKey, publicKeyFingerprint, importSigningKey, signBytes, verifyBytes, type DevicePublicKey } from "./keys";
import { parseStrictJson, signedBytes, type Json } from "./canonical";
import { acceptManifest, manifestIsCurrent, signManifest, verifyManifest, type BoardPermissionManifest, type SignedManifest, type ManifestRole, type ManifestEpochStore } from "./manifest";

export type EnrollmentIdentity = { kind: "board" | "account"; scope: string; boardId: string; driveProjectFileId: string; driveFolderId: string; email: string; role: ManifestRole };
export type AuthorityPin = { kind: "board" | "account"; scope: string; authorityKeyId: string; authorityPublicKey: DevicePublicKey; pinnedAt: number };
export type EnrollmentBundle = { format: "pboard-enrollment-v1"; authority: DevicePublicKey; manifest: SignedManifest };
export type DeviceRequest = { payload: EnrollmentIdentity & { deviceKeyId: string; publicKey: DevicePublicKey; expiresAt: number; nonce: string }; signature: string };
const PIN_KEY = "pboardSecurityPins";
const REQUEST_DOMAIN = "pboard-enrollment-request-v1";
export function storageManifestEpochs(storage: KeyValueStorage): ManifestEpochStore {
  return {
    async read(id) { const result = await storage.get("pboardManifestEpochs"); return (result.pboardManifestEpochs as Record<string, any> | undefined)?.[id] ?? null; },
    async write(id, record) { const result = await storage.get("pboardManifestEpochs"); await storage.set({ pboardManifestEpochs: { ...(result.pboardManifestEpochs as object ?? {}), [id]: record } }); }
  };
}
export function createDeviceEnrollment(options: {
  storage: KeyValueStorage;
  getKey?: typeof ensureDeviceKey;
  identity: (kind: "board" | "account", scope?: string) => Promise<EnrollmentIdentity>;
  read: (identity: EnrollmentIdentity) => Promise<string | null>;
  publish: (identity: EnrollmentIdentity, text: string) => Promise<void>;
  /** Recheck the target's current Drive ACL, rather than trusting its requested role. */
  roleForEmail: (identity: EnrollmentIdentity, email: string) => Promise<ManifestRole | null>;
}) {
  const epochs = storageManifestEpochs(options.storage);
  const slot = (id: EnrollmentIdentity) => `${id.kind}:${id.scope}`;
  const device = (id: EnrollmentIdentity) => (options.getKey ?? ensureDeviceKey)(`${id.kind}-device:${id.scope}`);
  const authority = (id: EnrollmentIdentity) => (options.getKey ?? ensureDeviceKey)(`${id.kind}-authority:${id.scope}`);
  async function pin(id: EnrollmentIdentity, publicKey: DevicePublicKey, manifest: BoardPermissionManifest) {
    const result = await options.storage.get(PIN_KEY);
    const pins = (result[PIN_KEY] ?? {}) as Record<string, AuthorityPin>;
    const fingerprint = await publicKeyFingerprint(publicKey);
    if (pins[slot(id)] && pins[slot(id)].authorityKeyId !== fingerprint) throw new Error("Authority already pinned; rotation requires a separate recovery procedure");
    await acceptManifest(manifest, epochs, Date.now());
    await options.storage.set({ [PIN_KEY]: { ...pins, [slot(id)]: { kind: id.kind, scope: id.scope, authorityKeyId: fingerprint, authorityPublicKey: publicKey, pinnedAt: Date.now() } } });
    if (id.kind === "board" && id.role === "owner") {
      const pending = await options.storage.get("pboardEnrollmentAttestations");
      await options.storage.set({ pboardEnrollmentAttestations: { ...(pending.pboardEnrollmentAttestations as object ?? {}), [id.scope]: manifest.epoch } });
    }
  }
  function assertBinding(id: EnrollmentIdentity, manifest: BoardPermissionManifest) {
    if (manifest.boardId !== id.boardId || manifest.driveProjectFileId !== id.driveProjectFileId || manifest.driveFolderId !== id.driveFolderId) throw new Error("Enrollment manifest belongs to another board/account or Drive binding");
  }
  async function write(id: EnrollmentIdentity, devices: BoardPermissionManifest["devices"], epoch: number) {
    const key = await authority(id); const now = Date.now();
    const manifest: BoardPermissionManifest = { protocol: 2, boardId: id.boardId, driveProjectFileId: id.driveProjectFileId,
      driveFolderId: id.driveFolderId, authorityKeyId: key.keyId, epoch, issuedAt: now, expiresAt: now + 300_000, devices };
    const signed = await signManifest(manifest, key);
    await options.publish(id, JSON.stringify(signed));
    await pin(id, key.publicJwk, manifest);
    return { format: "pboard-enrollment-v1" as const, authority: key.publicJwk, manifest: signed };
  }
  async function initialize(kind: "board" | "account", scope?: string) {
    const id = await options.identity(kind, scope);
    if (id.role !== "owner") throw new Error("Only the account/board owner may initialize or renew its authority");
    const own = await device(id); const key = await authority(id);
    const existing = await options.read(id);
    let devices = [{ deviceKeyId: own.keyId, publicKey: own.publicJwk, role: "owner" as ManifestRole }];
    let epoch = 1;
    if (existing) {
      const manifest = await verifyManifest(parseStrictJson(existing), key.publicJwk, key.keyId);
      assertBinding(id, manifest);
      devices = manifest.devices;
      if (!devices.some(d => d.deviceKeyId === own.keyId && d.role === "owner")) throw new Error("This device is not an enrolled authority owner");
      epoch = manifest.epoch + 1;
    }
    return write(id, devices, epoch);
  }
  async function request(kind: "board" | "account", scope?: string): Promise<DeviceRequest> {
    const id = await options.identity(kind, scope); const own = await device(id);
    const payload = { ...id, deviceKeyId: own.keyId, publicKey: own.publicJwk, expiresAt: Date.now() + 3600_000, nonce: crypto.randomUUID() };
    return { payload, signature: await signBytes(await importSigningKey(own.privateJwk), signedBytes(REQUEST_DOMAIN, payload as unknown as Json)) };
  }
  async function approve(raw: string, independentlyVerifiedDeviceFingerprint: string, independentlyVerifiedEmail: string): Promise<EnrollmentBundle> {
    const req = parseStrictJson(raw) as unknown as DeviceRequest;
    if (!independentlyVerifiedEmail || !req?.payload || req.payload.email !== independentlyVerifiedEmail.trim().toLowerCase()) throw new Error("Verify the requesting Google account email independently of the request");
    if (!req?.payload || !["board", "account"].includes(req.payload.kind) || !Number.isSafeInteger(req.payload.expiresAt) || req.payload.deviceKeyId !== independentlyVerifiedDeviceFingerprint.trim() ||
        await publicKeyFingerprint(req.payload.publicKey) !== req.payload.deviceKeyId || req.payload.expiresAt <= Date.now() ||
        req.payload.expiresAt > Date.now() + 3600_000 || !await verifyBytes(req.payload.publicKey, req.signature, signedBytes(REQUEST_DOMAIN, req.payload as unknown as Json))) {
      throw new Error("Invalid, expired or unverified device enrollment request");
    }
    const id = await options.identity(req.payload.kind, req.payload.scope);
    if (id.role !== "owner") throw new Error("Only the authority owner may approve another device");
    if (req.payload.boardId !== id.boardId || req.payload.driveProjectFileId !== id.driveProjectFileId || req.payload.driveFolderId !== id.driveFolderId || req.payload.scope !== id.scope) throw new Error("Request binding mismatch");
    const role = await options.roleForEmail(id, req.payload.email);
    if (!role || (id.kind === "account" && req.payload.email !== id.email)) throw new Error("Requested device has no verified Drive/account access");
    const key = await authority(id); const rawManifest = await options.read(id);
    if (!rawManifest) throw new Error("Initialize the authority first");
    const manifest = await verifyManifest(parseStrictJson(rawManifest), key.publicJwk, key.keyId);
    assertBinding(id, manifest);
    if (!manifestIsCurrent(manifest, Date.now())) throw new Error("Renew the authority before approving devices");
    const devices = manifest.devices.filter(d => d.deviceKeyId !== req.payload.deviceKeyId);
    devices.push({ deviceKeyId: req.payload.deviceKeyId, publicKey: req.payload.publicKey, role });
    return write(id, devices, manifest.epoch + 1);
  }
  async function trust(raw: string, independentlyVerifiedAuthorityFingerprint: string) {
    const bundle = parseStrictJson(raw) as unknown as EnrollmentBundle;
    if (bundle?.format !== "pboard-enrollment-v1" || await publicKeyFingerprint(bundle.authority) !== independentlyVerifiedAuthorityFingerprint.trim()) throw new Error("Authority fingerprint was not independently verified");
    const manifest = await verifyManifest(bundle.manifest, bundle.authority, independentlyVerifiedAuthorityFingerprint.trim());
    const kind = manifest.boardId.startsWith("account:") ? "account" : "board";
    const id = await options.identity(kind, kind === "board" ? manifest.boardId : undefined);
    assertBinding(id, manifest);
    const own = await device(id);
    const membership = manifest.devices.find(d => d.deviceKeyId === own.keyId);
    if (!membership || membership.role !== id.role || await publicKeyFingerprint(membership.publicKey) !== own.keyId) throw new Error("Manifest does not authorize this device with its current Drive role");
    await pin(id, bundle.authority, manifest);
    return manifest;
  }
  async function exported(kind: "board" | "account", scope?: string): Promise<EnrollmentBundle> {
    const id = await options.identity(kind, scope); const stored = await options.storage.get(PIN_KEY);
    const trusted = (stored[PIN_KEY] as Record<string, AuthorityPin> | undefined)?.[slot(id)];
    if (!trusted) throw new Error("No verified authority pin; enroll this device first");
    const raw = await options.read(id); if (!raw) throw new Error("Manifest unavailable");
    const manifest = await verifyManifest(parseStrictJson(raw), trusted.authorityPublicKey, trusted.authorityKeyId);
    assertBinding(id, manifest); await acceptManifest(manifest, epochs, Date.now());
    return { format: "pboard-enrollment-v1", authority: trusted.authorityPublicKey, manifest: parseStrictJson(raw) as unknown as SignedManifest };
  }
  async function grants(boardId: string) {
    const bundles = await Promise.all([exported("board", boardId), exported("account")]);
    const rooms: Record<string, Record<string, { publicKey: DevicePublicKey; expiresAt: number }>> = {};
    for (const bundle of bundles) {
      const m = bundle.manifest.payload;
      const topics = m.boardId.startsWith("account:") ? [`pboard-account-${m.boardId.slice(8)}-order`] : [`pboard-collab-${m.boardId}-cards`, `pboard-collab-${m.boardId}-projects`];
      for (const topic of topics) rooms[topic] = Object.fromEntries(m.devices.map(d => [d.deviceKeyId, { publicKey: d.publicKey, expiresAt: m.expiresAt }]));
    }
    return { rooms };
  }
  return { initialize, request, approve, trust, exported, grants };
}
