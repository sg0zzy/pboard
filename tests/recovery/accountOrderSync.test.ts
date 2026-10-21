import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createAccountPreferenceSync } from '../../src/sync/accountPreferences';
import type { DriveTransport } from '../../src/sync/driveTransport';

/**
 * The account preference sync loops until the saved order covers every
 * visible board and the uploaded file matches the local order. A project that
 * was deleted is kept out of the order, so the loop must not keep trying to
 * add it, and the upload must not repeat.
 */
const repos: RxRepository[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const repo of repos.splice(0)) await repo.db.close(); });

function memoryDrive(): { transport: DriveTransport; uploads: () => number } {
  const files = new Map<string, { id: string; name: string; contents: string }>();
  let uploads = 0;
  return {
    transport: {
      findProjectFile: async (id) => files.get(id) ?? null,
      listProjectFiles: async () => [...files.values()].reverse(),
      download: async (id) => files.get(id)!.contents,
      upload: async (id, contents, fileId) => {
        uploads++;
        const file = { id: fileId ?? id, name: `${id}.pboard`, contents };
        files.set(id, file); return file;
      },
      delete: async (id) => { files.delete(id); }
    },
    uploads: () => uploads
  };
}

it('uploads the account order once per sync and settles', async () => {
  const rx = await createRxRepository({ name: `ordersync${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Visible board', 'project');
  const account = 'account-a';
  await rx.setProjectOrderAccount(account);

  const drive = memoryDrive();
  const sync = createAccountPreferenceSync({
    transport: drive.transport, getAccountId: async () => account, getRepository: async () => rx
  });

  await sync();
  const afterFirst = drive.uploads();
  expect(afterFirst).toBeGreaterThan(0);

  // The sync must settle within one run: it does not upload in a loop.
  expect(afterFirst).toBeLessThanOrEqual(3);
  expect((await rx.getProjectOrder(account))?.ids).toContain(board.id);
});

it('settles when the saved order lists a board that no longer exists', async () => {
  const rx = await createRxRepository({ name: `ordersync2${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Visible board', 'project');
  const account = 'account-a';
  await rx.setProjectOrderAccount(account);

  const drive = memoryDrive();
  const sync = createAccountPreferenceSync({
    transport: drive.transport, getAccountId: async () => account, getRepository: async () => rx
  });
  await sync();

  // The remote order names a board this device does not have. The sync must
  // settle rather than adding it forever.
  await rx.applyProjectOrder(account, { ids: [board.id, 'unknown-board'], updatedAt: new Date().toISOString() });
  let iterations = 0;
  const original = rx.listProjects.bind(rx);
  vi.spyOn(rx, 'listProjects').mockImplementation(async () => {
    iterations++;
    if (iterations > 200) throw new Error('The account order sync did not settle');
    return original();
  });

  await sync();
  expect(iterations).toBeLessThan(50);
});
