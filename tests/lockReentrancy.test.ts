import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { createIndexedDbBlobStore } from '../src/storage/blobStore';
import { type LockAcquire, type ReentrantLock } from '../src/storage/lock';
import { createRepository, STORAGE_KEY, type KeyValueStorage } from '../src/storage/repository';
import { createRxRepository } from '../src/storage/rxdbRepository';
import { MemoryStorage } from './recovery/harness';
/** Yield one event-loop turn so a lock manager that grants a lock on a later turn has run,
 *  and so a caller that is still waiting can be observed. No wall-clock sleep. */
function drained() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/** The project's lib target is ES2022, so `Promise.withResolvers` is unavailable in its types. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function openRxRepository() {
  const name = `pboardlock${crypto.randomUUID().replaceAll('-', '')}`;
  return await createRxRepository({ name, storage: getRxStorageMemory(), blobs: createIndexedDbBlobStore(`${name}images`) });
}

/** Mutual exclusion: only the caller that opened the section may run inside it. */
async function callerStaysQueued(lock: ReentrantLock) {
  const { promise, release } = gate();
  const order: string[] = [];
  const held = lock.run(async () => { order.push('held'); await promise; return 'held'; });
  const waiting = lock.run(async () => { order.push('waiting'); return 'waiting'; });
  await drained();
  expect(order).toEqual(['held']);
  release();
  await Promise.all([held, waiting]);
  expect(order).toEqual(['held', 'waiting']);
}

async function holderReAcquiresItsOwnSection(lock: ReentrantLock) {
  const order: string[] = [];
  const nested = await lock.run(async reenter => {
    order.push('outer');
    const value = await reenter(async () => { order.push('re-acquired'); return 're-acquired'; });
    order.push('outer-resumed');
    return { value, order: [...order] };
  });
  expect(nested.value).toBe('re-acquired');
  expect(nested.order).toEqual(['outer', 're-acquired', 'outer-resumed']);
  return order;
}

describe('mutation lock held by the repository', () => {
  it('resolves a re-acquisition made by the holder of the section', async () => {
    const rx = await openRxRepository();
    await holderReAcquiresItsOwnSection({ run: rx.locked });
    await rx.db.remove();
  });

  it('keeps an independent caller queued behind a held section', async () => {
    const rx = await openRxRepository();
    await callerStaysQueued({ run: rx.locked });
    await rx.db.remove();
  });

  it('still queues an acquirer captured from a section that has ended', async () => {
    const rx = await openRxRepository();
    const stale: LockAcquire = await rx.locked(async reenter => reenter);
    const { promise, release } = gate();
    const order: string[] = [];
    const held = rx.locked(async () => { order.push('held'); await promise; return 'held'; });
    await drained();
    const viaStale = stale(async () => { order.push('stale'); return 'stale'; });
    await drained();
    // Losing proof of possession must not let a caller run unsynchronized.
    expect(order).toEqual(['held']);
    release();
    await Promise.all([held, viaStale]);
    expect(order).toEqual(['held', 'stale']);
    await rx.db.remove();
  });

  it('reports a failure to the caller that started the operation and keeps the lock moving', async () => {
    const rx = await openRxRepository();
    await expect(rx.locked(async () => { throw new Error('locked operation failed'); })).rejects.toThrow();
    await expect(rx.locked(async reenter => { await reenter(async () => { throw new Error('re-acquired operation failed'); }); return 'unreached'; })).rejects.toThrow();
    expect(await rx.locked(async () => 'next')).toBe('next');
    await rx.db.remove();
  });
});

describe('project state lock held by the project store', () => {
  it('resolves a re-acquisition made by the holder of the section', async () => {
    const repository = createRepository(new MemoryStorage());
    await holderReAcquiresItsOwnSection({ run: repository.withLock });
  });

  it('keeps an independent caller queued behind a held section', async () => {
    const repository = createRepository(new MemoryStorage());
    await callerStaysQueued({ run: repository.withLock });
  });

  it('still serializes two repositories that share one storage', async () => {
    const storage: KeyValueStorage = new MemoryStorage();
    const first = createRepository(storage);
    const second = createRepository(storage);
    const { promise, release } = gate();
    const order: string[] = [];
    const held = first.withLock(async () => { order.push('first'); await promise; return 'first'; });
    const waiting = second.withLock(async () => { order.push('second'); return 'second'; });
    await drained();
    expect(order).toEqual(['first']);
    release();
    await Promise.all([held, waiting]);
    expect(order).toEqual(['first', 'second']);
  });

  it('prefers the browser lock manager when one is present', async () => {
    const storage = new MemoryStorage();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const requested: string[] = [];
    let tail: Promise<unknown> = Promise.resolve();
    const lockManager = {
      // A lock manager grants one section at a time; that is what the code depends on.
      request: async (name: string, operation: () => Promise<unknown>) => {
        requested.push(name);
        const turn = tail.then(operation);
        tail = turn.then(() => undefined, () => undefined);
        return turn;
      }
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: lockManager } });
    try {
      const repository = createRepository(storage);
      await holderReAcquiresItsOwnSection({ run: repository.withLock });
      // The section asked the browser once; the re-acquisition ran inside it instead of
      // asking again, which a lock manager cannot grant to its own holder.
      expect(requested).toEqual([`pboard:${STORAGE_KEY}`]);
      await callerStaysQueued({ run: repository.withLock });
      expect(requested.length).toBe(3);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('falls back to arrival order when no lock manager is available', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    try {
      const repository = createRepository(new MemoryStorage());
      await callerStaysQueued({ run: repository.withLock });
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});
