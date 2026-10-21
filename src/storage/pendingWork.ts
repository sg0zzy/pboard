import type { PendingEdit, ChangeJournal, DocumentValue } from './changeJournal';
import { makeChange, documentValue } from './changeJournal';
import { validateChange, validateRecord } from './causalReconciliation';
import { canonicalize } from '../collab/security/canonical';
import { portableJournalChanges } from '../collab/security/journalProof';
import { withJournalMaterializations } from './journalMaterialization';

export const pendingValue = (value: Record<string, unknown>): DocumentValue => {
  const result = documentValue({ ...value, _deleted: value._deleted === true }); delete result._sec; return result;
};
export function pendingHeads(edits: PendingEdit[]) {
  const superseded = new Set(edits.flatMap(e => e.supersedes ?? []));
  return edits.filter(e => !e.admittedChangeId && !superseded.has(e.id));
}
export async function validatePending(edit: PendingEdit, boardId: string) {
  if (!edit || typeof edit.id !== 'string' || edit.id.length > 200 || edit.boardId !== boardId || !/^[A-Za-z0-9_-]{43}$/.test(edit.deviceKeyId)
    || !/^[A-Za-z0-9_-]{43}$/.test(edit.authorityKeyId) || !Array.isArray(edit.supersedes) || edit.supersedes.length > 128
    || edit.supersedes.some(id => typeof id !== 'string' || id.length > 200) || (edit.creation !== undefined && typeof edit.creation !== 'boolean')
    || edit.value?._sec !== undefined || edit.base?.boardId !== boardId) throw new Error('Invalid private pending work');
  await validateChange(edit.base); validateRecord(edit.base);
  const value = await makeChange({ ...edit.base, value: edit.value }); await validateChange(value); validateRecord(value);
  if (edit.parents && (!Array.isArray(edit.parents) || edit.parents.length > 8 || edit.parents.some(id => !/^[a-f0-9]{64}$/.test(id)))) throw new Error('Invalid pending resolution parents');
}
/** A pure command scratchpad reuses the ordinary repository; it is never a sync endpoint. */
export async function draftCommand(options: {
  boardId: string; journal: ChangeJournal; deviceKeyId: string; authorityKeyId: string;
  source: { collection: 'cards' | 'projects'; value: Record<string, unknown> }[];
  createScratch(): Promise<any>; command: string; args: unknown[];
}) {
  const { boardId, journal } = options;
  const drafts = pendingHeads((await journal.pendingEdits.toArray()).filter(e => e.boardId === boardId));
  const byTarget = new Map<string, PendingEdit[]>();
  for (const edit of drafts) {
    const key = `${edit.base.collection}:${edit.base.documentId}`, list = byTarget.get(key) ?? []; list.push(edit); byTarget.set(key, list);
    if (edit.deviceKeyId !== options.deviceKeyId || edit.authorityKeyId !== options.authorityKeyId) throw new Error('Review this other device’s pending work before creating a new edit');
    if (list.length > 1) throw new Error('Parallel pending versions require explicit review; all are retained');
  }
  const source = new Map(options.source.map(row => [`${row.collection}:${row.value.id}`, row]));
  const initial = new Map([...source].map(([key, row]) => [key, { ...row, value: pendingValue(row.value) }]));
  for (const [key, edits] of byTarget) initial.set(key, { collection: edits[0].base.collection, value: edits[0].value });
  const scratch = await options.createScratch();
  try {
    for (const name of ['projects', 'cards'] as const) {
      const values = [...initial.values()].filter(row => row.collection === name && !row.value._deleted).map(row => row.value);
      // The source versions already exist durably on the real repository.
      // Copying them into an isolated in-memory scratchpad is not a new edit:
      // avoid one strict IndexedDB WAL transaction per seed document. Only the
      // actual command below is journaled and turned into durable pending work.
      if (values.length) await withJournalMaterializations(scratch.db[name], values, () => scratch.db[name].bulkInsert(values));
    }
    // Preserve soft tombstones, ordering, board metadata and image references.
    const result = await scratch[options.command](...options.args);
    const entries = await scratch.journal.entries.where('boardId').equals(boardId).toArray();
    const ids = new Map<string, 'cards' | 'projects'>(entries.map((e: any) => [e.documentId, e.collection]));
    const changes: PendingEdit[] = [];
    for (const [id, collection] of ids) {
      const [row] = await scratch.db[collection].storageInstance.findDocumentsById([id], true);
      if (!row) continue;
      const value = pendingValue(row), key = `${collection}:${id}`, before = initial.get(key);
      if (before && canonicalize(pendingValue(before.value)) === canonicalize(value)) continue;
      const previous = byTarget.get(key)?.[0], original = source.get(key);
      const baseline = previous?.base ?? await makeChange({ boardId, collection, documentId: id, parents: [], ancestry: 'unknown', value: documentValue({ ...(original?.value ?? value), _deleted: original?.value._deleted === true }) });
      const candidates = await journal.entries.where('[collection+documentId]').equals([collection, id]).toArray();
      const portable = portableJournalChanges(candidates);
      const known = candidates.filter(e => e.state === 'committed' && portable.has(e.id) && canonicalize(e.value) === canonicalize(baseline.value));
      const edit: PendingEdit = { id: crypto.randomUUID(), boardId, deviceKeyId: options.deviceKeyId, authorityKeyId: options.authorityKeyId,
        base: previous?.base ?? (known.length === 1 ? known[0] : baseline), value, supersedes: previous ? [previous.id] : [],
        ...((previous?.creation ?? !original) ? { creation: true } : {}), ...(previous?.parents ? { parents: previous.parents } : {}) };
      await validatePending(edit, boardId); changes.push(edit);
    }
    // One strict transaction: a multi-document command cannot be half a draft.
    await journal.write('pendingEdits', store => { changes.forEach(edit => store.put(edit)); });
    return result;
  } finally {
    // Only the new, isolated scratch database is removed; source data is untouched.
    await scratch.db.remove();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(scratch.journal.name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  }
}
