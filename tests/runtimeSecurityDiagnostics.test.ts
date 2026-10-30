import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createDriveRuntime } from "../src/sync/runtime";
import { ensureDeviceKey, generateDeviceKey } from "../src/collab/security/keys";
import { signManifest, type BoardPermissionManifest, type SignedManifest } from "../src/collab/security/manifest";
import { hashBlob } from "../src/storage/blobStore";
import type { RxRepository } from "../src/storage/rxdbRepository";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function fixture() {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket");
  vi.stubEnv("VITE_PBOARD_SIGNALING_WS_URL", "wss://relay.example.test/ws");
  const socket = vi.fn(() => { throw Error("A blocked runtime must not open signaling"); });
  vi.stubGlobal("WebSocket", socket);
  const email = `${crypto.randomUUID()}@example.test`;
  const account = await hashBlob(new Blob([email])); const board = crypto.randomUUID();
  const authority = await generateDeviceKey();
  const accountDevice = await ensureDeviceKey(`account-device:${account}`);
  const boardDevice = await ensureDeviceKey(`board-device:${board}`);
  const state: Record<string, any> = { pboardDriveSharedProjects: { [board]: { folderId: "folder", projectFileId: "file", realtimeFolderId: "realtime" } } };
  const storage = { get: async (key: string) => ({ [key]: structuredClone(state[key]) }), set: async (values: Record<string, unknown>) => { Object.assign(state, structuredClone(values)); } };
  function payload(kind: "account" | "board"): BoardPermissionManifest {
    const d = kind === "account" ? accountDevice : boardDevice; const now = Date.now();
    return { protocol: 2, boardId: kind === "account" ? `account:${account}` : board,
      driveProjectFileId: kind === "account" ? "" : "file", driveFolderId: kind === "account" ? "" : "folder",
      authorityKeyId: authority.keyId, epoch: 1, issuedAt: now, expiresAt: now + 300_000,
      devices: [{ deviceKeyId: d.keyId, publicKey: d.publicJwk, role: "owner" }] };
  }
  let accountManifest: SignedManifest | null = await signManifest(payload("account"), authority);
  let boardManifest = await signManifest(payload("board"), authority);
  let driveFailure = false;
  let boardDownloadFailure = false;
  function pin(kind: "account" | "board") {
    state.pboardSecurityPins ??= {};
    const scope = kind === "account" ? account : board;
    state.pboardSecurityPins[`${kind}:${scope}`] = { kind, scope, authorityKeyId: authority.keyId, authorityPublicKey: authority.publicJwk, pinnedAt: Date.now() };
  }
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(String(input));
    let body: unknown;
    if (url.pathname.endsWith("/about")) body = { user: { emailAddress: email } };
    else if (url.pathname.endsWith("/permissions")) body = { permissions: [{ id: "owner", type: "user", role: "owner", emailAddress: email }] };
    else if (url.pathname.endsWith("/files")) {
      const isAccount = url.searchParams.get("spaces") === "appDataFolder";
      if (isAccount && driveFailure) return new Response(JSON.stringify({ error: { message: "PRIVATE_SENTINEL" } }), { status: 403 });
      body = { files: isAccount ? accountManifest ? [{ id: "account-manifest" }] : [] : [{ id: "board-manifest" }] };
    } else if (url.pathname.endsWith("/account-manifest")) body = accountManifest;
    else if (url.pathname.endsWith("/board-manifest")) {
      if (boardDownloadFailure) return new Response(JSON.stringify({ error: { message: "Fixture board access denied" } }), { status: 403 });
      body = boardManifest;
    }
    else throw Error("Unexpected fixture Drive endpoint");
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const repo = { setProjectOrderAccount: vi.fn(async () => {}), setMutatorRole: vi.fn() } as unknown as RxRepository;
  const runtime = createDriveRuntime({ operationSync: false, auth: { getAccessToken: async () => "fixture-token", getConnectionState: async () => "connected", isConfigured: () => true, connect: async () => {}, disconnect: async () => {} }, storage, fetcher, getRepository: async () => repo });
  async function blocked(message: RegExp) {
    try {
      await expect(runtime.collaborationManager.start(board)).rejects.toThrow(message);
      expect(runtime.collaborationManager.state().error).toMatch(message);
      expect(runtime.collaborationManager.state().error).not.toContain("PRIVATE_SENTINEL");
      expect(socket).not.toHaveBeenCalled();
    } finally { await runtime.collaborationManager.stop(); }
  }
  return { state, pin, payload, authority, blocked, setAccount: (value: SignedManifest | null) => { accountManifest = value; },
    setBoard: (value: SignedManifest) => { boardManifest = value; }, failDrive: () => { driveFailure = true; }, failBoardDownload: () => { boardDownloadFailure = true; } };
}

it("identifies missing account trust and provides the second-browser request step without opening signaling", async () => {
  const f = await fixture(); await f.blocked(/Account enrollment is missing.*My account device request/);
  expect(f.state.pboardSecurityPins).toBeUndefined();
});
it("identifies missing board trust after valid account verification", async () => {
  const f = await fixture(); f.pin("account"); await f.blocked(/Board enrollment is missing.*My board device request/);
});
it("distinguishes a missing Drive manifest from a failed Drive request without exposing the response", async () => {
  const f = await fixture(); f.pin("account"); f.setAccount(null); await f.blocked(/Account authorization manifest was not found/);
  f.failDrive(); await f.blocked(/Account authorization could not be read from Google Drive/);
});
it("rejects a different authority without replacing the pin", async () => {
  const f = await fixture(); f.pin("account"); const before = structuredClone(f.state.pboardSecurityPins);
  const other = await generateDeviceKey(); const p = f.payload("account"); p.authorityKeyId = other.keyId;
  f.setAccount(await signManifest(p, other)); await f.blocked(/Account authority in Drive differs/);
  expect(f.state.pboardSecurityPins).toEqual(before);
});
it("distinguishes invalid signature, expiry and an unenrolled replacement device", async () => {
  const f = await fixture(); f.pin("account"); const signed = await signManifest(f.payload("account"), f.authority);
  f.setAccount({ ...signed, signature: "forged" }); await f.blocked(/Account authorization signature or format could not be verified/);
  const expired = f.payload("account"); expired.issuedAt -= 400_000; expired.expiresAt -= 400_000;
  f.setAccount(await signManifest(expired, f.authority)); await f.blocked(/Account authorization expired/);
  const missingDevice = f.payload("account"); const other = await generateDeviceKey();
  missingDevice.devices = [{ deviceKeyId: other.keyId, publicKey: other.publicJwk, role: "owner" }];
  f.setAccount(await signManifest(missingDevice, f.authority)); await f.blocked(/device is not approved for the account/);
});
it("identifies a board Drive binding mismatch and retains all trust", async () => {
  const f = await fixture(); f.pin("account"); f.pin("board"); const before = structuredClone(f.state.pboardSecurityPins);
  const p = f.payload("board"); p.driveFolderId = "other-folder";
  f.setBoard(await signManifest(p, f.authority)); await f.blocked(/Board authorization belongs to a different/);
  expect(f.state.pboardSecurityPins).toEqual(before);
});
it("keeps ordinary Drive startup fail-closed with its existing generic error", async () => {
  const f = await fixture(); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "drive");
  await f.blocked(/Collaboration requires a trusted security manifest/);
});
it("preserves ordinary Drive download errors while giving experimental clients a scoped diagnostic", async () => {
  const f = await fixture(); f.pin("account"); f.pin("board"); f.failBoardDownload();
  await f.blocked(/Board authorization could not be read from Google Drive/);
  vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "drive");
  await f.blocked(/Google Drive request failed \(403\)/);
});
