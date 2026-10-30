import type { ChangeJournal } from '../../storage/changeJournal';
import { canonical, validateCommand, validateOperation, validateSegment, MAX_SEGMENT_BYTES, MAX_SEGMENT_OPERATIONS, PROTOCOL, type Command, type Frontier, type Operation, type Segment } from './protocol';

export type SnapshotIntent = { id: string; kind: 'snapshot-intent'; boardId: string; fileId: string; snapshot: import('./snapshots').OperationSnapshot; published: boolean };
type Stream = { id: string; boardId: string; actorId: string; seq: number; clock: number; frontier: Frontier; seen?: Frontier };
type Stored = { sourceId?: string; id: string; boardId: string; operation: Operation };
export type OutboxRow = Stored & { queuedAt?: number; realtimeSent: boolean; pendingBoard?: string; incorporatedSnapshotId?: string; segmentId?: string; driveFileId?: string };
export type PreparedSegment = { id: string; boardId: string; fileId: string; segment: Segment; published: boolean; attempts: number; retryAt: number; pendingBoard?: string };
const tables = ['operations', 'operationStreams', 'operationOutbox', 'operationCheckpoints'];

/** Source of truth is the committed WAL, with the UI as a recoverable projection.
 * No sequence can be allocated without the matching operation + outbox row. */
export class LocalOperationStore {
  private actors = new Map<string, string>();
  isOwn(boardId: string, operation: Operation) { return this.actors.get(boardId) === operation.actorId; }
  constructor(private journal: ChangeJournal) {}
  async append(boardId: string, command: Command, observed: { frontier: Frontier; clock: number }, sourceId?: string): Promise<Operation> {
    // Clone caller-owned buffers before IDB yields. Each browser profile gets a
    // random stream; shared contexts serialize through the IDB transaction.
    const input = structuredClone(command), seen = structuredClone(observed);
    validateCommand(input);
    const actor = crypto.randomUUID();
    return this.journal.operationTransaction(boardId, tables, (tx, result) => {
      const streams = tx.objectStore('operationStreams'), request = streams.get(boardId);
      request.onsuccess = () => {
        const allocate = () => {
        try {
          const stream: Stream = request.result ?? { id: boardId, boardId, actorId: actor, seq: 0, clock: 0, frontier: {} };
          const deps: Frontier = { ...stream.frontier };
          for (const [id, seq] of Object.entries(seen.frontier)) deps[id] = Math.max(deps[id] ?? 0, seq);
          if ((deps[stream.actorId] ?? 0) > stream.seq) throw new Error('Local stream identity was reused by another writer');
          if (stream.seq) deps[stream.actorId] = stream.seq;
          const operation: Operation = { ...input, schemaVersion: 1, boardId, actorId: stream.actorId, seq: stream.seq + 1,
            opId: `${stream.actorId}:${stream.seq + 1}`, clock: Math.max(stream.clock, seen.clock) + 1, deps };
          validateOperation(operation, boardId);
          const row: Stored = { id: operation.opId, boardId, operation, ...(sourceId ? { sourceId } : {}) };
          tx.objectStore('operations').add(row);
          if (sourceId) {
            tx.objectStore('operationCheckpoints').put({ id: `source-done:${sourceId}`, kind: 'operation-source-complete', boardId, operationId: operation.opId });
            tx.objectStore('operationCheckpoints').delete(`source-pending:${sourceId}`);
          }
          tx.objectStore('operationOutbox').add({ ...row, queuedAt: Date.now(), realtimeSent: false, pendingBoard: boardId });
          streams.put({ ...stream, seq: operation.seq, clock: operation.clock, frontier: { ...deps, [stream.actorId]: operation.seq }, seen: { ...stream.seen, [stream.actorId]: operation.seq } });
          this.actors.set(boardId, operation.actorId); result(operation);
        } catch { tx.abort(); }
        };
        if (!sourceId) allocate();
        else {
          const existing = tx.objectStore('operations').index('sourceId').get(sourceId);
          existing.onsuccess = () => { if (existing.result) {
            tx.objectStore('operationCheckpoints').put({ id: `source-done:${sourceId}`, kind: 'operation-source-complete', boardId, operationId: existing.result.operation.opId });
            tx.objectStore('operationCheckpoints').delete(`source-pending:${sourceId}`); result(existing.result.operation);
          } else allocate(); };
        }
      };
    });
  }
  async observed(boardId: string): Promise<{ frontier: Frontier; clock: number }> {
    const stream = await this.journal.read<Stream | undefined>('operationStreams', store => store.get(boardId));
    return { frontier: stream?.frontier ?? {}, clock: stream?.clock ?? 0 };
  }
  async observe(boardId: string, frontier: Frontier, clock: number): Promise<void> {
    await this.journal.operationTransaction<void>(boardId, ['operationStreams'], (tx, result) => {
      const store = tx.objectStore('operationStreams'), request = store.get(boardId);
      request.onsuccess = () => {
        const stream: Stream = request.result ?? { id: boardId, boardId, actorId: crypto.randomUUID(), seq: 0, clock: 0, frontier: {} };
        const merged = { ...stream.frontier };
        for (const [actor, seq] of Object.entries(frontier)) merged[actor] = Math.max(merged[actor] ?? 0, seq);
        store.put({ ...stream, frontier: merged, clock: Math.max(stream.clock, clock) });
      }; result(undefined);
    });
  }
  async localAfter(boardId: string, frontier: Frontier): Promise<Operation[]> {
    const stream = await this.journal.read<Stream | undefined>('operationStreams', store => store.get(boardId));
    if (!stream || (frontier[stream.actorId] ?? 0) >= stream.seq) return [];
    const range = IDBKeyRange.bound([boardId, stream.actorId, (frontier[stream.actorId] ?? 0) + 1], [boardId, stream.actorId, stream.seq]);
    const rows = await this.journal.read<Stored[]>('operations', store => store.index('stream').getAll(range));
    return rows.map(row => row.operation);
  }
  async operationsSince(boardId: string, frontier: Frontier): Promise<Operation[]> {
    const stream = await this.journal.read<Stream | undefined>('operationStreams', store => store.get(boardId));
    // Upgrade fallback for local WALs written before actor discovery metadata.
    if (stream) this.actors.set(boardId, stream.actorId);
    if (!stream?.seen) return (await this.operations(boardId)).filter(op => op.seq > (frontier[op.actorId] ?? 0));
    const actors = new Set([...Object.keys(stream.seen), ...Object.keys(stream.frontier), stream.actorId]);
    const rows = await Promise.all([...actors].map(actor => this.journal.read<Stored[]>('operations', store => store.index('stream').getAll(
      IDBKeyRange.bound([boardId, actor, (frontier[actor] ?? 0) + 1], [boardId, actor, Number.MAX_SAFE_INTEGER])))));
    return rows.flat().map(row => row.operation);
  }
  async operations(boardId: string): Promise<Operation[]> {
    const rows = await this.journal.read<Stored[]>('operations', store => store.index('boardId').getAll(boardId));
    return rows.map(row => row.operation);
  }
  async outbox(boardId: string, pendingOnly = false): Promise<OutboxRow[]> {
    return this.journal.read('operationOutbox', store => store.index(pendingOnly ? 'pendingBoard' : 'boardId').getAll(boardId));
  }
  async pendingTiming(boardId: string): Promise<{ oldest: number; latest: number } | null> {
    const rows = await this.outbox(boardId, true);
    if (!rows.length) return null;
    // Older outboxes have no enqueue timestamp. Treat those rows as overdue
    // rather than granting them another 25 minutes on every restart.
    let oldest = Infinity, latest = 0;
    for (const row of rows) { const time = row.queuedAt ?? 0; oldest = Math.min(oldest, time); latest = Math.max(latest, time); }
    return { oldest, latest };
  }
  /** Caller verifies current Drive permission before using either transport. */
  async receive(boardId: string, inputs: Operation[]): Promise<void> {
    const copied = structuredClone(inputs);
    const unique = new Map<string, Operation>();
    for (const op of copied) {
      const previous = unique.get(op.opId);
      if (previous && canonical(previous) !== canonical(op)) throw new Error('Conflicting operation identity');
      unique.set(op.opId, op);
    }
    const operations = [...unique.values()];
    if (copied.length > 128) throw new Error('Bounded receive batch required');
    for (const operation of operations) validateOperation(operation, boardId);
    await this.journal.operationTransaction<void>(boardId, ['operations', 'operationStreams'], (tx, result) => {
      const streams = tx.objectStore('operationStreams'), stream = streams.get(boardId);
      stream.onsuccess = () => {
        const row: Stream = stream.result ?? { id: boardId, boardId, actorId: crypto.randomUUID(), seq: 0, clock: 0, frontier: {} };
        const seen = { ...row.seen }; for (const op of operations) seen[op.actorId] = Math.max(seen[op.actorId] ?? 0, op.seq); streams.put({ ...row, seen });
      };
      const store = tx.objectStore('operations');
      for (const operation of operations) {
        const request = store.get(operation.opId);
        request.onsuccess = () => {
          if (request.result && canonical(request.result.operation) !== canonical(operation)) { tx.abort(); return; }
          if (!request.result) store.add({ id: operation.opId, boardId, operation });
        };
      }
      result(undefined);
    });
  }
  async downloadedFiles(boardId: string): Promise<Set<string>> {
    const receipts = await this.journal.receipts.where('destination').equals(`operation-download:${boardId}`).toArray();
    return new Set(receipts.map(row => row.changeId));
  }
  async downloaded(boardId: string, fileId: string): Promise<void> {
    await this.journal.receipts.put({ id: `operation-download:${boardId}:${fileId}`, changeId: fileId, destination: `operation-download:${boardId}` });
  }
  async saveCheckpoint(checkpoint: import('./engine').EngineCheckpoint): Promise<void> {
    await this.journal.operationTransaction<void>(checkpoint.boardId, ['operationCheckpoints'], (tx, result) => {
      tx.objectStore('operationCheckpoints').put({ id: checkpoint.boardId, boardId: checkpoint.boardId, checkpoint });
      tx.objectStore('operationCheckpoints').put({ id: `checkpoint-info:${checkpoint.boardId}`, kind: 'checkpoint-info', boardId: checkpoint.boardId, generation: crypto.randomUUID(), frontier: checkpoint.frontier }); result(undefined);
    }, ['operationCheckpoint']);
  }
  async checkpointInfo(boardId: string): Promise<{ generation: string; frontier: Frontier } | undefined> { return this.journal.read('operationCheckpoints', store => store.get(`checkpoint-info:${boardId}`)); }
  async checkpoint(boardId: string): Promise<import('./engine').EngineCheckpoint | null> {
    const row = await this.journal.read<{ checkpoint: import('./engine').EngineCheckpoint } | undefined>('operationCheckpoints', store => store.get(boardId));
    return row?.checkpoint ?? null;
  }
  async snapshotIntents(boardId: string): Promise<SnapshotIntent[]> {
    const rows = await this.journal.read<any[]>('operationCheckpoints', store => store.index('boardId').getAll(boardId));
    return rows.filter(row => row.kind === 'snapshot-intent');
  }
  async prepareSnapshot(snapshot: import('./snapshots').OperationSnapshot, fileId: string): Promise<SnapshotIntent> {
    const intent: SnapshotIntent = { id: `snapshot:${snapshot.snapshotId}`, kind: 'snapshot-intent', boardId: snapshot.boardId,
      snapshot: structuredClone(snapshot), fileId, published: false };
    await this.journal.operationTransaction<void>(snapshot.boardId, ['operationCheckpoints'], (tx, result) => {
      tx.objectStore('operationCheckpoints').add(intent); result(undefined);
    });
    return intent;
  }
  async snapshotPublished(id: string): Promise<void> {
    const intent = await this.journal.read<SnapshotIntent | undefined>('operationCheckpoints', store => store.get(id));
    if (!intent) throw new Error('Snapshot publication intent is missing');
    await this.journal.operationTransaction<void>(intent.boardId, ['operationCheckpoints', 'operationOutbox'], (tx, result) => {
      const store = tx.objectStore('operationCheckpoints'), request = store.get(id);
      request.onsuccess = () => { if (request.result?.kind !== 'snapshot-intent') { tx.abort(); return; }
        store.put({ ...request.result, published: true });
        for (const opId of Object.keys(intent.snapshot.checkpoint.receipts)) {
          const outbox = tx.objectStore('operationOutbox'), row = outbox.get(opId);
          row.onsuccess = () => { if (row.result) outbox.put({ ...row.result, incorporatedSnapshotId: intent.snapshot.snapshotId }); };
        }
      };
      result(undefined);
    });
  }
  async markRealtimeSent(opId: string): Promise<void> {
    const row = await this.journal.read<OutboxRow | undefined>('operationOutbox', store => store.get(opId));
    if (!row) return;
    await this.journal.operationTransaction<void>(row.boardId, ['operationOutbox'], (tx, result) => {
      const store = tx.objectStore('operationOutbox'), request = store.get(opId);
      request.onsuccess = () => { if (request.result) store.put({ ...request.result, realtimeSent: true }); };
      result(undefined);
    });
  }
  async prepared(boardId: string, pendingOnly = false): Promise<PreparedSegment[]> {
    return this.journal.read('operationSegments', store => store.index(pendingOnly ? 'pendingBoard' : 'boardId').getAll(boardId));
  }
  /** fileId comes from Drive generateIds; this entire intent commits before upload.
   * A concurrent context may prepare another batch, but cannot claim these rows. */
  async prepareSegment(boardId: string, fileId: string): Promise<PreparedSegment | null> {
    if (!fileId || fileId.length > 200) throw new Error('Drive file ID required');
    const segmentId = crypto.randomUUID();
    return this.journal.operationTransaction(boardId, ['operationOutbox', 'operationSegments'], (tx, result) => {
      const outbox = tx.objectStore('operationOutbox'), request = outbox.index('pendingBoard').getAll(boardId);
      request.onsuccess = () => {
        const rows = (request.result as OutboxRow[]).filter(row => !row.segmentId && !row.driveFileId)
          .sort((a, b) => a.operation.actorId < b.operation.actorId ? -1 : a.operation.actorId > b.operation.actorId ? 1 : a.operation.seq - b.operation.seq);
        const segment: Segment = { protocol: PROTOCOL, boardId, segmentId, operations: [] };
        const encoder = new TextEncoder(); let bytes = encoder.encode(canonical(segment)).length;
        for (const row of rows.slice(0, MAX_SEGMENT_OPERATIONS)) {
          const size = encoder.encode(canonical(row.operation)).length + (segment.operations.length ? 1 : 0);
          if (bytes + size > MAX_SEGMENT_BYTES - 128) break;
          segment.operations.push(row.operation); bytes += size;
        }
        if (!segment.operations.length) { result(null); return; }
        const prepared: PreparedSegment = { id: segmentId, boardId, fileId, segment, published: false, attempts: 0, retryAt: 0, pendingBoard: boardId };
        try { validateSegment(segment, boardId); } catch { tx.abort(); return; }
        tx.objectStore('operationSegments').add(prepared);
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const op of segment.operations) outbox.put({ ...byId.get(op.opId)!, segmentId });
        result(prepared);
      };
    });
  }
  async published(id: string): Promise<void> {
    const intent = await this.journal.read<PreparedSegment | undefined>('operationSegments', store => store.get(id));
    if (!intent) throw new Error('Segment publication intent is missing');
    await this.journal.operationTransaction<void>(intent.boardId, ['operationOutbox', 'operationSegments'], (tx, result) => {
      const segments = tx.objectStore('operationSegments'), request = segments.get(id);
      request.onsuccess = () => {
        const segment = request.result as PreparedSegment | undefined;
        if (!segment) { tx.abort(); return; }
        segments.put({ ...segment, published: true, pendingBoard: undefined });
        const outbox = tx.objectStore('operationOutbox');
        for (const op of segment.segment.operations) {
          const row = outbox.get(op.opId);
          row.onsuccess = () => { if (row.result) outbox.put({ ...row.result, driveFileId: segment.fileId, pendingBoard: undefined }); };
        }
      };
      result(undefined);
    });
  }
  async failed(id: string, now = Date.now(), random = Math.random()): Promise<void> {
    const intent = await this.journal.read<PreparedSegment | undefined>('operationSegments', store => store.get(id));
    if (!intent) return;
    await this.journal.operationTransaction<void>(intent.boardId, ['operationSegments'], (tx, result) => {
      const store = tx.objectStore('operationSegments'), request = store.get(id);
      request.onsuccess = () => {
        const row = request.result as PreparedSegment | undefined;
        if (!row || row.published) return;
        const attempts = row.attempts + 1;
        store.put({ ...row, attempts, retryAt: now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 9)) * (0.5 + Math.max(0, Math.min(1, random)) / 2) });
      };
      result(undefined);
    });
  }
}
