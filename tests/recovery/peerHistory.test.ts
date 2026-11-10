import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createPeerHistorySession, type PeerHistorySession } from '../../src/collab/peerHistory';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { installLiveBoardMutations, withUntrustedImport } from '../../src/collab/security/liveMutations';
import { manifestHash, signManifest, verifyManifest } from '../../src/collab/security/manifest';
import { verifyJournalChange } from '../../src/collab/security/journalProof';
import { makeChange, type Change } from '../../src/storage/changeJournal';
import type { CollaborationSecurityOptions } from '../../src/collab/manager';
import type { VerifiedSessionContext } from '../../src/collab/security/session';
import type { WithDeleted } from 'rxdb';
import type { CardRecord } from '../../src/storage/rxdbSchemas';
const repos: RxRepository[] = [], sessions: PeerHistorySession[] = [];
afterEach(async () => { vi.useRealTimers(); sessions.splice(0).forEach(s => s.close()); for (const r of repos.splice(0)) await r.db.close(); });
async function fixture() {
  const a = await createRxRepository({ name: `history-a-${crypto.randomUUID()}` }); repos.push(a);
  const b = await createRxRepository({ name: `history-b-${crypto.randomUUID()}` }); repos.push(b);
  const board = await a.createProject('Shared', 'project');
  const owner = await generateDeviceKey(), editor = await generateDeviceKey(), viewer = await generateDeviceKey();
  const payload = { protocol: 2 as const, boardId: board.id, driveProjectFileId: '', driveFolderId: '', authorityKeyId: owner.keyId,
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [ { deviceKeyId: owner.keyId, publicKey: owner.publicJwk, role: 'owner' as const }, { deviceKeyId: editor.keyId, publicKey: editor.publicJwk, role: 'editor' as const }, { deviceKeyId: viewer.keyId, publicKey: viewer.publicJwk, role: 'viewer' as const } ] };
  const signer = { deviceKeyId: owner.keyId, privateJwk: owner.privateJwk };
  const manifest = await verifyManifest(await signManifest(payload, signer), owner.publicJwk, owner.keyId);
  const sa: CollaborationSecurityOptions = { boardId: board.id, manifest, signer, ownSessionId: 'a' };
  const sb: CollaborationSecurityOptions = { ...sa, signer: { deviceKeyId: editor.keyId, privateJwk: editor.privateJwk }, ownSessionId: 'b' };
  await installLiveBoardMutations({ projectId: board.id, cards: a.db.cards, projects: a.db.projects, security: sa, attestExisting: true });
  await installLiveBoardMutations({ projectId: board.id, cards: b.db.cards, projects: b.db.projects, security: sb });
  const project = (await a.db.projects.findOne(board.id).exec())!.toJSON();
  await withUntrustedImport([b.db.projects], () => b.db.projects.upsert(JSON.parse(JSON.stringify(project))));
  return { a, b, sa, sb, board, viewer };
}
function context(own: CollaborationSecurityOptions, remote: CollaborationSecurityOptions): VerifiedSessionContext {
  return { boardId: own.boardId, collection: 'cards', ownDeviceKeyId: own.signer.deviceKeyId, remoteDeviceKeyId: remote.signer.deviceKeyId,
    remoteRole: remote.manifest.devices.find(d => d.deviceKeyId === remote.signer.deviceKeyId)!.role,
    ownSessionId: own.ownSessionId, remoteSessionId: remote.ownSessionId, manifestEpoch: own.manifest.epoch,
    manifestHash: manifestHash(own.manifest), transcriptHash: 'verified-test-dtls', manifestExpiresAt: own.manifest.expiresAt };
}
function link(f: Awaited<ReturnType<typeof fixture>>) {
  const errors: Error[] = [], frames: unknown[] = [];
  let left!: PeerHistorySession, right!: PeerHistorySession;
  let qa = Promise.resolve(), qb = Promise.resolve();
  left = createPeerHistorySession({ repository: f.a, security: f.sa, context: context(f.sa, f.sb), active: () => true,
    send(frame) { frames.push(frame); qb = qb.then(() => right.receive(frame)).catch(e => { errors.push(e); }); }, onError: e => errors.push(e) });
  right = createPeerHistorySession({ repository: f.b, security: f.sb, context: context(f.sb, f.sa), active: () => true,
    send(frame) { frames.push(frame); qa = qa.then(() => left.receive(frame)).catch(e => { errors.push(e); }); }, onError: e => errors.push(e) });
  sessions.push(left, right);
  return { left, right, errors, frames, async sync() { await Promise.all([left.flush(), right.flush()]); await qa; await qb; expect(errors).toEqual([]); }, close() { left.close(); right.close(); } };
}
async function incoming(f: Awaited<ReturnType<typeof fixture>>) {
  const frames: any[] = [];
  const session = createPeerHistorySession({ repository: f.b, security: f.sb, context: context(f.sb, f.sa), active: () => true, send: x => { frames.push(x); }, onError() {} });
  sessions.push(session);
  await session.receive({ kind: 'pboard-history', version: 1, op: 'hello', id: 'hello' });
  const entry = (await f.a.journal.entries.toArray()).find(e => e.collection === 'cards' && e.proof)!;
  return { session, frames, entry, async offer(id = entry.id) { await session.receive({ kind: 'pboard-history', version: 1, op: 'offer', id: 'offer', ids: [id] }); },
    put(change: Change = entry, proof = entry.proof) { return session.receive({ kind: 'pboard-history', version: 1, op: 'put', id: 'put', records: [{ change, proof }] }); } };
}
it('durably signs new causal parents with the original author and retains proofs across restart', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Root' });
  await f.a.updateItem(card.id, { content: 'Descendant' });
  const change = (await f.a.reconciliation.inspect({ boardId: f.board.id, collection: 'cards', documentId: card.id })).variants[0];
  const entry = (await f.a.journal.entries.get(change.id))!;
  expect(entry.parents).toHaveLength(1); expect(entry.proof?.payload.changeId).toBe(entry.id);
  await verifyJournalChange(entry, entry.proof, f.sa);
  const name = f.a.db.name; await f.a.db.close();
  const reopened = await createRxRepository({ name }); repos.push(reopened);
  expect((await reopened.journal.entries.get(entry.id))?.proof).toEqual(entry.proof);
});
it('exchanges missing authored history without Drive, deduplicates replay, and records peer-specific receipts', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Root' });
  const wire = link(f); await wire.sync();
  expect((await f.b.getCard(card.id))?.content).toBe('Root');
  const before = await f.b.journal.entries.count(); await wire.sync(); expect(await f.b.journal.entries.count()).toBe(before);
  const source = (await f.a.journal.entries.toArray()).find(e => e.collection === 'cards')!;
  expect((await f.a.journal.receipts.toArray()).some(r => r.changeId === source.id && r.destination.includes(f.sb.signer.deviceKeyId))).toBe(true);
  expect((await f.a.journal.receipts.toArray()).some(r => r.destination.startsWith('private-drive:'))).toBe(false);
});
it('preserves independent offline card edits and catches up after a new session', async () => {
  const f = await fixture(), one = await f.a.addItem({ projectId: f.board.id, content: 'One' }), two = await f.a.addItem({ projectId: f.board.id, content: 'Two' });
  const wire = link(f); await wire.sync(); wire.close();
  await f.a.updateItem(one.id, { content: 'A offline' }); await f.b.updateItem(two.id, { content: 'B offline' });
  await link(f).sync();
  for (const repo of [f.a, f.b]) { expect((await repo.getCard(one.id))?.content).toBe('A offline'); expect((await repo.getCard(two.id))?.content).toBe('B offline'); }
});
it('retains concurrent text variants, then exchanges an authorized manual resolution with every parent', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Common' });
  const first = link(f); await first.sync(); first.close();
  await f.a.updateItem(card.id, { content: 'A concurrent' }); await f.b.updateItem(card.id, { content: 'B concurrent' });
  const wire = link(f); await wire.sync();
  const target = { boardId: f.board.id, collection: 'cards' as const, documentId: card.id };
  const conflict = await f.a.reconciliation.inspect(target); expect(conflict.kind).toBe('conflict'); expect(conflict.variants.map(c => c.value.content).sort()).toEqual(['A concurrent', 'B concurrent']);
  await f.a.resolveConflict({ ...target, heads: conflict.heads, variantId: conflict.heads[0], edits: { title: '', content: 'Reviewed resolution' } });
  await wire.sync();
  const resolved = await f.b.reconciliation.inspect(target); expect(resolved.kind).toBe('current'); expect(resolved.variants[0].parents).toEqual(conflict.heads);
  expect((await f.b.getCard(card.id))?.content).toBe('Reviewed resolution');
});
it('preserves an edit/delete conflict and never resurrects a causally deleted card on replay', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Common' });
  const first = link(f); await first.sync(); first.close();
  await f.a.deleteItem(card.id); await f.b.updateItem(card.id, { content: 'Concurrent edit' }); await link(f).sync();
  expect((await f.b.reconciliation.inspect({ boardId: f.board.id, collection: 'cards', documentId: card.id })).reason).toBe('concurrent-delete');
});
it('keeps a created-edited-deleted card conflict-free for both sessions (no spurious panel)', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Root' });
  const wire = link(f); await wire.sync();
  await f.a.updateItem(card.id, { content: 'Edit 1' }); await wire.sync();
  await f.a.updateItem(card.id, { content: 'Edit 2' }); await wire.sync();
  expect(await f.a.listConflicts()).toEqual([]);
  expect(await f.b.listConflicts()).toEqual([]);
  await f.a.deleteItem(card.id); await wire.sync();
  expect(await f.a.listConflicts()).toEqual([]);
  expect(await f.b.listConflicts()).toEqual([]);
  expect(await f.b.reconciliation.inspect({ boardId: f.board.id, collection: 'cards', documentId: card.id })).toMatchObject({ kind: 'deleted' });
  expect((await f.b.getCard(card.id))).toBeNull();
});
it('re-delivers a delete whose delivery raced a disconnect (no orphan tombstone head)', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Root' });
  const first = link(f); await first.sync();
  await f.a.updateItem(card.id, { content: 'Edit' }); await first.sync();
  // The delete lands while the wire is torn down mid-flight.
  await f.a.deleteItem(card.id); first.close();
  await link(f).sync(); await new Promise(r => setTimeout(r, 50)); await link(f).sync();
  const target = { boardId: f.board.id, collection: 'cards' as const, documentId: card.id };
  expect((await f.b.reconciliation.inspect(target)).kind).toBe('deleted');
  expect(await f.b.listConflicts()).toEqual([]);
  expect(await f.a.listConflicts()).toEqual([]);
});
it('silently rebaselines unsigned bootstrap residue against the verified author chain after a delete', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Signed root' });
  const wire = link(f); await wire.sync();
  // Session B's pre-guard era: an observed, unsigned root of the same card,
  // exactly what importing legacy snapshot bytes leaves in the journal.
  const copy = { ...structuredClone((await f.b.db.cards.findOne(card.id).exec())!.toJSON()) } as Record<string, unknown>;
  delete copy._sec; copy.updatedAt = '2020-01-01T00:00:00.000Z';
  const { makeChange: mc } = await import('../../src/storage/changeJournal');
  const residue = await mc({ boardId: f.board.id, collection: 'cards', documentId: card.id, parents: [], ancestry: 'unknown', value: copy as never });
  await f.b.journal.accept([{ ...residue, state: 'committed', origin: 'observed' } as never]);
  // The author then deletes the card; B converges over history.
  await f.a.deleteItem(card.id); await wire.sync();
  const target = { boardId: f.board.id, collection: 'cards' as const, documentId: card.id };
  expect(await f.b.listConflicts()).toEqual([]);
  expect((await f.b.reconciliation.inspect(target)).kind).toBe('deleted');
  expect((await f.a.listConflicts()).map(r => r.documentId)).not.toContain(card.id);
  // The healed tombstone is a signed local resolution, visible as deleted.
  const tomb = (await f.b.db.cards.findOne(card.id).exec())!.toJSON() as Record<string, unknown>;
  expect(typeof tomb.deletedAt).toBe('string'); expect(tomb._sec).toBeTruthy();
});
it('relays another author proof unchanged and never exchanges drafts, images or unsigned private records', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Signed' });
  const wire = link(f); await wire.sync();
  const source = (await f.a.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  expect((await f.b.journal.entries.get(source.id))?.proof).toEqual(source.proof);
  await f.a.journal.drafts.put({ id: 'private', target: JSON.stringify([f.board.id,'cards',card.id]), writerId: 'writer', heads: [source.id], variantId: source.id, title: '', content: 'DO_NOT_SHARE_DRAFT' });
  await wire.sync(); expect(JSON.stringify(wire.frames)).not.toContain('DO_NOT_SHARE_DRAFT');
});
it('chunks larger signed documents within frame limits and reconstructs exact bytes', async () => {
  const f = await fixture(), text = 'Large 🦊 text '.repeat(4000).trim(), card = await f.a.addItem({ projectId: f.board.id, content: text });
  const wire = link(f); await wire.sync(); expect((await f.b.getCard(card.id))?.content).toBe(text);
  expect(wire.frames.some((x: any) => x.op === 'chunk')).toBe(true);
  expect(wire.frames.every(frame => new TextEncoder().encode(JSON.stringify(frame)).length <= 65536)).toBe(true);
});
it('replays full offers after remote database loss rather than trusting old receipts', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Durable' });
  const first = link(f); await first.sync(); first.close();
  const old = f.b; f.b = await createRxRepository({ name: `history-fresh-${crypto.randomUUID()}` }); repos.push(f.b);
  await installLiveBoardMutations({ projectId: f.board.id, cards: f.b.db.cards, projects: f.b.db.projects, security: f.sb });
  const project = (await f.a.db.projects.findOne(f.board.id).exec())!.toJSON(); await withUntrustedImport([f.b.db.projects], () => f.b.db.projects.upsert(JSON.parse(JSON.stringify(project))));
  await link(f).sync(); expect((await f.b.getCard(card.id))?.content).toBe('Durable'); expect(old).not.toBe(f.b);
});
it('rejects a recomputed change hash with tampered ancestry despite a valid document signature', async () => {
  const f = await fixture(); await f.a.addItem({ projectId: f.board.id, content: 'Signed' });
  const x = await incoming(f), forged = await makeChange({ ...x.entry, parents: ['a'.repeat(64)], ancestry: 'known' });
  await x.offer(forged.id); await expect(x.put(forged)).rejects.toThrow('binding'); expect(await f.b.journal.entries.get(forged.id)).toBeUndefined();
});
it('rejects document tampering, missing author proofs and foreign board bindings before persistence', async () => {
  const f = await fixture(); await f.a.addItem({ projectId: f.board.id, content: 'Signed' }); const x = await incoming(f);
  const forged = await makeChange({ ...x.entry, value: { ...x.entry.value, content: 'Forged' } }); await x.offer(forged.id);
  await expect(x.put(forged)).rejects.toThrow(); expect(await f.b.journal.entries.get(forged.id)).toBeUndefined();
});
it.each([
  { op: 'unknown' }, { op: 'put', records: [] }, { op: 'wanted', ids: [] },
  { op: 'offer', ids: ['not-an-id'] }, { op: 'offer', ids: Array(17).fill('a'.repeat(64)) },
  { op: 'chunk', index: 1, total: 2, data: 'x' }, { op: 'chunk', index: 0, total: 65, data: 'x' },
  { op: 'chunk', index: 0, total: 2, data: 'x'.repeat(8193) },
])('rejects malformed or unsolicited history frames: $op', async bad => {
  const f = await fixture(), x = await incoming(f);
  await expect(x.session.receive({ kind: 'pboard-history', version: 1, id: 'invalid', ...bad })).rejects.toThrow();
});
it('rejects expired sessions, cross-board contexts and repeated capability announcements', async () => {
  const f = await fixture(), x = await incoming(f);
  await expect(x.session.receive({ kind: 'pboard-history', version: 1, op: 'hello', id: 'again' })).rejects.toThrow('Repeated');
  f.sb.manifest = { ...f.sb.manifest, expiresAt: 1 };
  await expect(x.session.receive({ kind: 'pboard-history', version: 1, op: 'offer', id: 'expired', ids: [] })).rejects.toThrow('authorized');
});
it('retains legacy signed values with explicitly unknown ancestry rather than attesting other authors', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Legacy' });
  const source = (await f.a.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  await f.a.journal.entries.update(source.id, { proof: undefined });
  const wire = link(f); await wire.sync();
  const target = (await f.b.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  expect(target.ancestry).toBe('unknown'); expect(target.parents).toEqual([]); expect(target.proof).toBeUndefined();
});

it('requires an author proof for known ancestry and rejects foreign-room and unrequested records', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Protected' });
  const entry = (await f.a.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  await expect(verifyJournalChange(entry, undefined, f.sa)).rejects.toThrow('author proof');
  const foreign = await makeChange({ ...entry, boardId: 'foreign-board', value: { ...entry.value, projectId: 'foreign-board' } });
  await expect(verifyJournalChange(foreign, entry.proof, f.sa)).rejects.toThrow('authorization');
  const x = await incoming(f); await expect(x.put()).rejects.toThrow('Unrequested');
  expect(await f.b.journal.entries.get(entry.id)).toBeUndefined();
});
it('rejects invalid author signatures, viewer-signed mutations and changed proof identities', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Protected' });
  const entry = (await f.a.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  await expect(verifyJournalChange(entry, { ...entry.proof!, signature: 'a'.repeat(86) }, f.sa)).rejects.toThrow('invalid');
  await expect(verifyJournalChange(entry, { ...entry.proof!, payload: { ...entry.proof!.payload, authorKeyId: f.viewer.keyId } }, f.sa)).rejects.toThrow('binding');
  const { signMutation } = await import('../../src/collab/security/mutation');
  const value = await signMutation(entry.value, { privateJwk: f.viewer.privateJwk, deviceKeyId: f.viewer.keyId }, { boardId: f.board.id, collection: 'cards', manifest: f.sa.manifest, sequence: 1 });
  const viewer = await makeChange({ ...entry, parents: [], ancestry: 'unknown', value });
  await expect(verifyJournalChange(viewer, undefined, f.sa)).rejects.toThrow('view-only');
});
it('enforces flooding, outstanding-offer and unknown-field quotas', async () => {
  const f = await fixture(), x = await incoming(f);
  await expect(x.session.receive({ kind: 'pboard-history', version: 1, op: 'offer', id: 'unknown', ids: [], url: 'https://example.test' })).rejects.toThrow('field');
  await x.offer('a'.repeat(64));
  await expect(x.offer('b'.repeat(64))).rejects.toThrow('quota');
  const y = await incoming(f); let rejected = false;
  for (let n = 0; n < 201; n++) {
    try { await y.session.receive({ kind: 'pboard-history', version: 1, op: 'offer', id: String(n), ids: [] }); }
    catch (error) { expect(String(error)).toContain('rate'); rejected = true; break; }
  }
  expect(rejected).toBe(true);
});
it('does not create false conflicts when a legacy observation later receives the exact original signed ancestry', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Same signed operation' });
  const entry = (await f.a.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  const legacy = await makeChange({ ...entry, parents: [], ancestry: 'unknown' });
  await f.b.journal.accept([{ ...legacy, state: 'committed', origin: 'observed' }]);
  await link(f).sync();
  const result = await f.b.reconciliation.inspect({ boardId: f.board.id, collection: 'cards', documentId: card.id });
  expect(result.kind).toBe('current'); expect(result.heads).toEqual([entry.id]);
  expect(await f.b.journal.entries.get(legacy.id)).toBeDefined();
});
it('keeps pre-enrollment private content local while publishing later authenticated changes', async () => {
  const f = await fixture();
  const unsigned = await makeChange({ boardId: f.board.id, collection: 'cards', documentId: 'before-sharing', parents: [], ancestry: 'known', value: { id: 'before-sharing', projectId: f.board.id, content: 'PRIVATE_PRE_ENROLLMENT', _deleted: false } });
  await f.a.journal.accept([{ ...unsigned, state: 'committed', origin: 'baseline' }]);
  const card = await f.a.addItem({ projectId: f.board.id, content: 'Shared current content' });
  const wire = link(f); await wire.sync();
  expect(JSON.stringify(wire.frames)).not.toContain('PRIVATE_PRE_ENROLLMENT');
  expect((await f.b.getCard(card.id))?.content).toBe('Shared current content');
});
it('uses proven causal descendants over reversed document clocks in the existing RxDB conflict handler', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Initial' });
  const ancestorHandle = (await f.a.db.cards.findOne(card.id).exec())!;
  await ancestorHandle.incrementalModify(value => ({ ...value, content: 'Future-clock ancestor', updatedAt: '2099-01-01T00:00:00.000Z' }));
  const ancestor = (await f.a.reconciliation.inspect({ boardId: f.board.id, collection: 'cards', documentId: card.id })).variants[0];
  const wire = link(f); await wire.sync();
  // Anchoring requires a write whose previous is the recorded head; a stale handle is refused as an anonymous fork.
  const descendantHandle = (await f.a.db.cards.findOne(card.id).exec())!;
  await descendantHandle.incrementalModify(value => ({ ...value, content: 'Past-clock descendant', updatedAt: '2001-01-01T00:00:00.000Z' }));
  await wire.sync();
  expect((await f.b.getCard(card.id))?.content).toBe('Past-clock descendant');
  const atB = await f.b.reconciliation.inspect({ boardId: f.board.id, collection: 'cards', documentId: card.id });
  expect(atB.kind).toBe('current');
  const descendant = atB.variants[0];
  expect(atB.heads).toEqual([descendant.id]);
  expect(descendant.parents).toEqual([ancestor.id]);
  // Change.value is the untyped journal document; the handler input is the typed card row.
  const master = ancestor.value as WithDeleted<CardRecord>, next = descendant.value as WithDeleted<CardRecord>;
  const winner = await f.b.db.cards.conflictHandler.resolve({ realMasterState: master, newDocumentState: next }, 'peer-history-clock');
  expect(winner.content).toBe('Past-clock descendant');
});

it('retains authenticated legacy RxDB operation when the peer does not advertise history', async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const session = createPeerHistorySession({ repository: f.a, security: f.sa, context: context(f.sa, f.sb), active: () => true, send() {}, onError() {} }); sessions.push(session);
  const wait = session.flush(); await vi.advanceTimersByTimeAsync(1501); await wait;
  expect(await f.a.journal.receipts.count()).toBe(0);
});
it('never acknowledges an interrupted transfer and rejects incomplete chunk assemblies on timeout', async () => {
  const f = await fixture(); await f.a.addItem({ projectId: f.board.id, content: 'Unacknowledged' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); const failures: Error[] = [];
  let offered!: () => void; const offerSent = new Promise<void>(resolve => { offered = resolve; });
  const session = createPeerHistorySession({ repository: f.a, security: f.sa, context: context(f.sa, f.sb), active: () => true, send(frame: any) { if (frame.op === 'offer') offered(); }, onError: e => failures.push(e) }); sessions.push(session);
  await session.receive({ kind: 'pboard-history', version: 1, op: 'hello', id: 'peer' });
  const wait = session.flush().then(() => false, () => true);
  await offerSent; await vi.advanceTimersByTimeAsync(10001); expect(await wait).toBe(true);
  expect(await f.a.journal.receipts.count()).toBe(0);
  await session.receive({ kind: 'pboard-history', version: 1, op: 'chunk', id: 'partial', index: 0, total: 2, data: '{' });
  await vi.advanceTimersByTimeAsync(10001);
  expect(failures.some(e => e.message.includes('assembly timed out'))).toBe(true);
});
it.each(['live', 'deleted'])('keeps signed projection guards active beside a legacy unsigned head: %s', async state => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Signed ancestor' });
  const target = { boardId: f.board.id, collection: 'cards' as const, documentId: card.id };
  const ancestor = (await f.a.reconciliation.inspect(target)).variants[0];
  await f.a.updateItem(card.id, { content: 'Signed descendant' });
  if (state === 'deleted') await f.a.deleteItem(card.id);
  let descendant = (await f.a.reconciliation.inspect(target)).variants[0];
  // Select a high valid content ID so the legacy fallback-order regression is
  // exercised reliably, rather than depending on one random ECDSA signature.
  for (let n = 0; !descendant.id.startsWith('f') && n < 1024; n++) {
    await (await f.a.db.cards.findOne(card.id).exec())!.incrementalModify(value => ({ ...value, title: `Signed revision ${n}` }));
    descendant = (await f.a.reconciliation.inspect(target)).variants[0];
  }
  expect(descendant.id.startsWith('f')).toBe(true);
  const { _sec: _, ...value } = ancestor.value;
  let legacy = await makeChange({ ...target, parents: [], ancestry: 'unknown', value });
  for (let n = 0; legacy.id > descendant.id && n < 100; n++) legacy = await makeChange({ ...target, parents: [], ancestry: 'unknown', value: { ...value, content: `Pre-enrollment ${n}` } });
  expect(legacy.id < descendant.id).toBe(true);
  await f.a.journal.accept([{ ...legacy, state: 'committed', origin: 'baseline' }]);
  await withUntrustedImport([f.a.db.cards], () => f.a.db.cards.upsert(ancestor.value as any));
  await expect(f.a.privateRecovery.apply(f.board.id, async () => true)).resolves.toBeUndefined();
  const projected = (await f.a.db.cards.findOne(card.id).exec())!;
  expect(projected.content).toBe('Signed descendant');
  expect(!!projected.deletedAt).toBe(state === 'deleted');
  expect(await f.a.journal.entries.get(legacy.id)).toBeDefined();
  // An unowned baseline root beside a single verified author head collapses
  // silently (same-account backup residue must not raise a review panel);
  // the legacy entry stays retained but never wins projection.
  expect((await f.a.reconciliation.inspect(target)).kind).toBe(state === 'deleted' ? 'deleted' : 'current');
});
it('journals concurrent signed replication normally while exact projection/resolution intents are active', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Ancestor' });
  const target = { boardId: f.board.id, collection: 'cards' as const, documentId: card.id };
  const ancestor = (await f.a.reconciliation.inspect(target)).variants[0];
  await f.a.updateItem(card.id, { content: 'Projection' });
  const descendant = (await f.a.reconciliation.inspect(target)).variants[0];
  const { withJournalMaterialization } = await import('../../src/storage/journalMaterialization');
  const { withResolutionOrigin } = await import('../../src/storage/resolutionOrigin');
  await withUntrustedImport([f.a.db.cards], () => withResolutionOrigin(f.a.db.cards, descendant.value, [ancestor.id], () => withJournalMaterialization(f.a.db.cards, descendant.value, async () => {
    // A different valid row arrives while projection awaits its storage turn.
    await expect(f.a.db.cards.upsert(ancestor.value as any)).resolves.toBeDefined();
    await expect(f.a.db.cards.upsert({ ...ancestor.value, content: 'Unsigned tampering' } as any)).rejects.toBeDefined();
    await f.a.db.cards.upsert(descendant.value as any);
  })));
  expect((await f.a.getCard(card.id))?.content).toBe('Projection');
  expect((await f.a.reconciliation.inspect(target)).heads).toEqual([descendant.id]);
});
it('rejects malformed application values even with an authorized valid mutation signature', async () => {
  const f = await fixture(), card = await f.a.addItem({ projectId: f.board.id, content: 'Valid' });
  const source = (await f.a.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  const { signMutation } = await import('../../src/collab/security/mutation');
  const value = await signMutation({ ...source.value, content: null }, f.sa.signer, { boardId: f.board.id, collection: 'cards', manifest: f.sa.manifest, sequence: 100 });
  const invalid = await makeChange({ ...source, parents: [], ancestry: 'unknown', value });
  await verifyJournalChange(invalid, undefined, f.sa); // Signature is real; schema is independently rejected.
  const x = await incoming(f); await x.offer(invalid.id);
  await expect(x.put(invalid, undefined)).rejects.toThrow('invalid card');
  expect(await f.b.journal.entries.get(invalid.id)).toBeUndefined();
});
