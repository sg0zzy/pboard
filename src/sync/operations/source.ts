import type { ChangeJournal, DocumentValue, JournalEntry } from '../../storage/changeJournal';
import { canonical, validateCommand, type Collection, type Command } from './protocol';
import { LocalOperationStore } from './localStore';

/** A binding is local routing/Drive-cache data, never an authorization token. */
export type OperationBinding = { id: string; kind: 'operation-binding'; boardId: string; folderId: string;
  role: 'owner' | 'editor' | 'viewer' | 'revoked'; pendingIndexed?: boolean; legacyFileIds: string[]; baseRevision: number };
const projectKeys = ['name', 'template', 'createdAt', 'updatedAt'];
const cardKeys = ['title', 'content', 'type', 'status', 'displayMode', 'source', 'orderKey', 'createdAt', 'updatedAt', 'deletedAt'];
export function operationFields(collection: Collection, value: DocumentValue): Command['fields'] {
  const fields: Command['fields'] = {};
  for (const key of collection === 'projects' ? projectKeys : cardKeys) if (value[key] !== undefined) fields[key] = value[key];
  if (collection === 'cards' && typeof value.imageId === 'string') fields.image = {
    id: value.imageId, mimeType: value.imageMimeType ?? 'image/webp', width: value.imageWidth ?? 1, height: value.imageHeight ?? 1
  };
  return fields;
}
export function commandFromChange(entry: JournalEntry, parents: DocumentValue[]): Command | null {
  const fields = operationFields(entry.collection, entry.value);
  if (entry.value._deleted) return { collection: entry.collection, entityId: entry.documentId, kind: 'delete', fields: {}, unset: [] };
  if (!parents.length || parents.every(parent => parent._deleted)) {
    const command: Command = { collection: entry.collection, entityId: entry.documentId, kind: 'create', fields, unset: [] };
    validateCommand(command); return command;
  }
  const previous = parents.map(parent => operationFields(entry.collection, parent));
  const changed: Command['fields'] = {}, unset: string[] = [];
  for (const key of new Set([...Object.keys(fields), ...previous.flatMap(Object.keys)])) {
    if (previous.every(parent => canonical(parent[key] ?? null) === canonical(fields[key] ?? null))) continue;
    if (fields[key] === undefined) unset.push(key); else changed[key] = fields[key];
  }
  // RxDB bookkeeping/touchProject is not a second semantic edit.
  if (!unset.length && Object.keys(changed).every(key => ['updatedAt', 'createdAt'].includes(key))) return null;
  const command: Command = { collection: entry.collection, entityId: entry.documentId, kind: 'patch', fields: changed, unset };
  validateCommand(command); return command;
}

/** The pre-existing document WAL is the crash boundary. Conversion is idempotent
 * on its immutable source ID, including when two extension contexts recover it. */
export class OperationSource {
  readonly bindings = new Map<string, OperationBinding>();
  readonly local: LocalOperationStore;
  private covered = new Map<string, Set<string>>();
  private unsubscribe?: () => void;
  private refreshing: Promise<void> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly journal: ChangeJournal) { this.local = new LocalOperationStore(journal); }
  async open() {
    const rows = await this.journal.read<OperationBinding[]>('operationCheckpoints', store => store.index('kind').getAll('operation-binding'));
    for (const row of rows) if (row.kind === 'operation-binding') this.bindings.set(row.boardId, row);
    for (const boardId of this.bindings.keys()) {
      this.covered.set(boardId, new Set((await this.journal.receipts.where('destination').equals(`operation-source-covered:${boardId}`).toArray()).map(row => row.changeId)));
      await this.recover(boardId).catch(() => undefined);
    }
    this.unsubscribe = this.journal.subscribe(tables => {
      if (!tables.includes('operationBindings')) return;
      this.refreshing = this.refreshing.then(async () => {
        const bindings = await this.journal.read<OperationBinding[]>('operationCheckpoints', store => store.index('kind').getAll('operation-binding'));
        const ids = new Set(bindings.map(binding => binding.boardId));
        for (const board of this.bindings.keys()) if (!ids.has(board)) this.bindings.delete(board);
        for (const binding of bindings) {
          const first = !this.bindings.has(binding.boardId); this.bindings.set(binding.boardId, binding);
          if (first) {
            this.covered.set(binding.boardId, new Set((await this.journal.receipts.where('destination').equals(`operation-source-covered:${binding.boardId}`).toArray()).map(row => row.changeId)));
            await this.recover(binding.boardId);
          }
        }
      }).catch(() => undefined); // WAL recovery retries on the next open; no work is discarded.
    });
  }
  close() { this.unsubscribe?.(); }
  async bind(input: OperationBinding, coveredIds: string[] = []) {
    const binding = { ...input, pendingIndexed: true };
    const covered = new Set([...(this.covered.get(binding.boardId) ?? []), ...coveredIds]);
    await this.journal.operationTransaction<void>(binding.boardId, ['operationCheckpoints', 'entries'], (tx, result) => {
      const metadata = tx.objectStore('operationCheckpoints'), old = metadata.get(binding.id);
      old.onsuccess = () => {
        if (!old.result?.pendingIndexed) {
          const sources = tx.objectStore('entries').index('localBoard').getAllKeys([binding.boardId, 'committed', 'local']);
          sources.onsuccess = () => { for (const id of sources.result.map(String)) if (!covered.has(id)) metadata.put({ id: `source-pending:${id}`, kind: 'operation-source-pending', boardId: binding.boardId, entryId: id }); };
        }
        metadata.put(binding);
      };
      for (const id of coveredIds) tx.objectStore('receipts').put({ id: `operation-source-covered:${binding.boardId}:${id}`, changeId: id, destination: `operation-source-covered:${binding.boardId}` });
      result(undefined);
    }, ['operationBindings']);
    this.bindings.set(binding.boardId, binding); this.covered.set(binding.boardId, covered);
  }
  capture(entries: JournalEntry[]): Promise<void> {
    const run = this.queue.then(async () => {
      const done = new Set<string>(), visiting = new Set<string>();
      type Frame = { entry: JournalEntry; parents?: JournalEntry[] };
      const frames: Frame[] = [...entries].reverse().map(entry => ({ entry }));
      while (frames.length) {
        const frame = frames.pop()!, input = frame.entry;
        if (done.has(input.id) || input.origin !== 'local' || !this.bindings.has(input.boardId) || this.covered.get(input.boardId)?.has(input.id)) continue;
        if (!frame.parents) {
          if (visiting.has(input.id)) throw new Error('Local history has a causal cycle');
          const completed = await this.journal.read('operationCheckpoints', store => store.get(`source-done:${input.id}`));
          if (completed) { done.add(input.id); continue; }
          const entry = await this.journal.entries.get(input.id);
          if (entry?.state !== 'committed') continue;
          const parents = await Promise.all(entry.parents.map(id => this.journal.entries.get(id)));
          if (parents.some(parent => !parent || parent.boardId !== entry.boardId || parent.collection !== entry.collection || parent.documentId !== entry.documentId)) throw new Error('Local edit ancestry is unavailable or mismatched; the WAL is retained');
          visiting.add(entry.id); frames.push({ entry, parents: parents as JournalEntry[] });
          for (const parent of [...parents].reverse()) if (parent!.origin === 'local') frames.push({ entry: parent! });
          continue;
        }
        const command = commandFromChange(input, frame.parents.map(parent => parent.value));
        if (command) await this.local.append(input.boardId, command, await this.local.observed(input.boardId), input.id);
        else await this.journal.operationTransaction<void>(input.boardId, ['operationCheckpoints'], (tx, result) => {
          tx.objectStore('operationCheckpoints').put({ id: `source-done:${input.id}`, kind: 'operation-source-complete', boardId: input.boardId, operationId: null });
          tx.objectStore('operationCheckpoints').delete(`source-pending:${input.id}`); result(undefined);
        });
        visiting.delete(input.id); done.add(input.id);
      }
    });
    this.queue = run.catch(() => undefined); return run;
  }
  async recover(boardId: string) {
    const binding = this.bindings.get(boardId);
    if (binding && !binding.pendingIndexed) await this.bind(binding);
    const rows = await this.journal.read<{ entryId: string }[]>('operationCheckpoints', store => store.index('kindBoard').getAll(['operation-source-pending', boardId]));
    const entries = await Promise.all(rows.map(row => this.journal.entries.get(row.entryId)));
    if (entries.some(entry => !entry)) throw new Error('A pending operation source is missing; export the retained board before repairing history');
    await this.capture(entries as JournalEntry[]);
  }
}
