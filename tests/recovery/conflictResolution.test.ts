import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { makeChange, scope } from '../../src/storage/changeJournal';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { installLiveBoardMutations } from '../../src/collab/security/liveMutations';
import { signMutation, verifyMutation, createMutationReplayCache } from '../../src/collab/security/mutation';
import { signManifest, verifyManifest } from '../../src/collab/security/manifest';

const repos: RxRepository[] = [];
afterEach(async () => { for (const repo of repos.splice(0)) await repo.db.close(); });
async function fixture(secured = false) {
  const name = `resolution-${crypto.randomUUID()}`;
  const repo = await createRxRepository({ name }); repos.push(repo);
  const board = await repo.createProject('Conflicts', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'Common content' });
  const key = await generateDeviceKey();
  const manifest = { protocol: 2 as const, boardId: board.id, driveProjectFileId: '', driveFolderId: '', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' as 'owner' | 'editor' | 'viewer' }] };
  const signer = { deviceKeyId: key.keyId, privateJwk: key.privateJwk };
  const guard = secured ? await installLiveBoardMutations({ projectId: board.id, cards: repo.db.cards, projects: repo.db.projects,
    attestExisting: true, security: { boardId: board.id, signer, manifest, ownSessionId: 'test' } }) : null;
  const target = { boardId: board.id, collection: 'cards' as const, documentId: card.id };
  const root = (await repo.reconciliation.inspect(target)).variants[0];
  await repo.updateItem(card.id, { content: 'Local edit' });
  let value = { ...root.value, content: 'Other edit' };
  if (secured) value = await signMutation(value, signer, { boardId: board.id, collection: 'cards', manifest, sequence: 100 });
  const other = await makeChange({ ...target, ancestry: 'known', parents: [root.id], value });
  await repo.reconciliation.receive([other], secured ? async change => {
    await verifyMutation(change.value, { boardId: board.id, collection: 'cards', manifest }, createMutationReplayCache()); return true;
  } : async () => true); // Explicit trusted local graph fixture, not a transport implementation.
  return { repo, board, card, target, root, other, manifest, signer, guard, name };
}

it('resolves a real private card, retains every source variant, and survives restart', async () => {
  let { repo, other, target, name } = await fixture();
  const conflict = (await repo.listConflicts())[0]; expect(conflict.restriction).toBeNull();
  const original = await repo.journal.entries.toArray();
  await repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id, edits: { title: 'Reviewed', content: 'Manually combined' } });
  expect((await repo.getCard(target.documentId))?.content).toBe('Manually combined');
  const resolution = (await repo.reconciliation.inspect(target)).variants[0];
  expect(resolution.parents.sort()).toEqual(conflict.result.heads.sort());
  expect(await repo.listConflicts()).toEqual([]);
  for (const variant of original) expect(await repo.journal.entries.get(variant.id)).toEqual(variant);
  await repo.db.close(); repo = await createRxRepository({ name }); repos.push(repo);
  expect((await repo.getCard(target.documentId))?.content).toBe('Manually combined');
  expect((await repo.reconciliation.inspect(target)).heads).toEqual([resolution.id]);
});

it('signs a new authorized resolution with all reviewed parents, preserving original author signatures', async () => {
  const { repo, target, other, signer, manifest, guard } = await fixture(true);
  const conflict = (await repo.listConflicts())[0]; expect(conflict.restriction).toBeNull();
  const old = await repo.journal.entries.get(other.id);
  await repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id });
  const value = (await repo.db.cards.findOne(target.documentId).exec())!.toJSON();
  const proof = await verifyMutation(value, { boardId: target.boardId, collection: 'cards', manifest }, createMutationReplayCache());
  expect(proof.authorKeyId).toBe(signer.deviceKeyId); expect(proof.parents.sort()).toEqual(conflict.result.heads.sort());
  expect(await repo.journal.entries.get(other.id)).toEqual(old);
  expect((await repo.reconciliation.inspect(target)).kind).toBe('current');
  await repo.updateItem(target.documentId, { title: 'Ordinary later edit' });
  expect((await repo.db.cards.findOne(target.documentId).exec())!.toJSON()._sec?.provenance.parents).toEqual([]);
  await guard?.uninstall();
});

it('allows an independently authorized editor to resolve card text, but reserves board-deletion decisions for the owner', async () => {
  const { repo, target, other, signer: ownerSigner, manifest: initial, guard } = await fixture(true);
  await guard?.uninstall();
  const editor = await generateDeviceKey();
  const signed = await signManifest({ ...initial, epoch: 2, issuedAt: Date.now(), expiresAt: Date.now() + 300000,
    devices: [...initial.devices, { deviceKeyId: editor.keyId, publicKey: editor.publicJwk, role: 'editor' }] }, ownerSigner);
  const manifest = await verifyManifest(signed, initial.devices[0].publicKey, initial.authorityKeyId);
  const signer = { privateJwk: editor.privateJwk, deviceKeyId: editor.keyId };
  const installed = await installLiveBoardMutations({ projectId: target.boardId, cards: repo.db.cards, projects: repo.db.projects,
    security: { boardId: target.boardId, signer, manifest, manifestHistory: new Map([[1, initial], [2, manifest]]), ownSessionId: 'editor-test' } });
  try {
    const conflict = (await repo.listConflicts())[0]; expect(conflict.restriction).toBeNull();
    await repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id, edits: { title: '', content: 'Editor resolution' } });
    const value = (await repo.db.cards.findOne(target.documentId).exec())!.toJSON();
    const proof = await verifyMutation(value, { boardId: target.boardId, collection: 'cards', manifest }, createMutationReplayCache());
    expect(proof.authorKeyId).toBe(editor.keyId); expect(proof.parents.sort()).toEqual(conflict.result.heads.sort());
    const projectTarget = { boardId: target.boardId, collection: 'projects' as const, documentId: target.boardId };
    const before = (await repo.reconciliation.inspect(projectTarget)).variants[0];
    const tombstone = await signMutation({ ...before.value, _deleted: true }, ownerSigner, { boardId: target.boardId, collection: 'projects', manifest, sequence: 100 });
    const deletion = await makeChange({ ...projectTarget, ancestry: 'known', parents: before.parents, value: tombstone });
    await repo.reconciliation.receive([deletion], async () => true);
    const boardConflict = (await repo.listConflicts()).find(c => c.collection === 'projects')!;
    expect(boardConflict.restriction).toContain('Only the board owner');
    await expect(repo.resolveConflict({ ...projectTarget, heads: boardConflict.result.heads, variantId: before.id })).rejects.toThrow('Only the board owner');
  } finally { await installed.uninstall(); }
});

it.each(['viewer', 'expired', 'revoked', 'uninstalled'] as const)('rejects %s authorization without changing documents or conflict evidence', async mode => {
  const { repo, target, other, manifest, guard } = await fixture(true);
  const conflict = (await repo.listConflicts())[0]; const before = await repo.journal.entries.toArray();
  const content = (await repo.getCard(target.documentId))?.content;
  if (mode === 'viewer') manifest.devices[0].role = 'viewer';
  if (mode === 'expired') manifest.expiresAt = Date.now() - 100000;
  if (mode === 'revoked') manifest.devices = [];
  if (mode === 'uninstalled') await guard?.uninstall();
  if (mode === 'expired' || mode === 'uninstalled') {
    await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id })).resolves.toBeUndefined();
    expect((await repo.journal.pendingEdits.toArray()).some(e => e.parents?.length === 2)).toBe(true);
    expect((await repo.db.cards.findOne(target.documentId).exec())?.content).toBe(content);
  } else {
    await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id })).rejects.toThrow();
    expect((await repo.getCard(target.documentId))?.content).toBe(content);
  }
  expect(await repo.journal.entries.toArray()).toEqual(before);
  await guard?.uninstall();
});

it('blocks a private viewer and rejects stale reviewed heads, unknown variants and cross-board requests', async () => {
  const { repo, target, other, root } = await fixture(); const conflict = (await repo.listConflicts())[0];
  repo.setMutatorRole(target.boardId, 'viewer');
  await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id })).rejects.toThrow('View-only');
  await repo.setMutatorRole(target.boardId, 'editor');
  await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: root.id })).rejects.toThrow('reviewed');
  await expect(repo.resolveConflict({ ...target, boardId: 'foreign', heads: conflict.result.heads, variantId: other.id })).rejects.toThrow();
  const third = await makeChange({ ...target, ancestry: 'known', parents: [root.id], value: { ...root.value, content: 'Third edit' } });
  await repo.reconciliation.receive([third], async () => true);
  await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id })).rejects.toThrow('changed');
  expect((await repo.reconciliation.inspect(target)).variants).toHaveLength(3);
});

it('retains separate manual drafts from two editor windows across restart and after new variants arrive', async () => {
  let { repo, target, other, root, name } = await fixture(); const conflict = (await repo.listConflicts())[0];
  for (const writerId of ['window-a', 'window-b']) await repo.saveConflictDraft(target, { writerId, heads: conflict.result.heads, variantId: other.id,
    title: writerId, content: `Unfinished ${writerId}` });
  await repo.db.close(); repo = await createRxRepository({ name }); repos.push(repo);
  let restored = (await repo.listConflicts())[0];
  expect(restored.drafts.map(d => d.content).sort()).toEqual(['Unfinished window-a', 'Unfinished window-b']);
  const third = await makeChange({ ...target, ancestry: 'known', parents: [root.id], value: { ...root.value, content: 'Third' } });
  await repo.reconciliation.receive([third], async () => true);
  restored = (await repo.listConflicts())[0];
  expect(restored.drafts).toHaveLength(2); expect(restored.drafts.every(d => d.target === scope(target))).toBe(true);
  expect(restored.drafts[0].heads).toEqual(conflict.result.heads);
});

it('resolves an edit/delete pair to a soft tombstone and can later explicitly restore a concurrent variant', async () => {
  const { repo, target, root } = await fixture();
  const deletion = await makeChange({ ...target, ancestry: 'known', parents: [root.id], value: { ...root.value, _deleted: true } });
  await repo.reconciliation.receive([deletion], async () => true);
  let conflict = (await repo.listConflicts())[0];
  await repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: deletion.id });
  expect((await repo.reconciliation.inspect(target)).kind).toBe('deleted');
  expect(await repo.getCard(target.documentId)).toBeNull();
  const late = await makeChange({ ...target, ancestry: 'known', parents: [root.id], value: { ...root.value, content: 'Late concurrent edit' } });
  await repo.reconciliation.receive([late], async () => true);
  conflict = (await repo.listConflicts())[0];
  await repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: late.id });
  expect((await repo.getCard(target.documentId))?.content).toBe('Late concurrent edit');
  expect((await repo.reconciliation.inspect(target)).kind).toBe('current');
});

it('rejects a foreign authority without re-signing its data or erasing the trusted variants', async () => {
  const { repo, target, root, guard } = await fixture(true);
  const foreign = await generateDeviceKey();
  const manifest = { protocol: 2 as const, boardId: target.boardId, driveProjectFileId: '', driveFolderId: '', authorityKeyId: foreign.keyId,
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: foreign.keyId, publicKey: foreign.publicJwk, role: 'owner' as const }] };
  const value = await signMutation({ ...root.value, content: 'Foreign signed data' }, { privateJwk: foreign.privateJwk, deviceKeyId: foreign.keyId },
    { boardId: target.boardId, collection: 'cards', manifest, sequence: 1 });
  const branch = await makeChange({ ...target, ancestry: 'known', parents: [root.id], value });
  await repo.reconciliation.receive([branch], async () => true); // Simulated retained foreign evidence, never admitted by a real network guard.
  const conflict = (await repo.listConflicts())[0]; const before = await repo.journal.entries.toArray();
  expect(conflict.restriction).toContain('current board authority');
  await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: branch.id })).rejects.toThrow('authority');
  expect(await repo.journal.entries.toArray()).toEqual(before);
  await guard?.uninstall();
});

it('preserves all resolution parents across a document-commit/journal-ack interruption', async () => {
  let { repo, target, other, name } = await fixture(); const conflict = (await repo.listConflicts())[0];
  vi.spyOn(repo.journal, 'finish').mockRejectedValueOnce(new Error('interrupted commit acknowledgement'));
  await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id })).rejects.toThrow();
  expect(await repo.journal.entries.where('state').equals('prepared').count()).toBe(1);
  await repo.db.close(); repo = await createRxRepository({ name }); repos.push(repo);
  const result = await repo.reconciliation.inspect(target);
  expect(result.kind).toBe('current'); expect(result.variants[0].parents.sort()).toEqual(conflict.result.heads.sort());
  expect(result.preview?.content).toBe('Other edit');
});

it('keeps a late concurrent resolution as another conflict rather than overwriting the resolved intention', async () => {
  const { repo, target, other } = await fixture(); const conflict = (await repo.listConflicts())[0];
  await repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: other.id, edits: { title: '', content: 'Resolution one' } });
  const concurrent = await makeChange({ ...target, ancestry: 'known', parents: conflict.result.heads, value: { ...other.value, content: 'Resolution two' } });
  await repo.reconciliation.receive([concurrent], async () => true);
  const next = (await repo.listConflicts())[0];
  expect(next.result.kind).toBe('conflict');
  expect(next.result.variants.map(v => v.value.content).sort()).toEqual(['Resolution one', 'Resolution two']);
});

it('resolves project names while preserving unsupported template/deletion decisions for later board-wide recovery', async () => {
  const { repo, board } = await fixture();
  const target = { boardId: board.id, collection: 'projects' as const, documentId: board.id };
  const ancestor = (await repo.reconciliation.inspect(target)).variants[0];
  const branch = await makeChange({ ...target, ancestry: 'known', parents: [ancestor.id], value: { ...ancestor.value, name: 'Alternative' } });
  await repo.renameProject(board.id, 'Local title'); await repo.reconciliation.receive([branch], async () => true);
  let conflict = (await repo.listConflicts()).find(c => c.collection === 'projects')!;
  await repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: branch.id, edits: { name: 'Reviewed title' } });
  expect((await repo.getProject(board.id))?.name).toBe('Reviewed title');
  const resolution = (await repo.reconciliation.inspect(target)).variants[0];
  const template = await makeChange({ ...target, ancestry: 'known', parents: [ancestor.id], value: { ...ancestor.value, template: 'idea' } });
  await repo.reconciliation.receive([template], async () => true);
  conflict = (await repo.listConflicts()).find(c => c.collection === 'projects')!;
  await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: template.id })).rejects.toThrow('template');
  const deletion = await makeChange({ ...target, ancestry: 'known', parents: [resolution.id], value: { ...resolution.value, _deleted: true } });
  await repo.reconciliation.receive([deletion], async () => true);
  conflict = (await repo.listConflicts()).find(c => c.collection === 'projects')!;
  await expect(repo.resolveConflict({ ...target, heads: conflict.result.heads, variantId: deletion.id })).rejects.toThrow('board-wide');
  expect((await repo.reconciliation.inspect(target)).kind).toBe('conflict');
});

it('upgrades a v1 journal additively, retaining committed values and delivery receipts', async () => {
  const { repo, target } = await fixture(); const entries = await repo.journal.entries.toArray();
  const name = `journal-upgrade-${crypto.randomUUID()}`; const databaseName = `${name}-change-journal-v1`;
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const table = request.result.createObjectStore('entries', { keyPath: 'id' });
      table.createIndex('boardId', 'boardId'); table.createIndex('state', 'state'); table.createIndex('[collection+documentId]', ['collection', 'documentId']);
      request.result.createObjectStore('receipts', { keyPath: 'id' }).createIndex('destination', 'destination');
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = legacy.transaction(['entries', 'receipts'], 'readwrite');
    entries.forEach(entry => transaction.objectStore('entries').put(entry));
    transaction.objectStore('receipts').put({ id: 'existing-receipt', destination: 'drive:a', changeId: entries[0].id });
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
  }); legacy.close();
  const restored = await createRxRepository({ name }); repos.push(restored);
  expect(await restored.journal.entries.toArray()).toEqual(entries);
  expect((await restored.journal.receipts.toArray())[0].changeId).toBe(entries[0].id);
  await restored.saveConflictDraft(target, { writerId: 'new-window', heads: [], variantId: '', title: 'Recovered', content: 'Draft' });
  expect(await restored.journal.drafts.count()).toBe(1);
});
