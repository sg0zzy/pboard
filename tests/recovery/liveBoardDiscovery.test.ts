import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createDriveRuntime } from '../../src/sync/runtime';
import { DriveFixture, openDevice, type RecoveryDevice } from './harness';

const devices: RecoveryDevice[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const device of devices.splice(0)) await device.destroy();
});
async function open(cloud: DriveFixture, account = 'account-a') {
  const device = await openDevice(cloud, account); devices.push(device); return device;
}
function discovery(device: RecoveryDevice) {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('No legacy Drive or rendezvous requests expected'); });
  const runtime = createDriveRuntime({ operationSync: false, auth: device.auth, storage: device.storage, getRepository: async () => device.repo, fetcher });
  // Keep the real private-history provider and RxDB storage, replacing only
  // its HTTP boundary with the account-isolated synthetic Drive fixture.
  vi.spyOn(runtime.googleDrive, 'reconcileAll').mockImplementation(() => device.provider.reconcileAll());
  return { refresh: runtime.discoverSharedBoards, fetcher, runtime };
}

it('discovers a newly backed-up same-account board in an already-open reactive list, without changing selection or granting authority', async () => {
  const cloud = new DriveFixture(), a = await open(cloud), b = await open(cloud);
  const selected = await b.repo.createProject('Keep my selection');
  await b.provider.syncProject(selected.id);
  const { refresh, fetcher, runtime } = discovery(b);
  await refresh(); // B was already open before A created the board.
  const lists: string[][] = [];
  const stop = b.repo.subscribeProjects(projects => lists.push(projects.map(p => p.id)));
  try {
    const added = await a.repo.createProject('New board from browser A');
    const card = await a.repo.addItem({ projectId: added.id, content: 'Recovered while browser B stays open' });
    await a.provider.syncProject(added.id);
    await b.repo.addItem({ projectId: selected.id, content: 'My concurrent local card' });
    await Promise.all([refresh(), refresh()]);
    await vi.waitFor(() => expect(lists.some(ids => ids.includes(added.id))).toBe(true));
    expect((await b.repo.getCard(card.id))?.content).toBe('Recovered while browser B stays open');
    expect((await b.repo.getCurrentProject())?.id).toBe(selected.id);
    expect((await b.repo.listCards(selected.id)).some(c => c.content === 'My concurrent local card')).toBe(true);
    expect(await runtime.boardCollaboration.ownsAuthority(added.id)).toBe(false);
    expect(await runtime.boardCollaboration.localBundle(added.id)).toBeNull();
    expect(await b.repo.listConflicts()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { stop(); }
});

it('retries failed discovery without restart and does not expose another account private board', async () => {
  const cloud = new DriveFixture(), a = await open(cloud), b = await open(cloud), other = await open(cloud, 'account-b');
  const board = await a.repo.createProject('Account A private');
  await a.provider.syncProject(board.id);
  const { refresh } = discovery(b);
  cloud.available = false;
  await expect(refresh()).rejects.toThrow('Fixture network unavailable');
  const local = await b.repo.createProject('Offline editing still works');
  cloud.available = true;
  await refresh();
  expect(await b.repo.getProject(board.id)).not.toBeNull();
  expect(await b.repo.getProject(local.id)).not.toBeNull();
  await discovery(other).refresh();
  expect(await other.repo.getProject(board.id)).toBeNull();
});
