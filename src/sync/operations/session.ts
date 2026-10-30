import { createSnapshotAsync, parseSnapshotAsync, restoreCheckpointAsync } from './snapshotTasks';
import { OperationEngine } from './engine';
import { LocalOperationStore } from './localStore';
import type { OperationDriveStore, DriveRole } from './driveStore';
import type { OperationSnapshot } from './snapshots';
import type { Command, Operation } from './protocol';
import { driveFlushAt, drivePollDelay, DRIVE_EDIT_IDLE_MS, DRIVE_MAX_UNPUBLISHED_MS, DRIVE_POLL_MS, DRIVE_POLL_MAX_MS } from '../syncPolicy';

/** Shared operation protocol after verified board migration. Network work
 * runs outside the local application queue; repository WAL conversion and
 * RxDB projection are supplied by the service adapter. */
export class OperationSession {
  private engine: OperationEngine;
  private queue: Promise<unknown> = Promise.resolve();
  private syncing?: Promise<void>;
  private syncingPublishes = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private compacting?: Promise<string>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollDelay: number;
  private flushRetryAt = 0;
  private flushGeneration = 0;
  private realtime = true;
  private checkpointGeneration?: string;
  private polling = true;
  private epoch = 0;
  readonly metrics = { syncs: 0, downloadedSegments: 0, publishedSegments: 0, realtimeMessages: 0 };
  constructor(readonly options: {
    boardId: string; local: LocalOperationStore; drive: OperationDriveStore;
    role: () => Promise<DriveRole>; realtimeRole?: () => Promise<DriveRole>;
    broadcast?: (operations: Operation[]) => Promise<void | boolean>;
    onState?: (engine: OperationEngine, touched: string[]) => void | Promise<void>;
    onError?: (error: unknown) => void;
    beforeSync?: () => Promise<void>;
    afterSync?: (publish: boolean) => Promise<void>;
    batchDelayMs?: number; maxUnpublishedMs?: number; polling?: boolean; realtime?: boolean;
    pollMinMs?: number; pollMaxMs?: number; random?: () => number;
    setRealtimeEnabled?: (enabled: boolean) => Promise<void>;
  }) { this.engine = new OperationEngine(options.boardId); this.polling = options.polling ?? true; this.realtime = options.realtime ?? true; this.pollDelay = options.pollMinMs ?? DRIVE_POLL_MS; }
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation); this.queue = run.catch(() => undefined); return run;
  }
  private async replay(engine: OperationEngine, operations: Operation[]): Promise<void> {
    for (let i = 0; i < operations.length; i += 128) await engine.receive(operations.slice(i, i + 128));
  }
  async open(): Promise<void> {
    await this.locked(async () => {
      const info = await this.options.local.checkpointInfo(this.options.boardId);
      const checkpoint = await this.options.local.checkpoint(this.options.boardId);
      const engine = checkpoint ? await restoreCheckpointAsync(checkpoint) : new OperationEngine(this.options.boardId);
      await this.replay(engine, await this.options.local.operationsSince(this.options.boardId, engine.vector()));
      this.engine = engine;
      this.checkpointGeneration = info?.generation;
      await this.options.local.observe(this.options.boardId, engine.vector(), engine.logicalClock());
      await this.options.onState?.(engine, []);
    });
    this.schedulePoll();
    await this.scheduleFlush();
  }
  access() { return this.options.role(); }
  frontier() { return this.engine.vector(); }
  async refreshLocal(): Promise<Operation[]> {
    const operations = await this.locked(async () => {
      const local = this.options.local, boardId = this.options.boardId;
      const info = await local.checkpointInfo(boardId);
      if (info && info.generation !== this.checkpointGeneration) {
        const cached = await local.checkpoint(boardId);
        if (cached) {
          const ahead = Object.entries(cached.frontier).some(([actor, seq]) => seq > (this.engine.vector()[actor] ?? 0));
          if (!this.engine.pendingCount() && !this.engine.unresolvedReferences().length) this.engine = OperationEngine.join([this.engine.checkpoint(), (await restoreCheckpointAsync(cached)).checkpoint()], true);
          else { this.engine = await restoreCheckpointAsync(cached); await this.replay(this.engine, await local.operations(boardId)); }
          if (ahead) await this.options.onState?.(this.engine, []);
        }
        this.checkpointGeneration = info.generation;
      }
      const ops = await local.operationsSince(boardId, this.engine.vector());
      if (!ops.length) return [];
      const touched = await this.engine.receive(ops.slice(0, 128));
      for (let i = 128; i < ops.length; i += 128) touched.push(...await this.engine.receive(ops.slice(i, i + 128)));
      await local.observe(boardId, this.engine.vector(), this.engine.logicalClock());
      if (touched.length) await this.options.onState?.(this.engine, [...new Set(touched)]);
      return ops;
    });
    if (operations.length) { await this.scheduleFlush(); void this.broadcastLocal(operations.filter(op => this.options.local.isOwn(this.options.boardId, op))).catch(error => this.options.onError?.(error)); }
    return operations;
  }
  async broadcastLocal(operations: Operation[]) {
    if (!operations.length || !this.realtime || !this.options.broadcast || this.stopped) return;
    const epoch = this.epoch, role = await (this.options.realtimeRole ?? this.options.role)();
    if (!['owner', 'editor'].includes(role) || !this.realtime || epoch !== this.epoch) return;
    for (let n = 0; n < operations.length; n += 64) {
      const batch = operations.slice(n, n + 64);
      if (await this.options.broadcast(batch) === false) continue;
      this.metrics.realtimeMessages++;
      for (const op of batch) await this.options.local.markRealtimeSent(op.opId);
    }
  }
  setPolling(enabled: boolean) { this.polling = enabled; if (enabled) this.schedulePoll(); else clearTimeout(this.pollTimer); }
  state() { return this.engine.state(); }
  async unpublished() { return (await this.options.local.outbox(this.options.boardId, true)).length; }
  pendingDependencies() { return this.engine.missing(); }
  /** No network calls before the committed local edit is visible. Offline
   * entitlement is checked by the repository command boundary on integration. */
  async edit(command: Command): Promise<Operation> {
    const op = await this.locked(async () => {
      if (this.stopped) throw new Error('Operation session is closed');
      const op = await this.options.local.append(this.options.boardId, command,
        { frontier: this.engine.vector(), clock: this.engine.logicalClock() });
      let touched = await this.engine.receive([op]);
      // Another extension context can have advanced this same IDB stream.
      // Recover its durable prefix before projecting the newly allocated edit.
      if (this.engine.pendingCount()) {
        const cached = await this.options.local.checkpoint(this.options.boardId);
        const recovered = cached ? await restoreCheckpointAsync(cached) : new OperationEngine(this.options.boardId);
        await this.replay(recovered, await this.options.local.operations(this.options.boardId));
        this.engine = recovered; touched = [];
        if (recovered.pendingCount()) throw new Error('Local operation dependencies require recovery; the edit is durably retained');
      }
      await this.options.onState?.(this.engine, touched); return op;
    });
    void this.broadcastLocal([op]).catch(error => this.options.onError?.(error));
    await this.scheduleFlush();
    return op;
  }
  async receiveRealtime(operations: Operation[]): Promise<void> {
    if (!this.realtime || this.stopped) return;
    const epoch = this.epoch, inputs = structuredClone(operations);
    let role: DriveRole;
    try { role = await (this.options.realtimeRole ?? this.options.role)(); }
    catch (error) { await this.setRealtime(false); throw error; }
    if (role === 'revoked') { await this.setRealtime(false); throw new Error('Google Drive access was revoked'); }
    await this.locked(async () => {
      if (!this.realtime || this.stopped || this.epoch !== epoch) return;
      // Validate before persistence. Persist before projecting so a crash cannot
      // leave a received operation visible but absent from the local WAL.
      await this.engine.validate(inputs);
      await this.options.local.receive(this.options.boardId, inputs);
      const touched = await this.engine.receive(inputs);
      await this.options.local.observe(this.options.boardId, this.engine.vector(), this.engine.logicalClock()); if (touched.length) await this.options.onState?.(this.engine, touched);
    });
  }
  async flushDue(): Promise<boolean> {
    const timing = await this.options.local.pendingTiming(this.options.boardId);
    return !!timing && driveFlushAt(timing.oldest, timing.latest, this.options.batchDelayMs ?? DRIVE_EDIT_IDLE_MS, this.options.maxUnpublishedMs ?? DRIVE_MAX_UNPUBLISHED_MS) <= Date.now();
  }
  private async scheduleFlush() {
    const generation = ++this.flushGeneration;
    const timing = await this.options.local.pendingTiming(this.options.boardId);
    if (this.stopped || generation !== this.flushGeneration) return;
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    if (!timing) return;
    const deadline = driveFlushAt(timing.oldest, timing.latest, this.options.batchDelayMs ?? DRIVE_EDIT_IDLE_MS, this.options.maxUnpublishedMs ?? DRIVE_MAX_UNPUBLISHED_MS);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.sync().catch(error => this.options.onError?.(error));
    }, Math.max(0, deadline - Date.now(), this.flushRetryAt - Date.now()));
  }
  sync(force = false, publish = true): Promise<void> {
    if (this.syncing) return force || (publish && !this.syncingPublishes) ? this.syncing.then(() => this.sync(force, publish)) : this.syncing;
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    this.syncingPublishes = publish;
    const before = this.metrics.downloadedSegments + this.metrics.publishedSegments;
    const publishedBefore = this.metrics.publishedSegments;
    this.syncing = this.performSync(force, publish).then(() => {
      this.pollDelay = before < this.metrics.downloadedSegments + this.metrics.publishedSegments
        ? (this.options.pollMinMs ?? DRIVE_POLL_MS) : Math.min(this.options.pollMaxMs ?? DRIVE_POLL_MAX_MS, this.pollDelay * 2);
      if (publish) this.flushRetryAt = publishedBefore === this.metrics.publishedSegments ? Date.now() + this.pollDelay : 0;
    }, error => {
      this.pollDelay = Math.min(this.options.pollMaxMs ?? DRIVE_POLL_MAX_MS, this.pollDelay * 2);
      this.flushRetryAt = Date.now() + Math.max(this.pollDelay, Number(error?.waitMs) || 0);
      throw error;
    }).finally(async () => { this.syncing = undefined; this.schedulePoll(); await this.scheduleFlush(); }); return this.syncing;
  }
  private async performSync(force: boolean, publish: boolean): Promise<void> {
    if (this.stopped) return;
    this.metrics.syncs++;
    try {
      if (await this.options.role() === 'revoked') throw new Error('Google Drive access was revoked; unpublished local work is retained');
    } catch (error) { await this.setRealtime(false); throw error; }
    await this.options.beforeSync?.();
    await this.refreshLocal();
    const { local, drive, boardId } = this.options;
    const files = await drive.inventory(force), downloaded = await local.downloadedFiles(boardId);
    const snapshotFiles = files.filter(f => f.name.startsWith('snapshot-') && !downloaded.has(f.id));
    if (snapshotFiles.length) {
      const snapshots: OperationSnapshot[] = [];
      for (const file of snapshotFiles) {
        const snapshot = await parseSnapshotAsync(await drive.read(file.id, 32 * 1024 * 1024), boardId);
        snapshots.push(snapshot);
      }
      await this.locked(async () => {
        const cached = await local.checkpoint(boardId);
        const bases = snapshots.map(snapshot => snapshot.checkpoint);
        if (!this.engine.pendingCount() && !this.engine.unresolvedReferences().length) bases.push(this.engine.checkpoint());
        else if (cached) bases.push(cached);
        const engine = OperationEngine.join(bases, true);
        await this.replay(engine, await local.operationsSince(boardId, engine.vector()));
        this.engine = engine;
        if (!engine.pendingCount() && !engine.unresolvedReferences().length) {
          await local.saveCheckpoint(engine.checkpoint());
          for (const file of snapshotFiles) await local.downloaded(boardId, file.id);
        }
        await local.observe(boardId, engine.vector(), engine.logicalClock());
        await this.options.onState?.(engine, []);
      });
    }
    for (const file of files.filter(f => f.name.startsWith('operations-') && !downloaded.has(f.id))) {
      const segment = await drive.readSegment(file.id);
      await this.locked(async () => {
        await this.engine.validate(segment.operations);
        await local.receive(boardId, segment.operations);
        const touched = await this.engine.receive(segment.operations);
        await local.observe(boardId, this.engine.vector(), this.engine.logicalClock()); if (touched.length) await this.options.onState?.(this.engine, touched);
        await local.downloaded(boardId, file.id);
      });
      this.metrics.downloadedSegments++;
    }
    await local.observe(boardId, this.engine.vector(), this.engine.logicalClock());
    const role = await this.options.role();
    if (role === 'revoked') { await this.setRealtime(false); throw new Error('Google Drive access was revoked; unpublished local work is retained'); }
    if (publish && ['owner', 'editor'].includes(role)) {
      if ((await local.outbox(boardId, true)).some(row => !row.driveFileId && !row.segmentId)) {
        // Bound publication effort in one pass; follow-up events can flush more.
        for (let n = 0; n < 8; n++) if (!await local.prepareSegment(boardId, await drive.allocateId())) break;
      }
      for (const intent of (await local.prepared(boardId, true)).filter(row => !row.published && (force || row.retryAt <= Date.now()))) {
        try {
          await drive.publishSegment(intent.fileId, intent.segment);
          await local.published(intent.id); this.metrics.publishedSegments++;
        } catch (error) { await local.failed(intent.id); throw error; }
      }
    }
    if (Object.keys(this.engine.inconsistencies()).length) throw new Error(`Invalid operation history: ${JSON.stringify(this.engine.inconsistencies())}`);
    if (this.engine.unresolvedReferences().length) throw new Error(`Operation history references missing entities: ${this.engine.unresolvedReferences().join(', ')}`);
    if (this.engine.pendingCount()) throw new Error(`Operation history is incomplete: ${JSON.stringify(this.engine.missing())}`);
    await this.locked(async () => { await this.options.onState?.(this.engine, [`projects:${this.options.boardId}`]); });
    await this.options.afterSync?.(publish);
  }
  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    if (this.stopped || !this.polling) return;
    const minimum = this.options.pollMinMs ?? DRIVE_POLL_MS, maximum = Math.max(minimum, this.options.pollMaxMs ?? DRIVE_POLL_MAX_MS);
    const delay = drivePollDelay(0, this.options.random?.() ?? Math.random(), Math.max(minimum, this.pollDelay), maximum);
    this.pollTimer = setTimeout(() => { void this.sync(false, false).catch(error => this.options.onError?.(error)); }, delay);
  }
  compact(): Promise<string> {
    if (this.compacting) return this.compacting;
    this.compacting = this.performCompaction().finally(() => { this.compacting = undefined; });
    return this.compacting;
  }
  private async performCompaction(): Promise<string> {
    if (this.stopped) throw new Error('Operation session is closed');
    if (await this.options.role() !== 'owner') throw new Error('Only the Google Drive board owner may compact');
    await this.sync(true);
    const { local, drive, boardId } = this.options;
    // Resume exact immutable intents after timeout/crash, before making another.
    const pending = (await local.snapshotIntents(boardId)).filter(row => !row.published);
    if (pending.length) {
      for (const intent of pending) {
        if (await this.options.role() !== 'owner') throw new Error('Google Drive ownership changed');
        await drive.publishSnapshot(intent.fileId, intent.snapshot); await local.snapshotPublished(intent.id);
      }
      return pending[pending.length - 1].snapshot.snapshotId;
    }
    const parents: string[] = [];
    for (const file of (await drive.inventory()).filter(file => file.name.startsWith('snapshot-'))) {
      const parent = await parseSnapshotAsync(await drive.read(file.id, 32 * 1024 * 1024), boardId);
      parents.push(parent.snapshotId);
    }
    // Capture one complete causal frontier while editing is serialized locally;
    // release the queue before Drive allocation, upload and verification.
    const snapshot = await this.locked(() => createSnapshotAsync(this.engine, parents));
    const fileId = await drive.allocateId();
    const intent = await local.prepareSnapshot(snapshot, fileId);
    if (await this.options.role() !== 'owner') throw new Error('Google Drive ownership changed');
    await drive.publishSnapshot(fileId, snapshot); await local.snapshotPublished(intent.id);
    await local.saveCheckpoint(snapshot.checkpoint);
    return snapshot.snapshotId;
  }
  async setRealtime(enabled: boolean): Promise<void> {
    this.realtime = enabled; this.epoch++;
    const epoch = this.epoch;
    try { await this.options.setRealtimeEnabled?.(enabled); }
    catch (error) { if (epoch === this.epoch) { this.realtime = false; this.epoch++; } throw error; }
  }
  async close(): Promise<void> {
    this.stopped = true; this.epoch++; clearTimeout(this.pollTimer); clearTimeout(this.flushTimer); this.flushTimer = undefined;
    await this.options.setRealtimeEnabled?.(false); await this.queue; await this.syncing?.catch(() => undefined);
  }
}
