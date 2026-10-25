/**
 * Buffer runtime: joins the pump, the journal, and the leader publish cycle
 * with zero idle cost. No timers exist unless local mutations made work
 * pending; a board that nothing happens on touches the network zero times.
 *
 * All environment access is injected (journal queries, Drive IO, roles), so
 * this composes in tests without a browser or a server, and the production
 * wiring in `runtime.ts` stays a thin adapter.
 */
import { createBufferPump } from "./bufferProtocol";
import { runPublishCycle, type CycleOutcome, type PublishCycle } from "./leaderLoop";
import { sealOp, type BoardContentKey } from "./bufferCrypto";
import type { BufferClient } from "./bufferClient";

export type BufferedOpSource = { opId: string; document: Record<string, unknown>; deleted?: boolean };

export type BufferRuntimeOptions = {
  boardId: string;
  isWriter(): boolean;
  contentKey(): Promise<BoardContentKey | undefined>;
  /** Committed journal entries for this board not yet confirmed in a snapshot. */
  committedOps(): Promise<BufferedOpSource[]>;
  /** Journal change notification; returns an unsubscribe function. */
  subscribe(next: () => void): () => void;
  client: BufferClient;
  drive: Pick<PublishCycle, "meta" | "download" | "publish">;
  publishIntervalMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
  onError?: (error: unknown) => void;
  onCycle?: (outcome: CycleOutcome) => void;
};

export type BufferRuntime = { start(): void; stop(): Promise<void>; notify(): void };

export function createBufferRuntime(options: BufferRuntimeOptions): BufferRuntime {
  const interval = options.publishIntervalMs ?? 45_000;
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });
  const pump = createBufferPump({
    boardId: options.boardId,
    transport: options.client.transport(),
    seal: async (opId, plaintext) => {
      // The content key may still be arriving from a writer peer on first
      // connect; the pump holds and retries the seal through its backoff.
      const key = await options.contentKey();
      if (!key) throw new Error("Board content key unavailable for buffering");
      return sealOp(key, opId, plaintext);
    }
  });
  let unsubscribe: (() => void) | undefined;
  let cycleCancel: (() => void) | undefined;
  let cycling = false;
  let dirty = false;
  let stopped = false;

  async function cycle(): Promise<void> {
    if (cycling || stopped || !options.isWriter()) return;
    cycling = true;
    try {
      const cycleDeps: PublishCycle = {
        claim: options.client.claim,
        meta: options.drive.meta,
        download: options.drive.download,
        listBuffered: options.client.listOps,
        contentKey: options.contentKey,
        publish: options.drive.publish,
        commitOps: async (board, epoch, ids) => {
          if (ids.length) await options.client.commitOps(board, epoch, ids);
        },
        leaderCommit: options.client.leaderCommit,
        nowIso: () => new Date().toISOString()
      };
      const outcome = await runPublishCycle(options.boardId, cycleDeps);
      options.onCycle?.(outcome);
      dirty = outcome.status === "conflict";
      if (dirty) arm(interval);
    } catch (error) {
      options.onError?.(error);
      if (!stopped) arm(interval * 2);
    } finally {
      cycling = false;
    }
  }

  function arm(ms: number) {
    if (stopped || cycleCancel) return;
    cycleCancel = schedule(() => {
      cycleCancel = undefined;
      void cycle();
    }, ms);
  }

  async function enqueueCommitted() {
    if (stopped || !options.isWriter()) return;
    try {
      for (const op of await options.committedOps()) {
        pump.enqueue(op.opId, { document: { ...op.document, collection: op.document["collection"] ?? "cards" }, deleted: op.deleted });
      }
      dirty = true;
      arm(0);
      await pump.flush().catch(() => undefined);
    } catch (error) {
      options.onError?.(error);
    }
  }

  return {
    start() {
      if (unsubscribe || stopped) return;
      unsubscribe = options.subscribe(() => void enqueueCommitted());
    },
    notify() {
      void enqueueCommitted();
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      cycleCancel?.();
      cycleCancel = undefined;
      await pump.stop();
    }
  };
}
