import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { installLiveBoardMutations, verifyLiveBoardVariant, withUntrustedImport } from '../../src/collab/security/liveMutations';
import { makeChange } from '../../src/storage/changeJournal';
import { verifyMutation, signMutation, createMutationReplayCache } from '../../src/collab/security/mutation';
import { verifyJournalChange } from '../../src/collab/security/journalProof';
import { createBackendProjectSnapshotStore } from '../../src/sync/snapshot';

const repos: RxRepository[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const repo of repos.splice(0)) await repo.db.close(); });
async function setup(resolveDeletionRole?: (projectId: string) => Promise<'owner' | 'editor' | 'viewer'>) {
  const name = `offlineauthorization${crypto.randomUUID()}`;
  let repo = await createRxRepository({ name, resolveDeletionRole }); repos.push(repo);
  const board = await repo.createProject('Shared offline work', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'Original content' });
  const key = await generateDeviceKey();
  const manifest = { protocol: 2 as const, boardId: board.id, authorityKeyId: key.keyId, driveProjectFileId: '', driveFolderId: '',
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' as 'owner' | 'editor' | 'viewer' }] };
  let security = { boardId: board.id, manifest, signer: { deviceKeyId: key.keyId, privateJwk: key.privateJwk }, ownSessionId: 'test', manifestHistory: new Map([[1, manifest]]) };
  let guard = await installLiveBoardMutations({ projectId: board.id, cards: repo.db.cards, projects: repo.db.projects, security, attestExisting: true });
  async function renew(role: 'owner' | 'editor' | 'viewer' = 'owner', differentDevice = false) {
    await guard.uninstall();
    const own = differentDevice ? await generateDeviceKey() : key;
    const next = { ...manifest, epoch: security.manifest.epoch + 1, issuedAt: Date.now(), expiresAt: Date.now() + 300000,
      devices: [{ deviceKeyId: own.keyId, publicKey: own.publicJwk, role }] };
    security = { ...security, manifest: next, signer: { deviceKeyId: own.keyId, privateJwk: own.privateJwk }, manifestHistory: new Map([...security.manifestHistory, [next.epoch, next]]) };
    guard = await installLiveBoardMutations({ projectId: board.id, cards: repo.db.cards, projects: repo.db.projects, security });
  }
  return { board, card, key, manifest, get repo() { return repo; }, get security() { return security; },
    expire() { vi.spyOn(Date, 'now').mockReturnValue(manifest.expiresAt + 1); }, renew,
    async restart() { await guard.uninstall(); await repo.db.close(); repo = await createRxRepository({ name, resolveDeletionRole }); repos.push(repo); },
    async stop() { await guard.uninstall(); } };
}
it('keeps pending edits outside replicated documents and Drive snapshots, visible/exportable after restart', async () => {
  const f = await setup(); const raw = (await f.repo.db.cards.findOne(f.card.id).exec())!.toJSON();
  f.expire(); await f.repo.updateItem(f.card.id, { content: 'First draft' }); await f.repo.updateItem(f.card.id, { title: 'Offline title', content: 'Latest draft' });
  expect((await f.repo.db.cards.findOne(f.card.id).exec())!.toJSON()).toEqual(raw);
  const snapshots = createBackendProjectSnapshotStore({ get: async () => ({}), set: async () => {} }, async () => f.repo);
  expect((await snapshots.read(f.board.id)).items[0].content).toBe('Original content');
  expect((await f.repo.exportProject(f.board.id)).items[0].content).toBe('Latest draft');
  expect((await f.repo.journal.pendingEdits.toArray()).filter(e => e.base.documentId === f.card.id)).toHaveLength(2);
  await f.restart(); expect(await f.repo.getCard(f.card.id)).toMatchObject({ title: 'Offline title', content: 'Latest draft' });
});
it('admits pending work only under renewed authorization, with original base and one stable operation', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Pending edit' });
  const pending = (await f.repo.journal.pendingEdits.toArray()).find(e => e.base.documentId === f.card.id)!;
  await expect(f.repo.admitPendingWork(f.board.id)).rejects.toThrow('authorization');
  await f.renew(); await f.repo.admitPendingWork(f.board.id);
  const entry = (await f.repo.journal.entries.toArray()).find(e => e.value.content === 'Pending edit')!;
  expect(entry.parents).toEqual([pending.base.id]);
  await expect(verifyJournalChange(entry, entry.proof, f.security)).resolves.toBeUndefined();
  expect((await f.repo.db.cards.findOne(f.card.id).exec())?.content).toBe('Pending edit');
  const count = await f.repo.journal.entries.count(); await f.repo.admitPendingWork(f.board.id);
  expect(await f.repo.journal.entries.count()).toBe(count);
  await f.restart(); expect((await f.repo.getCard(f.card.id))?.content).toBe('Pending edit');
});
it('preserves concurrent remote work when admitting an offline branch instead of replacing it', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Offline branch' });
  const pending = (await f.repo.journal.pendingEdits.toArray()).find(e => e.base.documentId === f.card.id)!; await f.renew();
  const value = await signMutation({ ...pending.base.value, content: 'Concurrent remote branch' }, f.security.signer,
    { boardId: f.board.id, collection: 'cards', manifest: f.security.manifest, sequence: 55 });
  const remote = await makeChange({ boardId: f.board.id, collection: 'cards', documentId: f.card.id, ancestry: 'known', parents: [pending.base.id], value });
  await f.repo.journal.accept([{ ...pending.base, state: 'committed', origin: 'baseline' }]);
  await f.repo.reconciliation.receive([remote], async change => {
    await verifyMutation(change.value, { boardId: f.board.id, collection: 'cards', manifest: f.security.manifest }, createMutationReplayCache()); return true;
  });
  await f.repo.admitPendingWork(f.board.id);
  const result = await f.repo.reconciliation.inspect({ boardId: f.board.id, collection: 'cards', documentId: f.card.id });
  expect(result.kind).toBe('conflict'); expect(result.variants.map(v => v.value.content).sort()).toEqual(['Concurrent remote branch', 'Offline branch']);
});
it('keeps downgraded work private/exportable and viewer restrictions through stop and restart', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Unadmitted work' }); await f.renew('viewer');
  await expect(f.repo.admitPendingWork(f.board.id)).rejects.toThrow('view-only');
  await f.stop(); await f.repo.setMutatorRole(f.board.id, null); await f.restart();
  await expect(f.repo.updateItem(f.card.id, { content: 'Forbidden' })).rejects.toThrow('view-only');
  expect((await f.repo.exportProject(f.board.id)).items[0].content).toBe('Unadmitted work');
  expect((await f.repo.journal.entries.toArray()).some(e => e.value.content === 'Unadmitted work')).toBe(false);
});
it('cannot re-sign another device pending work, even under the same authority', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Original device draft' }); await f.renew('editor', true);
  await expect(f.repo.admitPendingWork(f.board.id)).resolves.toBeUndefined();
  expect((await f.repo.journal.pendingEdits.toArray()).find(e => e.base.documentId === f.card.id)!.admittedChangeId).toBeUndefined();
});
it('buffers shared structural commands without publishing and preserves source documents', async () => {
  const f = await setup(); f.expire();
  const added = await f.repo.addItem({ projectId: f.board.id, content: 'Local pending card' });
  await f.repo.deleteItem(f.card.id);
  expect((await f.repo.listCards(f.board.id)).map(c => c.id)).toEqual([added.id]);
  expect(await f.repo.db.cards.findOne(added.id).exec()).toBeNull();
  expect((await f.repo.db.cards.findOne(f.card.id).exec())?.content).toBe('Original content');
});
it('does not infer editing entitlement from restored signed content', async () => {
  const f = await setup(); const backup = await f.repo.exportProject(f.board.id);
  const fresh = await createRxRepository({ name: `freshsigned${crypto.randomUUID()}` }); repos.push(fresh);
  await fresh.importProject(backup.project, backup.items);
  expect((await fresh.getCard(f.card.id))?.content).toBe('Original content');
  await expect(fresh.updateItem(f.card.id, { content: 'Google login is not a grant' })).rejects.toThrow('authorization');
});

it('retains local verified historical admission after removal, but rejects newly presented timestamp claims', async () => {
  const f = await setup(), author = await generateDeviceKey();
  f.manifest.devices.push({ deviceKeyId: author.keyId, publicKey: author.publicJwk, role: 'editor' });
  const previous = (await f.repo.db.cards.findOne(f.card.id).exec())!;
  const received = await signMutation({ ...previous.toJSON(), content: 'Previously admitted' }, { privateJwk: author.privateJwk, deviceKeyId: author.keyId },
    { boardId: f.board.id, collection: 'cards', manifest: f.manifest, sequence: 10 });
  await withUntrustedImport([f.repo.db.cards], () => previous.incrementalModify(() => received));
  const evidenceCount = await f.repo.journal.admissions.count(); expect(evidenceCount).toBeGreaterThan(0);
  await f.restart(); await f.renew(); // New epoch removes the remote author; no receipt is imported from outside.
  await expect(verifyLiveBoardVariant(f.repo.db.cards, f.board.id, received)).resolves.toBeUndefined();
  const late = await signMutation({ ...received, content: 'Unadmitted timestamp claim' }, { privateJwk: author.privateJwk, deviceKeyId: author.keyId },
    { boardId: f.board.id, collection: 'cards', manifest: f.manifest, sequence: 11, now: f.manifest.issuedAt });
  await expect(verifyLiveBoardVariant(f.repo.db.cards, f.board.id, late)).rejects.toThrow('not authorized');
  expect(await f.repo.journal.admissions.count()).toBe(evidenceCount);
});
it('confirmed removal blocks further drafts without deleting existing pending work', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Keep this pending work' });
  const previous = (await f.repo.journal.permissions.get(f.board.id))!;
  await f.repo.journal.permissions.put({ ...previous, role: 'revoked' }); await f.restart();
  await expect(f.repo.updateItem(f.card.id, { content: 'No further shared edits' })).rejects.toThrow('removed');
  await expect(f.repo.admitPendingWork(f.board.id)).rejects.toThrow('removed');
  expect((await f.repo.exportProject(f.board.id)).items[0].content).toBe('Keep this pending work');
});
it('retries a crash after admission without re-signing the already durable operation', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Crash-safe admission' }); await f.renew();
  const update = vi.spyOn(f.repo.journal.pendingEdits, 'update').mockRejectedValueOnce(new Error('simulated crash before pending acknowledgement'));
  await expect(f.repo.admitPendingWork(f.board.id)).rejects.toThrow('simulated crash'); update.mockRestore(); 
  const entry = (await f.repo.journal.entries.toArray()).find(e => e.value.content === 'Crash-safe admission')!;
  const count = await f.repo.journal.entries.where("[collection+documentId]").equals(["cards", f.card.id]).count(); await f.restart(); await f.renew(); await f.repo.admitPendingWork(f.board.id);
  expect(await f.repo.journal.entries.get(entry.id)).toEqual(entry); expect(await f.repo.journal.entries.where("[collection+documentId]").equals(["cards", f.card.id]).count()).toBe(count);
  expect((await f.repo.getCard(f.card.id))?.content).toBe('Crash-safe admission');
});
it('hiding a cached board without current authority never deletes shared documents or pending work', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Do not discard' }); await f.stop();
  await f.repo.deleteProject(f.board.id);
  expect(await f.repo.db.projects.findOne(f.board.id).exec()).not.toBeNull(); expect(await f.repo.db.cards.findOne(f.card.id).exec()).not.toBeNull();
  expect((await f.repo.exportPendingWork(f.board.id)).edits.find(e => e.base.documentId === f.card.id)!.value.content).toBe('Do not discard');
});

it('recovers admission acknowledged before its RxDB projection without losing the pending operation', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Durable unprojected admission' }); await f.renew();
  const apply = vi.spyOn(f.repo.privateRecovery, 'apply').mockRejectedValueOnce(new Error('simulated crash before projection'));
  await expect(f.repo.admitPendingWork(f.board.id)).rejects.toThrow('before projection'); apply.mockRestore();
  const pending = (await f.repo.journal.pendingEdits.toArray()).find(e => e.base.documentId === f.card.id)!; expect(pending.admittedChangeId).toBeTruthy(); expect(pending.projected).toBeUndefined();
  expect((await f.repo.db.cards.findOne(f.card.id).exec())?.content).toBe('Original content');
  await f.restart(); await f.renew(); await f.repo.admitPendingWork(f.board.id);
  expect((await f.repo.db.cards.findOne(f.card.id).exec())?.content).toBe('Durable unprojected admission');
  expect((await f.repo.journal.pendingEdits.get(pending.id))?.projected).toBe(true);
});

it('restoring a hidden board exposes its retained pending and conflict evidence again', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Evidence survives removal' }); await f.renew('editor'); await f.stop();
  await f.repo.deleteProject(f.board.id); // An editor removes only their own list copy; content stays.
  const pending = await f.repo.listPendingWork();
  expect(pending.filter(e => e.boardId === f.board.id).every(e => e.boardMissing && e.canReview === false)).toBe(true);
  await f.repo.unhideProject(f.board.id);
  expect(await f.repo.isDeletedProject(f.board.id)).toBe(false);
  expect((await f.repo.listPendingWork()).find(e => e.base.documentId === f.card.id)).toMatchObject({ boardMissing: false });
  expect((await f.repo.getCard(f.card.id))?.content).toBe('Evidence survives removal');
});

it('a conflict on a board without any list handle becomes retained evidence with a restore path', async () => {
  const f = await setup();
  // Two concurrent branches from one signed base: the journal retains both as a
  // durable conflict (same parents, different values, no descendant relation).
  await f.renew('editor');
  const base = (await f.repo.journal.entries.where('[collection+documentId]').equals(['cards', f.card.id]).toArray()).at(-1)!;
  const { makeChange } = await import('../../src/storage/changeJournal');
  for (const [index, content] of ['Held branch A', 'Held branch B'].entries()) {
    await (f.repo as never as { journal: { accept(entries: unknown[]): Promise<void> } }).journal.accept([
      { ...(await makeChange({ boardId: f.board.id, collection: 'cards' as const, documentId: f.card.id, parents: [base.id], ancestry: 'known' as const,
        value: { ...base.value, content, updatedAt: new Date(Date.now() + index + 1).toISOString() } })), state: 'committed' as const, origin: 'observed' as const },
    ]);
  }
  await f.stop();
  // The board disappears from the list (hidden) — evidence, not a broken panel.
  await f.repo.deleteProject(f.board.id);
  const conflicts = await f.repo.listConflicts();
  const onBoard = conflicts.filter(c => c.boardId === f.board.id);

  expect(onBoard.length).toBeGreaterThan(0);
  for (const conflict of onBoard) {
    expect(conflict.boardMissing).toBe(true);
    expect(conflict.restriction).toContain('Restore this board');
  }
  expect((await f.repo.listPendingWork()).filter(e => e.boardId === f.board.id).every(e => e.boardMissing)).toBe(true);
  // Restore re-opens the handle: the versions and the conflict come back actionable.
  await f.repo.unhideProject(f.board.id);
  expect((await f.repo.listConflicts()).filter(c => c.boardId === f.board.id).every(c => !c.boardMissing)).toBe(true);
});

it('a restored board survives later preference merges carrying older deletion markers', async () => {
  const { mergeProjectOrder, parseProjectOrder } = await import('../../src/storage/projectOrder');
  const f = await setup(); await f.renew('editor'); await f.stop();
  await f.repo.deleteProject(f.board.id);
  await f.repo.unhideProject(f.board.id);
  expect(await f.repo.isDeletedProject(f.board.id)).toBe(false);
  // The Drive preference copy still knows the deletion; merging re-applies only
  // markers newer than the restore, so the restored row stays visible.
  const staleRemote = parseProjectOrder(JSON.stringify({ ids: [], updatedAt: '2026-01-01T00:00:00.000Z', deletedProjectIds: [f.board.id] }));
  const localRaw = await (f.repo as unknown as { db: { settings: { findOne: (id: string) => { exec(): Promise<{ value?: string } | null> } } } }).db.settings.findOne('localProjectOrder').exec();
  const localPreference = parseProjectOrder(localRaw?.value ?? '{"ids":[],"updatedAt":"1970-01-01T00:00:00.000Z"}');
  const merged = mergeProjectOrder(staleRemote, { ids: localPreference.ids ?? [], updatedAt: localPreference.updatedAt ?? new Date().toISOString(),
    restoreEvents: localPreference.restoreEvents });
  expect(merged.deletedProjectIds ?? []).not.toContain(f.board.id);
  expect(merged.ids).toContain(f.board.id);
  await f.repo.applyProjectOrder('account-a', staleRemote);
  expect(await f.repo.isDeletedProject(f.board.id)).toBe(false);
});

it('restoring a hard-removed board rebuilds its pre-deletion rows from retained history', async () => {
  const f = await setup(); await f.renew('owner'); // Keep guards live so the owner's delete hard-removes documents.
  await f.repo.deleteProject(f.board.id);
  expect((await f.repo.db.projects.find().exec()).length).toBe(0);
  await f.repo.unhideProject(f.board.id);
  expect((await f.repo.db.projects.find().exec()).map(d => d.toJSON().id)).toContain(f.board.id);
  const list = (await f.repo.listProjects()).map(p => p.id);
  expect(list).toContain(f.board.id);
  // Retained conflict/concurrent evidence still exists per document after restore.
  expect((await f.repo.listConflicts()).filter(c => c.boardId === f.board.id).every(c => !c.boardMissing)).toBe(true);
});

it('keeps owner deletion signed when sidebar selection teardown follows board removal', async () => {
  const f = await setup();
  const teardown: Promise<void>[] = [];
  const stop = f.repo.subscribeProjects(projects => {
    if (!projects.some(p => p.id === f.board.id)) teardown.push(f.stop());
  });
  try {
    await f.repo.deleteProject(f.board.id);
    await Promise.all(teardown);
    expect(await f.repo.db.projects.findOne(f.board.id).exec()).toBeNull();
    expect((await f.repo.db.cards.findOne(f.card.id).exec())?.deletedAt).toBeTruthy();
    const tombstones = (await f.repo.journal.entries.where('boardId').equals(f.board.id).toArray()).filter(e => e.value._deleted || e.value.deletedAt);
    expect(tombstones.some(e => e.collection === 'projects')).toBe(true);
    expect(tombstones.every(e => !!e.value._sec)).toBe(true);
  } finally { stop(); }
});


it('uses verified independent board grants for removal without consulting Drive ACLs', async () => {
  const acl = vi.fn(async (): Promise<'owner'> => { throw Error('Independent boards must not consult Drive ACLs'); });
  const f = await setup(acl);
  await f.repo.deleteProject(f.board.id);
  expect(acl).not.toHaveBeenCalled();
  expect(await f.repo.db.projects.findOne(f.board.id).exec()).toBeNull();
  expect((await f.repo.db.cards.findOne(f.card.id).exec())?.deletedAt).toBeTruthy();
});

it('retains restore evidence when a different board is removed or the list is reordered', async () => {
  const f = await setup();
  await f.repo.deleteProject(f.board.id); await f.repo.unhideProject(f.board.id);
  const previous = JSON.parse((await f.repo.db.settings.findOne('localProjectOrder').exec())!.value);
  expect(previous.restoreEvents[f.board.id]).toBeTruthy();
  const other = await f.repo.createProject('Unrelated board');
  await f.repo.deleteProject(other.id);
  await f.repo.reorderProjects([f.board.id]);
  const current = JSON.parse((await f.repo.db.settings.findOne('localProjectOrder').exec())!.value);
  expect(current.restoreEvents).toEqual(previous.restoreEvents);
  expect(await f.repo.isDeletedProject(f.board.id)).toBe(false);
});

it('reads pending recovery metadata once per visible board without scanning its change history', async () => {
  const f = await setup(); f.expire();
  await f.repo.updateItem(f.card.id, { content: 'Retained offline edit' });
  await f.repo.addItem({ projectId: f.board.id, content: 'Another offline edit' });
  const history = vi.spyOn(f.repo.journal.entries, 'where');
  const permissions = vi.spyOn(f.repo.journal.permissions, 'get');
  const pending = await f.repo.listPendingWork();
  expect(pending.length).toBeGreaterThan(1);
  expect(pending.every(edit => edit.boardName === f.board.name)).toBe(true);
  expect(history.mock.calls.filter(([index]) => index === 'boardId')).toHaveLength(0);
  expect(permissions.mock.calls.filter(([id]) => id === f.board.id)).toHaveLength(1);
});

it('bounds pending-panel reads during a burst of journal notifications and refreshes after the burst', async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // The panel reads the pending-edit table through a shared copy, so the
  // table is read once for a whole burst. The journal read is the seam: the
  // burst must not cause one table scan per notification.
  const original = f.repo.journal.pendingEdits.toArray.bind(f.repo.journal.pendingEdits);
  const reads = vi.spyOn(f.repo.journal.pendingEdits, 'toArray').mockImplementationOnce(async () => { await gate; return original(); });
  const receive = vi.fn();
  const stop = f.repo.subscribePendingWork(receive);
  try {
    // The panel's first read populates the shared copy.
    await vi.waitFor(() => expect(receive).toHaveBeenCalledWith([]));
    const permission = (await f.repo.journal.permissions.get(f.board.id))!;
    for (let i = 0; i < 12; i++) await f.repo.journal.permissions.put(permission);
    // The permissions table is not the pending-edit table, so the shared copy
    // stays valid and the burst costs no further table scan.
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
  } finally { release(); stop(); }
});

it('journals the offline command without re-journaling every scratchpad seed document', async () => {
  const f = await setup();
  for (let i = 0; i < 12; i++) await f.repo.addItem({ projectId: f.board.id, content: `Existing card ${i}` });
  f.expire();
  const { ChangeJournal } = await import('../../src/storage/changeJournal');
  const prepare = vi.spyOn(ChangeJournal.prototype, 'prepare');
  const card = await f.repo.addItem({ projectId: f.board.id, content: 'Durably held offline' });
  expect(prepare).toHaveBeenCalledTimes(2); // New card plus board ordering metadata.
  expect((await f.repo.listCards(f.board.id)).find(row => row.id === card.id)?.content).toBe('Durably held offline');
  expect(await f.repo.db.cards.findOne(card.id).exec()).toBeNull();
  await f.restart();
  expect((await f.repo.listCards(f.board.id)).find(row => row.id === card.id)?.content).toBe('Durably held offline');
});

it('reconstructs a restored pending receipt only from the exact verified signed admission', async () => {
  const f = await setup(); f.expire();
  await f.repo.updateItem(f.card.id, { content: 'Already synchronized draft' });
  await f.renew(); await f.repo.admitPendingWork(f.board.id);
  const admitted = (await f.repo.journal.pendingEdits.toArray()).find(e => e.base.documentId === f.card.id)!;
  const { admittedChangeId: _, projected: __, ...restored } = admitted;
  await f.repo.journal.pendingEdits.put(restored); // Immutable private archive predates admission.
  await f.renew('owner', true); // A replacement device must not re-sign the original author's draft.
  f.security.manifest.devices.push({ deviceKeyId: f.key.keyId, publicKey: f.key.publicJwk, role: 'editor' });
  await f.repo.admitPendingWork(f.board.id);
  expect((await f.repo.journal.pendingEdits.get(restored.id))?.admittedChangeId).toBe(admitted.admittedChangeId);
  expect(await f.repo.listPendingWork()).toEqual([]);
  await expect(f.repo.updateItem(f.card.id, { content: 'New replacement-device edit' })).resolves.toBeUndefined();
});

it('does not hide a changed restored draft behind another signed operation with the same pending ID', async () => {
  const f = await setup(); f.expire();
  await f.repo.updateItem(f.card.id, { content: 'Verified operation' });
  await f.renew(); await f.repo.admitPendingWork(f.board.id);
  const admitted = (await f.repo.journal.pendingEdits.toArray()).find(e => e.base.documentId === f.card.id)!;
  const { admittedChangeId: _, projected: __, ...restored } = admitted;
  await f.repo.journal.pendingEdits.put({ ...restored, value: { ...restored.value, content: 'Different retained content' } });
  await f.renew('owner', true); await f.repo.admitPendingWork(f.board.id);
  expect((await f.repo.journal.pendingEdits.get(restored.id))?.admittedChangeId).toBeUndefined();
  expect((await f.repo.listPendingWork()).some(edit => edit.value.content === 'Different retained content')).toBe(true);
});

it('explicitly discards removed-board pending work atomically including signed history and remembers erasure after restart', async () => {
  const f = await setup(); f.expire();
  await f.repo.updateItem(f.card.id, { content: 'Discard this held version' });
  await f.renew('viewer'); await f.repo.deleteProject(f.board.id);
  const reviewed = await f.repo.listPendingWork();
  expect(reviewed.length).toBeGreaterThan(0); expect(reviewed.every(edit => edit.boardMissing)).toBe(true);
  const originals = await f.repo.journal.pendingEdits.toArray();
  await Promise.all([
    f.repo.discardRemovedBoardWork(f.board.id, reviewed.map(edit => edit.id)),
    ...originals.map(edit => f.repo.journal.restorePendingWork(edit, () => {}))
  ]);
  expect(await f.repo.listPendingWork()).toEqual([]);
  expect(await f.repo.journal.pendingEdits.toArray()).toEqual([]);
  expect(await f.repo.journal.entries.toArray()).toEqual([]);
  expect(await f.repo.listConflicts()).toEqual([]);
  expect(await f.repo.listCards(f.board.id)).toEqual([]);
  expect(await f.repo.getProject(f.board.id)).toBeNull();
  await f.restart();
  for (const edit of originals) await f.repo.journal.restorePendingWork(edit, () => { throw Error('Discarded data must be skipped'); });
  expect(await f.repo.listPendingWork()).toEqual([]);
  expect(await f.repo.journal.pendingEdits.toArray()).toEqual([]);
});

it('rejects permanent disposal of a visible board and aborts deletion if its reviewed pending heads change', async () => {
  const f = await setup(); f.expire(); await f.repo.updateItem(f.card.id, { content: 'Keep pending content' });
  const ids = (await f.repo.listPendingWork()).map(edit => edit.id);
  await expect(f.repo.discardRemovedBoardWork(f.board.id, ids)).rejects.toThrow('Remove this board');
  await f.renew('viewer'); await f.repo.deleteProject(f.board.id);
  const before = await f.repo.journal.pendingEdits.toArray();
  await expect(f.repo.discardRemovedBoardWork(f.board.id, ['stale-review'])).rejects.toThrow('Retained work changed');
  expect(await f.repo.journal.pendingEdits.toArray()).toEqual(before);
  expect(await f.repo.journal.receipts.where('destination').equals(`local-pending-discard:${f.board.id}`).toArray()).toEqual([]);
});

// A signed "independent" board pulled with collaboration sharing off never
// consults the Drive ACL for roles — but if the board is Drive-shared (its
// usual origin), a collaborator whose Drive permission is editor/viewer must
// not destroy the shared content on delete. The repository re-checks via
// `reverifySharedDeletionRole`; unverifiable verdicts keep the grant's say.
async function sharedSetup(reverify: (projectId: string) => Promise<'owner' | 'editor' | 'viewer' | null>) {
  const name = `signedleave${crypto.randomUUID()}`;
  const events: string[] = [];
  const repo = await createRxRepository({ name, reverifySharedDeletionRole: reverify,
    events: { projectDeleting: async () => { events.push('deleting'); }, projectDeleted: async () => { events.push('deleted'); }, projectHidden: async () => { events.push('hidden'); } } });
  repos.push(repo);
  const board = await repo.createProject('Signed but Drive-shared', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'Shared content' });
  const key = await generateDeviceKey();
  const manifest = { protocol: 2 as const, boardId: board.id, authorityKeyId: key.keyId, driveProjectFileId: '', driveFolderId: '',
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' as 'owner' | 'editor' | 'viewer' }] };
  const security = { boardId: board.id, manifest, signer: { deviceKeyId: key.keyId, privateJwk: key.privateJwk }, ownSessionId: 'test', manifestHistory: new Map([[1, manifest]]) };
  const guard = await installLiveBoardMutations({ projectId: board.id, cards: repo.db.cards, projects: repo.db.projects, security, attestExisting: true });
  return { board, card, events, guard, repo };
}

it('hides instead of deleting when the Drive ACL reports a non-owner for a signed board', async () => {
  const f = await sharedSetup(async () => 'editor');
  await f.repo.deleteProject(f.board.id);
  expect(f.events).toEqual(['hidden']);
  expect((await f.repo.db.cards.findOne(f.card.id).exec())?.deletedAt).toBeFalsy();
  expect(await f.repo.isDeletedProject(f.board.id)).toBe(true);
  await f.guard.uninstall();
});

it('keeps the verified grant verdict when the Drive recheck fails, and honours owner/not-shared', async () => {
  const denied = await sharedSetup(async () => { throw new Error('Drive unreachable'); });
  await denied.repo.deleteProject(denied.board.id);
  expect(denied.events).toEqual(['deleting', 'deleted']);
  await denied.guard.uninstall();
  const sharedOwner = await sharedSetup(async () => 'owner');
  await sharedOwner.repo.deleteProject(sharedOwner.board.id);
  expect(sharedOwner.events).toEqual(['deleting', 'deleted']);
  await sharedOwner.guard.uninstall();
  const privateBoard = await sharedSetup(async () => null);
  await privateBoard.repo.deleteProject(privateBoard.board.id);
  expect(privateBoard.events).toEqual(['deleting', 'deleted']);
  await privateBoard.guard.uninstall();
});
