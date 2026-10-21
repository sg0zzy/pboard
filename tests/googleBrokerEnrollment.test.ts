import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createGoogleBrokerEnrollment, googleBrokerEnabled, googleBrokerPermissionOrigin } from "../src/collab/googleBrokerEnrollment";
import { generateDeviceKey, signBytes, importSigningKey, publicKeyFingerprint, verifyBytes } from "../src/collab/security/keys";
import { signManifest, type SignedManifest } from "../src/collab/security/manifest";
import { createMutationReplayCache, signMutation, verifyMutation } from "../src/collab/security/mutation";
import { collaborationDiagnostics } from "../src/collab/diagnostics";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture(canAccessEndpoint?: (origin: string) => Promise<boolean>) {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket"); vi.stubEnv("VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT", "1");
  vi.stubEnv("VITE_PBOARD_SIGNALING_WS_URL", "wss://relay.example.test/ws");
  vi.spyOn(console, "info").mockImplementation(() => {});
  const authority = await generateDeviceKey(); vi.stubEnv("VITE_PBOARD_SIGNALING_AUTHORITY", JSON.stringify(authority.publicJwk));
  const state: Record<string, any> = { pboardSecurityPins: { existing: "preserve" }, pboardManifestEpochs: { existing: { epoch: 99 } } };
  const storage = { get: async (key: string) => ({ [key]: state[key] }), set: async (values: object) => { Object.assign(state, values); } };
  let alter = (value: any) => value; let epoch = 1; let signed: SignedManifest | undefined;
  const fetcher = vi.fn(async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    // Reproduce the receiver requirement hidden by arrow-function HTTP doubles.
    expect(this).toBeUndefined();
    const url = new URL(String(input)); expect(url.origin).toBe("https://relay.example.test");
    if (url.pathname.endsWith("challenge")) { expect((init?.headers as any).Authorization).toBeUndefined(); return Response.json({ challenge: "c".repeat(43) }); }
    const req = JSON.parse(String(init?.body)); expect((init?.headers as any).Authorization).toBe("Bearer transient-token");
    const keyId = await publicKeyFingerprint(req.publicKey);
    expect(await verifyBytes(req.publicKey, req.signature, new TextEncoder().encode(JSON.stringify(["pboard-google-enroll-v1", req.challenge, keyId, req.kind, req.scope, req.driveProjectFileId, req.driveFolderId])))).toBe(true);
    signed = await signManifest({ protocol: 2, boardId: req.kind === "account" ? `account:${req.scope}` : req.scope, driveProjectFileId: req.driveProjectFileId, driveFolderId: req.driveFolderId,
      authorityKeyId: authority.keyId, epoch, issuedAt: Date.now(), expiresAt: Date.now() + 300_000, devices: [{ deviceKeyId: keyId, publicKey: req.publicKey, role: "owner" }] }, authority);
    return Response.json(await alter({ authority: authority.publicJwk, manifest: signed, history: [signed], deviceKeyId: keyId }));
  });
  const broker = createGoogleBrokerEnrollment({ storage, getAccessToken: async () => "transient-token", fetcher, canAccessEndpoint });
  const id = { kind: "board" as const, scope: crypto.randomUUID(), file: "file", folder: "folder", role: "owner" as const };
  return { broker, id, state, fetcher, authority, alter: (fn: typeof alter) => { alter = fn; }, setEpoch: (n: number) => { epoch = n; } };
}
it("pins the build authority, verifies the signed challenge and isolates manual pins/epochs", async () => {
  const f = await fixture(); const security = await f.broker.security(f.id);
  expect(security.manifest.devices).toHaveLength(1); expect(security.manifestHistory?.size).toBe(1);
  expect(f.state.pboardSecurityPins).toEqual({ existing: "preserve" }); expect(f.state.pboardManifestEpochs.existing.epoch).toBe(99);
  expect(JSON.stringify(f.state)).not.toContain("transient-token");
  expect(Object.keys(f.state.pboardManifestEpochs).some(slot => slot.startsWith("broker:"))).toBe(true);
});
it("fails before sending credentials without an explicit public authority pin or in ordinary builds", async () => {
  const f = await fixture(); vi.stubEnv("VITE_PBOARD_SIGNALING_AUTHORITY", "");
  await expect(f.broker.security(f.id)).rejects.toThrow(/pinned enrollment authority/); expect(f.fetcher).not.toHaveBeenCalled();
  vi.stubEnv("DEV", false); expect(googleBrokerEnabled()).toBe(false);
  await expect(f.broker.security(f.id)).rejects.toThrow(/disabled/);
});
it("reports the failing stage without logging network errors or credentials", async () => {
  const f = await fixture(); collaborationDiagnostics.clear();
  f.fetcher.mockRejectedValueOnce(new TypeError("PRIVATE_ERROR_PAYLOAD"));
  await expect(f.broker.security(f.id)).rejects.toThrow("PRIVATE_ERROR_PAYLOAD");
  const events = collaborationDiagnostics.snapshot();
  expect(events.at(-1)?.event).toBe("google.board.failed.challenge");
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_ERROR_PAYLOAD|transient-token/);
  collaborationDiagnostics.clear();
});
it("checks signaling host access before HTTP or credentials and recovers after a grant", async () => {
  let granted = false;
  const permission = vi.fn(async (origin: string) => { expect(origin).toBe("https://relay.example.test/*"); return granted; });
  const f = await fixture(permission); collaborationDiagnostics.clear();
  await expect(f.broker.security(f.id)).rejects.toThrow(/browser permission.*Connect \/ reconnect/);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(collaborationDiagnostics.snapshot().at(-1)?.event).toBe("google.board.failed.host_permission");
  expect(f.state.pboardSecurityPins).toEqual({ existing: "preserve" });
  granted = true;
  await expect(f.broker.security(f.id)).resolves.toBeTruthy();
  expect(permission).toHaveBeenCalledTimes(2);
});
it("uses the same hostname match pattern as the manifest for loopback development ports", async () => {
  await fixture(); vi.stubEnv("VITE_PBOARD_SIGNALING_WS_URL", "ws://127.0.0.1:8787/ws");
  expect(googleBrokerPermissionOrigin()).toBe("http://127.0.0.1/*");
});
it("rejects forged authority, signature, binding, expiry and role instead of overwriting trust", async () => {
  for (const corrupt of [
    async (body: any) => ({ ...body, authority: (await generateDeviceKey()).publicJwk }),
    (body: any) => ({ ...body, manifest: { ...body.manifest, signature: "forged" } }),
    (body: any) => ({ ...body, manifest: { ...body.manifest, payload: { ...body.manifest.payload, driveFolderId: "wrong" } } })
  ]) {
    const f = await fixture(); f.alter(corrupt); await expect(f.broker.security(f.id)).rejects.toThrow();
    expect(f.state.pboardSecurityPins).toEqual({ existing: "preserve" });
  }
  const f = await fixture(); await expect(f.broker.security({ ...f.id, role: "viewer" })).rejects.toThrow(/permissions/);
});
it("detects broker epoch changes, rejects rollback, and ignores other boards when polling", async () => {
  const f = await fixture(); await f.broker.security(f.id); f.setEpoch(2);
  expect(await f.broker.poll(f.id.scope, null)).toBe(true);
  f.setEpoch(1); await expect(f.broker.poll(f.id.scope, null)).rejects.toThrow(/rollback/);
  const calls = f.fetcher.mock.calls.length; expect(await f.broker.poll("another-board", null)).toBe(false); expect(f.fetcher.mock.calls).toHaveLength(calls);
});
it("verifies historical signatures after renewal while enforcing current membership, roles and time bounds", async () => {
  const device = await generateDeviceKey(); const now = Date.now();
  const old = { protocol: 2 as const, boardId: "board", driveProjectFileId: "file", driveFolderId: "folder", authorityKeyId: device.keyId, epoch: 1,
    issuedAt: now - 600_000, expiresAt: now - 300_000, devices: [{ deviceKeyId: device.keyId, publicKey: device.publicJwk, role: "owner" as const }] };
  const current = { ...old, epoch: 2, issuedAt: now, expiresAt: now + 300_000 };
  const doc = await signMutation({ id: "card", projectId: "board", content: "offline edit" }, { privateJwk: device.privateJwk, deviceKeyId: device.keyId }, { boardId: "board", collection: "cards", manifest: old, sequence: 1, now: now - 450_000 });
  const context = { boardId: "board", collection: "cards" as const, manifest: current, history: new Map([[1, old], [2, current]]) };
  await expect(verifyMutation(doc, context, createMutationReplayCache())).resolves.toBeTruthy();
  await expect(verifyMutation(doc, { ...context, history: undefined }, createMutationReplayCache())).rejects.toThrow(/epoch/);
  await expect(verifyMutation({ ...doc, content: "forged" }, context, createMutationReplayCache())).rejects.toThrow(/hash/);
  await expect(verifyMutation(doc, { ...context, manifest: { ...current, devices: [] } }, createMutationReplayCache())).rejects.toThrow(/not authorized/);
  await expect(verifyMutation(doc, { ...context, manifest: { ...current, devices: [{ ...current.devices[0], role: "viewer" }] } }, createMutationReplayCache())).rejects.toThrow(/view-only/);
  const late = await signMutation({ id: "card", projectId: "board" }, { privateJwk: device.privateJwk, deviceKeyId: device.keyId }, { boardId: "board", collection: "cards", manifest: old, sequence: 2, now });
  await expect(verifyMutation(late, context, createMutationReplayCache())).rejects.toThrow(/historical/);
});
