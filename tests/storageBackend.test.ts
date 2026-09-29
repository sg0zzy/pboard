import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { STORAGE_KEY } from "../src/storage/repository";
import type { AppState } from "../src/types";

vi.mock("../src/sync/browser", () => ({
  driveSyncState: { markDirty: async () => undefined, get: async () => ({}) },
  driveTombstones: { add: async () => undefined },
  googleDrive: { deleteProject: async () => undefined },
  registerRxRepositoryResolver: () => undefined
}));

describe("storage backend rollout", () => {
  it("defaults to RxDB, preserves legacy bytes, rolls back with recovery, and falls back after failed import", async () => {
    const values: Record<string, unknown> = {};
    const listeners = new Set<(changes: Record<string, { newValue: unknown }>, area: string) => void>();
    const local = {
      async get(key: string) { return { [key]: structuredClone(values[key]) }; },
      async set(patch: Record<string, unknown>) {
        Object.assign(values, structuredClone(patch));
        const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }]));
        for (const listener of listeners) listener(changes, "local");
      }
    };
    Object.assign(globalThis, { browser: { storage: { local, onChanged: {
      addListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.add(listener),
      removeListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.delete(listener)
    } } } });
    const { repository, legacyRepository, setStorageBackend, configuredBackend,
      PRE_ROLLBACK_BACKUP_KEY, RXDB_MIGRATION_ERROR_KEY } = await import("../src/storage/browser");
    const project = await legacyRepository.createProject("Legacy");
    const image = { dataUrl: "data:image/webp;base64,AAAA", mimeType: "image/webp", width: 2, height: 2 };
    const card = await legacyRepository.addItem({ projectId: project.id, content: "Before", image });
    const original = structuredClone(values[STORAGE_KEY]);
    expect(values.pboardStorageBackend).toBeUndefined();
    expect(await configuredBackend()).toBe("rxdb");
    expect((await repository.listCards(project.id))[0].imageId).toBeTruthy();
    expect(values[STORAGE_KEY]).toEqual(original);
    await setStorageBackend("rxdb");
    expect(await configuredBackend()).toBe("rxdb");
    expect(values[STORAGE_KEY]).toEqual(original);
    expect((await repository.listCards(project.id))[0].imageId).toBeTruthy();
    await repository.updateItem(card.id, { content: "After" });
    expect((values[STORAGE_KEY] as AppState).boardItems[0].content).toBe("Before");
    await setStorageBackend("legacy");
    expect(await configuredBackend()).toBe("legacy");
    expect(values[PRE_ROLLBACK_BACKUP_KEY]).toEqual(original);
    expect((await legacyRepository.load()).boardItems[0].content).toBe("After");
    await legacyRepository.updateItem(card.id, { content: "Later" });
    await setStorageBackend("rxdb");
    expect((await repository.getCard(card.id))?.content).toBe("Later");
    await setStorageBackend("legacy");
    const broken = await legacyRepository.load();
    broken.boardItems[0].image!.dataUrl = "not-a-data-url";
    await local.set({ [STORAGE_KEY]: broken, pboardStorageBackend: "rxdb" });
    // This call must preserve the old data and expose a diagnostic.
    expect((await repository.getCard(card.id))?.content).toBe("Later");
    expect(values[RXDB_MIGRATION_ERROR_KEY]).toMatch(/url|image/i);
    expect(values[STORAGE_KEY]).toEqual(broken);
  });
});
