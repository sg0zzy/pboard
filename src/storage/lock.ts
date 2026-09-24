import type { KeyValueStorage } from "./repository";

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
