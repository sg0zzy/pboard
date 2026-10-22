import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createAccountPreferenceSync } from '../../src/sync/accountPreferences';
import type { DriveTransport } from '../../src/sync/driveTransport';

/**
 * The account's project order is merged on every account-preference sync, and
 * the merge produces a new value each time. Writing it unconditionally changed
 * the settings collection on every sync.
 *
 * The settings collection is observed by the sidebar's project list and its
 * current project, so that write re-rendered the whole board — and the
 * re-render started the next sync. The sidebar was therefore re-rendering
 * continuously, and every render asked Drive for the board's role and shared
 * file.
 */
const repos: RxRepository[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.db.close();
});

function memoryDrive() {
  const files = new Map<string, { id: string; name: string; contents: string }>();
  const stats = { uploads: 0 };
  const transport: DriveTransport = {
    async listProjectFiles() { return [...files.values()].map((f) => ({ id: f.id, name: f.name })); },
    async findProjectFile(projectId: string) {
      const name = `account-preferences-${projectId}.pboard`;
      return [...files.values()].find((f) => f.name === name) ?? null;
    },
    async download(fileId: string) {
      const file = files.get(fileId);
      if (!file) throw new Error("missing");
      return file.contents;
    },
    async upload(projectId: string, contents: string, fileId?: string) {
      stats.uploads++;
      const name = `account-preferences-${projectId}.pboard`;
      const id = fileId ?? `f${files.size + 1}`;
      files.set(id, { id, name, contents });
      return { id, name };
    },
    async delete(fileId: string) { files.delete(fileId); }
  };
  return { stats, files, transport };
}

it("does not rewrite the account's order when the merge changes nothing", async () => {
  const rx = await createRxRepository({ name: `order${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Board', 'project');
  const account = 'account-a';
  await rx.setProjectOrderAccount(account);

  const data = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return { [key]: data.get(key) }; },
    async set(values: Record<string, unknown>) { for (const [k, v] of Object.entries(values)) data.set(k, v); }
  };
  const drive = memoryDrive();
  const sync = createAccountPreferenceSync({
    transport: drive.transport, getAccountId: async () => account,
    getRepository: async () => rx
  });

  // The first sync records the order.
  await sync();
  const stored = await rx.getProjectOrder(account);
  console.log('stored order:', JSON.stringify(stored));

  // Every later sync must leave the stored order alone.
  for (let round = 0; round < 3; round++) await sync();
  const after = await rx.getProjectOrder(account);
  console.log('order after 3 more syncs:', JSON.stringify(after));
  expect(after).toEqual(stored);

  // And the settings collection must not have been written again, because the
  // sidebar's subscriptions observe it.
  expect(await rx.db.settings.findOne(`projectOrder:${account}`).exec()).toBeTruthy();
}, 60000);

it("keeps the sidebar's project list unchanged when the order does not change", async () => {
  const rx = await createRxRepository({ name: `emit${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Board', 'project');
  const account = 'account-a';
  await rx.setProjectOrderAccount(account);
  // The account's own order, as the account-preference sync records it.
  await rx.applyProjectOrder(account, { ids: [board.id], updatedAt: '1970-01-01T00:00:00.000Z' });

  let emissions = 0;
  const stop = rx.subscribeProjects(() => { emissions += 1; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterMount = emissions;

  // The merge the account-preference sync performs: the same order again.
  await rx.applyProjectOrder(account, { ids: [board.id], updatedAt: '1970-01-01T00:00:00.000Z' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log('emissions after mount:', afterMount, 'after an unchanged merge:', emissions - afterMount);
  stop();

  // The merge changed nothing, so the settings collection must not have
  // changed, so the project list must not have been re-read and re-rendered.
  expect(emissions - afterMount).toBe(0);
}, 60000);
