import { executeSnapshotTask, type SnapshotTask } from './snapshotTaskCore';
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: number; task: SnapshotTask }>) => void) | null; postMessage: (value: unknown) => void };
worker.onmessage = event => {
  void executeSnapshotTask(event.data.task).then(value => worker.postMessage({ id: event.data.id, value }),
    error => worker.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : 'Snapshot processing failed' }));
};
