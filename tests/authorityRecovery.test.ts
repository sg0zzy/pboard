import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { createBoardGrantService } from '../src/collab/boardGrants';
import { generateDeviceKey, type StoredDeviceKey } from '../src/collab/security/keys';
import { openAuthorityRecovery } from '../src/collab/security/authorityRecovery';
const passphrase = 'synthetic recovery phrase for automated tests';
function setup() {
  let published: any, unavailable = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (unavailable) return new Response('{}', { status: 503 });
    if (path === '/grants/challenge') return new Response(JSON.stringify({ version: 2, challenge: 'a'.repeat(43) }));
    if (path === '/grants/publish') { published = JSON.parse(String(init?.body)).bundle; return new Response(null, { status: 204 }); }
    return published ? new Response(JSON.stringify(published)) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  function client() {
    const values: Record<string, unknown> = {}, keys = new Map<string, StoredDeviceKey>(), recovered = new Map<string, StoredDeviceKey>();
    const storage = { get: async (id: string) => ({ [id]: structuredClone(values[id]) }), set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); } };
    const getKey = async (purpose: string) => { if (!keys.has(purpose)) keys.set(purpose, await generateDeviceKey()); return keys.get(purpose)!; };
    const make = () => createBoardGrantService({ storage, fetcher, getKey, recoveryKeys: { load: async purpose => recovered.get(purpose) ?? null, save: async (purpose, key) => { if (recovered.has(purpose) && recovered.get(purpose)!.keyId !== key.keyId) throw new Error('refuse replacement'); recovered.set(purpose, structuredClone(key)); } } });
    return { service: make(), make, keys, recovered, values, async enable() { await this.service.configure({ provider: 'websocket', url: 'wss://relay.example.test/ws' }); }, destroy() { keys.clear(); for (const name of Object.keys(values)) delete values[name]; } };
  }
  return { client, restart: () => { published = undefined; }, down: () => { unavailable = true; } };
}
it('recovers the same authority on a new device after permanent source loss and server restart, with explicit reviewed owner authorization', async () => {
  const f = setup(), a = f.client(), b = f.client(); await a.enable(); await b.enable();
  const board = `recovery-${crypto.randomUUID()}`, first = await a.service.initialize(board), pin = first.history[0].payload.authorityKeyId;
  const encrypted = await a.service.exportAuthorityRecovery(board, passphrase);
  const originalRoot = (await a.service.security(board))!.historyAuthority!.privateJwk;
  expect(encrypted).not.toContain(String(originalRoot.d));
  a.destroy(); f.restart();
  const review = await b.service.inspectRecovery(encrypted, passphrase, pin);
  await b.service.restoreAuthority(encrypted, passphrase, pin, review.reviewedHash, review.devices.map(d => d.deviceKeyId));
  expect(await b.service.ownsAuthority(board)).toBe(true); expect(await b.service.role(board)).toBe('owner');
  const restored = (await b.service.localBundle(board))!;
  expect(restored.authority).toEqual(first.authority); expect(restored.history[0]).toEqual(first.history[0]);
  expect(restored.history.at(-1)!.payload.devices).toHaveLength(2);
  const context = (await b.service.security(board))!;
  expect(context.signer.deviceKeyId).not.toBe(first.history[0].payload.devices[0].deviceKeyId);
  const afterRestart = b.make(); expect(await afterRestart.ownsAuthority(board)).toBe(true); await afterRestart.initialize(board);
  expect((await afterRestart.localBundle(board))!.history.at(-1)!.payload.authorityKeyId).toBe(pin);
});
it('merges current grant history and rejects a stale roster review rather than restoring revoked devices', async () => {
  const f = setup(), a = f.client(), b = f.client(), editor = f.client(); for (const c of [a, b, editor]) await c.enable();
  const board = `recovery-${crypto.randomUUID()}`, first = await a.service.initialize(board), pin = first.history[0].payload.authorityKeyId;
  const request = await editor.service.deviceRequest(JSON.stringify(first)); await a.service.approve(JSON.stringify(request), request.deviceKeyId, 'editor');
  const encrypted = await a.service.exportAuthorityRecovery(board, passphrase), before = await b.service.inspectRecovery(encrypted, passphrase, pin);
  await a.service.revoke(board, request.deviceKeyId);
  await expect(b.service.restoreAuthority(encrypted, passphrase, pin, before.reviewedHash, before.devices.map(d => d.deviceKeyId))).rejects.toThrow('review');
  expect(b.recovered.size).toBe(0);
  const current = await b.service.inspectRecovery(encrypted, passphrase, pin); expect(current.devices.some(d => d.deviceKeyId === request.deviceKeyId)).toBe(false);
  await b.service.restoreAuthority(encrypted, passphrase, pin, current.reviewedHash, current.devices.map(d => d.deviceKeyId));
  expect(await b.service.automaticDeviceAllowed(board, request.deviceKeyId)).toBe(false);
});
it('rejects wrong passphrases, tampering, wrong authority pins and incompatible existing trust before importing keys', async () => {
  const f = setup(), a = f.client(), b = f.client(); await a.enable(); await b.enable();
  const board = `recovery-${crypto.randomUUID()}`, bundle = await a.service.initialize(board), pin = bundle.history[0].payload.authorityKeyId;
  const encrypted = await a.service.exportAuthorityRecovery(board, passphrase);
  await expect(b.service.inspectRecovery(encrypted, 'wrong phrase long enough', pin)).rejects.toThrow('decrypt');
  await expect(b.service.inspectRecovery(encrypted, passphrase, 'a'.repeat(43))).rejects.toThrow('fingerprint');
  const malformed = JSON.parse(encrypted); malformed.ciphertext = 'a'.repeat(100);
  await expect(b.service.inspectRecovery(JSON.stringify(malformed), passphrase, pin)).rejects.toThrow('decrypt');
  await b.service.initialize(board); await expect(b.service.inspectRecovery(encrypted, passphrase, pin)).rejects.toThrow('Existing authority');
  expect(b.recovered.size).toBe(0);
});
it('a valid Google identity or ordinary member grant never supplies a root recovery capability', async () => {
  const f = setup(), a = f.client(), b = f.client(); await a.enable(); await b.enable();
  const board = `recovery-${crypto.randomUUID()}`, bundle = await a.service.initialize(board), pin = bundle.history[0].payload.authorityKeyId;
  const request = await b.service.deviceRequest(JSON.stringify(bundle)), approved = await a.service.approve(JSON.stringify(request), request.deviceKeyId, 'editor');
  await b.service.trust(JSON.stringify(approved), pin);
  await expect(b.service.exportAuthorityRecovery(board, passphrase)).rejects.toThrow('Only the original'); expect(await b.service.ownsAuthority(board)).toBe(false);
});
it('requires endpoint availability to be established, preserves keys on failures, and bounds decryption input', async () => {
  const f = setup(), a = f.client(), b = f.client(); await a.enable(); await b.enable();
  const board = `recovery-${crypto.randomUUID()}`, bundle = await a.service.initialize(board), pin = bundle.history[0].payload.authorityKeyId;
  const encrypted = await a.service.exportAuthorityRecovery(board, passphrase); f.down();
  await expect(b.service.inspectRecovery(encrypted, passphrase, pin)).rejects.toThrow('503'); expect(b.recovered.size).toBe(0);
  await expect(openAuthorityRecovery('x'.repeat(8 * 1024 * 1024 + 1), passphrase, pin)).rejects.toThrow();
  await expect(a.service.exportAuthorityRecovery(board, 'short')).rejects.toThrow('passphrase');
});
it('a returning original browser preserves the recovered authority state and cannot automatically overwrite its membership', async () => {
  const f = setup(), a = f.client(), b = f.client(); await a.enable(); await b.enable();
  const board = `recovery-${crypto.randomUUID()}`, original = await a.service.initialize(board), pin = original.history[0].payload.authorityKeyId;
  const encrypted = await a.service.exportAuthorityRecovery(board, passphrase), review = await b.service.inspectRecovery(encrypted, passphrase, pin);
  await b.service.restoreAuthority(encrypted, passphrase, pin, review.reviewedHash, review.devices.map(d => d.deviceKeyId));
  await expect(a.service.signAuthority(board, new TextEncoder().encode('stale automatic policy'))).rejects.toThrow('moved');
  await a.service.security(board, true); expect(await a.service.ownsAuthority(board)).toBe(false);
  expect(await a.service.role(board)).toBe('owner'); // Existing content grant is preserved.
  await expect(a.service.initialize(board)).rejects.toThrow('moved');
  expect((await b.service.localBundle(board))!.history[0]).toEqual(original.history[0]);
});
