/**
 * Regression suite for the "existing signed collaboration data" defect:
 * a board created by the current user whose grant record was lost must be
 * RESTORED from its own retained authority, never re-initialized, and its
 * owner must be able to create cards again. Restoration accepts only the
 * cryptographic chain this device's root key signed, never rolls back a
 * pinned epoch, and never overwrites anything.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoardGrantService } from '../../src/collab/boardGrants';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { openDevice, DriveFixture } from './harness';

afterEach(() => { vi.useRealTimers(); });

function setup() {
  let published: any, unavailable = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (unavailable) return new Response('{}', { status: 503 });
    if (path === '/grants/challenge') return new Response(JSON.stringify({ version: 2, challenge: 'a'.repeat(43) }));
    if (path === '/grants/publish') { published = structuredClone(JSON.parse(String(init?.body)).bundle); return new Response(null, { status: 204 }); }
    return published ? new Response(JSON.stringify(published)) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  function client() {
    const values: Record<string, unknown> = {}, keys = new Map<string, StoredDeviceKey>();
    const storage = { get: async (id: string) => ({ [id]: structuredClone(values[id]) }), set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); } };
    const getKey = async (purpose: string) => { if (!keys.has(purpose)) keys.set(purpose, await generateDeviceKey()); return keys.get(purpose)!; };
    const make = () => createBoardGrantService({ storage, fetcher, getKey, peekKey: async purpose => keys.get(purpose) ?? null });
    return {
      service: make(), make, keys, values,
      async enable() { await this.service.configure({ provider: 'websocket', url: 'wss://relay.example.test/ws' }); },
      dropGrantRecord() { delete values.pboardBoardGrants; },
      restoreRecord() { return values.pboardBoardGrants as Record<string, unknown> | undefined; },
      advance(minutes: number) { vi.setSystemTime(Date.now() + minutes * 60_000); },
      serve(bundle: unknown) { published = structuredClone(bundle); },
      clear() { published = undefined; },
      get published() { return published; }
    };
  }
  return { client };
}

it('restores a lost grant record on its own authority device instead of demanding re-initialization', async () => {
  const { client } = setup(), a = client(); await a.enable();
  const board = `restore-${crypto.randomUUID()}`, first = await a.service.initialize(board);
  expect(await a.service.role(board)).toBe('owner');
  a.dropGrantRecord();
  expect(await a.service.localBundle(board)).toBeNull();
  expect(await a.service.restoreAuthorityRecord(board)).toBe(true);
  expect(await a.service.ownsAuthority(board)).toBe(true);
  expect(await a.service.role(board)).toBe('owner');
  expect((await a.service.localBundle(board))!.history).toEqual(first.history);
  // Idempotent and side-effect free afterwards.
  expect(await a.service.restoreAuthorityRecord(board)).toBe(false);
  expect((await a.service.localBundle(board))!.history).toEqual(first.history);
});

it('adopts an expired service head, then renews it as epoch+1 under the same authority', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { client } = setup(), a = client(); await a.enable();
  const board = `restore-${crypto.randomUUID()}`, first = await a.service.initialize(board);
  a.advance(6); // the five-minute manifest is now expired on the service too
  a.dropGrantRecord();
  expect(await a.service.restoreAuthorityRecord(board)).toBe(true);
  const context = await a.service.security(board);
  expect(context).not.toBeNull();
  expect(context!.manifest.epoch).toBe(first.history.at(-1)!.payload.epoch + 1);
  const renewed = (await a.service.localBundle(board))!;
  expect(renewed.history.length).toBe(2);
  expect(renewed.history[0]).toEqual(first.history[0]);
  expect(renewed.history.at(-1)!.payload.authorityKeyId).toBe(first.history.at(-1)!.payload.authorityKeyId);
});

it('refuses epoch rollback, forged authorities and unenrolled devices, leaving no record behind', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { client } = setup(), a = client(), stranger = client(); await a.enable(); await stranger.enable();
  const board = `restore-${crypto.randomUUID()}`, first = await a.service.initialize(board);
  const firstWire = structuredClone(a.published); // wire form, exactly as the service stores it
  a.advance(6); await a.service.security(board); // pin epoch 2 locally
  const secondWire = structuredClone(a.published);
  void first;
  a.dropGrantRecord(); a.serve(firstWire);
  expect(await a.service.restoreAuthorityRecord(board)).toBe(false); // epoch rollback rejected
  expect(a.restoreRecord()).toBeUndefined();
  // A bundle signed by another key never matches the locally retained root.
  await stranger.service.initialize(`other-${crypto.randomUUID()}`);
  a.serve(stranger.published);
  expect(await a.service.restoreAuthorityRecord(board)).toBe(false);
  expect(a.restoreRecord()).toBeUndefined();
  // A device that never held this board's keys never adopts a valid grant.
  a.serve(secondWire);
  expect(await stranger.service.restoreAuthorityRecord(board)).toBe(false);
  // And with the service cache gone (restart), nothing restores or is written.
  const fresh = client(); await fresh.enable();
  fresh.clear();
  expect(await fresh.service.restoreAuthorityRecord(board)).toBe(false);
  expect(fresh.restoreRecord()).toBeUndefined();
});

it('never overwrites an existing grant record, valid or conflicting', async () => {
  const { client } = setup(), a = client(); await a.enable();
  const board = `restore-${crypto.randomUUID()}`, first = await a.service.initialize(board);
  expect(await a.service.restoreAuthorityRecord(board)).toBe(false);
  expect((await a.service.localBundle(board))!.history).toEqual(first.history);
  const attacker = client(); await attacker.enable();
  expect(await attacker.service.restoreAuthorityRecord(board)).toBe(false);
  expect((await a.service.localBundle(board))!.history).toEqual(first.history);
});

it('a restored record survives the service object being recreated and keeps owning the board', async () => {
  const { client } = setup(), a = client(); await a.enable();
  const board = `restore-${crypto.randomUUID()}`; await a.service.initialize(board);
  a.dropGrantRecord();
  expect(await a.service.restoreAuthorityRecord(board)).toBe(true);
  const afterRestart = a.make();
  expect(await afterRestart.localBundle(board)).not.toBeNull();
  expect(await afterRestart.ownsAuthority(board)).toBe(true);
  expect(await afterRestart.role(board)).toBe('owner');
});

it('creation on a blocked board queues a private creation draft and admits it after the authority is restored', async () => {
  const cloud = new DriveFixture(), device = await openDevice(cloud);
  const board = await device.repo.createProject('Restore board', 'project');
  try {
    await device.grants.configure({ provider: 'websocket', url: 'wss://relay.example.test/ws' });
    await device.grants.initialize(board.id);
    const first = (await device.grants.security(board.id))!;
    await device.repo.installBoardSecurity({ security: first });
    await device.repo.addItem({ projectId: board.id, content: 'established history' }); // genuinely signed locally
    await device.restart();
    delete device.storage.data.pboardBoardGrants;
    const repo = device.repo;
    await expect(repo.addItem({ projectId: board.id, content: 'blocked without authority' }))
      .resolves.toBeTruthy(); // local-first: queued, never dropped
    const drafts = (await repo.journal.pendingEdits.toArray()).filter(edit => edit.boardId === board.id);
    const cardDraft = drafts.find(edit => edit.base.collection === 'cards')!;
    expect(cardDraft.creation).toBe(true);
    expect(cardDraft.authorityKeyId).toBe(first.manifest.authorityKeyId);
    expect((cardDraft.value as Record<string, unknown>).content).toBe('blocked without authority');
    expect(await repo.db.cards.findOne(cardDraft.base.documentId).exec()).toBeNull(); // private work, not a local fake-signature
    // Reopen the board: the manager's security path restores the lost record
    // and re-authorizes; the queued creation is admitted as a signed change.
    // The service cache is gone entirely — the device's own verified chain
    // (journal publicGrants, written at guard install) carries the restore.
    device.setPublished(undefined);
    expect(await device.grants.restoreAuthorityRecord(board.id)).toBe(true);
    const restored = (await device.grants.security(board.id))!;
    await repo.installBoardSecurity({ security: restored });
    await repo.admitPendingWork(board.id);
    const card = await repo.db.cards.findOne(cardDraft.base.documentId).exec();
    expect(card).not.toBeNull();
    expect((card!.toJSON() as Record<string, unknown>).content).toBe('blocked without authority');
    expect((await repo.journal.pendingEdits.toArray())
      .filter(edit => edit.boardId === board.id).every(edit => edit.admittedChangeId)).toBe(true);
    const changes = await repo.journal.entries.where('boardId').equals(board.id).toArray();
    expect(changes.some(change => change.documentId === cardDraft.base.documentId && (change.value as Record<string, unknown>)._sec)).toBe(true);
  } finally { await device.repo.db.close(); }
});

it('creation without any offline permission evidence stays refused', async () => {
  const { createRxRepository } = await import('../../src/storage/rxdbRepository');
  const repo = await createRxRepository({ name: `restore-${crypto.randomUUID()}` });
  try {
    const board = await repo.createProject('Signed board', 'project');
    const { makeChange } = await import('../../src/storage/changeJournal');
    await repo.journal.accept([{ ...(await makeChange({ boardId: board.id, collection: 'cards', documentId: 'foreign-card',
      parents: [], ancestry: 'known', value: { id: 'foreign-card', projectId: board.id, content: 'signed', _sec: { signature: 's' } } })),
      state: 'committed' as const, origin: 'observed' as const }]);
    await expect(repo.addItem({ projectId: board.id, content: 'nope' })).rejects.toThrow('Current board authorization is required');
    expect((await repo.journal.pendingEdits.toArray()).filter(edit => edit.boardId === board.id)).toHaveLength(0);
  } finally { await repo.db.close(); }
});
