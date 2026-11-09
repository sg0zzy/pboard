/** Verify a durable migration snapshot against the exact source operation
 * receipts and the prior checkpoint. This does not mark a migration complete:
 * callers must also hold a relay-enforced write fence across the cutover. */
import { canonical, digest, validateOperation, type Operation } from './protocol';
import { createSnapshot, validateSnapshot, type OperationSnapshot } from './snapshots';
import { OperationEngine, type EngineCheckpoint } from './engine';

/** Build from an existing durable baseline and every strictly recovered relay
 * operation. Never synthesize missing history or silently drop unknown edits. */
export async function prepareLegacyMigrationSnapshot(options: {
  boardId: string; baseline: EngineCheckpoint; operations: readonly Operation[]; parents?: string[];
}): Promise<OperationSnapshot> {
  if (options.baseline.boardId !== options.boardId) throw new Error('Migration baseline belongs to a different board');
  const engine = OperationEngine.restore(options.baseline);
  for (let index = 0; index < options.operations.length; index += 128) {
    await engine.receive(options.operations.slice(index, index + 128));
  }
  if (engine.pendingCount() || engine.unresolvedReferences().length || Object.keys(engine.inconsistencies()).length || engine.skippedOperations().length) {
    throw new Error('Migration history is incomplete or cannot be represented safely');
  }
  const snapshot = await createSnapshot(engine, options.parents);
  // Check operation receipts before returning an intent for publication.
  await verifyLegacyMigrationSnapshot({ boardId: options.boardId, baseline: options.baseline,
    expected: snapshot, readback: snapshot, operations: options.operations });
  return snapshot;
}

export async function verifyLegacyMigrationSnapshot(options: {
  boardId: string;
  expected: OperationSnapshot;
  readback: OperationSnapshot;
  baseline: EngineCheckpoint;
  operations: readonly Operation[];
}): Promise<void> {
  const { boardId, expected, readback, baseline, operations } = options;
  if (baseline.boardId !== boardId) throw new Error('Migration baseline belongs to a different board');
  OperationEngine.restore(baseline);
  await validateSnapshot(expected, boardId);
  await validateSnapshot(readback, boardId);
  // A valid but different snapshot is not evidence that this upload succeeded.
  if (canonical(expected) !== canonical(readback)) throw new Error('Migration snapshot readback differs from the prepared snapshot');
  if (readback.checkpoint.skipped?.length || baseline.skipped?.length) throw new Error('Migration cannot cover unknown operations');
  for (const [actor, seq] of Object.entries(baseline.frontier)) {
    if ((readback.checkpoint.frontier[actor] ?? 0) < seq) throw new Error('Migration snapshot does not cover the baseline frontier');
  }
  for (const [id, receipt] of Object.entries(baseline.receipts)) {
    const included = readback.checkpoint.receipts[id];
    if (!included || included.hash !== receipt.hash || included.clock !== receipt.clock)
      throw new Error('Migration snapshot does not cover the baseline receipts');
  }
  for (const operation of operations) {
    validateOperation(operation, boardId);
    const receipt = readback.checkpoint.receipts[operation.opId];
    if (!receipt || receipt.hash !== await digest(operation) || receipt.clock !== operation.clock
      || (readback.checkpoint.frontier[operation.actorId] ?? 0) < operation.seq) {
      throw new Error(`Migration snapshot does not cover operation ${operation.opId}`);
    }
  }
}
