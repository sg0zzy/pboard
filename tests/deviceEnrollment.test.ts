import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createDeviceEnrollment, type EnrollmentIdentity } from "../src/collab/security/enrollment";
import { generateDeviceKey, publicKeyFingerprint, ensureDeviceKey, saveDeviceKey, type StoredDeviceKey } from "../src/collab/security/keys";
import { verifyManifest } from "../src/collab/security/manifest";
import type { KeyValueStorage } from "../src/storage/repository";
function storage(): KeyValueStorage {
  const data: Record<string, unknown> = {};
  return { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => { Object.assign(data, structuredClone(value)); } };
}
function keys() {
  const entries = new Map<string, Promise<StoredDeviceKey>>();
  return (purpose: string) => { if (!entries.has(purpose)) entries.set(purpose, generateDeviceKey()); return entries.get(purpose)!; };
}
function setup() {
  const manifests = new Map<string, string>();
  const ownerEmail = "owner@example.test";
  const members = new Map([[ownerEmail, "owner" as const], ["editor@example.test", "editor" as const]]);
  function client(email: string) {
    const local = storage();
    const enrollment = createDeviceEnrollment({ storage: local, getKey: keys(),
      identity: async (kind, scope) => {
        const account = email === ownerEmail ? "owner-hash" : "editor-hash";
        if (kind === "account" && scope && scope !== account) throw new Error("Another account");
        if (kind === "board" && scope !== "board") throw new Error("Another board");
        return { kind, scope: kind === "account" ? account : "board", boardId: kind === "account" ? `account:${account}` : "board", driveProjectFileId: kind === "account" ? "" : "file", driveFolderId: kind === "account" ? "" : "folder", email, role: kind === "account" ? "owner" : members.get(email)! } as EnrollmentIdentity;
      },
      read: async id => manifests.get(id.boardId) ?? null,
      publish: async (id, text) => { manifests.set(id.boardId, text); },
      roleForEmail: async (id, email) => id.kind === "account" ? (id.email === email ? "owner" : null) : members.get(email) ?? null
    });
    return { enrollment, local };
  }
  return { client, manifests, members };
}
describe("explicit signed enrollment", () => {
  it("initializes, verifies possession, approves a Drive-authorized device and requires an independent authority fingerprint", async () => {
    const { client } = setup(); const owner = client("owner@example.test"); const editor = client("editor@example.test");
    const initial = await owner.enrollment.initialize("board", "board");
    const request = await editor.enrollment.request("board", "board");
    await expect(owner.enrollment.approve(JSON.stringify(request), "wrong", "editor@example.test")).rejects.toThrow(/unverified/);
    await expect(owner.enrollment.approve(JSON.stringify(request), request.payload.deviceKeyId, "owner@example.test")).rejects.toThrow(/email/);
    const bundle = await owner.enrollment.approve(JSON.stringify(request), request.payload.deviceKeyId, "editor@example.test");
    expect(bundle.manifest.payload.devices.find(d => d.deviceKeyId === request.payload.deviceKeyId)?.role).toBe("editor");
    await expect(editor.enrollment.trust(JSON.stringify(bundle), "wrong")).rejects.toThrow(/fingerprint/);
    const accepted = await editor.enrollment.trust(JSON.stringify(bundle), initial.manifest.payload.authorityKeyId);
    expect(accepted.epoch).toBe(2);
    const stored = await editor.local.get("pboardSecurityPins");
    expect(JSON.stringify(stored)).not.toContain('"d":');
    await expect(editor.enrollment.initialize("board", "board")).rejects.toThrow(/owner/);
    await expect(verifyManifest(bundle.manifest, bundle.authority, accepted.authorityKeyId)).resolves.toEqual(accepted);
  });
  it("rejects forged, expired and wrong-board requests without publishing", async () => {
    const { client, manifests } = setup(); const a = client("owner@example.test"); const b = client("editor@example.test");
    await a.enrollment.initialize("board", "board"); const before = manifests.get("board");
    const request = await b.enrollment.request("board", "board");
    for (const changed of [{ ...request, signature: "x" }, { ...request, payload: { ...request.payload, expiresAt: 0 } }, { ...request, payload: { ...request.payload, boardId: "other" } }]) {
      await expect(a.enrollment.approve(JSON.stringify(changed), request.payload.deviceKeyId, "editor@example.test")).rejects.toThrow();
      expect(manifests.get("board")).toBe(before);
    }
  });
  it("rejects removed users and never lets a board owner enroll another user's account", async () => {
    const { client, members } = setup(); const a = client("owner@example.test"); const b = client("editor@example.test");
    await a.enrollment.initialize("board", "board");
    const req = await b.enrollment.request("board", "board"); members.delete("editor@example.test");
    await expect(a.enrollment.approve(JSON.stringify(req), req.payload.deviceKeyId, "editor@example.test")).rejects.toThrow(/access/);
    await a.enrollment.initialize("account"); const accountReq = await b.enrollment.request("account");
    await expect(a.enrollment.approve(JSON.stringify(accountReq), accountReq.payload.deviceKeyId, "editor@example.test")).rejects.toThrow(/account/);
  });
  it("exports only approved exact-room public grants and rejects rollback", async () => {
    const { client } = setup(); const a = client("owner@example.test");
    await a.enrollment.initialize("account"); const first = await a.enrollment.initialize("board", "board");
    await a.enrollment.initialize("board", "board");
    await expect(a.enrollment.trust(JSON.stringify(first), first.manifest.payload.authorityKeyId)).rejects.toThrow(/rollback/);
    const grants = await a.enrollment.grants("board");
    expect(Object.keys(grants.rooms).sort()).toEqual(["pboard-account-owner-hash-order", "pboard-collab-board-cards", "pboard-collab-board-projects"]);
    expect(JSON.stringify(grants)).not.toContain('"d":');
  });
});
it("preserves device identity across reloads and repairs legacy purpose slots without replacing private keys", async () => {
  const purpose = `test:${crypto.randomUUID()}`;
  const first = await ensureDeviceKey(purpose); const second = await ensureDeviceKey(purpose);
  expect(second.keyId).toBe(await publicKeyFingerprint(first.publicJwk));
  expect(second.privateJwk).toEqual(first.privateJwk);
  await saveDeviceKey({ ...first, keyId: `purpose:${purpose}` });
  const repaired = await ensureDeviceKey(purpose);
  expect(repaired.keyId).toBe(first.keyId); expect(repaired.privateJwk).toEqual(first.privateJwk);
});
