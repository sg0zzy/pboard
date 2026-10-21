import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { createExperimentalWebSocketSignaling } from "../src/collab/experimentalWebSocketSignaling";
import { selectRuntimeSignaling } from "../src/collab/signalingSelection";
import { generateDeviceKey, type StoredDeviceKey } from "../src/collab/security/keys";
import type { PboardSignaling } from "../src/collab/signaling";
import { signManifest } from "../src/collab/security/manifest";
import { prepareRelayAdmission, type RelayAuthorization } from "../src/collab/security/relayAdmission";
import { buildPresence, buildSignedSignal } from "../src/collab/security/session";
import { SDP } from "./signalingFixtures";

it("keeps Drive default and ignores experimental flags in production", () => {
  const drive = vi.fn(() => ({}) as PboardSignaling);
  vi.stubEnv("DEV", false); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket");
  expect(selectRuntimeSignaling("anything", drive)).toBe(drive.mock.results[0].value);
  vi.unstubAllEnvs();
});

describe.skipIf(!existsSync(resolve("services/pboard-signaling/target/debug/pboard-signaling")))("automatic signed relay admission", () => {
  let child: ChildProcess, folder: string, url: string, port: number;
  let authority: StoredDeviceKey, a: StoredDeviceKey, b: StoredDeviceKey, proof: RelayAuthorization;
  const providers: PboardSignaling[] = [];
  let enabled = true;
  async function start() {
    child = spawn(resolve("services/pboard-signaling/target/debug/pboard-signaling"), { env: { ...process.env,
      PBOARD_SIGNALING_BIND: `127.0.0.1:${port}`, PBOARD_SIGNALING_GRANTS: join(folder, "grants.json"), PBOARD_SIGNALING_AUTOMATIC_ADMISSION: enabled ? "1" : "0" }, stdio: "ignore" });
    await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true));
  }
  async function stop() { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  async function authorization(root: StoredDeviceKey): Promise<RelayAuthorization> {
    const now = Date.now();
    return { authority: root.publicJwk, manifest: await signManifest({ protocol: 2, boardId: "auto-board", driveProjectFileId: "file", driveFolderId: "folder",
      authorityKeyId: root.keyId, epoch: 1, issuedAt: now, expiresAt: now + 60_000,
      devices: [a, b].map((key, i) => ({ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: i === 0 ? "owner" : "editor" })) }, root) };
  }
  function provider(key: StoredDeviceKey, credentials = proof) {
    const p = createExperimentalWebSocketSignaling({ topic: "pboard-collab-auto-board-cards", url, getKey: async () => key,
      getAuthorization: async () => credentials, loopbackDevelopment: true });
    providers.push(p); return p;
  }
  beforeAll(async () => {
    [authority, a, b] = await Promise.all([generateDeviceKey(), generateDeviceKey(), generateDeviceKey()]);
    proof = await authorization(authority);
    const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
    folder = await mkdtemp(join(tmpdir(), "pboard-auto-relay-test-")); url = `ws://127.0.0.1:${port}/ws`;
    await writeFile(join(folder, "grants.json"), '{"rooms":{}}'); await start();
  });
  afterAll(async () => { await Promise.all(providers.map(p => p.leave())); await stop(); await rm(folder, { recursive: true, force: true }); });
  it("uses WebCrypto-signed manifests with empty server grants and reconnects after restart", async () => {
    const first = provider(a), second = provider(b); let peersA: string[] = [], peersB: string[] = [];
    const received = vi.fn(); second.onSignal(received);
    await first.join(p => { peersA = p; }); await second.join(p => { peersB = p; });
    await vi.waitFor(() => expect(peersA).toEqual([b.keyId]));
    const presenceA = vi.fn(), presenceB = vi.fn();
    first.onPresence!(presenceA); second.onPresence!(presenceB);
    for (const [provider,key,session] of [[first,a,"logical-a"],[second,b,"logical-b"]] as const) {
      await provider.publishPresence!({ manifest: proof.manifest.payload, presence: await buildPresence({ privateJwk: key.privateJwk, deviceKeyId: key.keyId }, { manifest: proof.manifest.payload, boardId:"auto-board", collection:"cards", ownSessionId:session, now:Date.now() }) });
    }
    await vi.waitFor(() => { expect(presenceA).toHaveBeenCalled(); expect(presenceB).toHaveBeenCalled(); });
    const envelope = await buildSignedSignal({privateJwk:a.privateJwk,deviceKeyId:a.keyId},{manifest:proof.manifest.payload,boardId:"auto-board",collection:"cards",ownSessionId:"logical-a",now:Date.now()},{deviceKeyId:b.keyId,sessionId:"logical-b"},{type:"offer",sdp:SDP},0);
    await first.sendSignal(b.keyId, envelope);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(a.keyId, envelope));
    await stop(); await start();
    await vi.waitFor(() => { expect(peersA).toEqual([b.keyId]); expect(peersB).toEqual([a.keyId]); }, { timeout: 10_000 });
    const rogueProof = await authorization(await generateDeviceKey());
    const rogue = provider(a, rogueProof); let roguePeers: string[] = [];
    await rogue.join(p => { roguePeers = p; });
    expect(roguePeers).toEqual([]); expect(peersB).toEqual([a.keyId]);
    await expect(rogue.sendSignal(b.keyId, { type: "offer" })).rejects.toThrow();
    await Promise.all([first.leave(), second.leave(), rogue.leave()]);
  }, 15_000);
  it("rejects mismatched topics, private fields and unenrolled keys before transport", async () => {
    await expect(prepareRelayAdmission("pboard-account-auto-board-order", proof, a.keyId)).rejects.toThrow("topic");
    await expect(prepareRelayAdmission("pboard-collab-auto-board-cards", proof, (await generateDeviceKey()).keyId)).rejects.toThrow("enrolled");
    await expect(prepareRelayAdmission("pboard-collab-auto-board-cards", { ...proof, authority: { ...proof.authority, d: "private" } as never }, a.keyId)).rejects.toThrow("public key");
    await expect(provider(a, { ...proof, manifest: { ...proof.manifest, signature: "forged" } }).join(() => {})).rejects.toThrow();
  });
  it("refuses automatic downgrade to an operator-only relay", async () => {
    await stop(); enabled = false; await start();
    await expect(provider(a).join(() => {})).rejects.toThrow("no insecure downgrade");
  });
});
it("requires an explicit development endpoint", () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket"); vi.stubEnv("VITE_PBOARD_SIGNALING_WS_URL", "");
  expect(() => selectRuntimeSignaling("pboard-collab-board-cards", () => ({}) as PboardSignaling)).toThrow("requires");
  vi.unstubAllEnvs();
});
it("rejects non-loopback plaintext and embedded credentials", () => {
  const getKey = generateDeviceKey;
  expect(() => createExperimentalWebSocketSignaling({ topic: "room", url: "ws://example.com/ws", getKey, loopbackDevelopment: true })).toThrow();
  expect(() => createExperimentalWebSocketSignaling({ topic: "room", url: "wss://u:p@example.com/ws", getKey })).toThrow();
});

const binary = resolve("services/pboard-signaling/target/debug/pboard-signaling");
describe.skipIf(!existsSync(binary))("TypeScript provider against real Rust service", () => {
  let first: StoredDeviceKey; let second: StoredDeviceKey;
  let child: ChildProcess; let folder: string; let port: number; let url: string;
  const providers: PboardSignaling[] = [];
  async function start() {
    child = spawn(binary, { env: { ...process.env, PBOARD_SIGNALING_BIND: `127.0.0.1:${port}`, PBOARD_SIGNALING_GRANTS: join(folder, "grants.json") }, stdio: "ignore" });
    await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true));
  }
  async function stop() { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  function provider(key: StoredDeviceKey) {
    const value = createExperimentalWebSocketSignaling({ topic: "test-room", url, getKey: async () => key, loopbackDevelopment: true });
    providers.push(value); return value;
  }
  beforeAll(async () => {
    [first, second] = await Promise.all([generateDeviceKey(), generateDeviceKey()]);
    const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
    url = `ws://127.0.0.1:${port}/ws`; folder = await mkdtemp(join(tmpdir(), "pboard-ws-test-"));
    await writeFile(join(folder, "grants.json"), JSON.stringify({ rooms: { "test-room": Object.fromEntries([first, second].map(k => [k.keyId, { publicKey: k.publicJwk, expiresAt: Date.now() + 60_000 }])) } }));
    await start();
  });
  afterAll(async () => { await Promise.all(providers.map(p => p.leave())); await stop(); await rm(folder, { recursive: true, force: true }); });
  it("authenticates with existing WebCrypto keys, forwards valid negotiation, and rejoins after restart", async () => {
    const a = provider(first); const b = provider(second);
    let rosterA: string[] = []; let rosterB: string[] = [];
    const receive = vi.fn(); b.onSignal(receive);
    await a.join(p => { rosterA = p; }); await b.join(p => { rosterB = p; });
    await vi.waitFor(() => expect(rosterA).toEqual([second.keyId]));
    const envelope = { type: "offer", sdp: SDP };
    await a.sendSignal(second.keyId, envelope);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(first.keyId, envelope));
    await stop(); await start();
    await vi.waitFor(() => { expect(rosterA).toEqual([second.keyId]); expect(rosterB).toEqual([first.keyId]); }, { timeout: 10_000 });
    await a.sendSignal(second.keyId, { type: "answer", sdp: SDP });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
  }, 15_000);
});
