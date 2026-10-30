import snapshotWorkerUrl from './snapshotWorker?worker&url';
import { executeSnapshotTask, type SnapshotTask } from './snapshotTaskCore';
import { OperationEngine, type EngineCheckpoint } from './engine';
import type { OperationSnapshot, planGardening } from './snapshots';
let worker: Worker | undefined, next = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
function stop(error: Error) {
  worker?.terminate(); worker = undefined;
  for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(error); } pending.clear();
}
function request<T>(task: SnapshotTask): Promise<T> {
  // MV3 workers already execute outside the UI thread. Node uses the same
  // implementation, so tests do not depend on a browser-specific polyfill.
  if (typeof document === 'undefined' || typeof Worker === 'undefined') return executeSnapshotTask(task) as Promise<T>;
  if (pending.size >= 4) return Promise.reject(new Error('Snapshot processing is busy. Retry after the current job finishes.'));
  if (!worker) {
    worker = new Worker(new URL(snapshotWorkerUrl, globalThis.location.href), { type: 'module' });
    worker.onmessage = event => {
      const item = pending.get(event.data.id); if (!item) return;
      pending.delete(event.data.id); clearTimeout(item.timeout);
      if (event.data.error) item.reject(new Error(event.data.error)); else item.resolve(event.data.value);
    };
    worker.onerror = () => stop(new Error('Snapshot worker failed. Local work and previous Drive history are retained.'));
    globalThis.addEventListener?.('pagehide', () => stop(new Error('Snapshot processing was interrupted; retry on reopening')), { once: true });
  }
  const id = ++next;
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => stop(new Error('Snapshot processing timed out; previous history is retained')), 60000);
    pending.set(id, { resolve, reject, timeout });
    try { worker!.postMessage({ id, task }); } catch (error) { pending.delete(id); clearTimeout(timeout); reject(error); }
  });
}
export const createSnapshotAsync = (engine: OperationEngine, parents: string[] = []) => request<OperationSnapshot>({ kind: 'build', checkpoint: engine.checkpoint(), parents });
export const validateSnapshotAsync = async (snapshot: OperationSnapshot, boardId: string) => { await request({ kind: 'validate', snapshot, boardId }); };
export const parseSnapshotAsync = (text: string, boardId: string) => request<OperationSnapshot>({ kind: 'parse', text, boardId });
export const planGardeningAsync = (options: Parameters<typeof planGardening>[0]) => request<Awaited<ReturnType<typeof planGardening>>>({ kind: 'garden', options });

export async function restoreCheckpointAsync(checkpoint: EngineCheckpoint) { await request({ kind: 'checkpoint', checkpoint }); return OperationEngine.restoreVerified(checkpoint); }
