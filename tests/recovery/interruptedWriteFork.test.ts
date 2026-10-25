// Guards the report "creating a new board created a conflict (only one user
// connected)": an interrupted write (durable document, journal entry left
// "prepared" by a killed worker) must not strand the next write into a
// duplicate baseline root, and pre-existing forks whose extra heads descend
// only from synthetic snapshot roots must reconcile as the document's state
// instead of surfacing "unrelated-history" conflicts.
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { documentValue, makeChange } from '../../src/storage/changeJournal';
import { withJournalMaterialization } from '../../src/storage/journalMaterialization';
import { withUntrustedImport } from '../../src/collab/security/liveMutations';

const repos: RxRepository[] = [];
afterEach(async () => { for (const r of repos.splice(0)) await r.db.close(); });
const open = async (tag: string) => {
  const rx = await createRxRepository({ name: `interrupted-${tag}-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`interrupted-blobs-${tag}-${crypto.randomUUID()}`) });
  repos.push(rx); return rx;
};

it('anchors the next write on an interrupted write and stays conflict-free', async () => {
  const rx = await open('prepared');
  const board = await rx.createProject('Crash window', 'project');
  // Recreate an interrupted write: the document bytes landed durably while
  // the journal entry never left state "prepared" (no finish call).
  const doc = (await rx.db.projects.findOne(board.id).exec())!.toJSON() as Record<string, unknown>;
  const root = (await rx.journal.entries.where('boardId').equals(board.id).toArray()).find(e => !e.parents.length)!;
  const landed = { ...doc, _deleted: false, updatedAt: new Date(Date.parse(String(doc.updatedAt)) + 50).toISOString() };
  const entry = await makeChange({ boardId: board.id, collection: 'projects', documentId: board.id, parents: [root.id], ancestry: 'known', value: documentValue(landed) as never });
  await rx.journal.entries.put({ ...entry, state: 'prepared', origin: 'local' } as never);
  await withUntrustedImport([rx.db.projects], () => withJournalMaterialization(rx.db.projects, landed as never, () => rx.db.projects.upsert(landed as never)));
  await rx.renameProject(board.id, 'Renamed after crash');
  // The stranded entry was matched and committed; no baseline fragment exists.
  const entries = await rx.journal.entries.where('boardId').equals(board.id).toArray();
  expect(entries.filter(e => e.state === 'prepared')).toEqual([]);
  expect(entries.filter(e => e.origin === 'baseline')).toEqual([]);
  expect(entries.filter(e => !e.parents.length)).toHaveLength(1);
  expect(await rx.listConflicts()).toEqual([]);
});

it('collapses a pre-existing fork on synthetic roots instead of reporting a conflict', async () => {
  const rx = await open('fork');
  const board = await rx.createProject('Legacy fork', 'project');
  // Recreate a fork a pre-fix browser leaves behind: a committed baseline
  // root wrapping the then-current bytes beside the continued local chain.
  const doc = (await rx.db.projects.findOne(board.id).exec())!.toJSON() as Record<string, unknown>;
  const baseline = await makeChange({ boardId: board.id, collection: 'projects', documentId: board.id, parents: [], ancestry: 'unknown',
    value: documentValue({ ...doc, updatedAt: new Date(Date.parse(String(doc.updatedAt)) - 1000).toISOString() }) as never });
  await rx.journal.accept([{ ...baseline, state: 'committed', origin: 'baseline' } as never]);
  await rx.renameProject(board.id, 'Renamed');
  expect(await rx.listConflicts()).toEqual([]);
  const inspected = await rx.reconciliation.inspect({ boardId: board.id, collection: 'projects', documentId: board.id });
  expect(inspected.kind).toBe('current');
  expect(inspected.variants[0].value.name).toBe('Renamed');
});
