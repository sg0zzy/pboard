// Snapshot pulls are state imports, not authored changes. Guards the report
// "A creates a board; a few seconds later it appears on B already showing
// Conflict requires resolution": every pull used to add an unanchored journal
// root per changed document, so the second pull of any board conflicted with
// the first on the receiving browser.
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { makeChange } from '../../src/storage/changeJournal';

const repos: RxRepository[] = [];
afterEach(async () => { for (const r of repos.splice(0)) await r.db.close(); });
const open = async (tag: string) => {
  const rx = await createRxRepository({ name: `pull-${tag}-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`pull-blobs-${tag}-${crypto.randomUUID()}`) });
  repos.push(rx); return rx;
};

it('two pulls of a changed board leave the puller with no conflicts and no journal heads', async () => {
  const a = await open('a'), b = await open('b');
  const board = await a.createProject('Fresh', 'project');
  await a.addItem({ projectId: board.id, content: 'first card' });
  let snap = await a.exportProject(board.id);
  await b.importProject(snap.project, snap.items); // pull #1
  await a.updateItem((await a.listCards(board.id))[0].id, { content: 'edited card' });
  await a.renameProject(board.id, 'Fresh renamed');
  snap = await a.exportProject(board.id);
  await b.mergeSharedSnapshot(snap.project, snap.items, async () => true); // pull #2
  expect(await b.listConflicts()).toEqual([]);
  expect(await b.journal.entries.count()).toBe(0);
  // The pulled state itself is live and current.
  expect((await b.getProject(board.id))?.name).toBe('Fresh renamed');
  expect((await b.listCards(board.id)).map(c => c.content)).toEqual(['edited card']);
  // B's first local edit anchors on the imported bytes and stays clean.
  await b.renameProject(board.id, 'Renamed on B');
  expect(await b.listConflicts()).toEqual([]);
});

it('retires pre-fix observation roots without authorship instead of conflicting', async () => {
  const a = await open('c'), b = await open('d');
  const board = await a.createProject('Legacy', 'project');
  const snap = await a.exportProject(board.id);
  await b.importProject(snap.project, snap.items);
  // Recreate the journal state a pre-fix browser persisted: one parentless,
  // unproven, unsigned observation root per pull generation.
  const doc = (await b.db.projects.findOne(board.id).exec())!.toJSON() as Record<string, unknown>;
  for (const [name, updatedAt] of [['Fresh', '2026-01-01T00:00:00.000Z'], ['Fresh renamed', '2026-01-02T00:00:00.000Z']] as const) {
    const residue = await makeChange({ boardId: board.id, collection: 'projects', documentId: board.id, parents: [], ancestry: 'unknown',
      value: { ...doc, name, updatedAt } as never });
    await b.journal.accept([{ ...residue, state: 'committed', origin: 'observed' } as never]);
  }
  expect(await b.listConflicts()).toEqual([]);
  const inspected = await b.reconciliation.inspect({ boardId: board.id, collection: 'projects', documentId: board.id });
  expect(inspected.kind).toBe('current');
  expect(inspected.variants[0].value.name).toBe('Fresh renamed');
});
