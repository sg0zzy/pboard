import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createDriveRuntime } from '../../src/sync/runtime';
import { createRxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { DriveStub } from '../sync/driveStub';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function profile(stub: DriveStub) {
  const name = `pboardopsruntime${crypto.randomUUID().replaceAll('-', '')}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const data: Record<string, unknown> = {};
  const runtime = createDriveRuntime({ auth: { getAccessToken: async () => 'token', getConnectionState: async () => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
    storage: { get: async (key: string) => ({ [key]: structuredClone(data[key]) }), set: async value => { Object.assign(data, structuredClone(value)); } },
    getRepository: async () => rx, fetcher: stub.fetch as typeof fetch });
  await runtime.collaborationManager.setEnabled(false);
  closes.push(async () => { await runtime.collaborationManager.stop(); for (const id of rx.operationSource.bindings.keys()) await runtime.operationService.close(id); await rx.db.close(); });
  return { runtime, rx, data };
}
it('default runtime migrates and manually syncs independent profiles using immutable regular Drive storage', async () => {
  const drive = new DriveStub(); drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const a = await profile(drive), b = await profile(drive);
  const project = await a.rx.createProject('Runtime board', 'project');
  const card = await a.rx.addItem({ projectId: project.id, content: 'Initial' });
  await a.runtime.googleDrive.syncProject(project.id, { force: true });
  const requestsAfterMigration = drive.requests.length;
  await b.runtime.googleDrive.reconcileAll();
  expect((await b.rx.listCards(project.id))[0].content).toBe('Initial');
  await a.rx.updateItem(card.id, { content: 'A' }); await b.rx.updateItem(card.id, { title: 'B' });
  await a.runtime.googleDrive.syncProject(project.id, { force: true });
  await b.runtime.googleDrive.syncProject(project.id, { force: true });
  await a.runtime.googleDrive.syncProject(project.id, { force: true });
  expect(await a.rx.listCards(project.id)).toEqual(await b.rx.listCards(project.id));
  expect(await a.rx.getProject(project.id)).toEqual(await b.rx.getProject(project.id));
  expect((await a.rx.listCards(project.id))[0]).toMatchObject({ content: 'A', title: 'B' });
  expect(drive.files.some(file => file.name.startsWith('operations-'))).toBe(true);
  expect(drive.requests.slice(requestsAfterMigration).some(url => url.includes('upload') && url.includes('appDataFolder'))).toBe(false);
  expect(drive.files.filter(file => file.parents.includes('appDataFolder'))).toHaveLength(0);
});
it('publishes account erasure in regular Drive and prevents a fresh profile resurrecting the deleted board', async () => {
  const { hashBlob } = await import('../../src/storage/blobStore');
  const drive = new DriveStub(); drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const a = await profile(drive), project = await a.rx.createProject('Private erasure', 'project');
  await a.rx.addItem({ projectId: project.id, content: 'Discarded by explicit deletion' }); await a.runtime.googleDrive.syncProject(project.id, { force: true });
  const account = await hashBlob(new Blob(['owner@example.com']));
  await a.rx.permanentlyDeleteBoard(project.id, account); await a.runtime.googleDrive.reconcileAll();
  expect(drive.files.some(file => file.name === `erased-${account}-${project.id}.pboard` && !file.parents.includes('appDataFolder'))).toBe(true);
  const fresh = await profile(drive); await fresh.runtime.googleDrive.reconcileAll();
  expect(await fresh.rx.getProject(project.id)).toBeNull(); expect(await fresh.rx.journal.boardErasure(project.id)).toBeTruthy();
});
