/** Strict recovery of an encrypted relay window. Unlike live replay, recovery
 * must not advance across an unreadable row: it may be an edit, not a beacon.
 * This function performs no writes and does not authorize a format cutover. */
import { parseStrictJson } from '../../collab/security/canonical';
import { openOp, type BoardContentKey, type SealedOp } from '../bufferCrypto';
import { record, validateOperation, type Operation } from './protocol';

export type LegacyRelayRow = { seq: number; opId: string; payload: string };
export type LegacyRecoveryResult =
  | { status: 'ready'; operations: Operation[]; covered: number }
  | { status: 'blocked'; reason: 'missing-key' | 'invalid-window' | 'unreadable-row' | 'invalid-operation'; sequence?: number };

/** The caller must provide every row strictly after `after` through `through`,
 * including pages received from the relay. A gap, foreign key, corrupted row or
 * handoff beacon blocks the entire window; none is treated as safely covered. */
export async function recoverLegacyRelayWindow(options: {
  boardId: string; after: number; through: number; rows: readonly LegacyRelayRow[]; key?: BoardContentKey;
}): Promise<LegacyRecoveryResult> {
  const { boardId, after, through, rows, key } = options;
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(through) || after < 0 || through < after || rows.length !== through - after)
    return { status: 'blocked', reason: 'invalid-window' };
  if (rows.length && !key) return { status: 'blocked', reason: 'missing-key' };
  const operations: Operation[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.seq !== after + index + 1 || typeof row.opId !== 'string' || typeof row.payload !== 'string')
      return { status: 'blocked', reason: 'invalid-window', sequence: after + index + 1 };
    let decoded: unknown;
    try {
      const envelope: unknown = parseStrictJson(row.payload, 4 * 1024 * 1024);
      if (!record(envelope) || envelope.v !== 1 || envelope.opId !== row.opId
        || typeof envelope.keyId !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') throw new Error('Invalid envelope');
      decoded = await openOp(key!, envelope as SealedOp);
    } catch {
      return { status: 'blocked', reason: 'unreadable-row', sequence: row.seq };
    }
    try {
      if (!record(decoded)) throw new Error('Invalid operation');
      const operation = decoded as Operation;
      validateOperation(operation, boardId);
      if (operation.opId !== row.opId) throw new Error('Operation identity mismatch');
      operations.push(operation);
    } catch {
      return { status: 'blocked', reason: 'invalid-operation', sequence: row.seq };
    }
  }
  return { status: 'ready', operations, covered: through };
}
