/** Prepare a durable snapshot of a fenced legacy relay window. This does not
 * switch formats or release the fence: those require the cutover protocol. */
import type { BoardContentKey } from '../bufferCrypto';
import type { EngineCheckpoint } from './engine';
import { prepareLegacyMigrationSnapshot, verifyLegacyMigrationSnapshot } from './legacyMigrationSnapshot';
import { recoverLegacyRelayWindow, type LegacyRelayRow } from './legacyRelayRecovery';
import type { OperationSnapshot } from './snapshots';

export type LegacyMigrationIntent = {
  boardId: string; generation: string; after: number; through: number;
  baseline: EngineCheckpoint; snapshot: OperationSnapshot;
};

export type LegacyMigrationPreparation = {
  boardId: string; generation: string; after: number; baseline: EngineCheckpoint;
  fence(generation: string): Promise<number>;
  readWindow(after: number, through: number): Promise<LegacyRelayRow[]>;
  key(): Promise<BoardContentKey | undefined>;
  journal: {
    /** Persist or verify this board/generation before fencing, so a crash before
     * the first snapshot intent still leaves the fence recoverable. */
    reserve(boardId: string, generation: string): Promise<void>;
    load(): Promise<LegacyMigrationIntent | null>;
    save(intent: LegacyMigrationIntent): Promise<void>;
  };
  /** Must be idempotent for this exact snapshot, including after a crash. */
  publish(snapshot: OperationSnapshot): Promise<void>;
  /** Independently retrieve the immutable snapshot from durable storage. */
  readback(snapshotId: string): Promise<OperationSnapshot>;
};

export async function prepareFencedLegacyMigration(options: LegacyMigrationPreparation): Promise<LegacyMigrationIntent> {
  await options.journal.reserve(options.boardId, options.generation);
  const through = await options.fence(options.generation);
  const saved = await options.journal.load();
  if (saved && (saved.boardId !== options.boardId || saved.generation !== options.generation
    || saved.after !== options.after || saved.through !== through)) throw new Error('A different migration attempt is already recorded');
  // Re-read and decrypt on every attempt: the saved intent alone does not prove
  // the recovered window was complete, and source rows remain fenced in place.
  const rows = await options.readWindow(options.after, through);
  const recovered = await recoverLegacyRelayWindow({ boardId: options.boardId, after: options.after, through, rows, key: await options.key() });
  if (recovered.status !== 'ready') throw new Error(`Legacy recovery blocked: ${recovered.reason}`);
  const intent = saved ?? { boardId: options.boardId, generation: options.generation, after: options.after, through,
    baseline: options.baseline, snapshot: await prepareLegacyMigrationSnapshot({ boardId: options.boardId, baseline: options.baseline, operations: recovered.operations }) };
  // This check runs even for a resumed intent before any remote write.
  await verifyLegacyMigrationSnapshot({ boardId: options.boardId, baseline: intent.baseline,
    expected: intent.snapshot, readback: intent.snapshot, operations: recovered.operations });
  if (!saved) await options.journal.save(intent);
  // Another owner may have cancelled and restarted this generation while we
  // were preparing; never publish against a changed relay watermark.
  if (await options.fence(options.generation) !== through) throw new Error('Migration fence changed while preparing the snapshot');
  await options.publish(intent.snapshot);
  const readback = await options.readback(intent.snapshot.snapshotId);
  await verifyLegacyMigrationSnapshot({ boardId: options.boardId, baseline: intent.baseline,
    expected: intent.snapshot, readback, operations: recovered.operations });
  if (await options.fence(options.generation) !== through) throw new Error('Migration fence changed while verifying the snapshot');
  return intent;
}
