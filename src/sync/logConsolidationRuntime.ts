/**
 * Consolidation wiring for the durable operation log: the connection between the
 * pure ordering rules (`operations/logConsolidation.ts`), a board's operation
 * session, its Drive folder and its log connection.
 *
 * It is deliberately not where the safety rules live. The cycle owns the order
 * (catch up, then build, then upload, then commit) and is testable without
 * Drive, WebSockets or timers; this module only translates those calls onto the
 * objects that exist at runtime, and answers the one policy question that belongs
 * here: a board's snapshots are written by its Google Drive owner, with the log's
 * lease deciding which owner when several browsers are open.
 */
import type { KeyValueStorage } from '../storage/repository';
import type { DriveRole, OperationDriveStore } from './operations/driveStore';
import type { OperationSession } from './operations/session';
import type { OperationSnapshot } from './operations/snapshots';
import { LogSnapshotPendingError, runLogConsolidationCycle, type LogConsolidationCycle, type LogCycleOutcome, type LogPendingConsolidation, type LogWatermark } from './operations/logConsolidation';
import type { OperationLogSync } from './operations/logSync';

const PENDING_KEY = 'pboardLogConsolidation';
const aNumber = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** A board's live consolidation inputs, as the realtime relay established them. */
export type LogConsolidationTarget = {
  boardId: string;
  /** Drive folder that holds the board's snapshots. */
  folderId: string;
  log: Pick<OperationLogSync, 'lease' | 'release' | 'diagnose' | 'catchUpTo' | 'commit'>;
  session: OperationSession;
  drive: OperationDriveStore;
  role: () => Promise<DriveRole>;
  storage: KeyValueStorage;
};

/**
 * How a cycle outcome reads in the room diagnostics (`RoomSnapshot.consolidation`):
 * `published/<generation>` after a publish, `idle:<reason>` when a cycle ran and
 * deliberately did nothing, the bare status otherwise. The idle reasons are the
 * whole diagnostic — a board whose snapshot never publishes is otherwise
 * indistinguishable from a healthy one.
 */
export function describeLogCycle(outcome: LogCycleOutcome): string {
  return outcome.status === 'published' ? `published/${outcome.snapshotSeq}`
    : outcome.status === 'idle' ? `idle:${outcome.reason}` : outcome.status;
}

/** Cycles in flight in this process, per board: a room trigger and an
 * on-demand caller must not run two cycles that both take the lease and race
 * to write the pending-intent record. */
const activeCycles = new Map<string, Promise<LogCycleOutcome>>();
/** Live rooms by board, so reconciliation outside a room can consolidate it. */
const openRooms = new Map<string, LogConsolidationTarget>();

/**
 * Runs one consolidation cycle for a board, or joins the one already running
 * for it in this process. The outcome says what happened; a rejected promise
 * means the log or Drive could not be reached, which is the caller's signal to
 * try again on the next trigger rather than to report a fault about the board.
 */
export function runLogConsolidation(options: LogConsolidationTarget): Promise<LogCycleOutcome> {
  openRooms.set(options.boardId, options);
  return coalesceLogConsolidation(options);
}

/**
 * Consolidates a board by id from outside its realtime room — the manual
 * Drive reconcile's log leg, for instance. Every open room self-registers when
 * its own triggers call `runLogConsolidation`, and both entry points coalesce
 * into the single in-flight cycle, so concurrent callers never race a lease.
 * A board with no open room has no live log connection to consolidate and is
 * reported idle rather than erroring.
 */
export function consolidateBoardLog(boardId: string): Promise<LogCycleOutcome> {
  const target = openRooms.get(boardId);
  if (!target) return Promise.resolve({ status: 'idle', reason: 'no-room' });
  return coalesceLogConsolidation(target);
}

/** Forgets a room's registration when its relay closes; harmless if called
 * for a board that never consolidated. */
export function releaseLogConsolidation(boardId: string): void {
  openRooms.delete(boardId);
}

function coalesceLogConsolidation(options: LogConsolidationTarget): Promise<LogCycleOutcome> {
  const running = activeCycles.get(options.boardId);
  if (running) return running;
  const cycle = cycleFor(options).finally(() => { activeCycles.delete(options.boardId); });
  activeCycles.set(options.boardId, cycle);
  return cycle;
}

async function cycleFor(options: LogConsolidationTarget): Promise<LogCycleOutcome> {
  if (await options.role() !== 'owner') return { status: 'idle', reason: 'not-owner' };

  // Snapshots built during this cycle, kept so an upload that failed mid-flight
  // can be finished without asking the engine for a snapshot it no longer has.
  const prepared = new Map<string, OperationSnapshot>();
  const all = async () => ((await options.storage.get(PENDING_KEY))[PENDING_KEY] ?? {}) as Record<string, LogPendingConsolidation>;
  const snapshotName = (snapshotId: string) => `snapshot-${snapshotId}.json`;
  // The watermark this cycle read, captured so `build` knows whether anything
  // below the snapshot has ever been pruned or committed (bootstrap proof).
  let watermark: LogWatermark | null = null;

  const cycle: LogConsolidationCycle = {
    async lease() {
      try { return await options.log.lease(); }
      // Busy is the expected answer when another browser is consolidating; any
      // other refusal (a revoked grant, an expired manifest) is worth reporting.
      catch (error) { if (String(error instanceof Error ? error.message : error) === 'lease_busy') return null; throw error; }
    },
    async watermark() {
      const status = await options.log.diagnose();
      // `nextSeq` in a status frame is the highest sequence the log has assigned,
      // so it is the ceiling a snapshot may claim to cover.
      watermark = { covered: aNumber(status.nextSeq), checkpoint: aNumber(status.checkpointSeq), snapshotSeq: aNumber(status.snapshotSeq) };
      return watermark;
    },
    async catchUp(covered) { return await options.log.catchUpTo(covered); },
    async build(_covered) {
      // A board whose log started after the board did has entity updates with no
      // create anywhere in the log, so the engine can never resolve those
      // references and every cycle would refuse the snapshot. That is a bootstrap
      // situation, and it is safe exactly while nothing has ever been committed:
      // checkpoint 0 at generation 0 means the log still holds operation 1, so no
      // create was pruned and the unresolved references can only be the board's
      // pre-log past. Once any checkpoint exists, or any snapshot generation has
      // been committed, an unresolved reference means history really is missing,
      // and the session keeps refusing.
      const bootstrapUnresolved = watermark !== null && watermark.checkpoint === 0 && watermark.snapshotSeq === 0;
      const { snapshot } = await options.session.prepareLogSnapshot(bootstrapUnresolved);
      prepared.set(snapshot.snapshotId, snapshot);
      return { snapshotId: snapshot.snapshotId, name: snapshotName(snapshot.snapshotId) };
    },
    async find(name) {
      const files = await options.drive.inventory();
      return files.find(file => file.name === name)?.id ?? null;
    },
    async upload(pending: LogPendingConsolidation) {
      const snapshot = prepared.get(pending.snapshotId) ?? await options.session.logSnapshot(pending.snapshotId);
      // No bytes for that intent: it belongs to a browser session that is gone,
      // and its snapshot cannot be reproduced. The cycle forgets it and publishes
      // the current state instead.
      if (!snapshot) return { failed: 'missing' as const };
      // The session publishes through its own intent journal, so a retried upload
      // is idempotent and the local checkpoint only moves once Drive has the file.
      await options.session.publishLogSnapshot(snapshot);
      const published = await options.drive.inventory().then(files => files.find(file => file.name === pending.name)?.id);
      // Drive lists files lazily, so a missing listing is not a failed upload: the
      // cycle keeps the intent and resolves it through `find` on the next pass.
      return published ? { etag: published } : { failed: 'error' as const };
    },
    async commit(lease, covered, snapshotSeq, driveEtag) {
      const committed = await options.log.commit(lease, covered, snapshotSeq, driveEtag);
      return { stale: committed.stale };
    },
    async release() { await options.log.release().catch(() => undefined); },
    pending: {
      async load() { return (await all())[options.boardId] ?? null; },
      async save(value) {
        const records = await all();
        if (value) records[options.boardId] = value; else delete records[options.boardId];
        await options.storage.set({ [PENDING_KEY]: records });
      }
    }
  };
  try {
    return await runLogConsolidationCycle(cycle);
  } catch (error) {
    // The engine had unacked local writes at build time. That is a *retry*,
    // not a fault: reported as an idle outcome so the room records
    // `idle:pending-local-writes` and the next trigger gets its chance at a
    // quiet engine. A structurally unbuildable history still rejects instead,
    // and that refusal is what the diagnostics should show.
    if (error instanceof LogSnapshotPendingError) return { status: 'idle', reason: 'pending-local-writes' };
    throw error;
  }
}
