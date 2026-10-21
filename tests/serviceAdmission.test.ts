import { afterEach, expect, it, vi } from 'vitest';
import { createExperimentalWebSocketSignaling } from '../src/collab/experimentalWebSocketSignaling';
import { generateDeviceKey, verifyBytes } from '../src/collab/security/keys';
import { createGoogleIdentitySharing } from '../src/collab/googleIdentitySharing';
import { createBoardGrantService } from '../src/collab/boardGrants';
import { canonicalBytes } from '../src/collab/security/canonical';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: any[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(_url: string | URL) { Socket.instances.push(this); queueMicrotask(() => this.receive({ type: 'welcome', version: 1,
    supportedVersions: [1, 2], challenge: 'c'.repeat(43), session: 's'.repeat(43), requiresServiceAdmission: true })); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(raw: string) {
    const message = JSON.parse(raw); this.sent.push(message);
    if (message.type === 'authenticate') queueMicrotask(() => this.receive({ type: 'authenticated', peerId: message.deviceKeyId, session: 's'.repeat(43) }));
    if (message.type === 'join') queueMicrotask(() => this.receive({ type: 'joined', peers: [] }));
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
afterEach(() => { Socket.instances = []; vi.restoreAllMocks(); });
it('refuses a required service gate when no Google proof callback is configured', async () => {
  const provider = createExperimentalWebSocketSignaling({ topic: 'test-room', url: 'wss://relay.example.test/ws', getKey: generateDeviceKey, webSocket: Socket as unknown as typeof WebSocket });
  try { await expect(provider.join(() => {})).rejects.toThrow('Google service admission'); expect(Socket.instances[0].sent).toEqual([]); }
  finally { await provider.leave(); }
});
it('binds the short-lived service receipt to the actual socket challenge, room and signing device', async () => {
  const key = await generateDeviceKey(), admission = vi.fn(async () => 'a'.repeat(43));
  const provider = createExperimentalWebSocketSignaling({ topic: 'test-room', url: 'wss://relay.example.test/ws', getKey: async () => key,
    webSocket: Socket as unknown as typeof WebSocket, getServiceAdmission: admission });
  try {
    await provider.join(() => {});
    expect(admission).toHaveBeenCalledWith({ challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'test-room', key });
    const auth = Socket.instances[0].sent[0]; expect(auth.serviceAdmission).toBe('a'.repeat(43));
    expect(await verifyBytes(key.publicJwk, auth.signature, new TextEncoder().encode(JSON.stringify(['pboard-ws-auth-v1', 'c'.repeat(43), 's'.repeat(43), 'test-room', key.keyId])))).toBe(true);
  } finally { await provider.leave(); }
});
it.each(['', 'invalid', 'a'.repeat(44)])('fails closed on malformed service receipts: %j', async receipt => {
  const provider = createExperimentalWebSocketSignaling({ topic: 'test-room', url: 'wss://relay.example.test/ws', getKey: generateDeviceKey,
    webSocket: Socket as unknown as typeof WebSocket, getServiceAdmission: async () => receipt });
  try { await expect(provider.join(() => {})).rejects.toThrow('could not be verified'); expect(Socket.instances[0].sent).toEqual([]); }
  finally { await provider.leave(); }
});
it('exchanges Google only over HTTP, proving possession of the board device key without requesting board membership', async () => {
  const key = await generateDeviceKey(), requests: { path: string; body: any; headers?: HeadersInit }[] = [];
  const storage = { get: async () => ({ pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.example.test/ws' } }), set: async () => {} };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)); requests.push({ path, body, headers: init?.headers });
    return new Response(JSON.stringify(path.endsWith('challenge') ? { version: 1, challenge: 'h'.repeat(43) } : { version: 1, admission: 'a'.repeat(43), expiresAt: Date.now() + 300000 }));
  }) as typeof fetch;
  const auth = { getAccessToken: async () => 'synthetic-test-token', getConnectionState: async () => 'connected' as const, connect: async () => {}, disconnect: async () => {}, isConfigured: () => true };
  const service = createGoogleIdentitySharing({ storage, auth, grants: createBoardGrantService({ storage, fetcher }), fetcher, canInitialize: async () => false, canReceive: async () => false });
  expect(await service.admitService({ challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'room', key })).toBe('a'.repeat(43));
  expect(requests.map(r => r.path)).toEqual(['/identity/challenge', '/identity/exchange']);
  const sent = requests[1]; expect(sent.body.operation).toEqual({ type: 'admit', challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'room' });
  expect(await verifyBytes(key.publicJwk, sent.body.signature, canonicalBytes(['pboard-identity-v1', 'h'.repeat(43), key.keyId, sent.body.operation]))).toBe(true);
  expect(JSON.stringify(sent.body)).not.toContain('synthetic-test-token');
});
