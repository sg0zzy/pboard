import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { LocalOperationStore } from '../../src/sync/operations/localStore';
import { OperationEngine } from '../../src/sync/operations/engine';
import type { Command } from '../../src/sync/operations/protocol';
const journals: ChangeJournal[] = [];
const command: Command = { collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Board', template: 'project', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, unset: [] };
async function open(name = crypto.randomUUID()) { const journal = new ChangeJournal(name); await journal.open(); journals.push(journal); return { journal, store: new LocalOperationStore(journal), name }; }
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); });

describe('atomic local operation WAL and durable outbox', () => {
  it('serializes concurrent browser contexts into unique monotonic IDs', async () => {
    const a = await open(), b = await open(a.name);
    const operations = await Promise.all(Array.from({ length: 20 }, (_, n) => (n % 2 ? a : b).store.append('board', command, { frontier: {}, clock: 0 })));
    expect(new Set(operations.map(op => op.opId)).size).toBe(20);
    expect(new Set(operations.map(op => op.actorId)).size).toBe(1);
    expect(operations.map(op => op.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    expect(await a.store.outbox('board')).toHaveLength(20);
  });
  it('allocates independent streams in separate profiles on the same account', async () => {
    const a = await open(), b = await open();
    const left = await a.store.append('board', command, { frontier: {}, clock: 0 });
    const right = await b.store.append('board', command, { frontier: {}, clock: 0 });
    expect(left.opId).not.toBe(right.opId);
  });
  it('recovers after a crash before projection or Drive publication, and keeps sequence allocation', async () => {
    const a = await open(); const first = await a.store.append('board', command, { frontier: {}, clock: 0 });
    a.journal.close(); const resumed = await open(a.name), engine = new OperationEngine('board');
    await engine.receive(await resumed.store.operations('board'));
    expect(engine.state().project?.name).toBe('Board'); expect(await resumed.store.outbox('board')).toHaveLength(1);
    const next = await resumed.store.append('board', { ...command, kind: 'patch', fields: { name: 'Next' } }, { frontier: engine.vector(), clock: engine.logicalClock() });
    expect(next.actorId).toBe(first.actorId); expect(next.seq).toBe(2);
  });
  it('does not allocate a sequence for invalid commands or failed transactions', async () => {
    const a = await open();
    await expect(a.store.append('board', { ...command, fields: {} }, { frontier: {}, clock: 0 })).rejects.toThrow();
    const first = await a.store.append('board', command, { frontier: {}, clock: 0 });
    await expect(a.store.append('board', command, { frontier: { [first.actorId]: 200 }, clock: 300 })).rejects.toThrow();
    const second = await a.store.append('board', command, { frontier: {}, clock: 0 });
    expect(second.seq).toBe(2); expect(await a.store.outbox('board')).toHaveLength(2);
  });
  it('never treats WebRTC acknowledgement as Drive publication', async () => {
    const a = await open(), op = await a.store.append('board', command, { frontier: {}, clock: 0 });
    await a.store.markRealtimeSent(op.opId);
    expect((await a.store.outbox('board'))[0]).toMatchObject({ realtimeSent: true });
    expect((await a.store.outbox('board'))[0].driveFileId).toBeUndefined();
  });
  it('persists a fixed upload intent and recovers it after crash during upload or before local acknowledgement', async () => {
    const a = await open(); await a.store.append('board', command, { frontier: {}, clock: 0 });
    const intent = await a.store.prepareSegment('board', 'reserved-drive-id'); expect(intent).toBeTruthy();
    expect(await a.store.prepareSegment('board', 'another-id')).toBeNull();
    a.journal.close(); const resumed = await open(a.name);
    expect(await resumed.store.prepared('board')).toEqual([intent]);
    await resumed.store.published(intent!.id); await resumed.store.published(intent!.id);
    expect((await resumed.store.outbox('board'))[0].driveFileId).toBe('reserved-drive-id');
    expect(await resumed.store.operations('board')).toHaveLength(1);
  });
  it('batches many edits, caps segments and gives concurrent preparers disjoint claims', async () => {
    const a = await open();
    for (let n = 0; n < 150; n++) await a.store.append('board', command, { frontier: {}, clock: 0 });
    const [first, second] = await Promise.all([a.store.prepareSegment('board', 'file-1'), a.store.prepareSegment('board', 'file-2')]);
    expect(first!.segment.operations).toHaveLength(128); expect(second!.segment.operations).toHaveLength(22);
    const ids = [...first!.segment.operations, ...second!.segment.operations].map(op => op.opId);
    expect(new Set(ids).size).toBe(150);
  });
  it('persists bounded exponential backoff with jitter without changing operation IDs', async () => {
    const a = await open(); const op = await a.store.append('board', command, { frontier: {}, clock: 0 });
    const intent = (await a.store.prepareSegment('board', 'file'))!;
    await a.store.failed(intent.id, 100, 0); let row = (await a.store.prepared('board'))[0];
    expect(row.retryAt).toBe(1100); expect(row.segment.operations[0].opId).toBe(op.opId);
    for (let n = 0; n < 20; n++) await a.store.failed(intent.id, 100, 1);
    row = (await a.store.prepared('board'))[0]; expect(row.retryAt).toBe(300100);
  });
  it('deduplicates remote persistence, rejects conflicting IDs atomically and does not add remote work to own outbox', async () => {
    const a = await open(), b = await open(), op = await a.store.append('board', command, { frontier: {}, clock: 0 });
    await b.store.receive('board', [op, op]); await b.store.receive('board', [op]);
    expect(await b.store.operations('board')).toHaveLength(1); expect(await b.store.outbox('board')).toHaveLength(0);
    await expect(b.store.receive('board', [{ ...op, fields: { ...op.fields, name: 'Changed' } }])).rejects.toThrow();
    expect(await b.store.operations('board')).toEqual([op]);
  });  it('guards operation writes with existing board erasure and purges the new local history', async () => {
    const a = await open(); await a.store.append('board', command, { frontier: {}, clock: 0 });
    await a.store.prepareSegment('board', 'reserved'); await a.store.downloaded('board', 'remote-file');
    await a.journal.beginBoardErasure('board', null, [], []);
    await expect(a.store.append('board', command, { frontier: {}, clock: 0 })).rejects.toThrow(/aborted/);
    await a.journal.purgeBoardHistory('board');
    expect(await a.store.operations('board')).toHaveLength(0); expect(await a.store.outbox('board')).toHaveLength(0);
    expect(await a.store.prepared('board')).toHaveLength(0); expect(await a.store.downloadedFiles('board')).toEqual(new Set());
    await expect(a.store.append('board', command, { frontier: {}, clock: 0 })).rejects.toThrow(/aborted/);
  });
  it('upgrades the v6 journal additively without changing legacy records or receipts', async () => {
    const name = crypto.randomUUID();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`${name}-change-journal-v1`, 6);
      request.onupgradeneeded = () => {
        const entries = request.result.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('boardId', 'boardId'); entries.createIndex('state', 'state');
        entries.createIndex('[collection+documentId]', ['collection', 'documentId']);
        const receipts = request.result.createObjectStore('receipts', { keyPath: 'id' }); receipts.createIndex('destination', 'destination');
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['entries', 'receipts'], 'readwrite');
      tx.objectStore('entries').put({ id: 'legacy-entry', boardId: 'board', state: 'committed', value: { content: 'Retained' } });
      tx.objectStore('receipts').put({ id: 'legacy-receipt', destination: 'private-history', changeId: 'legacy-entry' });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    database.close();
    const upgraded = await open(name);
    expect(await upgraded.journal.entries.get('legacy-entry')).toMatchObject({ value: { content: 'Retained' } });
    expect(await upgraded.journal.receipts.get('legacy-receipt')).toMatchObject({ destination: 'private-history' });
    const operation = await upgraded.store.append('board', command, { frontier: {}, clock: 0 });
    expect(operation.seq).toBe(1);
  });

});
