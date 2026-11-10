import { canonical } from '../../src/sync/operations/protocol';
import { createRxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { createOperationService } from '../../src/sync/operations/service';
import { ImmutableDriveFake } from '../../tests/operations/driveFake';
import type { DriveBoardStore } from '../../src/sync/driveBoardStore';

const probe = { result: undefined as unknown }; (window as any).probe = probe;
(async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  async function client() {
    const name = `pboardbrowser${crypto.randomUUID().replaceAll('-', '')}`;
    const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
    const auth = { getAccessToken: async () => 'test', getConnectionState: async (): Promise<'connected'> => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} };
    const service = createOperationService({ auth, fetcher: fake.fetch, getRepository: async () => rx,
      store: { boardFolder: async () => 'folder', snapshotFileId: async () => null } as unknown as DriveBoardStore,
      sharedLayout: async () => layout, recordLayout: async (_, folderId, projectFileId) => { Object.assign(layout, { folderId, projectFileId }); }, stopLegacy: async () => {} });
    return { rx, service };
  }
  const a = await client(), b = await client(), count = 1000, stamp = new Date().toISOString(), boardId = 'browser-board';
  try {
    await a.rx.importProject({ id: boardId, name: 'Browser benchmark', template: 'project', revision: 1, createdAt: stamp, updatedAt: stamp }, Array.from({ length: count }, (_, i) => ({ id: `card-${i}`, projectId: boardId, content: `Card ${i}: ${'representative text '.repeat(12)}`, type: 'note' as const, status: 'candidate' as const, order: i, createdAt: stamp, updatedAt: stamp })));
    const start = performance.now(); await a.service.sync(boardId, true); await b.service.sync(boardId, true);
    const bootstrapMs = performance.now() - start;
    const longTasks: number[] = []; const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration))); observer.observe({ type: 'longtask', buffered: false });
    const editTimes: number[] = [], requestsBeforeEdits = fake.requests.length;
    for (let i = 0; i < 50; i++) { const t = performance.now(); await a.rx.updateItem(`card-${i % 10}`, { content: `Committed edit ${i}` }); editTimes.push(performance.now() - t); }
    const editRequests = fake.requests.length - requestsBeforeEdits;
    await a.service.sync(boardId, true); await b.service.sync(boardId, true);
    const aa = await a.rx.listCards(boardId), bb = await b.rx.listCards(boardId);
    if (canonical(aa) !== canonical(bb)) throw new Error(`Independent real IndexedDB clients diverged: ${canonical(aa).slice(0,900)} / ${canonical(bb).slice(0,900)}`);
    const beforeSnapshot = performance.now(); await a.service.compact(boardId); const snapshotMs = performance.now() - beforeSnapshot;
    await b.service.sync(boardId, true); observer.disconnect();
    const c = await client(); await c.service.sync(boardId, true);
    if (canonical(await c.rx.listCards(boardId)) !== canonical(aa)) throw new Error('Fresh browser checkpoint recovery diverged');
    await c.service.close(boardId); await c.rx.db.close();
    const operations = await a.rx.operationSource.local.operations(boardId);
    probe.result = { pass: true, backend: 'native Chromium IndexedDB; synthetic Drive API; WebRTC disabled', cards: count, edits: editTimes.length, bootstrapMs, editMedianMs: [...editTimes].sort((x,y)=>x-y)[25], editMaxMs: Math.max(...editTimes), driveRequestsDuringEdits: editRequests, totalDriveRequests: fake.requests.length, operationSegments: [...fake.files.values()].filter(file=>file.name.startsWith('operations-')).length, durableOperations: operations.length, snapshotMs, longTasksMs: longTasks, heapBytes: (performance as any).memory?.usedJSHeapSize };
  } finally { await a.service.close(boardId); await b.service.close(boardId); await a.rx.db.close(); await b.rx.db.close(); }
})().catch(error => { probe.result = { pass: false, error: String(error), stack: error.stack }; });
