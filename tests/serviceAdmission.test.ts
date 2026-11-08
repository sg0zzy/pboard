import { afterEach, expect, it, vi } from 'vitest';
import { createExperimentalWebSocketSignaling } from '../src/collab/experimentalWebSocketSignaling';
import { generateDeviceKey, verifyBytes } from '../src/collab/security/keys';
import { createGoogleIdentitySharing } from '../src/collab/googleIdentitySharing';
import { createBoardGrantService } from '../src/collab/boardGrants';
import { instantAuthBudget } from './helpers/authBudget';
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
  const provider = createExperimentalWebSocketSignaling({ topic: 'test-room', url: 'wss://relay.example.test/ws', getKey: generateDeviceKey, webSocket: Socket as unknown as typeof WebSocket, authBudget: instantAuthBudget() });
  try { await expect(provider.join(() => {})).rejects.toThrow('Google service admission'); expect(Socket.instances[0].sent).toEqual([]); }
  finally { await provider.leave(); }
});
it('binds the short-lived service receipt to the actual socket challenge, room and signing device', async () => {
  const key = await generateDeviceKey(), admission = vi.fn(async () => 'a'.repeat(43));
  const provider = createExperimentalWebSocketSignaling({ topic: 'test-room', url: 'wss://relay.example.test/ws', getKey: async () => key,
    webSocket: Socket as unknown as typeof WebSocket, getServiceAdmission: admission, authBudget: instantAuthBudget() });
  try {
    await provider.join(() => {});
    expect(admission).toHaveBeenCalledWith({ challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'test-room', key });
    const auth = Socket.instances[0].sent[0]; expect(auth.serviceAdmission).toBe('a'.repeat(43));
    expect(await verifyBytes(key.publicJwk, auth.signature, new TextEncoder().encode(JSON.stringify(['pboard-ws-auth-v1', 'c'.repeat(43), 's'.repeat(43), 'test-room', key.keyId])))).toBe(true);
  } finally { await provider.leave(); }
});
it.each(['', 'invalid', 'a'.repeat(44)])('fails closed on malformed service receipts: %j', async receipt => {
  const provider = createExperimentalWebSocketSignaling({ topic: 'test-room', url: 'wss://relay.example.test/ws', getKey: generateDeviceKey,
    webSocket: Socket as unknown as typeof WebSocket, getServiceAdmission: async () => receipt, authBudget: instantAuthBudget() });
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
  const service = createGoogleIdentitySharing({ storage, auth, grants: createBoardGrantService({ storage, fetcher, authBudget: instantAuthBudget() }), fetcher, authBudget: instantAuthBudget(), canReceive: async () => false });
  expect(await service.admitService({ challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'room', key })).toBe('a'.repeat(43));
  expect(requests.map(r => r.path)).toEqual(['/identity/challenge', '/identity/exchange']);
  const sent = requests[1]; expect(sent.body.operation).toEqual({ type: 'admit', challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'room' });
  expect(await verifyBytes(key.publicJwk, sent.body.signature, canonicalBytes(['pboard-identity-v1', 'h'.repeat(43), key.keyId, sent.body.operation]))).toBe(true);
  expect(JSON.stringify(sent.body)).not.toContain('synthetic-test-token');
});

it('serialises the single-use challenge pair: two concurrent admissions ask for one exchange, never one 403', async () => {
  // The live journal's `identity_enrollment_rejected reason="challenge_invalid"`
  // followed within a second by `identity_enrollment_verified`: one context ran
  // two challenge/exchange pairs against a service that removes a challenge
  // before verifying it, and the loser lost the challenge *and* a round. Two
  // attaches of one room ask for the same (challenge, session, room, device),
  // so the context must spend exactly one pair for them.
  const key = await generateDeviceKey(), paths: string[] = [];
  const storage = { get: async () => ({ pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.example.test/ws' } }), set: async () => {} };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    // A small delay on the challenge read is what makes the race real: without
    // serialisation both callers hold a challenge before either exchanges one.
    if (path.endsWith('challenge')) { await new Promise<void>(resolve => setTimeout(resolve, 5)); return new Response(JSON.stringify({ version: 1, challenge: ('h' + paths.length).padEnd(43, 'x') })); }
    return new Response(JSON.stringify({ version: 1, admission: 'a'.repeat(43), expiresAt: Date.now() + 300000 }));
  }) as typeof fetch;
  const auth = { getAccessToken: async () => 'synthetic-test-token', getConnectionState: async () => 'connected' as const, connect: async () => {}, disconnect: async () => {}, isConfigured: () => true };
  const service = createGoogleIdentitySharing({ storage, auth, grants: createBoardGrantService({ storage, fetcher, authBudget: instantAuthBudget() }), fetcher, authBudget: instantAuthBudget(), canReceive: async () => false });
  const request = { challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'room', key };
  const [first, second] = await Promise.all([service.admitService(request), service.admitService(request)]);
  expect(first).toBe('a'.repeat(43));
  expect(second).toBe(first);
  expect(paths.filter(path => path === '/identity/challenge')).toHaveLength(1);
  expect(paths.filter(path => path === '/identity/exchange')).toHaveLength(1);
});

it('mints a fresh receipt for every attach: a receipt the relay consumed is never handed out again', async () => {
  // `identity_enrollment.rs` removes a receipt on presentation, so a second
  // presentation of the same one is `service_auth_required` — a refusal the
  // transport treats as terminal. A sixty-second reuse cache therefore made a
  // board switched away and back on one socket unmountable for good: its attach
  // carried a spent receipt and the room stopped with `detached:service_auth_required`
  // while its sibling kept syncing. The same four binding values must cost a
  // second pair, not answer from the first.
  const key = await generateDeviceKey(), paths: string[] = [];
  const storage = { get: async () => ({ pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.example.test/ws' } }), set: async () => {} };
  let issued = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith('challenge')) return new Response(JSON.stringify({ version: 1, challenge: `${'h'.repeat(42)}${issued++}` }));
    return new Response(JSON.stringify({ version: 1, admission: `${'a'.repeat(42)}${issued}`, expiresAt: Date.now() + 300000 }));
  }) as typeof fetch;
  const auth = { getAccessToken: async () => 'synthetic-test-token', getConnectionState: async () => 'connected' as const, connect: async () => {}, disconnect: async () => {}, isConfigured: () => true };
  const service = createGoogleIdentitySharing({ storage, auth, grants: createBoardGrantService({ storage, fetcher, authBudget: instantAuthBudget() }), fetcher, authBudget: instantAuthBudget(), canReceive: async () => false });
  const request = { challenge: 'c'.repeat(43), session: 's'.repeat(43), room: 'room', key };
  const first = await service.admitService(request);
  const second = await service.admitService(request);
  expect(first).toHaveLength(43);
  expect(second).toHaveLength(43);
  expect(second, 'the second attach got its own receipt').not.toBe(first);
  expect(paths.filter(path => path === '/identity/exchange'), 'one exchange per attach').toHaveLength(2);
  // Concurrent duplicates still share one pair: serialisation without waste.
  const [third, fourth] = await Promise.all([service.admitService(request), service.admitService(request)]);
  expect(third).toBe(fourth);
  expect(paths.filter(path => path === '/identity/exchange')).toHaveLength(3);
});
