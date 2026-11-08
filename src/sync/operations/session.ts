import { createSnapshotAsync, parseSnapshotAsync, restoreCheckpointAsync } from './snapshotTasks';
import { LogSnapshotPendingError } from './logConsolidation';
import { OperationEngine } from './engine';
import { LocalOperationStore } from './localStore';
import type { OperationDriveStore, DriveRole } from './driveStore';
import type { OperationSnapshot } from './snapshots';
import type { Command, Operation } from './protocol';
import { driveFlushAt, drivePollDelay, DRIVE_EDIT_IDLE_MS, DRIVE_MAX_UNPUBLISHED_MS, DRIVE_POLL_MS, DRIVE_POLL_MAX_MS } from '../syncPolicy';
import { isDriveGone } from '../driveHttp';

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
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollDelay: number;
  private flushRetryAt = 0;
  private flushGeneration = 0;
  private realtime = true;
  /** Last value successfully handed to `setRealtimeEnabled`, or null when
   * nothing is attached (including after a failure). The session's `realtime`
   * flag is an intent that starts optimistic — a session with no transport
   * yet still reports true — so idempotence has to compare against what was
   * actually established, not what was wanted. */
  private realtimeRequested: boolean | null = null;
  private checkpointGeneration?: string;
  private polling = true;
  private epoch = 0;
  /**
   * Counters for the diagnostics handle. `skipped` carries the reason the last
   * local edit did not go out on the data channel — the difference between an
   * edit that never reached the session, one that arrived while realtime was off,
   * and one the role check would not authorise, none of which is visible anywhere
   * else, and all of which look like "the other browser only updates from Drive".
   */
  /**
   * Counters for the diagnostics surface. `roleCheckFailures`/`roleCheckError` explain a room
   * that will not connect without closing it: a role check that could not run keeps
   * realtime switched on, so the failure has to be visible somewhere else.
   */
  private relaying = false;
  readonly metrics = { syncs: 0, downloadedSegments: 0, publishedSegments: 0, realtimeMessages: 0, refreshes: 0, localOps: 0, broadcasts: 0, skipped: '', roleCheckFailures: 0, roleCheckError: '', goneResources: 0 };
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
    this.metrics.refreshes++;
    // Only this browser's own operations may go out; the rest arrived from Drive
    // and belong to their authors.
    const own = operations.filter(op => this.options.local.isOwn(this.options.boardId, op));
    if (operations.length) { await this.scheduleFlush(); if (own.length) this.metrics.localOps += own.length; void this.broadcastLocal(own).catch(error => this.options.onError?.(error)); }
    return operations;
  }
  async broadcastLocal(operations: Operation[]) {
    if (!operations.length) return;
    this.metrics.broadcasts++;
    if (this.stopped) { this.metrics.skipped = 'stopped'; return; }
    if (!this.options.broadcast) { this.metrics.skipped = 'no-broadcast-target'; return; }
    if (!this.realtime) { this.metrics.skipped = 'realtime-off'; return; }
    const epoch = this.epoch;
    let role: DriveRole;
    try {
      role = await (this.options.realtimeRole ?? this.options.role)();
    } catch (error) {
      // Recording why nothing went out is the point of the counter; the caller
      // still hears about the failure exactly as before.
      this.metrics.skipped = `role-check-failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
      throw error;
    }
    if (!this.realtime) { this.metrics.skipped = 'realtime-off'; return; }
    if (epoch !== this.epoch) { this.metrics.skipped = 'superseded'; return; }
    if (!['owner', 'editor'].includes(role)) { this.metrics.skipped = `role:${role}`; return; }
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
/** A Drive role check that could not run is not a revocation. */
  private async roleOrKeepRealtime(read: () => Promise<DriveRole>): Promise<DriveRole> {
    try {
      return await read();
    } catch (error) {
      // Revocation is something Drive *answers*: the read returns `revoked`, and
      // every caller acts on that answer directly. Anything thrown here means the
      // question was never answered — the local quota ledger declining a request
      // during an ordinary editing burst, a 404 on a resource, an aborted request,
      // a 503 from Google. None of those is evidence that access ended.
      //
      // Switching the room off for them was the most expensive bug in this file.
      // The sidebar re-resolves the role every ten seconds and re-enables realtime
      // as soon as one read succeeds, so a single failing read per cycle closed the
      // room and opened a new one: `starts` in the diagnostics climbing past sixty
      // inside ten minutes. A peer connection torn down every ten seconds never
      // finishes ICE, which is why the room showed a healthy roster with `connected
      // 0` and Firefox reported "ICE failed". The failure is counted and reported
      // instead, so a genuinely broken role still surfaces — as a number, not as a
      // room that quietly stops existing.
      this.metrics.roleCheckFailures++;
      this.metrics.roleCheckError = `${error instanceof Error ? error.message : String(error)}`.slice(0, 160);
      throw error;
    }
  }

  async receiveRealtime(operations: Operation[]): Promise<void> {
    if (!this.realtime || this.stopped) return;
    const epoch = this.epoch, inputs = structuredClone(operations);
    const role = await this.roleOrKeepRealtime(() => (this.options.realtimeRole ?? this.options.role)());
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
    const syncRole = await this.roleOrKeepRealtime(() => this.options.role());
    if (syncRole === 'revoked') { await this.setRealtime(false); throw new Error('Google Drive access was revoked; unpublished local work is retained'); }
    await this.options.beforeSync?.();
    await this.refreshLocal();
    const { local, drive, boardId } = this.options;
    const files = await drive.inventory(force), downloaded = await local.downloadedFiles(boardId);
    // Drive lists files for a while after deleting them: compaction removes an old
    // segment or snapshot, and its id keeps coming back in the listing for minutes.
    // Every appearance used to be a download that answered 404, which cost 200 units
    // of quota, rejected the whole sync — so nothing else in that poll was applied
    // either — and changed nothing about the id, which was asked again on the next
    // poll forever. Drive saying *gone* is an answer, not a failure: remember it in
    // the same ledger that stops the asking, and carry on with the files that exist.
    const forgetGone = async (fileId: string, error: unknown) => {
      if (!isDriveGone(error)) return false;
      this.metrics.goneResources++;
      await local.downloaded(boardId, fileId);
      return true;
    };
    const snapshotFiles = files.filter(f => f.name.startsWith('snapshot-') && !downloaded.has(f.id));
    if (snapshotFiles.length) {
      const snapshots: OperationSnapshot[] = [];
      for (const file of snapshotFiles) {
        try { snapshots.push(await parseSnapshotAsync(await drive.read(file.id, 32 * 1024 * 1024), boardId)); }
        catch (error) { if (await forgetGone(file.id, error)) continue; throw error; }
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
      let segment;
      try { segment = await drive.readSegment(file.id); }
      catch (error) { if (await forgetGone(file.id, error)) continue; throw error; }
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
  /**
   * Captures one immutable snapshot for the durable operation log: the intent
   * journal and worker-offloaded build, deliberately without the Drive sync
   * the legacy compaction started from — on the log path the log is what this
   * board is current with, and pulling Drive segments in would reintroduce the
   * thing the log replaces. Publishing is a separate call so the log's commit
   * can sit between them: `prepared -> Drive -> commit` is the order that makes
   * an interrupted consolidation recoverable.
   *
   * `bootstrapUnresolved` (from the consolidation wiring, only when the log has
   * never committed a checkpoint and pruned nothing) lets a board whose history
   * predates its log publish its first snapshot: entities the log only ever
   * observed through updates are recorded as bootstrap entities rather than
   * refused. With `checkpoint > 0` or a committed generation an unresolved
   * reference is a real hole, and the refusal below is what stops a snapshot
   * from freezing it.
   */
  async prepareLogSnapshot(bootstrapUnresolved = false): Promise<{ fileId: string; snapshot: OperationSnapshot }> {
    if (this.stopped) throw new Error('Operation session is closed');
    const { local, boardId } = this.options;
    // Unacked local writes are a reason to *retry the cycle*, not a fault: an
    // owner who keeps editing would otherwise see `failed:` forever on a board
    // that is merely busy at trigger time.
    if (this.engine.pendingCount()) throw new LogSnapshotPendingError('Board history has local writes that are not acknowledged yet');
    const unresolved = this.engine.unresolvedReferences(), inconsistencies = this.engine.inconsistencies();
    // Refusing to publish a board the engine cannot explain is what keeps a
    // snapshot from becoming the way a half-applied history becomes permanent.
    // `bootstrapUnresolved` is the caller's proof that the unproven entities
    // are the board's pre-log past — nothing below this point has been pruned
    // or committed — and the copy it publishes marks them as such (see
    // `OperationEngine.snapshotEngine`); field values are never manufactured.
    if ((unresolved.length || Object.keys(inconsistencies).length) && !(bootstrapUnresolved && unresolved.length && !Object.keys(inconsistencies).length)) {
      throw new Error('Board history is incomplete; a snapshot would freeze the gap');
    }
    const source = unresolved.length ? this.engine.snapshotEngine({ bootstrapUnresolved: true }) : this.engine;
    // The skipped ledger refuses with its own voice, and it is the data-safety
    // keystone of vocabulary tolerance: publishing this snapshot is what tells
    // the log and the gardening job that the history below the checkpoint may
    // be pruned, and that permission is scoped to the snapshot's *receipts* —
    // an operation is collectible only when a retained snapshot proves it. An
    // operation this client skipped was never applied, so it is absent from the
    // receipts even though its sequence sits inside the frontier; consolidating
    // now would authorize deleting history that the snapshot cannot reproduce
    // and that any other client still needs to rebuild the board. While any
    // operation is skipped, this device does not consolidate; the history stays
    // where a client that understands it can publish from.
    const skipped = this.engine.skippedOperations();
    if (skipped.length) {
      throw new Error(`Board history contains ${skipped.length} operation(s) this client cannot read; a snapshot would prune history its receipts do not cover`);
    }
    const parents: string[] = [];
    for (const file of (await this.options.drive.inventory()).filter(file => file.name.startsWith('snapshot-'))) {
      parents.push((await parseSnapshotAsync(await this.options.drive.read(file.id, 32 * 1024 * 1024), boardId)).snapshotId);
    }
    const snapshot = await this.locked(() => createSnapshotAsync(source, parents));
    const fileId = await this.options.drive.allocateId();
    await local.prepareSnapshot(snapshot, fileId);
    return { fileId, snapshot };
  }
  /** A prepared snapshot by id, for a consolidation cycle resuming after a reload. */
  async logSnapshot(snapshotId: string): Promise<OperationSnapshot | null> {
    const intent = (await this.options.local.snapshotIntents(this.options.boardId)).find(row => row.snapshot.snapshotId === snapshotId);
    return intent?.snapshot ?? null;
  }
  /**
   * Publishes a prepared snapshot through the board's own intent journal, so
   * Drive allocation and the local checkpoint move together: an upload that dies
   * halfway leaves the intent unpublished, which is what the legacy compaction
   * resume path and the consolidation cycle both read.
   */
  async publishLogSnapshot(snapshot: OperationSnapshot): Promise<void> {
    const { local, drive, boardId } = this.options;
    const intent = (await local.snapshotIntents(boardId)).find(row => row.snapshot.snapshotId === snapshot.snapshotId);
    if (!intent) throw new Error('Snapshot was never prepared');
    if (!intent.published) {
      await drive.publishSnapshot(intent.fileId, snapshot);
      await local.snapshotPublished(intent.id);
    }
    await local.saveCheckpoint(snapshot.checkpoint);
  }
  async setRealtime(enabled: boolean): Promise<void> {
    // An idempotent re-enable is not a re-attach. The sidebar re-resolves the
    // board's role every ten seconds and re-enables realtime on every pass,
    // and each unconditional call bumped the epoch (voiding the in-flight
    // broadcasts and receives of a healthy room) and, once the realtime
    // factory had ever rejected, re-ran its whole handshake — identity
    // sharing, key courier, grant publication — against the relay per tick.
    // A failure path clears the established value, so the next genuine
    // enable still retries; only the no-change call is dropped here.
    if (this.stopped || this.realtimeRequested === enabled) return;
    this.realtime = enabled; this.epoch++;
    const epoch = this.epoch;
    try { await this.options.setRealtimeEnabled?.(enabled); this.realtimeRequested = enabled; }
    catch (error) { this.realtimeRequested = null; if (epoch === this.epoch) { this.realtime = false; this.epoch++; } throw error; }
    // The channel is new; the operations that missed the old one are still
    // sitting in the outbox unrelayed. Nothing else ever retries them, and the
    // peer on the other end has no way to ask.
    if (enabled) void this.broadcastUnsent().catch(error => this.options.onError?.(error));
  }
  /** Hands every operation the live channel never saw to the channel that is
   * open now. Idempotent by the `realtimeSent` ledger, and concurrent calls
   * only risk resending an operation a receiver already holds. */
  async broadcastUnsent(): Promise<void> {
    if (!this.realtime || this.stopped || this.relaying) return;
    this.relaying = true;
    try {
      const operations = (await this.options.local.unsent(this.options.boardId))
        .filter(operation => this.options.local.isOwn(this.options.boardId, operation));
      if (operations.length) await this.broadcastLocal(operations);
    } finally { this.relaying = false; }
  }
  async close(): Promise<void> {
    this.stopped = true; this.epoch++; clearTimeout(this.pollTimer); clearTimeout(this.flushTimer); this.flushTimer = undefined;
    await this.options.setRealtimeEnabled?.(false); await this.queue; await this.syncing?.catch(() => undefined);
  }
}
