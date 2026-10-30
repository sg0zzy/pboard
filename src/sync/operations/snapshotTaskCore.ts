import { parseStrictJson } from '../../collab/security/canonical';
import { OperationEngine, type EngineCheckpoint } from './engine';
import { createSnapshot, validateSnapshot, planGardening, type OperationSnapshot } from './snapshots';

export type SnapshotTask = { kind: 'build'; checkpoint: EngineCheckpoint; parents: string[] }
  | { kind: 'validate'; snapshot: OperationSnapshot; boardId: string }
  | { kind: 'parse'; text: string; boardId: string }
  | { kind: 'checkpoint'; checkpoint: EngineCheckpoint }
  | { kind: 'garden'; options: Parameters<typeof planGardening>[0] };
/** Shared by a bundled worker and the non-DOM background/Node fallback. */
export async function executeSnapshotTask(task: SnapshotTask): Promise<unknown> {
  if (task.kind === 'checkpoint') { OperationEngine.restore(task.checkpoint); return true; }
  if (task.kind === 'build') return createSnapshot(OperationEngine.restore(task.checkpoint), task.parents);
  if (task.kind === 'validate') { await validateSnapshot(task.snapshot, task.boardId); return true; }
  if (task.kind === 'garden') return planGardening(task.options);
  const snapshot = parseStrictJson(task.text, 32 * 1024 * 1024) as unknown as OperationSnapshot;
  await validateSnapshot(snapshot, task.boardId); return snapshot;
}
