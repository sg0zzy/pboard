import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { ChangeJournal, makeChange, type Change } from '../../src/storage/changeJournal';
import { createCausalReconciliation } from '../../src/storage/causalReconciliation';

const journals: ChangeJournal[] = [];
const target = { boardId: 'board', collection: 'cards' as const, documentId: 'card' };
const authorized = async () => true; // Only this local engine fixture. No network/auth implementation is stubbed.
async function open(name = `causal-${crypto.randomUUID()}`) {
  const journal = new ChangeJournal(name); await journal.open(); journals.push(journal);
  return { journal, engine: createCausalReconciliation(journal), name };
}
async function root(patch = {}) {
  return makeChange({ ...target, parents: [], ancestry: 'known', value: {
    id: 'card', projectId: 'board', title: 'Title', content: 'Base', displayMode: 'standard',
    type: 'note', status: 'todo', orderKey: 'a0', updatedAt: '2099-01-01', _deleted: false, ...patch
  } });
}
async function edit(base: Change, patch: Record<string, any>, parents = [base.id]) {
  return makeChange({ boardId: base.boardId, collection: base.collection, documentId: base.documentId,
    parents, ancestry: 'known', value: { ...base.value, ...patch } });
}
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); });

it('[C01/C02] descendant edits win by ancestry even with a backwards clock; replay is idempotent', async () => {
  const { engine, journal } = await open(); const a = await root(), b = await edit(a, { content: 'Descendant', updatedAt: '1900-01-01' });
  await engine.receive([b, a, b], authorized);
  expect((await engine.inspect(target))).toMatchObject({ kind: 'current', heads: [b.id], preview: { content: 'Descendant' } });
  expect(await journal.entries.count()).toBe(2);
  await journal.acknowledge(b.id, 'peer:source');
  expect((await journal.pending('peer:source')).some(c => c.id === b.id)).toBe(false);
  expect((await journal.pending('drive:own-account')).some(c => c.id === b.id)).toBe(true);
});

it('[C04] independent fields merge against a common ancestor without altering signed variants', async () => {
  const { engine, journal } = await open(); const a = await root({ _sec: { signature: 'original' } });
  const b = await edit(a, { title: 'New title', _sec: { signature: 'title author' } });
  const c = await edit(a, { content: 'New content', _sec: { signature: 'content author' } });
  await engine.receive([a, b, c], authorized);
  const result = await engine.inspect(target);
  expect(result).toMatchObject({ kind: 'mergeable', preview: { title: 'New title', content: 'New content' } });
  expect(result.preview).not.toHaveProperty('_sec');
  expect((await journal.entries.get(b.id))?.value._sec).toEqual({ signature: 'title author' });
  expect((await journal.entries.get(c.id))?.value._sec).toEqual({ signature: 'content author' });
});

it('[C05] identical concurrent values keep both authors while allowing a common preview', async () => {
  const { engine } = await open(); const a = await root();
  const b = await edit(a, { content: 'Same', _sec: { signature: 'author B' } });
  const c = await edit(a, { content: 'Same', _sec: { signature: 'author C' } });
  await engine.receive([a, b, c], authorized);
  const result = await engine.inspect(target);
  expect(result).toMatchObject({ kind: 'mergeable', preview: { content: 'Same' } });
  expect(result.heads.sort()).toEqual([b.id, c.id].sort());
});

it('preserves concurrent project template/name changes instead of assuming card invariants still hold', async () => {
  const { engine } = await open();
  const a = await makeChange({ boardId: 'board', collection: 'projects', documentId: 'board', parents: [], ancestry: 'known',
    value: { id: 'board', name: 'Original', template: 'idea' } });
  await engine.receive([a, await edit(a, { template: 'project' }), await edit(a, { name: 'New name' })], authorized);
  expect(await engine.inspect(a)).toMatchObject({ kind: 'conflict', reason: 'structural-change' });
});

it('recognizes soft tombstones and rejects invalid automatic display-mode merges', async () => {
  const { engine } = await open(); const a = await root();
  const deletion = await edit(a, { deletedAt: '2020-01-01' });
  await engine.receive([a, deletion], authorized);
  expect((await engine.inspect(target)).kind).toBe('deleted');
  await engine.receive([await edit(a, { displayMode: 'invalid' })], authorized);
  expect((await engine.inspect(target)).kind).toBe('conflict');
});

it('[C06] concurrent atomic text variants persist across database reopen and converge under reverse delivery', async () => {
  let first = await open(); const second = await open();
  const a = await root(), b = await edit(a, { content: 'Left' }), c = await edit(a, { content: 'Right' });
  await first.engine.receive([a, b, c], authorized); await second.engine.receive([c, b, a, c], authorized);
  first.journal.close(); first = await open(first.name);
  const result = await first.engine.inspect(target);
  expect(result).toMatchObject({ kind: 'conflict', reason: 'concurrent-fields' });
  expect(result.variants.map(c => c.value.content).sort()).toEqual(['Left', 'Right']);
  expect(await second.engine.inspect(target)).toEqual(result);
});

it('keeps independent documents in separate causal graphs', async () => {
  const { engine } = await open(); const a = await root();
  const other = await makeChange({ ...a, documentId: 'other', value: { ...a.value, id: 'other', content: 'Other edit' } });
  await engine.receive([a, other], authorized);
  expect((await engine.inspect(target)).heads).toEqual([a.id]);
  expect((await engine.inspect({ ...target, documentId: 'other' })).preview?.content).toBe('Other edit');
});

it.each([{ orderKey: 'b0' }, { type: 'task' }, { status: 'done' }])('preserves structural/move changes for invariant review: %j', async patch => {
  const { engine } = await open(); const a = await root();
  await engine.receive([a, await edit(a, patch), await edit(a, { content: 'Concurrent' })], authorized);
  expect(await engine.inspect(target)).toMatchObject({ kind: 'conflict', reason: 'structural-change' });
});

it('[C07] missing ancestors remain unresolved until the exact parent arrives', async () => {
  const { engine } = await open(); const a = await root(), b = await edit(a, { content: 'Later' });
  await engine.receive([b], authorized);
  expect(await engine.inspect(target)).toMatchObject({ kind: 'conflict', reason: 'missing-ancestry' });
  await engine.receive([a], authorized);
  expect(await engine.inspect(target)).toMatchObject({ kind: 'current', heads: [b.id] });
});

it('does not invent ancestry between legacy snapshots', async () => {
  const { engine } = await open(); const a = await root();
  const b = await makeChange({ ...target, parents: [], ancestry: 'unknown', value: { ...a.value, content: 'Unknown history' } });
  await engine.receive([a, b], authorized);
  expect(await engine.inspect(target)).toMatchObject({ kind: 'conflict', reason: 'unrelated-history' });
});

it('[D01/D03] preserves edit/delete conflicts; descendant deletion cannot be undone by replay of an ancestor', async () => {
  const { engine, journal } = await open(); const a = await root(), b = await edit(a, { content: 'Edited' });
  const deletion = await edit(a, { _deleted: true });
  await engine.receive([a, deletion, b], authorized);
  expect(await engine.inspect(target)).toMatchObject({ kind: 'conflict', reason: 'concurrent-delete' });
  const resolution = await edit(deletion, {}, [b.id, deletion.id]);
  await engine.receive([resolution, a, b], authorized);
  expect(await engine.inspect(target)).toMatchObject({ kind: 'deleted', heads: [resolution.id] });
  expect(await journal.entries.count()).toBe(4);
});

it('[D06/D07] a resolution must supersede all variants; concurrent resolutions remain conflicting', async () => {
  const { engine } = await open(); const a = await root(), b = await edit(a, { content: 'Left' }), c = await edit(a, { content: 'Right' });
  const partial = await edit(b, { content: 'Partial' });
  await engine.receive([a, b, c, partial], authorized);
  expect((await engine.inspect(target)).kind).toBe('conflict');
  const r1 = await edit(b, { content: 'Resolution one' }, [partial.id, c.id]);
  const r2 = await edit(c, { content: 'Resolution two' }, [partial.id, c.id]);
  await engine.receive([r1], authorized); expect((await engine.inspect(target)).kind).toBe('current');
  await engine.receive([r2], authorized);
  expect((await engine.inspect(target)).variants.map(c => c.value.content).sort()).toEqual(['Resolution one', 'Resolution two']);
});

it('fails closed on missing authorization, hash equivocation, malformed scope and rejected authorization', async () => {
  const { engine, journal } = await open(); const a = await root();
  await expect(engine.receive([a], undefined as any)).rejects.toThrow();
  await expect(engine.receive([a], async () => false)).rejects.toThrow('authorization');
  await expect(engine.receive([{ ...a, value: { ...a.value, content: 'Forgery' } }], authorized)).rejects.toThrow('identity');
  await expect(engine.receive([{ ...a, boardId: 'other-board' }], authorized)).rejects.toThrow();
  for (const malformed of [
    { ...a, boardId: 1, value: { ...a.value, projectId: 1 } },
    { ...a, parents: [a.id, a.id] },
    { ...a, value: { ...a.value, _deleted: 'yes' } },
    { ...a, value: { ...a.value, _rev: 'untrusted-storage-field' } }
  ]) await expect(engine.receive([malformed as unknown as Change], authorized)).rejects.toThrow();
  await expect(engine.receive(Array(129).fill(a), authorized)).rejects.toThrow('Bounded');
  expect(await journal.entries.count()).toBe(0);
  await engine.receive([a], authorized);
  await expect(engine.receive([a], async () => false)).rejects.toThrow('authorization');
});

it('rejects cross-board ancestor references atomically, including out-of-order references', async () => {
  const { engine, journal } = await open(); const a = await root();
  const foreign = await makeChange({ ...target, boardId: 'foreign', parents: [], ancestry: 'known', value: { ...a.value, projectId: 'foreign' } });
  const child = await edit(a, { content: 'Cross-board' }, [foreign.id]);
  await expect(engine.receive([foreign, child], authorized)).rejects.toBeTruthy();
  expect(await journal.entries.count()).toBe(0);
  await engine.receive([child], authorized);
  await expect(engine.receive([foreign], authorized)).rejects.toBeTruthy();
  expect((await engine.inspect(target)).kind).toBe('conflict');
});

// Failure mode: a queued or stale-UI write claimed a parent the journal had already
// superseded, so the change became an anonymous fork that only surfaced as a conflict at
// confirm time. Refusal must land at prepare, before the entry is constructed or written.
it('refuses a prepare that claims a superseded parent instead of the recorded journal head', async () => {
  const { engine, journal } = await open(); const a = await root(), b = await edit(a, { content: 'Head' });
  await engine.receive([a, b], authorized);
  const stranded = (await journal.pending('drive:own-account')).map(e => e.id).sort();
  await expect(journal.prepare('cards', { ...b.value, content: 'Stale anchoring' }, a.value, true)).rejects.toThrow();
  expect(await journal.entries.count()).toBe(2); // refused before anything was constructed or written
  expect((await journal.entries.where('state').equals('prepared').count())).toBe(0);
  expect((await engine.inspect(target))).toMatchObject({ kind: 'current', heads: [b.id], preview: { content: 'Head' } });
  expect((await journal.pending('drive:own-account')).map(e => e.id).sort()).toEqual(stranded); // the refusal strands nothing
  // An explicit resolution claim naming a superseded entry is the same defect.
  await expect(journal.prepare('cards', { ...b.value, content: 'Reviewed' }, b.value, true, [a.id])).rejects.toThrow();
  expect(await journal.entries.count()).toBe(2);
  // Claiming the recorded head still prepares. Content two candidates could both explain is
  // not attributed to either branch, so it anchors on the synthesized honest unknown baseline
  // root instead of silently picking one.
  const anchored = await journal.prepare('cards', { ...b.value, content: 'From the head' }, b.value, true);
  expect(anchored.parents).toEqual([b.id]); expect(anchored.ancestry).toBe('known');
  const rival = await makeChange({ ...target, parents: [b.id], ancestry: 'known', value: b.value });
  await engine.receive([rival], authorized);
  const ambiguous = await journal.prepare('cards', { ...b.value, content: 'Ambiguous' }, b.value, true);
  expect(ambiguous.parents.length).toBe(1);
  const synthesized = await journal.entries.get(ambiguous.parents[0]);
  expect(synthesized?.origin).toBe('baseline'); expect(synthesized?.ancestry).toBe('unknown');
  expect(synthesized?.id).not.toBe(b.id); expect(synthesized?.id).not.toBe(rival.id);
});

// Failure mode: an erasure marker committed while a verified batch was mid-flight, so
// intake read the pre-erasure state and either dropped entries one by one or appended to
// a journal that was already retired. Intake must refuse the batch as a whole inside the
// same strict transaction that reads the marker. Intake is genuinely mid-flight: its
// verification callback awaits the erasure itself, so the guard decides from the markers read
// inside its own strict transaction, never from a pre-erasure check or a wall-clock sleep.
it('refuses a batch whose board was retired while reconciliation was in flight', async () => {
  const { engine, journal } = await open(); const change = await root();
  const retired = journal.beginBoardErasure('board', null, [], []);
  await expect(engine.receive([change], async () => { await retired; return true; })).rejects.toThrow();
  expect(await journal.entries.count()).toBe(0); // nothing half-applied and nothing appended
  expect(await journal.boardErasure('board')).toBeTruthy(); // a retired journal stays retired
  expect((await engine.inspect(target)).kind).toBe('empty'); // the retired journal is never read as live history
  expect((await journal.pending('drive:own-account')).length).toBe(0); // nothing stranded pending
});
