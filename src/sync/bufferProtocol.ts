/**
 * Client pump for the signaling server's durable operation buffer (Sync v2).
 *
 * Invariants this module owns:
 * - Ordering: ops reach the transport in enqueue order; a failed send halts
 *   the queue (with backoff) instead of skipping ahead.
 * - Durability hand-off: an op is dropped from the queue only after the
 *   transport acknowledges it. The client's journal remains the fallback —
 *   losing the buffer never loses data, it only removes insurance.
 * - Backpressure: a transport that rejects with `BufferBackpressureError`
 *   backs off (never drops); the buffer is bounded server-side by design.
 * - Idle cost: no timers run while the queue is empty (a pumped-queue timer
 *   would be exactly the class of idle CPU work Sync v2 is meant to remove).
 *
 * `opId` dedupe on the server makes every send safe to replay; the pump still
 * dedupes locally so a reconnect replay never inflates a batch.
 */
import { sealOp, type BoardContentKey, type SealedOp } from "./bufferCrypto";

export class BufferBackpressureError extends Error {
  constructor(boardId: string) {
    super(`Operation buffer full for ${boardId}`);
    this.name = "BufferBackpressureError";
  }
}

export type BufferTransport = {
  /** Resolve = the server durably holds every op in this batch (dedupe by opId). */
  send(boardId: string, ops: SealedOp[]): Promise<void>;
};

export type BufferPump = {
  enqueue(opId: string, plaintext: unknown): void;
  /** Resolve when the queue currently enqueued is acknowledged (or rejects after failed attempts). */
  flush(): Promise<void>;
  pending(): number;
  stop(): Promise<void>;
};

export type BufferPumpOptions = {
  boardId: string;
  key?: BoardContentKey;
  transport: BufferTransport;
  /** Override sealing (tests inject a synchronous seal; production uses AES-GCM). */
  seal?: (opId: string, plaintext: unknown) => Promise<SealedOp>;
  maxBatchOps?: number;
  maxBackoffMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  onIdle?: () => void;
};

export function createBufferPump(options: BufferPumpOptions): BufferPump {
  const maxBatch = options.maxBatchOps ?? 64;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });
  const queue: { opId: string; sealed: Promise<SealedOp> }[] = [];
  const queuedIds = new Set<string>();
  const waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];
  let attempts = 0;
  let running = false;
  let cancelRetry: (() => void) | undefined;
  const seal = options.seal ?? ((opId: string, plaintext: unknown) => {
    if (!options.key) throw new Error("Buffer pump needs a content key or an injected seal");
    return sealOp(options.key, opId, plaintext);
  });
  let stopped = false;
  async function drainOnce(): Promise<boolean> {
    const batch: { opId: string; sealed: Promise<SealedOp> }[] = [];
    while (batch.length < maxBatch && batch.length < queue.length) batch.push(queue[batch.length]);
    if (!batch.length) return true;
    const sealed = await Promise.all(batch.map((item) => item.sealed));
    await options.transport.send(options.boardId, sealed);
    for (const item of batch.splice(0, batch.length)) {
      queue.shift();
      queuedIds.delete(item.opId);
    }
    attempts = 0;
    return queue.length === 0;
  }

  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const empty = await drainOnce();
        if (empty) {
          const settled = waiters.splice(0, waiters.length);
          settled.forEach((waiter) => waiter.resolve());
          options.onIdle?.();
          break;
        }
      }
    } catch (error) {
      if (stopped) {
        const settled = waiters.splice(0, waiters.length);
        settled.forEach((waiter) => waiter.reject(error));
      }
      // While running, waiters keep waiting: the queue retries with backoff
      // and the journal is the durability anchor, so a failed send is never
      // a reason to drop data or fail callers that only want durability.
      if (!stopped) {
        attempts += 1;
        const delay = Math.min(maxBackoff, 1000 * 2 ** Math.min(attempts - 1, 6));
        cancelRetry = schedule(() => {
          cancelRetry = undefined;
          void drain().catch(() => undefined);
        }, error instanceof BufferBackpressureError ? delay : Math.min(delay, 15_000));
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(opId, plaintext) {
      if (stopped) throw new Error("Buffer pump is stopped");
      if (queuedIds.has(opId)) return;
      queuedIds.add(opId);
      queue.push({ opId, sealed: seal(opId, plaintext) });
      // Coalesce same-tick mutations into one send instead of one request per op.
      queueMicrotask(() => {
        if (queuedIds.has(opId)) void drain().catch(() => undefined);
      });
    },
    async flush() {
      if (!queue.length) return;
      // Promise.withResolvers is outside this project's lib target.
      await new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        void drain().catch(() => undefined);
      });
    },
    pending() {
      return queue.length;
    },
    async stop() {
      stopped = true;
      cancelRetry?.();
      for (let guard = 0; queue.length && guard < 3; guard += 1) {
        try {
          await drainOnce();
        } catch {
          /* journal remains the durability anchor; pending sends retry next session */
        }
      }
      const settled = waiters.splice(0, waiters.length);
      settled.forEach((waiter) => waiter.reject(new Error("Buffer pump stopped with pending ops")));
    }
  };
}
