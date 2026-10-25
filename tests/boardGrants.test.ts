import { afterEach, expect, it, vi } from "vitest";
import { createBoardGrantService, rendezvousOrigin } from "../src/collab/boardGrants";
import { generateDeviceKey } from "../src/collab/security/keys";
import { signManifest } from "../src/collab/security/manifest";
import { selectRuntimeSignaling } from "../src/collab/signalingSelection";
import type { PboardSignaling } from "../src/collab/signaling";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function fixture() {
  const network = new Map<string, unknown>();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.headers ?? {}).not.toHaveProperty("Authorization");
    const url = new URL(String(input)); expect(url.origin).toBe("https://relay.example.test");
    if (url.pathname === "/grants/challenge") return new Response(JSON.stringify({ version: 2, challenge: "a".repeat(43) }));
    if (url.pathname === "/grants/publish") { const publication = JSON.parse(String(init?.body)); network.set("current", publication.bundle); return new Response(null, { status: 204 }); }
    if (!network.has("current")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(network.get("current")));
  }) as typeof fetch;
  function client(onAuthorization?: Parameters<typeof createBoardGrantService>[0]["onAuthorization"]) {
    const values: Record<string, unknown> = {};
    const storage = { get: async (id: string) => ({ [id]: structuredClone(values[id]) }), set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); } };
    const keys = new Map<string, Awaited<ReturnType<typeof generateDeviceKey>>>();
    const getKey = async (scope: string) => { if (!keys.has(scope)) keys.set(scope, await generateDeviceKey()); return keys.get(scope)!; };
    const make = () => createBoardGrantService({ storage, getKey, fetcher, onAuthorization });
    return { service: make(), make, keys, values };
  }
  return { client, fetcher, network };
}
const settings = { provider: "websocket" as const, url: "wss://relay.example.test/ws" };
it("keeps Drive as the production default, with explicit production WebSocket opt-in", async () => {
  vi.stubEnv("DEV", false); vi.stubEnv("VITE_PBOARD_SIGNALING_PROVIDER", "websocket");
  const f = fixture(), owner = f.client();
  expect((await owner.service.settings()).provider).toBe("drive");
  const drive = vi.fn(() => ({}) as PboardSignaling);
  expect(selectRuntimeSignaling("anything", drive)).toBe(drive.mock.results[0].value);
  await owner.service.configure(settings);
  await owner.service.initialize("board");
  const context = (await owner.service.security("board"))!;
  expect(selectRuntimeSignaling("pboard-collab-board-cards", drive, context, settings)).toHaveProperty("join");
  expect(drive).toHaveBeenCalledTimes(1);
  expect(() => rendezvousOrigin("ws://127.0.0.1:8787/ws")).toThrow();
});
it("requires owner approval and independently verified authority, without Google or Drive ACL access", async () => {
  const f = fixture(), owner = f.client(), joining = f.client(), outsider = f.client();
  await Promise.all([owner.service.configure(settings), joining.service.configure(settings), outsider.service.configure(settings)]);
  const invitation = await owner.service.initialize("board");
  expect(await outsider.service.security("board")).toBeNull();
  expect(await joining.service.security("board")).toBeNull();
  await expect(joining.service.trust(JSON.stringify(invitation), invitation.history[0].payload.authorityKeyId)).rejects.toThrow("no owner-approved");
  const request = await joining.service.deviceRequest(JSON.stringify(invitation));
  await expect(owner.service.approve(JSON.stringify(request), "wrong", "editor")).rejects.toThrow("fingerprint");
  const approved = await owner.service.approve(JSON.stringify(request), request.deviceKeyId, "editor");
  await expect(joining.service.trust(JSON.stringify(approved), "wrong")).rejects.toThrow("fingerprint");
  expect(await joining.service.trust(JSON.stringify(approved), request.authorityKeyId)).toBe("board");
  expect(await joining.service.role("board")).toBe("editor");
  expect(await joining.service.canBootstrap("board")).toBe(false);
  expect(await owner.service.canBootstrap("board")).toBe(true);
  const restored = joining.make();
  expect((await restored.security("board"))?.manifestHistory?.size).toBe(2);
  expect(joining.values.pboardSecurityPins).toBeUndefined();
});
it("rejects expired/forged requests, authority replacement and history forks, and enforces revocation", async () => {
  const f = fixture(), owner = f.client(), joining = f.client();
  await owner.service.configure(settings); await joining.service.configure(settings);
  const first = await owner.service.initialize("board");
  const req = await joining.service.deviceRequest(JSON.stringify(first));
  await expect(owner.service.approve(JSON.stringify({ ...req, signature: "forged" }), req.deviceKeyId, "editor")).rejects.toThrow();
  const approved = await owner.service.approve(JSON.stringify(req), req.deviceKeyId, "viewer");
  await joining.service.trust(JSON.stringify(approved), req.authorityKeyId);
  expect(await joining.service.role("board")).toBe("viewer");
  const newAuthority = await generateDeviceKey();
  const replacement = { ...approved, authority: newAuthority.publicJwk, history: [await signManifest({ ...approved.history.at(-1)!.payload, authorityKeyId: newAuthority.keyId }, newAuthority)] };
  await expect(joining.service.trust(JSON.stringify(replacement), newAuthority.keyId)).rejects.toThrow("already pinned");
  const renewed = await owner.service.initialize("board");
  await expect(joining.service.trust(JSON.stringify({ ...renewed, history: renewed.history.slice(1) }), req.authorityKeyId)).rejects.toThrow("truncation");
  await owner.service.revoke("board", req.deviceKeyId);
  await expect(joining.service.poll("board")).rejects.toThrow("no owner-approved");
});
it("reports the expired-grant state when the service no longer publishes the board", async () => {
  const f = fixture(), owner = f.client(), joining = f.client();
  await owner.service.configure(settings); await joining.service.configure(settings);
  const invitation = await owner.service.initialize("board");
  const req = await joining.service.deviceRequest(JSON.stringify(invitation));
  await joining.service.trust(JSON.stringify(await owner.service.approve(JSON.stringify(req), req.deviceKeyId, "editor")), req.authorityKeyId);
  expect(await joining.service.security("board")).not.toBeNull();
  // The authority browser went offline; the service cache expired the grant.
  // A joiner holding the grant record must be told to wake the authority, not
  // that the service itself is broken.
  f.network.delete("current");
  await expect(joining.service.security("board", true)).rejects.toThrow("Board grant expired. The original authority browser must be online to renew it.");
});
it("renews from persisted owner history after an interruption without discarding old signed epochs", async () => {
  const f = fixture(), owner = f.client(); await owner.service.configure(settings);
  const first = await owner.service.initialize("board");
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 400_000);
  const context = await owner.make().security("board");
  expect(context?.manifest.epoch).toBe(2);
  expect(context?.manifestHistory?.get(1)).toEqual(first.history[0].payload);
});
it("fails closed on service/permission errors and leaves persisted board/Drive records intact", async () => {
  const f = fixture(), owner = f.client(); await owner.service.configure(settings);
  owner.values.pboardSecurityPins = { sentinel: "legacy" };
  await owner.service.initialize("board");
  const before = structuredClone(owner.values);
  vi.mocked(f.fetcher).mockRejectedValue(new Error("network unavailable"));
  await expect(owner.make().security("board")).rejects.toThrow("network unavailable");
  expect(owner.values).toEqual(before);
});

it('pairs actual owner/editor services using connection codes and automatic grant retrieval, never board-ID knowledge alone', async () => {
  const f = fixture(), owner = f.client(), joining = f.client(), outsider = f.client();
  for (const c of [owner, joining, outsider]) await c.service.configure(settings);
  const invitation = await owner.service.pairing.invite('pair-board');
  const request = await joining.service.pairing.request(invitation);
  expect(request.code).toMatch(/^pboard-connect-v1:/);
  expect(await joining.service.pairing.finish()).toBeNull();
  expect(await joining.service.security('pair-board')).toBeNull();
  const review = await owner.service.pairing.preview(request.code);
  expect(review.boardId).toBe('pair-board');
  expect(review.verification).toBe(request.verification);
  await expect(owner.service.pairing.approve(request.code, 'WRONG', 'editor')).rejects.toThrow('verification code');
  expect(await joining.service.pairing.finish()).toBeNull();
  await owner.service.pairing.approve(request.code, review.verification, 'editor');
  expect(await joining.make().pairing.finish()).toBe('pair-board');
  expect(await joining.service.role('pair-board')).toBe('editor');
  expect(await outsider.service.security('pair-board')).toBeNull();
  await joining.service.pairing.cancel();
  expect(await joining.service.pairing.pending()).toBeNull();
  expect(await joining.service.pairing.finish()).toBeNull();
});
it('rejects pairing tampering, expired invitations, wrong services and authority replacement', async () => {
  const f = fixture(), owner = f.client(), joining = f.client();
  for (const c of [owner, joining]) await c.service.configure(settings);
  const invitation = await owner.service.pairing.invite('pair-board');
  const raw = JSON.parse(atob(invitation.split(':')[1].replaceAll('-', '+').replaceAll('_', '/')));
  const forged = 'pboard-connect-v1:' + btoa(JSON.stringify({ ...raw, boardId: 'other' })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  await expect(joining.service.pairing.request(forged)).rejects.toThrow('Invitation expired, invalid');
  await joining.service.configure({ ...settings, url: 'wss://other.example.test/ws' });
  await expect(joining.service.pairing.request(invitation)).rejects.toThrow('different rendezvous');
  await joining.service.configure(settings);
  vi.useFakeTimers(); vi.setSystemTime(Date.now()+600_001);
  await expect(joining.service.pairing.request(invitation)).rejects.toThrow('Invitation expired');
  expect(joining.values.pboardBoardGrants).toBeUndefined();
});
it('refreshes an expiring cached owner grant instead of reusing an expired security context', async () => {
  const f = fixture(), owner = f.client(); await owner.service.configure(settings);
  await owner.service.initialize('board');
  const first = await owner.service.security('board');
  vi.useFakeTimers(); vi.setSystemTime(Date.now()+400_000);
  const next = await owner.service.security('board');
  expect(next?.manifest.epoch).toBe(first!.manifest.epoch+1);
  expect(next!.manifest.expiresAt).toBeGreaterThan(Date.now());
});
it('does not replace a previously pinned board authority through pairing codes', async () => {
  const f=fixture(), owner=f.client(), joining=f.client(), replacement=f.client();
  for(const c of [owner,joining,replacement])await c.service.configure(settings);
  const first=await joining.service.pairing.request(await owner.service.pairing.invite('board'));
  await owner.service.pairing.approve(first.code,first.verification,'viewer');
  expect(await joining.service.pairing.finish()).toBe('board');
  const before=structuredClone(joining.values.pboardBoardGrants);
  const next=await joining.service.pairing.request(await replacement.service.pairing.invite('board'));
  await replacement.service.pairing.approve(next.code,next.verification,'editor');
  await expect(joining.service.pairing.finish()).rejects.toThrow('already pinned');
  expect(joining.values.pboardBoardGrants).toEqual(before);
});
it('does not complete a cancelled request when an already-running metadata fetch returns', async () => {
  const f=fixture(), owner=f.client(), joining=f.client();
  for(const c of [owner,joining])await c.service.configure(settings);
  const request=await joining.service.pairing.request(await owner.service.pairing.invite('board'));
  await owner.service.pairing.approve(request.code,request.verification,'editor');
  let complete: ((response: Response)=>void)|undefined;
  vi.mocked(f.fetcher).mockImplementationOnce(()=>new Promise<Response>(done=>{complete=done;}));
  const finish=joining.service.pairing.finish();
  await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));
  await joining.service.pairing.cancel();
  complete!(new Response(JSON.stringify(f.network.get('current'))));
  expect(await finish).toBeNull();
  expect(joining.values.pboardBoardGrants).toBeUndefined();
});
it('reports renewal to active pools even when role lookup already refreshed the cached manifest', async () => {
  const f=fixture(), owner=f.client(); await owner.service.configure(settings);
  await owner.service.initialize('board'); await owner.service.security('board');
  vi.useFakeTimers(); vi.setSystemTime(Date.now()+400_000);
  expect(await owner.service.role('board')).toBe('owner');
  expect(await owner.service.poll('board')).toBe(true);
  expect(await owner.service.poll('board')).toBe(false);
});

it("persists verified downgrades/removal before rejecting admission and never treats a network error as revocation", async () => {
  const f = fixture(), owner = f.client();
  const observed: import('../src/storage/changeJournal').OfflinePermission[] = [];
  const peer = f.client(async (_board, permission) => { observed.push(permission); });
  await owner.service.configure(settings); await peer.service.configure(settings);
  const invitation = await owner.service.initialize('board');
  const request = await peer.service.deviceRequest(JSON.stringify(invitation));
  const grant = await owner.service.approve(JSON.stringify(request), request.deviceKeyId, 'editor');
  await peer.service.trust(JSON.stringify(grant), request.authorityKeyId);
  expect(observed.at(-1)?.role).toBe('editor');
  await owner.service.updateAuthorizedDevices('board', { [request.deviceKeyId]: 'viewer' }); await peer.service.poll('board');
  expect(observed.at(-1)?.role).toBe('viewer');
  await owner.service.revoke('board', request.deviceKeyId);
  await expect(peer.service.poll('board')).rejects.toThrow('no owner-approved');
  expect(observed.at(-1)).toMatchObject({ role: 'revoked', authorityKeyId: request.authorityKeyId, deviceKeyId: request.deviceKeyId });
  await expect(peer.service.security('board')).rejects.toThrow('no owner-approved');
  const count = observed.length; f.network.delete('current');
  await expect(peer.service.poll('board')).rejects.toThrow('Board grant expired'); expect(observed).toHaveLength(count);
});
