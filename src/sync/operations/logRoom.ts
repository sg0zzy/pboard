/**
 * The per-room half of the operation log: the cursor, the applied sequence, the
 * operations awaiting acknowledgment, and the requests that move all three.
 *
 * It is deliberately transport-free. A room's behaviour must not depend on
 * whether its frames travel over a socket of its own (protocol 2) or over the
 * context's shared socket (protocol 3), so the only thing this module asks its
 * caller for is `ask(action, body)` — "put one request on the wire and give me
 * the reply" — and the hooks that say when a bootstrap finished. Everything
 * else in here is state that belongs to the room and to nothing else, which is
 * also why one room losing its attachment cannot disturb another's cursor.
 */
import { parseStrictJson } from '../../collab/security/canonical';
import { emit } from '../../debug/bus';
import { importSigningKey, signBytes, type StoredDeviceKey } from '../../collab/security/keys';
import { prepareRelayAdmission, type RelayAuthorization } from '../../collab/security/relayAdmission';
import type { ServiceAdmissionRequest } from '../../collab/experimentalWebSocketSignaling';
import { ServiceAdmissionUnavailable } from './logPolicy';
import { collaborationDiagnostic } from '../../collab/diagnostics';
import { openOp, sealOp, type BoardContentKey, type SealedOp } from '../bufferCrypto';
import { isKnownVocabulary, validateOperation, type Operation } from './protocol';
import type { LogGap } from './logSync';

/** Envelope version understood by the log; the server refuses others. */
export const LOG_PROTOCOL_VERSION = 1;

export type Frame = Record<string, unknown>;
export const aString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export const aNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const aBoolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
export const frames = (value: unknown): Frame[] => Array.isArray(value)
  ? value.filter((row): row is Frame => !!row && typeof row === 'object' && !Array.isArray(row)) : [];

/** A row whose sealed envelope disagrees with the identifier the log is
 * delivering it under (or is not an envelope at all). That is an integrity
 * violation on data addressed to *our* key — never inert foreign wire — so
 * it must fail the batch instead of being skipped. */
export class OperationBindingError extends Error {}

/** Log codec: operations are sealed with the board content key, exactly as the
 * legacy buffer had them. */
export function createOperationLogCodec(key: BoardContentKey) {
  return {
    async seal(operation: Operation) { return JSON.stringify(await sealOp(key, operation.opId, operation)); },
    async open(payload: string, opId: string) {
      const sealed = parseStrictJson(payload, 4 * 1024 * 1024) as SealedOp | null;
      if (!sealed || typeof sealed !== 'object' || sealed.opId !== opId) throw new OperationBindingError('Operation payload does not match its identifier');
      // Decrypted at the edge and validated by the caller; the plaintext shape is
      // whatever the author sealed, so it cannot be trusted without `validateOperation`.
      return await openOp(key, sealed) as unknown as Operation;
    }
  };
}

export type LogMetrics = {
  submitted: number; acked: number; duplicates: number; received: number;
  resubmitted: number; reconnects: number; gaps: number; refused: number;
  holes: number; adoptions: number; skipped: number; foreign: number;
};

export type RoomCoreOptions = {
  /** Board identifier used to validate operation payloads. */
  boardId: string;
  seal: (operation: Operation) => Promise<string>;
  open: (payload: string, opId: string) => Promise<Operation>;
  receive: (operations: Operation[]) => Promise<void>;
  /** A log row this device could not open. Never throws. */
  foreignRow?: (sequence: number) => void;
  /** The replay window could not be answered. */
  gap?: (gap: LogGap) => void;
  /** Last applied sequence, persisted so a browser restart does not re-read
   * retained history. */
  cursor?: { load: () => Promise<number>; save: (sequence: number) => Promise<void> };
  /** Puts one request on the wire and resolves with its reply. Rejects with the
   * server's own code when the reply is an `error` frame. */
  ask: (action: string, body: Frame) => Promise<Frame>;
  /** The room's cursor or queue moved: the caller republishes its status. */
  announce: () => void;
  /** A bootstrap settled: `synced` (live from the cursor) or `snapshot` (the
   * history was pruned and the caller must read a snapshot first). */
  synchronized: (outcome: 'synced' | 'snapshot', detail: { reason?: string }) => void;
  /** Runs a self-healing follow-up (the missing-window re-subscribe) off the
   * caller's own queue, so it cannot interleave with the room's serialized work.
   * A failing follow-up is reported, never thrown: the room is still usable. */
  background: (work: () => Promise<void>) => void;
};

export type RoomCore = {
  readonly metrics: LogMetrics;
  appliedSeq(): number;
  checkpointSeq(): number;
  setCheckpoint(sequence: number): void;
  pendingCount(): number;
  pendingOperations(): Operation[];
  /** Applies rows in arrival order. The cursor moves only after `receive`
   * took them. */
  apply(rows: Frame[]): Promise<void>;
  /** The first replay window of a connection. */
  bootstrap(): Promise<void>;
  /** Re-reads what the cursor cannot reach any other way. */
  resync(): Promise<void>;
  /** Submits without the caller's own queue; callers are already serialized. */
  publish(operations: Operation[]): Promise<boolean>;
  /** Applies log operations until the cursor reaches `sequence`. */
  catchUpTo(sequence: number): Promise<'ready' | 'gap'>;
  /** Continues from a sequence a published snapshot already covers. */
  resumeFrom(sequence: number): Promise<void>;
  /** Resubmits anything the log never acknowledged. */
  resend(): Promise<boolean>;
};

export async function createRoomCore(options: RoomCoreOptions): Promise<RoomCore> {
  const metrics: LogMetrics = { submitted: 0, acked: 0, duplicates: 0, received: 0, resubmitted: 0, reconnects: 0, gaps: 0, refused: 0, holes: 0, adoptions: 0, skipped: 0, foreign: 0 };
  let appliedSeq = await options.cursor?.load() ?? 0, checkpointSeq = 0;
  const unacked = new Map<string, Operation>();
  // Sequences known to be in the log — applied, or our own and acknowledged —
  // that are not yet contiguous with the cursor. The cursor never jumps over a
  // hole: the relay drops a subscriber that cannot drain rather than blocking
  // the connection, and a live broadcast lost that way must not be skipped
  // forever by a cursor that had already run past it.
  const durable = new Set<number>();
  let resyncing = false, adopting = false;

  const advance = async () => {
    const before = appliedSeq;
    while (durable.has(appliedSeq + 1)) { appliedSeq++; durable.delete(appliedSeq); }
    await options.cursor?.save(appliedSeq);
    // The cursor is the transport's own progress report, and a subscriber that
    // only hears about it on the next unrelated event reads a stale frontier:
    // `receive` has already applied the record (the board row is visible) while
    // the reported sequence still sits below it. Announcing here makes "the
    // record was applied, not merely received" observable at the moment it is
    // true, and costs one status call per applied batch.
    if (appliedSeq !== before) options.announce();
  };

  async function apply(rows: Frame[]) {
    const operations: Operation[] = [];
    const sequences: number[] = [];
    let sawForeign = false;
    for (const row of rows) {
      const seq = aNumber(row.seq), opId = aString(row.opId), payload = aString(row.payload);
      // A row at/below our cursor or already durable: a known duplicate from
      // replay overlap. Debug severity: during a bootstrap replay this is
      // routine bookkeeping, and a trace reader can still find it.
      if (typeof seq === 'number' && typeof opId === 'string' && (seq <= appliedSeq || durable.has(seq)))
        emit({ component: "sync", event: "operation.duplicate", severity: "debug", boardId: options.boardId, operationId: opId, details: { seq, appliedSeq, reason: seq <= appliedSeq ? "cursor" : "durable" } });
      if (typeof seq !== 'number' || seq <= appliedSeq || durable.has(seq) || typeof opId !== 'string' || typeof payload !== 'string') continue;
      emit({ component: "sync", event: "operation.received", severity: "info", boardId: options.boardId, operationId: opId, details: { seq } });
      let operation: Operation;
      try {
        operation = await options.open(payload, opId);
      } catch (error) {
        // A binding violation (envelope vs delivered identifier) is an integrity
        // failure on data addressed to our own key — it fails the batch and holds
        // the cursor below. Anything else that will not open is inert wire, not a
        // broken connection: sealing can rotate, and an admitted writer may still
        // be waiting for the board key — its handoff beacon is meant to look
        // exactly like this. Skipping advances the cursor past the row (the
        // cursor's no-hole rule protects undelivered rows, not unreadable ones)
        // and tells the board, which is what re-wraps the key or fetches a
        // rotated one.
        if (error instanceof OperationBindingError) throw error;
        metrics.foreign++; sawForeign = true;
        collaborationDiagnostic('logsync.foreign_seal', { count: seq });
        options.foreignRow?.(seq);
        durable.add(seq);
        continue;
      }
      // The log is opaque by design, so the only place a wrong board, a forged
      // identifier or a stale schema version can be caught is here. A row that
      // opened with our own key yet fails these checks stays a hard batch
      // failure with the cursor held: it must be seen again on the next
      // reconnect, never silently advanced past.
      validateOperation(operation, options.boardId);
      if (operation.opId !== opId) throw new Error('Operation record does not match its payload');
      // Structurally valid but over vocabulary this build cannot read: hand it
      // to the session anyway — its engine owns the skip ledger the snapshot
      // paths consult — and let the sequence become durable below so the cursor
      // advances past it.
      if (!isKnownVocabulary(operation)) { metrics.skipped++; collaborationDiagnostic('logsync.unsupported_operation', { count: seq }); }
      emit({ component: "sync", event: "operation.validated", severity: "info", boardId: options.boardId, operationId: opId, details: { seq, clock: operation.clock, kind: operation.kind, ...(isKnownVocabulary(operation) ? {} : { vocabulary: "unsupported" }) } });
      operations.push(operation);
      sequences.push(seq);
    }
    if (!operations.length) { if (sawForeign) await advance(); return; }
    // The cursor advances only after the engine has taken them: an operation it
    // rejected must be seen again on the next reconnect, not skipped.
    // The local store accepts at most 128 operations per durable
    // transaction, while a relay replay page may contain up to 512. Commit and
    // advance each chunk independently so a later failure never skips it.
    for (let offset = 0; offset < operations.length; offset += 128) {
      const chunk = operations.slice(offset, offset + 128);
      await options.receive(chunk);
      metrics.received += chunk.length;
      for (const operation of chunk)
        emit({ component: "sync", event: "operation.applied", severity: "info", boardId: options.boardId, operationId: operation.opId, details: { kind: operation.kind, seq: operation.seq } });
      for (const seq of sequences.slice(offset, offset + 128)) durable.add(seq);
      await advance();
    }
  }

  async function resync() {
    const window = await options.ask('subscribe', { afterSeq: appliedSeq, limit: 128 });
    checkpointSeq = aNumber(window.checkpointSeq) ?? checkpointSeq;
    await apply(frames(window.operations));
  }

  async function bootstrap() {
    let target: number | undefined;
    for (;;) {
      const window = await options.ask('subscribe', { afterSeq: appliedSeq, limit: 128 });
      checkpointSeq = aNumber(window.checkpointSeq) ?? 0;
      if (target === undefined) {
        const liveFrom = aNumber(window.liveFromSeq);
        if (Number.isSafeInteger(liveFrom) && liveFrom! > 0) target = liveFrom! - 1;
      }
      const before = appliedSeq;
      await apply(frames(window.operations));
      if (window.synced !== true) {
        const reason = aString((window.gap as Frame | undefined)?.reason) ?? 'history_unavailable';
        metrics.gaps++;
        const detail = { reason,
          checkpointSeq: aNumber((window.gap as Frame | undefined)?.checkpointSeq),
          checkpointEpoch: aNumber((window.gap as Frame | undefined)?.checkpointEpoch),
          snapshotSeq: aNumber((window.gap as Frame | undefined)?.snapshotSeq),
          oldestRetainedSeq: aNumber((window.gap as Frame | undefined)?.oldestRetainedSeq) };
        options.synchronized('snapshot', { reason });
        options.gap?.(detail);
        return;
      }
      if (target === undefined || appliedSeq >= target) break;
      if (appliedSeq === before) throw new Error('Operation log replay did not advance');
    }
    options.synchronized('synced', {});
    // Everything still unacknowledged predates this connection.
    const retry = [...unacked.values()];
    if (retry.length) { metrics.resubmitted += retry.length; await publish(retry); }
  }

  async function publish(operations: Operation[]): Promise<boolean> {
    if (!operations.length) return false;
    for (const operation of operations) unacked.set(operation.opId, operation);
    metrics.submitted += operations.length;
    let allAcknowledged = true;
    // The relay fans each accepted operation out separately into a bounded
    // socket queue, including the sender's own queue. Wait for each small
    // batch so a backlog cannot fill that queue in one synchronous fan-out.
    for (let offset = 0; offset < operations.length; offset += 16) {
      const batch = operations.slice(offset, offset + 16);
      for (const operation of batch)
        emit({ component: "sync", event: "operation.transmitted", severity: "info", boardId: options.boardId, operationId: operation.opId, details: { seq: operation.seq } });
      const sealed = await Promise.all(batch.map(async operation => ({
        opId: operation.opId,
        protocolVersion: LOG_PROTOCOL_VERSION,
        logicalClock: operation.clock,
        payload: await options.seal(operation)
      })));
      const reply = await options.ask('submit', { operations: sealed });
      // Answered per batch, never globally: two callers can have operations waiting
      // at the same time, and "your edit is safe" cannot depend on someone else's.
      const acknowledged = new Set<string>();
      for (const result of frames(reply.results)) {
        const opId = aString(result.opId), seq = aNumber(result.seq), duplicate = aBoolean(result.duplicate);
        if (!opId || typeof seq !== 'number') continue;
        unacked.delete(opId);
        acknowledged.add(opId);
        metrics.acked++;
        if (duplicate) metrics.duplicates++;
        emit({
          component: "sync",
          event: duplicate ? "operation.duplicate" : "operation.acknowledged",
          severity: "info",
          boardId: options.boardId,
          operationId: opId,
          details: { seq, ...(duplicate ? { serverDuplicate: true } : {}) }
        });
        // An acknowledged sequence is durable whether or not the broadcast for it
        // has arrived; remembering it keeps a reload from waiting on our own edit.
        durable.add(seq);
        await advance();
        if (seq > appliedSeq + 1 && !resyncing) {
          // Something below our own operation was never delivered to this
          // connection. Ask for exactly the missing window instead of letting the
          // cursor settle over it; the log retains it until a snapshot covers it.
          metrics.holes++;
          resyncing = true;
          options.background(async () => { try { await resync(); } finally { resyncing = false; } });
        }
      }
      allAcknowledged &&= batch.every(op => acknowledged.has(op.opId));
    }
    return allAcknowledged;
  }

  return {
    metrics,
    appliedSeq: () => appliedSeq,
    checkpointSeq: () => checkpointSeq,
    setCheckpoint(sequence: number) { checkpointSeq = sequence; },
    pendingCount: () => unacked.size,
    pendingOperations: () => [...unacked.values()],
    apply,
    bootstrap,
    resync,
    publish,
    async catchUpTo(sequence: number) {
      for (let page = 0; appliedSeq < sequence && page < 64; page++) {
        const window = await options.ask('subscribe', { afterSeq: appliedSeq, limit: 128 });
        checkpointSeq = aNumber(window.checkpointSeq) ?? checkpointSeq;
        const rows = frames(window.operations);
        const before = appliedSeq;
        await apply(rows);
        // No progress means the rows the log offered do not continue from the
        // cursor — which is a gap by definition, not a page worth retrying.
        if (!rows.length || appliedSeq === before) return appliedSeq >= sequence ? 'ready' : 'gap';
      }
      return appliedSeq >= sequence ? 'ready' : 'gap';
    },
    /**
     * Continues from a sequence the caller adopted from a published snapshot.
     * The cursor is replaced rather than advanced — everything below it is
     * understood to be inside the snapshot the caller just applied — and a
     * second adoption cannot start while one is running, or the two windows
     * would interleave.
     */
    async resumeFrom(sequence: number) {
      if (adopting) return;
      adopting = true;
      metrics.adoptions++;
      try {
        appliedSeq = sequence;
        durable.clear();
        await options.cursor?.save(sequence);
        await bootstrap();
      } finally { adopting = false; }
    },
    async resend() {
      const retry = [...unacked.values()];
      if (!retry.length) return true;
      metrics.resubmitted += retry.length;
      await publish(retry);
      return unacked.size === 0;
    }
  };
}

/** Rebuilds one room's admission proof against a specific welcome. The proof is
 * bound to the connection's `challenge`/`session`, so it is built per dial —
 * never cached — and for v3 it is the same material v2 sent, because the
 * binding is the same one.
 *
 * When the welcome demands service admission this mints **that room's own**
 * receipt for this exact `(challenge, session, room, device)` binding. Receipts
 * are single-use (`identity_enrollment.rs` consumes one on presentation), so a
 * proof is never reused across two frames and never reused across two
 * welcomes. A failure here is that room's alone and is raised as
 * `ServiceAdmissionUnavailable` — carrying whether a retry with the same
 * material could succeed — so a room whose ticket cannot be minted reports its
 * own cause instead of taking the socket down. */
export async function proveRoom(options: {
  topic: string;
  authorization: RelayAuthorization;
  key: StoredDeviceKey;
  challenge: string;
  session: string;
  serviceAdmissionRequired: boolean;
  getServiceAdmission?: (request: ServiceAdmissionRequest) => Promise<string>;
  /** True when this failure cannot be cured by retrying with the same material
   * (the identity service refused the account, not the transport). */
  isTerminalAdmissionError?: (error: unknown) => boolean;
}) {
  const admission = await prepareRelayAdmission(options.topic, options.authorization, options.key.keyId);
  let serviceAdmission: string | undefined;
  if (options.serviceAdmissionRequired) {
    if (!options.getServiceAdmission) throw new ServiceAdmissionUnavailable('Verified Google service admission is required', false);
    try {
      serviceAdmission = await options.getServiceAdmission({ challenge: options.challenge, session: options.session, room: admission.room, key: options.key });
    } catch (cause) {
      // The room's own cause, in the room's own vocabulary: the sidebar already
      // speaks `service_auth_required` and `admission:refused`, and either is
      // truthful here because the frame this proof would have carried never
      // reached the relay.
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new ServiceAdmissionUnavailable(reason, options.isTerminalAdmissionError?.(cause) === true);
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(serviceAdmission))
      throw new ServiceAdmissionUnavailable('Invalid service admission response', false);
  }
  const signature = await signBytes(await importSigningKey(options.key.privateJwk), new TextEncoder().encode(JSON.stringify(
    ['pboard-ws-auth-v2', options.challenge, options.session, admission.room, options.key.keyId, admission.digest])));
  return { room: admission.room, keyId: options.key.keyId, signature, serviceAdmission, authorization: admission.authorization };
}
