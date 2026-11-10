import type { KeyValueStorage } from "./repository";

/** Runs work inside the critical section the caller already owns, or acquires the lock normally. */
export type LockAcquire = <T>(operation: () => Promise<T>) => Promise<T>;
export type LockedOperation<T> = (reenter: LockAcquire) => Promise<T>;
export type ReentrantLock = { run<T>(operation: LockedOperation<T>): Promise<T> };

const fallbackQueues = new WeakMap<KeyValueStorage, Map<string, Promise<void>>>();

function fallbackLock<T>(storage: KeyValueStorage, name: string, operation: () => Promise<T>): Promise<T> {
  let queues = fallbackQueues.get(storage);
  if (!queues) {
    queues = new Map();
    fallbackQueues.set(storage, queues);
  }
  const previous = queues.get(name) ?? Promise.resolve();
  const run = previous.then(operation);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(name, tail);
  void tail.finally(() => {
    if (queues?.get(name) === tail) queues.delete(name);
  });
  return run;
}

export function withStorageLock<T>(storage: KeyValueStorage, name: string, operation: () => Promise<T>): Promise<T> {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager) return lockManager.request(`pboard:${name}`, operation);
  return fallbackLock(storage, name, operation);
}

/** Adds the same-holder path to a single-exclusion acquisition. The operation that
 * owns a critical section is handed an acquirer, so work it acquires runs inside the
 * section it already owns instead of queueing behind itself and deadlocking. Every
 * other caller — including an acquirer kept past the end of its section — still goes
 * through `acquire`, so FIFO order and mutual exclusion are unchanged. A nested
 * acquisition that cannot prove it belongs to the running section still queues. */
export function createReentrantLock(acquire: LockAcquire): ReentrantLock {
  let section: symbol | undefined;
  return {
    run<T>(operation: LockedOperation<T>): Promise<T> {
      const holder = Symbol("pboard lock section");
      const reenter: LockAcquire = <R>(nested: () => Promise<R>): Promise<R> =>
        section === holder ? nested() : acquire(nested);
      return acquire(async () => {
        const outer = section;
        section = holder;
        try {
          return await operation(reenter);
        } finally {
          section = outer;
        }
      });
    }
  };
}
