import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { generateDeviceKey, signWithStored, verifyBytes, publicKeyFingerprint, ensureDeviceKey } from "../src/collab/security/keys";
import { canonicalize, signedBytes, DOMAIN_SIGNAL, parseStrictJson } from "../src/collab/security/canonical";
import { signManifest, verifyManifest, acceptManifest, createInMemoryManifestEpochStore, manifestAcceptedAndCurrent, manifestHash } from "../src/collab/security/manifest";

describe("canonical serialization", () => {
  it("produces stable sorted canonical JSON with strict number formatting", () => {
    const value = { b: 2, a: [1, -0.5, 'x"y\u00e9'], c: { z: true, a: null } };
    const canonical = canonicalize(value);
    expect(canonical).toBe('{"a":[1,-0.5,"x\\"y\\u00e9"],"b":2,"c":{"a":null,"z":true}}');
    expect(canonicalize(JSON.parse(canonical))).toBe(canonical);
    expect(() => canonicalize({ a: NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(canonicalize({ n: 5e-7 })).toBe('{"n":5e-7}');
  });

  it("rejects duplicate JSON members including escape-colliding keys", () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/Duplicate/);
    expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow(/Duplicate/);
    expect(() => parseStrictJson('{"a":{"a":1}}')).not.toThrow();
    expect(() => parseStrictJson("[" + "[".repeat(17) + "]".repeat(17) + "]")).toThrow(/nesting/);
    expect(() => parseStrictJson('{"a":1e999}')).toThrow(/Non-finite/);
    expect(parseStrictJson('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });

  it("signing prefix derives domain + length + canonical bytes", () => {
    const bytes = signedBytes(DOMAIN_SIGNAL, { n: 1 });
    expect(new TextDecoder().decode(bytes.subarray(0, 16))).toBe("pboard-signal-v2");
    expect(() => signedBytes(DOMAIN_SIGNAL, { pad: "x".repeat(70000) })).toThrow(/exceeds/);
  });
});

describe("device keys", () => {
  it("generates P-256 keys with canonical-JWK fingerprints; signatures verify and fail closed", async () => {
    const key = await generateDeviceKey();
    expect(key.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await publicKeyFingerprint(key.publicJwk)).toBe(key.keyId);

    const bytes = new TextEncoder().encode("test message");
    const signature = await signWithStored(key, bytes);
    expect(await verifyBytes(key.publicJwk, signature, bytes)).toBe(true);
    expect(await verifyBytes(key.publicJwk, signature, new TextEncoder().encode("test messagX"))).toBe(false);
    expect(await verifyBytes((await generateDeviceKey()).publicJwk, signature, bytes)).toBe(false);
    expect(await verifyBytes(key.publicJwk, "not-a-signature", bytes)).toBe(false);
    expect(await verifyBytes(key.publicJwk, signature + "!", bytes)).toBe(false);
  });

  it("fingerprint is independent of JWK member order; signature follows the key", async () => {
    const key = await generateDeviceKey();
    const bytes = new TextEncoder().encode("deterministic vector");
    const signature = await signWithStored(key, bytes);
    // Canonical form is independent of member insertion order.
    const reordered = { y: key.publicJwk.y, crv: "P-256" as const, kty: "EC" as const, x: key.publicJwk.x };
    expect(await verifyBytes(reordered, signature, bytes)).toBe(true);
    expect(await publicKeyFingerprint(reordered)).toBe(key.keyId);
  });

  it("ensureDeviceKey reuses the stored key per purpose", async () => {
    const first = await ensureDeviceKey("board-authority:test-board");
    const second = await ensureDeviceKey("board-authority:test-board");
    expect(second.publicJwk).toEqual(first.publicJwk);
    const other = await ensureDeviceKey("board-authority:other-board");
    expect(other.keyId).not.toBe(first.keyId);
  });
});

describe("permission manifests", () => {
  const context = { boardId: "board-1", driveProjectFileId: "file-1", driveFolderId: "folder-1" };
  const now = 1_000_000;

  async function authorityKey() {
    return ensureDeviceKey("board-authority:manifest-test");
  }

  async function deviceEntry(key: Awaited<ReturnType<typeof ensureDeviceKey>>, role: "owner" | "editor" | "viewer") {
    // Manifest device ids are raw fingerprints; the purpose-slot id is a local
    // storage concern and never enters the wire format.
    return { deviceKeyId: await publicKeyFingerprint(key.publicJwk), publicKey: key.publicJwk, role };
  }

  async function baseManifest(authority: Awaited<ReturnType<typeof ensureDeviceKey>>) {
    return {
      protocol: 2 as const,
      boardId: context.boardId,
      driveProjectFileId: context.driveProjectFileId,
      driveFolderId: context.driveFolderId,
      authorityKeyId: await publicKeyFingerprint(authority.publicJwk),
      epoch: 1,
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
      devices: [await deviceEntry(authority, "owner")]
    };
  }

  it("verifies an authority-signed manifest and rejects tampering", async () => {
    const authority = await authorityKey();
    const signed = await signManifest(await baseManifest(authority), authority);
    const verified = await verifyManifest(signed, authority.publicJwk, await publicKeyFingerprint(authority.publicJwk));
    expect(verified.epoch).toBe(1);
    expect(verified.devices[0].role).toBe("owner");

    // Tampered payload
    const tampered = { ...signed, payload: { ...signed.payload, epoch: 2 } };
    await expect(verifyManifest(tampered, authority.publicJwk, await publicKeyFingerprint(authority.publicJwk))).rejects.toThrow(/signature|authority/);
    // Signature from a different authority
    const impostor = await ensureDeviceKey("board-authority:manifest-impostor");
    const impostorSigned = await signManifest(await baseManifest(impostor), impostor);
    await expect(verifyManifest(impostorSigned, authority.publicJwk, await publicKeyFingerprint(authority.publicJwk))).rejects.toThrow(/pinned authority|signature/);
    // Wrong version
    await expect(verifyManifest({ ...signed, payload: { ...signed.payload, protocol: 3 } }, authority.publicJwk, await publicKeyFingerprint(authority.publicJwk)))
      .rejects.toThrow(/protocol/i);
  });

  it("rejects structurally invalid manifests: roles, duplicate keys, no owner, oversize", async () => {
    const authority = await authorityKey();
    const editor = await ensureDeviceKey("device:manifest-editor");
    const withDuplicate: any = await baseManifest(authority);
    withDuplicate.devices.push(await deviceEntry(editor, "editor"), await deviceEntry(editor, "viewer"));
    await expect(signManifest(withDuplicate, authority)).rejects.toThrow(/twice/);
    const noRole: any = await baseManifest(authority);
    noRole.devices = [await deviceEntry(editor, "admin" as never)];
    await expect(signManifest(noRole, authority)).rejects.toThrow(/role/);
    const noOwner: any = await baseManifest(authority);
    noOwner.devices = [await deviceEntry(editor, "editor")];
    await expect(signManifest(noOwner, authority)).rejects.toThrow(/owner/);
    const tooLong = { ...(await baseManifest(authority)), expiresAt: now + 60 * 60_000 };
    await expect(signManifest(tooLong, authority)).rejects.toThrow(/lifetime/);
  });

  it("enforces anti-rollback and same-epoch conflict rules", async () => {
    const authority = await authorityKey();
    const pin = await publicKeyFingerprint(authority.publicJwk);
    const store = createInMemoryManifestEpochStore();
    const firstManifest = await verifyManifest(await signManifest(await baseManifest(authority), authority), authority.publicJwk, pin);
    await acceptManifest(firstManifest, store, now);
    // Rollback (lower epoch) rejected.
    const older: any = await baseManifest(authority);
    older.epoch = 0;
    await expect(acceptManifest(older, store, now)).rejects.toThrow(/rollback/);
    // Same-epoch conflicting payload rejected.
    const forked: any = JSON.parse(JSON.stringify(await baseManifest(authority)));
    forked.expiresAt = forked.expiresAt + 1;
    await expect(acceptManifest(forked, store, now)).rejects.toThrow(/same epoch/);
    // Current-time check consults the store too.
    const signed = await verifyManifest(await signManifest(await baseManifest(authority), authority), authority.publicJwk, pin);
    expect(await manifestAcceptedAndCurrent(signed, store, now)).toBe(true);
    expect(await manifestAcceptedAndCurrent(signed, store, now + 6 * 60_000)).toBe(false);
    expect(manifestHash(signed)).not.toBe(manifestHash({ ...signed, epoch: 2 }));
  });
});

it('counts JSON nesting outside quoted chunk/content strings while preserving the depth limit', () => {
  for (const text of ['}', '{{{{{{{{{{{{{{{{{{{{{{{{{{', 'escaped \\" quote and \\ slash } ][']) {
    const value = { data: text, nested: [{ literal: '}' }] };
    expect(parseStrictJson(JSON.stringify(value))).toEqual(value);
  }
  const deep = '{"padding":"' + '}'.repeat(30) + '","nested":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}';
  expect(() => parseStrictJson(deep)).toThrow(/nesting/);
});
