/**
 * Drive-verified authority re-key (D1/D4) at the grant-service level: a fresh
 * ownership proof establishes a NEW authority on a device without a grant
 * record, while every unverified case (stale proof, existing record) leaves no
 * trace. Old key slots and records are never modified, and the transition row
 * lands in the durable audit store.
 */
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { createBoardGrantService } from '../../src/collab/boardGrants';
import { generateDeviceKey, publicKeyFingerprint, type StoredDeviceKey } from '../../src/collab/security/keys';
import { sha256Hex, verifyTransition, verifyTransitionOwnership } from '../../src/collab/security/authorityTransition';
import { ChangeJournal } from '../../src/storage/changeJournal';

function setup() {
  let published: unknown;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/grants/challenge') return new Response(JSON.stringify({ version: 2, challenge: 'a'.repeat(43) }));
    if (path === '/grants/publish') { published = structuredClone(JSON.parse(String(init?.body)).bundle); return new Response(null, { status: 204 }); }
    return published ? new Response(JSON.stringify(published)) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  const values: Record<string, unknown> = {}, keys = new Map<string, StoredDeviceKey>(), transitions: unknown[] = [];
  const storage = { get: async (id: string) => ({ [id]: structuredClone(values[id]) }), set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); } };
  const getKey = async (purpose: string) => { if (!keys.has(purpose)) keys.set(purpose, await generateDeviceKey()); return keys.get(purpose)!; };
  const permissions: Record<string, { id: string; role: string; deviceKeyId?: string; authorityKeyId?: string }> = {};
  const service = createBoardGrantService({ storage, fetcher, getKey, peekKey: async purpose => keys.get(purpose) ?? null,
    onAuthorization: async (board, permission, authorityReplacementAuthorized) => {
      // Mirrors the runtime guard: only a Drive-verified transition may replace
      // a locally pinned authority in the journal permission row.
      const previous = permissions[board];
      if (previous?.authorityKeyId && previous.authorityKeyId !== permission.authorityKeyId && !authorityReplacementAuthorized) throw new Error("Board authority replacement is forbidden");
      permissions[board] = { ...permission };
    },
    onTransition: async (_board, record) => { transitions.push(record); } });
  return {
    service, keys, values, transitions, permissions,
    get published() { return published; },
    enable: () => service.configure({ provider: 'websocket', url: 'wss://relay.example.test/ws' }),
    dropRecord() { delete values.pboardBoardGrants; },
    proof: async (board: string, overrides: { folderFileId?: string; verifiedAt?: number } = {}) => ({
      folderFileId: overrides.folderFileId ?? `folder-${board}`,
      ownerEmailHash: await sha256Hex('owner@example.com'),
      aclDigest: await sha256Hex('acl'),
      verifiedAt: overrides.verifiedAt ?? Date.now(),
    }),
  };
}

it('re-keys a lost authority for the live-verified Drive owner', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  const transition = await a.service.reestablishAuthority(board, await a.proof(board));
  expect(await verifyTransition(transition)).toBe(true);
  expect(transition.previousAuthorityKeyId).toBeNull();
  expect(transition.driveFolderFileId).toBe(`folder-${board}`);

  const bundle = (await a.service.localBundle(board))!;
  expect(bundle.history).toHaveLength(1);
  expect(bundle.history[0].payload.epoch).toBe(1);
  expect(bundle.history[0].payload.authorityKeyId).toBe(transition.newAuthorityKeyId);
  expect(await a.service.role(board)).toBe('owner');
  expect(await a.service.ownsAuthority(board)).toBe(true);
  // The legacy root slot was never touched (it was never created here).
  expect(a.keys.has(`standalone-board-authority:${board}`)).toBe(false);
  expect(a.transitions).toEqual([transition]);
  expect(a.published).toBeTruthy();

  // The security path keeps working and signs under the new root.
  const context = await a.service.security(board);
  expect(context).not.toBeNull();
  expect(context!.manifest.authorityKeyId).toBe(transition.newAuthorityKeyId);
});

it('binds and preserves a retained legacy root instead of replacing it', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  const retained = await generateDeviceKey();
  a.keys.set(`standalone-board-authority:${board}`, retained);
  const transition = await a.service.reestablishAuthority(board, await a.proof(board));
  expect(transition.previousAuthorityKeyId).toBe(retained.keyId);
  expect(transition.previousAuthorityPublicKey).toEqual(retained.publicJwk);
  expect(await verifyTransition(transition)).toBe(true);
  // The legacy key stays exactly where it was; only the record supersedes it.
  expect(a.keys.get(`standalone-board-authority:${board}`)).toBe(retained);
  const entries = a.values.pboardBoardGrants as Record<string, { superseded?: { previousAuthorityKeyId: string | null }[] }>;
  expect(entries[board].superseded).toEqual([{ previousAuthorityKeyId: retained.keyId, note: 'authority re-established after verified Drive ownership' }]);
});

it('refuses re-keying when this device already pins an authority, changing nothing', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  const first = await a.service.initialize(board);
  await expect(a.service.reestablishAuthority(board, await a.proof(board))).rejects.toThrow(/already pins a board authority/);
  const bundle = (await a.service.localBundle(board))!;
  expect(bundle.history.map(entry => entry.signature)).toEqual(first.history.map(entry => entry.signature));
});

it('stale ownership proofs are refused before any key or record is created', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  await expect(a.service.reestablishAuthority(board, await a.proof(board, { verifiedAt: Date.now() - 61_000 }))).rejects.toThrow(/fresh live Drive ownership proof/);
  expect(await a.service.localBundle(board)).toBeNull();
  expect(a.keys.size).toBe(0);
  expect(a.transitions).toEqual([]);
});

it('rejects malformed proofs and unknown boards without side effects', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  const proof = await a.proof(board);
  await expect(a.service.reestablishAuthority(board, { ...proof, ownerEmailHash: '' })).rejects.toThrow(/ownership proof/);
  await expect(a.service.reestablishAuthority('not a board id', proof)).rejects.toThrow(/local board/);
  expect(a.keys.size).toBe(0);
});

it('records survive a journal round trip and match a fresh ownership read', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  const transition = await a.service.reestablishAuthority(board, await a.proof(board));
  const journal = new ChangeJournal(`rekey-audit-${crypto.randomUUID().slice(0, 8)}`);
  await journal.open();
  await journal.authorityTransitions.put({ id: `${board}:${transition.newAuthorityKeyId}`, boardId: board, record: transition as unknown as Record<string, unknown>, storedAt: Date.now() });
  const rows = await journal.authorityTransitions.where('boardId').equals(board).toArray();
  expect(rows).toHaveLength(1);
  const stored = rows[0].record as typeof transition;
  expect(await verifyTransition(stored)).toBe(true);
  expect(verifyTransitionOwnership(stored, await a.proof(board))).toBe(true);
  journal.close();
});

it('a Drive-verified transition replaces the locally pinned permission row, ordinary flows still may not', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  await a.service.initialize(board);
  const first = (await a.service.localBundle(board))!;
  expect(a.permissions[board]?.authorityKeyId).toBe(first.history[0].payload.authorityKeyId);
  // The authority record disappears, the journal permission row keeps pinning
  // the old authority — exactly the partially-lost state a Drive owner hits.
  a.dropRecord();
  const transition = await a.service.reestablishAuthority(board, await a.proof(board));
  expect(a.permissions[board]?.authorityKeyId).toBe(transition.newAuthorityKeyId);
  expect(await a.service.authorityTransitioned(board)).toBe(true);
  // Without a transition, an unrelated authority may never take the pinned row:
  // importing a foreign valid chain for the same board is refused by the guard.
  const b = setup(); await b.enable();
  const foreign = await b.service.initialize(board);
  const foreignPin = await publicKeyFingerprint(foreign.authority);
  a.dropRecord();
  a.permissions[board] = { id: board, role: "owner", authorityKeyId: "unrelated-authority" };
  await expect(a.service.trust(JSON.stringify(foreign), foreignPin)).rejects.toThrow(/replacement is forbidden/);
});

it('a foreign (non-owner) device cannot displace its own pinned row through the transition path either', async () => {
  const a = setup(); await a.enable();
  const board = `rekey-${crypto.randomUUID()}`;
  await a.service.initialize(board);
  const first = (await a.service.localBundle(board))!;
  // Journal row pinned, record still present: re-key must refuse outright.
  await expect(a.service.reestablishAuthority(board, await a.proof(board))).rejects.toThrow(/already pins/);
  expect(a.permissions[board]?.authorityKeyId).toBe(first.history[0].payload.authorityKeyId);
});
