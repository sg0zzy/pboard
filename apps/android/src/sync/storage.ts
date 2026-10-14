import type { KeyValueStorage } from '../../../../src/storage/repository';

/** Sync metadata only; cards and photos remain in the existing RxDB stores. */
export function createSyncStorage(storage: Storage = localStorage): KeyValueStorage {
  const prefix = 'pboard.android.sync.';
  return {
    async get(key) {
      const value = storage.getItem(prefix + key);
      return { [key]: value === null ? undefined : JSON.parse(value) };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) storage.setItem(prefix + key, JSON.stringify(value));
    },
  };
}
