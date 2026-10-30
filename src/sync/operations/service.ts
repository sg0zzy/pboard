import { createSnapshotAsync, parseSnapshotAsync, planGardeningAsync } from './snapshotTasks';
import { blobToDataUrl } from '../../storage/blobStore';
import type { RxRepository } from '../../storage/rxdbRepository';
import type { GoogleAuthProvider } from '../googleAuth';
import type { DriveBoardStore } from '../driveBoardStore';
import { serializeProjectSnapshot, deserializeProjectSnapshot, type ProjectSnapshot } from '../snapshot';
import { deserializeBoardSnapshotV2, v2EntitiesToV1 } from '../snapshotV2';
import { createOperationDriveStore, type OperationDriveStore, type DriveRole } from './driveStore';
import { OperationSession } from './session';
import { OperationEngine } from './engine';
import { legacyBootstrap, preserveLocalFork } from './migration';
import { projectOperations } from './projection';
import { canonical, PROTOCOL, digest, MAX_SEGMENT_BYTES, MAX_SEGMENT_OPERATIONS, type Segment } from './protocol';
import { parseStrictJson } from '../../collab/security/canonical';
import type { OperationBinding } from './source';

type MigrationMarker = { protocol: string; boardId: string; snapshotFileId?: string; baselineSegmentIds?: string[]; baselineIntegrity?: string; legacyFileIds: string[] };
const SNAPSHOT_LIMIT = 32 * 1024 * 1024;
export function createOperationService(options: {
  auth: GoogleAuthProvider; store: DriveBoardStore; fetcher: typeof fetch; getRepository: () => Promise<RxRepository | null>;
  sharedLayout: (boardId: string) => Promise<{ folderId: string | null; projectFileId: string | null }>;
  stopLegacy: (boardId: string) => Promise<void>;
  changes?: ReturnType<typeof import('./changes').createDriveChanges>;
  recoverLegacyImage?: (boardId: string, imageId: string) => Promise<import('../../types').BoardImage | null>;
  freezeLegacyMirrors?: (boardId: string, drive: OperationDriveStore) => Promise<void>;
  realtime?: (boardId: string, session: OperationSession, drive: OperationDriveStore) => Promise<{ broadcast: (ops: import('./protocol').Operation[]) => Promise<boolean>; close: () => Promise<void> }>;
  recordLayout: (boardId: string, folderId: string, projectFileId: string) => Promise<void>;
  onStatus?: (boardId: string, error?: string) => Promise<void>;
}) {
  const sessions = new Map<string, { session: OperationSession; drive: OperationDriveStore; stop: () => void; binding: OperationBinding }>();
  const opening = new Map<string, Promise<OperationSession>>();
  async function repository() { const rx = await options.getRepository(); if (!rx) throw new Error('Operation synchronization requires local RxDB storage'); return rx; }
  async function readSnapshot(drive: OperationDriveStore, id: string, boardId: string) {
    return parseSnapshotAsync(await drive.read(id, SNAPSHOT_LIMIT), boardId);
  }
  async function syncImages(rx: RxRepository, drive: OperationDriveStore, boardId: string, images: { id: string }[], publish = true) {
    if (!images.length) return;
    const files = await drive.inventory(), verified = await rx.operationSource.local.downloadedFiles(boardId);
    const role = await drive.folderRole();
    for (const imageId of new Set(images.map(image => image.id))) {
      const candidates = files.filter(file => file.name === `image-${imageId}.json`);
      let local = await rx.blobs.getBlob(imageId), durable = false;
      for (const file of candidates) {
        if (verified.has(file.id) && local) { durable = true; break; }
        try {
          const image = await drive.readImage(file.id, imageId);
          if (!local) { await rx.putImage(image); local = await rx.blobs.getBlob(imageId); }
          await rx.operationSource.local.downloaded(boardId, file.id); durable = true; break;
        } catch { /* Preserve corrupt candidates and try another immutable copy. */ }
      }
      if (durable) continue;
      if (!local && options.recoverLegacyImage) {
        const recovered = await options.recoverLegacyImage(boardId, imageId);
        if (recovered) { const actual = await rx.putImage(recovered); if (actual !== imageId) throw new Error('Legacy image hash mismatch; original asset retained'); local = await rx.blobs.getBlob(imageId); }
      }
      if (local && (role === 'viewer' || !publish)) continue;
      if (!local || !['owner', 'editor'].includes(role)) throw new Error(`Image ${imageId.slice(0, 12)} is not yet available on Google Drive; text edits remain saved`);
      const id = `image:${boardId}:${imageId}`;
      let intent = await rx.journal.read<{ fileId: string } | undefined>('operationCheckpoints', store => store.get(id));
      if (!intent) {
        intent = { fileId: await drive.allocateId() };
        await rx.journal.operationTransaction<void>(boardId, ['operationCheckpoints'], (tx, result) => { tx.objectStore('operationCheckpoints').put({ id, boardId, kind: 'image-intent', ...intent }); result(undefined); });
      }
      await drive.publishImage(intent.fileId, imageId, { dataUrl: await blobToDataUrl(local.blob), mimeType: local.mimeType, width: local.width, height: local.height });
      await rx.operationSource.local.downloaded(boardId, intent.fileId);
    }
  }
  async function open(boardId: string, allowRemoved = false): Promise<OperationSession> {
    const active = sessions.get(boardId); if (active) return active.session;
    const pending = opening.get(boardId); if (pending) return pending;
    const run = performOpen(boardId, allowRemoved).finally(() => opening.delete(boardId)); opening.set(boardId, run); return run;
  }
  async function performOpen(boardId: string, allowRemoved: boolean) {
    const rx = await repository();
    if ((!allowRemoved && await rx.isDeletedProject(boardId)) || await rx.journal.boardErasure(boardId)) throw new Error('This board was removed');
    const existing = rx.operationSource.bindings.get(boardId), shared = await options.sharedLayout(boardId);
    const folderId = existing?.folderId ?? shared.folderId ?? await options.store.boardFolder(boardId);
    const drive: OperationDriveStore = createOperationDriveStore({ auth: options.auth, fetcher: options.fetcher, boardId, folderId,
      inventory: options.changes ? (full, force) => options.changes!.inventory(boardId, folderId, full, force) : undefined,
      role: async () => {
        const role = await drive.folderRole();
        const binding = rx.operationSource.bindings.get(boardId);
        if (binding && binding.role !== role) await rx.bindOperationBoard({ ...binding, role });
        return role;
      } });
    const role = await drive.folderRole();
    if (role === 'revoked') throw new Error('Google Drive access was revoked');
    await options.stopLegacy(boardId);
    let binding = existing;
    if (!binding) {
      // Capture recoverable local work before any migration projection/network.
      const covered = await rx.journal.localSourceIds(boardId);
      const local = await rx.getProject(boardId) ? await rx.exportProject(boardId) : null;
      const initialFiles = await drive.inventory();
      const markers = initialFiles.filter(file => file.name.startsWith('migration-'));
      let base: OperationEngine, legacyIds: string[] = [], baseRevision = local?.project.revision ?? 0;
      if (markers.length) {
        const checkpoints = [];
        for (const file of markers) {
          const marker = parseStrictJson(await drive.read(file.id)) as unknown as MigrationMarker;
          if (marker.protocol !== PROTOCOL || marker.boardId !== boardId || !Array.isArray(marker.legacyFileIds) || (typeof marker.snapshotFileId !== 'string' && !Array.isArray(marker.baselineSegmentIds))) throw new Error('Unsupported board protocol. Upgrade Pboard; local work is retained.');
          for (const id of marker.legacyFileIds) {
            if (!(await drive.metadata(id)).contentRestrictions?.some(r => r.readOnly)) throw new Error('The legacy write barrier was removed. Re-lock the legacy snapshot before syncing.');
          }
          legacyIds.push(...marker.legacyFileIds);
        }
        for (const file of initialFiles.filter(file => file.name.startsWith('snapshot-'))) checkpoints.push((await readSnapshot(drive, file.id, boardId)).checkpoint);
        if (checkpoints.length) base = OperationEngine.join(checkpoints, true);
        else {
          base = new OperationEngine(boardId);
          for (const file of markers) {
            const marker = parseStrictJson(await drive.read(file.id)) as unknown as MigrationMarker;
            if (!marker.baselineSegmentIds?.length) throw new Error('No verified recovery snapshot or baseline remains');
            const candidate = new OperationEngine(boardId);
            for (const id of marker.baselineSegmentIds) { const segment = await drive.readSegment(id); await rx.operationSource.local.receive(boardId, segment.operations); await candidate.receive(segment.operations); }
            if (typeof marker.baselineIntegrity !== 'string' || await digest(candidate.checkpoint()) !== marker.baselineIntegrity) throw new Error('Legacy operation baseline is incomplete or corrupt; original data retained');
            base = OperationEngine.join([base.checkpoint(), candidate.checkpoint()], true);
          }
          base.checkpoint(); // Require complete baseline sequences, including the tail.
        }
        if (local) {
          // Preserve ambiguous pre-protocol forks rather than replay historical
          // whole documents as if they were fresh user edits.
          const remote = base.state();
          const compatible: ProjectSnapshot = { format: 'pboard-project', version: 1, exportedAt: new Date().toISOString(),
            project: { ...(remote.project ?? { ...local.project, name: '' }), revision: baseRevision } as never,
            items: remote.cards.map((card, order) => ({ ...card, order, ...((card.image as any)?.id ? { imageId: (card.image as any).id, imageMimeType: (card.image as any).mimeType, imageWidth: (card.image as any).width, imageHeight: (card.image as any).height } : {}), image: undefined })) as never };
          await preserveLocalFork(rx, local, compatible);
        }
      } else {
        const legacyFileId = shared.projectFileId ?? await options.store.snapshotFileId(boardId);
        let legacy: ProjectSnapshot | null = null;
        const readLegacy = async (): Promise<ProjectSnapshot> => {
          if (shared.projectFileId) return deserializeProjectSnapshot(await drive.read(legacyFileId!, SNAPSHOT_LIMIT));
          const bytes = await options.store.downloadFile(legacyFileId!);
          if (!bytes) throw new Error('Legacy snapshot is missing; no migration data was removed');
          const snapshot = await deserializeBoardSnapshotV2(bytes, { expectBoardId: boardId });
          return v2EntitiesToV1(snapshot.entities, snapshot.exportedAt);
        };
        if (role === 'viewer') {
          await rx.setMutatorRole(boardId, 'viewer');
          if (legacyFileId) {
            const readable = await readLegacy();
            if (readable.project.id !== boardId) throw new Error('Legacy board identity mismatch');
            const preview = await legacyBootstrap(readable, rx);
            if (local) await preserveLocalFork(rx, local, readable);
            await projectOperations(rx, preview.engine, []);
            await syncImages(rx, drive, boardId, preview.engine.state().cards.flatMap(card => card.image ? [card.image as { id: string }] : []));
          }
          throw new Error('Legacy content is available read-only. A Drive editor must upgrade this board to synchronize operations.');
        }
        if (legacyFileId) {
          // Validate compatibility before installing a write barrier. Read again
          // after locking so an edit committed during preflight is included.
          const preflight = await readLegacy();
          if (preflight.project.id !== boardId) throw new Error('Legacy board identity mismatch');
          await legacyBootstrap(preflight, rx);
          await drive.protectLegacy(legacyFileId); legacyIds = [legacyFileId];
          legacy = await readLegacy();
        }
        if (!legacy && local) legacy = { format: 'pboard-project', version: 1, exportedAt: new Date().toISOString(), ...local };
        if (!legacy || legacy.project.id !== boardId) throw new Error('No matching recoverable board exists');
        const bootstrap = await legacyBootstrap(legacy, rx); base = bootstrap.engine;
        await options.freezeLegacyMirrors?.(boardId, drive);
        if (local && legacyFileId) await preserveLocalFork(rx, local, legacy);
        // Keep the legacy discovery identity, including for new unified boards.
        // Old clients can read this checkpoint but cannot overwrite it.
        let discoveryId = shared.projectFileId;
        if (!discoveryId) {
          discoveryId = await drive.allocateId();
          await drive.createLegacy(discoveryId, serializeProjectSnapshot(legacy.project, legacy.items));
          legacyIds.push(discoveryId);
        }
        await options.recordLayout(boardId, folderId, discoveryId);
        baseRevision = legacy.project.revision;
        if (role === 'owner') {
        let intent = (await rx.operationSource.local.snapshotIntents(boardId)).find(row => !row.published);
        if (!intent) intent = await rx.operationSource.local.prepareSnapshot(await createSnapshotAsync(base), await drive.allocateId());
        await drive.publishSnapshot(intent.fileId, intent.snapshot); await rx.operationSource.local.snapshotPublished(intent.id);
        await syncImages(rx, drive, boardId, base.state().cards.flatMap(card => card.image ? [card.image as { id: string }] : []));
        // The marker is immutable; a crash before it leaves the source locked and
        // recoverable, and retry publishes another equivalent candidate safely.
        await drive.publishMigration(await drive.allocateId(), { protocol: PROTOCOL, boardId, snapshotFileId: intent.fileId, legacyFileIds: legacyIds });
        } else {
          // Editors bootstrap through the same immutable operation protocol;
          // creating a consolidated snapshot remains exclusively owner-only.
          const baselineSegmentIds: string[] = []; let offset = 0;
          while (offset < bootstrap.operations.length) {
            const operations: typeof bootstrap.operations = [], encoder = new TextEncoder(); let bytes = 512;
            while (offset < bootstrap.operations.length && operations.length < MAX_SEGMENT_OPERATIONS) {
              const op = bootstrap.operations[offset], size = encoder.encode(canonical(op)).length + 1;
              if (bytes + size > MAX_SEGMENT_BYTES && operations.length) break;
              operations.push(op); bytes += size; offset++;
            }
            const segmentId = `baseline-${(await digest(operations)).slice(0, 40)}`;
            const segment: Segment = { protocol: PROTOCOL, boardId, segmentId, operations };
            const key = `migration-segment:${boardId}:${segmentId}`;
            let saved = await rx.journal.read<{ fileId: string } | undefined>('operationCheckpoints', store => store.get(key));
            if (!saved) { saved = { fileId: await drive.allocateId() }; await rx.journal.operationTransaction<void>(boardId, ['operationCheckpoints'], (tx, result) => { tx.objectStore('operationCheckpoints').put({ id: key, boardId, kind: 'migration-segment', ...saved }); result(undefined); }); }
            await drive.publishSegment(saved.fileId, segment); baselineSegmentIds.push(saved.fileId);
          }
          await syncImages(rx, drive, boardId, base.state().cards.flatMap(card => card.image ? [card.image as { id: string }] : []));
          await drive.publishMigration(await drive.allocateId(), { protocol: PROTOCOL, boardId, baselineSegmentIds, baselineIntegrity: await digest(base.checkpoint()), legacyFileIds: legacyIds });
        }
      }
      await rx.operationSource.local.saveCheckpoint(base.checkpoint());
      await rx.operationSource.local.observe(boardId, base.vector(), base.logicalClock());
      binding = { id: `binding:${boardId}`, kind: 'operation-binding', boardId, folderId, role, legacyFileIds: [...new Set(legacyIds)], baseRevision };
      await rx.bindOperationBoard(binding, covered);
      await rx.operationSource.recover(boardId);
    } else await rx.bindOperationBoard({ ...binding, role });
    let realtime: Awaited<ReturnType<NonNullable<typeof options.realtime>>> | undefined;
    let realtimeGeneration = 0;
    let verifiedRole: DriveRole = role, verifiedAt = Date.now();
    const verifyRole = async () => {
      verifiedRole = await drive.folderRole(); verifiedAt = Date.now();
      const current = rx.operationSource.bindings.get(boardId)!;
      if (verifiedRole !== current.role) await rx.bindOperationBoard({ ...current, role: verifiedRole });
      return verifiedRole;
    };
    const session = new OperationSession({ boardId, polling: false, realtime: false,
      beforeSync: async () => { await rx.operationSource.recover(boardId); for (const id of binding!.legacyFileIds) if (!(await drive.metadata(id)).contentRestrictions?.some(r => r.readOnly)) throw new Error('Legacy write protection was removed. Re-lock the legacy checkpoint before synchronization.'); },
      afterSync: async publish => syncImages(rx, drive, boardId, (await rx.db.cards.find({ selector: { projectId: boardId } }).exec()).flatMap(card => card.imageId ? [{ id: card.imageId }] : []), publish),
      broadcast: operations => realtime?.broadcast(operations) ?? Promise.resolve(false),
      setRealtimeEnabled: async enabled => {
        const generation = ++realtimeGeneration;
        if (!enabled) { const old = realtime; realtime = undefined; await old?.close(); }
        else if (!realtime && options.realtime) {
          const candidate = await options.realtime(boardId, session, drive);
          if (generation !== realtimeGeneration) await candidate.close();
          else realtime = candidate;
        }
      }, local: rx.operationSource.local, drive,
      role: verifyRole,
      realtimeRole: async () => Date.now() - verifiedAt < 10000 ? verifiedRole : verifyRole(),
      onState: (engine, touched) => projectOperations(rx, engine, touched),
      onError: error => { void options.onStatus?.(boardId, error instanceof Error ? error.message : 'Board synchronization failed'); }
    });
    await session.open();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const stop = rx.journal.subscribe(tables => {
      if ((!tables.includes('operations') && !tables.includes('operationCheckpoint')) || !tables.includes(`operation-board:${boardId}`)) return;
      clearTimeout(scheduled); scheduled = setTimeout(() => { void session.refreshLocal().catch(error => options.onStatus?.(boardId, String(error))); }, 8);
    });
    sessions.set(boardId, { session, drive, binding, stop: () => { clearTimeout(scheduled); stop(); } });
    return session;
  }
  return {
    open,
    async sync(boardId: string, force = false, publish = true) { const session = await open(boardId); await session.sync(force, publish); await options.onStatus?.(boardId); },
    async flushRemoval(boardId: string) { const session = await open(boardId, true); if (await sessions.get(boardId)!.drive.folderRole() !== 'owner') return; await session.sync(true); },
    async compact(boardId: string) { return (await open(boardId)).compact(); },
    async previewGardening(boardId: string) {
      await (await open(boardId)).sync(true);
      const { drive } = sessions.get(boardId)!;
      if (await drive.folderRole() !== 'owner') throw new Error('Only the Drive board owner may garden history');
      const files = await drive.inventory(), snapshots = [], segments = [];
      const snapshotFiles = new Map<string, string>(), snapshotDates: Record<string, string> = {};
      for (const file of files) {
        if (file.name.startsWith('snapshot-')) { const snapshot = await readSnapshot(drive, file.id, boardId); snapshots.push(snapshot); snapshotFiles.set(snapshot.snapshotId, file.id); snapshotDates[snapshot.snapshotId] = file.createdTime ?? ''; }
        if (file.name.startsWith('operations-')) segments.push({ fileId: file.id, segment: await drive.readSegment(file.id), createdAt: file.createdTime ?? '' });
      }
      const plan = await planGardeningAsync({ boardId, snapshots, segments, snapshotDates });
      const eligibleFileIds = [...plan.eligibleSegmentIds, ...plan.eligibleSnapshotIds.map(id => snapshotFiles.get(id)!)];
      return { ...plan, eligibleFileIds, eligibleSnapshots: plan.eligibleSnapshotIds.length, bytes: files.filter(file => eligibleFileIds.includes(file.id)).reduce((sum, file) => sum + Number(file.size ?? 0), 0) };
    },
    async garden(boardId: string, reviewedIds: string[]) {
      const fresh = await this.previewGardening(boardId), { drive } = sessions.get(boardId)!;
      if (canonical([...reviewedIds].sort()) !== canonical([...fresh.eligibleFileIds].sort())) throw new Error('History changed. Review a fresh gardening preview.');
      for (const id of fresh.eligibleFileIds) await drive.trash(id);
      return fresh.eligibleFileIds.length;
    },
    async subscribeRole(boardId: string, listener: (owner: boolean) => void) {
      const rx = await repository(); let active = true;
      const stop = rx.journal.subscribe(tables => { if (!tables.includes('operationBindings')) return;
        void rx.journal.read<OperationBinding | undefined>('operationCheckpoints', store => store.get(`binding:${boardId}`))
          .then(binding => { if (active) listener(binding?.role === 'owner'); }).catch(() => { if (active) listener(false); });
      });
      return () => { active = false; stop(); };
    },
    async role(boardId: string) { await open(boardId); return sessions.get(boardId)!.session.access(); },
    async layout(boardId: string) { await open(boardId); return sessions.get(boardId)!.binding; },
    active(boardId: string) { return sessions.get(boardId)?.session; },
    async close(boardId: string) { const current = sessions.get(boardId); sessions.delete(boardId); current?.stop(); await current?.session.close(); }
  };
}
