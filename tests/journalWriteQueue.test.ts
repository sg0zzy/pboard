import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { RxError } from 'rxdb';
import type { BulkWriteRow, RxCollection, RxDocumentData, RxStorageWriteError } from 'rxdb';
import { createRevision } from 'rxdb/plugins/utils';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { ChangeJournal, documentValue } from '../src/storage/changeJournal';
import { createIndexedDbBlobStore } from '../src/storage/blobStore';
import { createRxRepository } from '../src/storage/rxdbRepository';
import type { CardRecord } from '../src/storage/rxdbSchemas';
import type { JournalWriteFailure } from '../src/storage/journalStorage';

/** A write row for a document already in the storage, so `previous` is the stored bytes rather than the
 * undefined of an insert. */
type ExistingRow = BulkWriteRow<CardRecord> & { previous: RxDocumentData<CardRecord> };

/** `createRxRepository` builds its own journal and installs the storage wrapper on the cards collection
 * (rxdbRepository.ts:190-199), so `cards.storageInstance.bulkWrite` is the wrapper under test and the
 * journal these assertions read has to be that same journal. Nothing here pins a refusal string: those
 * texts are already pinned by tests/operations/changeJournalConfirmGate.test.ts. */
async function openBoard(label: string) {
  const repo = await createRxRepository({
    name: `write-queue-${label}`,
    storage: getRxStorageMemory(),
    blobs: createIndexedDbBlobStore(`write-queue-blobs-${label}`)
  });
  const board = await repo.createProject(`Board ${label}`, 'project');
  const cards = repo.db.cards;
  const first = await repo.addItem({ projectId: board.id, content: 'Baseline on the first card' });
  const second = await repo.addItem({ projectId: board.id, content: 'Baseline on the second card' });
  const spare = await repo.addItem({ projectId: board.id, content: 'Baseline on the spare card' });
  return { journal: repo.journal, cards, first, second, spare, token: repo.db.token };
}

/** Journal entry states for one card, sorted so the comparison does not depend on the order the
 * composite index returns them in. */
async function statesFor(journal: ChangeJournal, id: string) {
  return (await journal.entries.where('[collection+documentId]').equals(['cards', id]).toArray()).map(entry => entry.state).sort();
}

/** A row as the write queue builds it: the stored bytes as `previous`, the change as `document`.
 * `createRevision(token, previousDocData)` returns the new `_rev` string, so the document has to be
 * assembled from the stored bytes plus the change. */
async function rowFor(cards: RxCollection<CardRecord>, token: string, id: string, content: string): Promise<ExistingRow> {
  const stored = (await cards.storageInstance.findDocumentsById([id], true))[0];
  if (!stored) throw new Error(`card ${id} is not in the storage`);
  return { previous: stored, document: { ...stored, content, _rev: createRevision(token, stored) } };
}

/** RxDB's published write-error variants carry no cause field, so the journal cause is read through the
 * wrapper's own failure type. */
function causeOf(failure: RxStorageWriteError<CardRecord>): Error {
  const cause = (failure as JournalWriteFailure<CardRecord>).error;
  if (!(cause instanceof Error)) throw new Error('the response row did not carry a cause');
  return cause;
}

/** The queue rejects a caller with an `RxError` whose `writeError` is the row the wrapper produced for
 * that caller. `RxStorageWriteError` itself publishes no cause field, so read it as the wrapper's type. */
function callerRow(error: unknown): JournalWriteFailure<CardRecord> {
  if (!(error instanceof RxError) || !error.parameters.writeError) throw new Error('the caller was not settled with an error row');
  return error.parameters.writeError as JournalWriteFailure<CardRecord>;
}

describe('journal write queue response contract', () => {
  it('answers a guard refusal with a complete response, settles its caller with that refusal, and keeps the queue usable', async () => {
    const { journal, cards, first, spare, token } = await openBoard('settled');
    const rowRefusedByTheGuard = await rowFor(cards, token, first.id, 'Change that would clobber the retained work');
    const rowTheGuardWouldAccept = await rowFor(cards, token, spare.id, 'Change with nothing pending');

    // Recorded pending work against the journal head. A row that anchors on the head instead of on
    // the retained work is refused before the entry is written, so this call throws.
    await journal.prepare('cards', documentValue({ ...rowRefusedByTheGuard.document, content: 'Retained work' }), documentValue(rowRefusedByTheGuard.previous), true);
    const guardRefusal = await journal.prepare('cards', documentValue(rowRefusedByTheGuard.document), documentValue(rowRefusedByTheGuard.previous), true)
      .catch((error: unknown) => error);
    if (!(guardRefusal instanceof Error)) throw new Error('the guard did not refuse the row');

    // Every input row must appear: RxDB's write queue derives the written documents from the input
    // rows minus the error ids, so a row missing from the response would be treated as committed.
    const response = await cards.storageInstance.bulkWrite([rowRefusedByTheGuard, rowTheGuardWouldAccept], 'incremental-write');
    expect(response).toMatchObject({ success: [] });
    expect(response.error).toHaveLength(2);
    const causes = response.error.map(causeOf);
    // One refusal covers the batch, so both rows carry the same cause rather than a per-row outcome the
    // storage never produced.
    expect(causes[1]).toBe(causes[0]);
    for (const [index, row] of [rowRefusedByTheGuard, rowTheGuardWouldAccept].entries()) {
      const failure = response.error[index];
      if (failure.status !== 422) throw new Error('the response row is not the guard refusal form');
      expect(failure.isError).toBe(true);
      expect(failure.documentId).toBe(row.document.id);
      expect(failure.writeRow).toBe(row);
      expect(failure.context).toBe('incremental-write');
      expect(failure.validationErrors).toEqual([]);
      expect(causeOf(failure)).toBe(causes[0]);
    }

    // Nothing committed, and the retained work is still recorded for review.
    const storedAfterRefusal = await cards.storageInstance.findDocumentsById([first.id, spare.id], true);
    expect(storedAfterRefusal.map(doc => doc.content)).toEqual(['Baseline on the first card', 'Baseline on the spare card']);
    expect(await statesFor(journal, first.id)).toEqual(['committed', 'prepared']);

    // The caller settles with its own refusal instead of hanging. A queue item is anchored on the last
    // known document state, so the caller's bytes are the ones the storage still holds.
    const queue = cards.incrementalWriteQueue;
    const rejectedCallerError = await queue.addWrite(storedAfterRefusal[0], data => ({ ...data, content: 'Caller the guard refuses' }))
      .catch((error: unknown) => error);
    const rejectedRow = callerRow(rejectedCallerError);
    expect(rejectedRow.documentId).toBe(first.id);
    expect(rejectedRow.writeRow.previous).toEqual(storedAfterRefusal[0]);
    // The caller's row carries the guard's refusal as its cause, not a status-only RxDB error.
    expect(causeOf(rejectedRow)).toBe(rejectedRow.error);

    // The queue was not left marked running: a later write on the same collection completes.
    const settled = await queue.addWrite(storedAfterRefusal[1], data => ({ ...data, content: 'A later write completes' }));
    expect(settled.content).toBe('A later write completes');
    const storedAfterSettledWrite = await cards.storageInstance.findDocumentsById([first.id, spare.id], true);
    expect(storedAfterSettledWrite.map(doc => doc.content)).toEqual(['Baseline on the first card', 'A later write completes']);
    expect(await statesFor(journal, spare.id)).toEqual(['committed', 'committed']);
  });

  it('attributes a storage conflict to its own row so the accepted caller commits and the conflicting caller re-anchors on the newest state', async () => {
    const { journal, cards, first, second, token } = await openBoard('mixed');
    const rejectedRow = await rowFor(cards, token, first.id, 'Row the storage rejects');
    const acceptedRow = await rowFor(cards, token, second.id, 'Row the storage accepts');
    // Only the rejected row carries stale `previous` bytes, so the storage refuses that row alone.
    const staleRow = { previous: { ...rejectedRow.previous, _rev: 'not-the-newest-state' }, document: rejectedRow.document };
    const response = await cards.storageInstance.bulkWrite([staleRow, acceptedRow], 'incremental-write');
    expect(response.error).toHaveLength(1);
    const refused = response.error[0];
    expect(refused.status).toBe(409);
    // The response must name exactly the refused row; the storage reports its own processed copy, so
    // identify that row by the stale `previous` bytes instead of by object identity.
    expect(refused.writeRow.previous).toEqual(staleRow.previous);
    expect(refused.writeRow.document.id).toBe(first.id);

    // Exactly the failed row stays recoverable — rejected, never promoted to committed — while the
    // accepted row commits in the journal and lands in the storage.
    expect(await statesFor(journal, first.id)).toEqual(['committed', 'rejected']);
    expect(await statesFor(journal, second.id)).toEqual(['committed', 'committed']);
    const stored = await cards.storageInstance.findDocumentsById([first.id, second.id], true);
    expect(stored.map(doc => doc.content)).toEqual(['Baseline on the first card', 'Row the storage accepts']);

    // A conflict is retriable: the queue re-anchors the item on the storage's newest state and runs it
    // again, so its caller is not rejected — only a non-conflict error (the guard refusal above) rejects
    // a caller. The accepted caller settles immediately with its own outcome.
    const queue = cards.incrementalWriteQueue;
    const retriedCaller = await queue.addWrite(staleRow.previous, data => ({ ...data, content: 'Caller re-anchored after the conflict' }));
    const acceptedCaller = await queue.addWrite(stored[1], data => ({ ...data, content: 'Caller the queue accepts' }));
    expect(retriedCaller.content).toBe('Caller re-anchored after the conflict');
    expect(acceptedCaller.content).toBe('Caller the queue accepts');
    // The refused row stays recorded as rejected next to the change that committed on the retry.
    expect(await statesFor(journal, first.id)).toEqual(['committed', 'committed', 'rejected']);
  });

  it('settles every caller in a guard-refused batch with the same cause without committing any row', async () => {
    const { journal, cards, first, second, spare } = await openBoard('pending-gate');
    const stored = await cards.storageInstance.findDocumentsById([first.id, second.id, spare.id], true);
    // Recorded pending work against the journal head; a row that anchors on the head instead of on the
    // retained work is refused.
    const retained = await journal.prepare('cards', documentValue({ ...stored[0], content: 'Retained work' }), documentValue(stored[0]), true);
    expect(retained.state).toBe('prepared');

    // Items added while a run is in flight land in the next run together, because the queue takes over
    // the items it started with. So the first write pins the run boundary without any timing assumption.
    const queue = cards.incrementalWriteQueue;
    const runInFlight = queue.addWrite(stored[2], data => ({ ...data, content: 'Write that started the run' }));
    const gatedCaller = queue.addWrite(stored[0], data => ({ ...data, content: 'Caller that would clobber the retained work' }));
    const acceptedCaller = queue.addWrite(stored[1], data => ({ ...data, content: 'Caller with nothing pending' }));
    const gatedRow = callerRow(await gatedCaller.catch((error: unknown) => error));
    const acceptedRowError = callerRow(await acceptedCaller.catch((error: unknown) => error));

    // The wrapper cannot blame one row for a batch-wide refusal, so each caller still gets its own row
    // back and both carry the same cause.
    expect(gatedRow.documentId).toBe(first.id);
    expect(acceptedRowError.documentId).toBe(second.id);
    expect(acceptedRowError.error).toBe(gatedRow.error);

    // Nothing from the refused batch committed, the retained work is still there for review, and the
    // run that started before the refusal completed on its own row.
    expect((await runInFlight).content).toBe('Write that started the run');
    const storedAfter = await cards.storageInstance.findDocumentsById([first.id, second.id, spare.id], true);
    expect(storedAfter.map(doc => doc.content)).toEqual(['Baseline on the first card', 'Baseline on the second card', 'Write that started the run']);
    expect(await statesFor(journal, first.id)).toEqual(['committed', 'prepared']);
    expect(await statesFor(journal, second.id)).toEqual(['committed']);
  });
});
