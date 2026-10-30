import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { createOperationService } from '../../src/sync/operations/service';
import { ImmutableDriveFake } from './driveFake';
import type { DriveBoardStore } from '../../src/sync/driveBoardStore';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function client(fake: ImmutableDriveFake, layout: { folderId: string | null; projectFileId: string | null }, name = `pboardops${crypto.randomUUID().replaceAll('-', '')}`, extra: Partial<Parameters<typeof createOperationService>[0]> = {}) {
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const auth = { getAccessToken: async () => 'test', getConnectionState: async (): Promise<'connected'> => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} };
  const service = createOperationService({ auth, fetcher: fake.fetch, getRepository: async () => rx,
    store: { boardFolder: async () => 'folder', snapshotFileId: async () => null } as unknown as DriveBoardStore,
    sharedLayout: async () => layout, recordLayout: async (_, folderId, projectFileId) => { Object.assign(layout, { folderId, projectFileId }); }, stopLegacy: async () => {}, ...extra });
  cleanups.push(async () => { for (const board of rx.operationSource.bindings.keys()) await service.close(board); await rx.db.close(); });
  return { rx, service, name };
}
it('migrates an actual repository, captures editing commands and synchronizes without an authoritative browser', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout); const project = await a.rx.createProject('Original', 'project');
  const card = await a.rx.addItem({ projectId: project.id, content: 'Original card' });
  await a.service.sync(project.id, true);
  expect(fake.files.get(layout.projectFileId!)?.contentRestrictions?.[0].readOnly).toBe(true);
  const oldBytes = fake.files.get(layout.projectFileId!)!.body;
  fake.role = 'editor'; const b = await client(fake, layout); await b.service.sync(project.id, true);
  expect((await b.rx.listCards(project.id))[0].content).toBe('Original card');
  await a.rx.updateItem(card.id, { content: 'Edited by A' });
  await b.rx.updateItem(card.id, { title: 'Edited by B' });
  await a.service.sync(project.id, true); await b.service.sync(project.id, true); await a.service.sync(project.id, true);
  expect(await a.rx.listCards(project.id)).toEqual(await b.rx.listCards(project.id));
  expect((await a.rx.listCards(project.id))[0]).toMatchObject({ content: 'Edited by A', title: 'Edited by B' });
  expect(fake.files.get(layout.projectFileId!)!.body).toBe(oldBytes);
});
it('records property operations rather than full board snapshots for real editing commands', async () => {
  const fake = new ImmutableDriveFake(), a = await client(fake, { folderId: null, projectFileId: null });
  const project = await a.rx.createProject('Board', 'project'), card = await a.rx.addItem({ projectId: project.id, content: 'Initial' });
  await a.service.open(project.id); await a.rx.updateItem(card.id, { content: 'Changed' });
  const ops = await a.rx.operationSource.local.operations(project.id);
  expect(ops).toHaveLength(1); expect(ops[0]).toMatchObject({ kind: 'patch', fields: { content: 'Changed' } });
  expect(ops[0].fields).not.toHaveProperty('title');
});
it('preserves a legacy local fork in a visible recovery board without replacing newer shared data', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Shared', 'project');
  await a.rx.addItem({ projectId: project.id, content: 'Shared current' }); await a.service.sync(project.id, true);
  const b = await client(fake, layout); await b.rx.importProject(project, [{ id: 'local-card', projectId: project.id, content: 'Offline legacy work', type: 'note', status: 'candidate', order: 0, createdAt: project.createdAt, updatedAt: project.updatedAt }]);
  await b.service.sync(project.id, true);
  expect((await b.rx.listCards(project.id))[0].content).toBe('Shared current');
  const recovery = (await b.rx.listProjects()).find(p => p.name.endsWith('(local recovery)'))!;
  expect((await b.rx.listCards(recovery.id))[0].content).toBe('Offline legacy work');
});
it('keeps image bytes recoverable for a fresh viewer using the same hash references', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Images', 'project');
  const image = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bQAAAABJRU5ErkJggg==', mimeType: 'image/png', width: 1, height: 1 };
  await a.rx.addItem({ projectId: project.id, content: 'Image card', image }); await a.service.sync(project.id, true);
  fake.role = 'viewer'; const b = await client(fake, layout); await b.service.sync(project.id, true);
  const card = (await b.rx.listCards(project.id))[0]; expect(await b.rx.hasImage(card.imageId!)).toBe(true);
  expect((await b.rx.exportProject(project.id)).items[0].image?.dataUrl).toBe(image.dataUrl);
  await expect(b.rx.updateItem(card.id, { content: 'viewer write' })).rejects.toThrow(/editing access/);
});
it('recovers a crash after document commit but before operation allocation from the original WAL', async () => {
  const { vi } = await import('vitest');
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Crash', 'project'), card = await a.rx.addItem({ projectId: project.id, content: 'Before' });
  await a.service.open(project.id);
  vi.spyOn(a.rx.operationSource.local, 'append').mockRejectedValueOnce(new Error('Simulated worker interruption'));
  await expect(a.rx.updateItem(card.id, { content: 'Survives interruption' })).rejects.toThrow();
  await a.service.close(project.id); await a.rx.db.close();
  const resumed = await client(fake, layout, a.name); await resumed.service.sync(project.id, true);
  expect((await resumed.rx.listCards(project.id))[0].content).toBe('Survives interruption');
  expect(await resumed.rx.operationSource.local.operations(project.id)).toHaveLength(1);
});
it('an editor upgrades a legacy board while its owner is offline, without publishing an owner snapshot', async () => {
  const { serializeProjectSnapshot } = await import('../../src/sync/snapshot');
  const fake = new ImmutableDriveFake(), layout = { folderId: 'folder', projectFileId: 'legacy' };
  const stamp = '2026-01-01T00:00:00Z', project = { id: 'board', name: 'Legacy shared', template: 'project' as const, revision: 4, createdAt: stamp, updatedAt: stamp };
  fake.files.set('legacy', { id: 'legacy', name: 'project.json', parents: ['folder'], body: serializeProjectSnapshot(project, [{ id: 'old-card', projectId: 'board', content: 'Survives upgrade', type: 'note', status: 'candidate', order: 0, createdAt: stamp, updatedAt: stamp }]), createdTime: stamp });
  fake.role = 'editor'; const a = await client(fake, layout); await a.service.sync('board', true);
  expect([...fake.files.values()].filter(file => file.name.startsWith('snapshot-'))).toHaveLength(0);
  expect([...fake.files.values()].some(file => file.name.startsWith('operations-baseline-'))).toBe(true);
  await a.rx.updateItem('old-card', { title: 'Edited without owner' }); await a.service.sync('board', true);
  const b = await client(fake, layout); await b.service.sync('board', true);
  expect(await b.rx.listCards('board')).toEqual(await a.rx.listCards('board'));
  await expect(b.service.compact('board')).rejects.toThrow(/owner/);
  fake.role = 'owner'; await b.service.compact('board');
  const c = await client(fake, layout); await c.service.sync('board', true);
  expect(await c.rx.listCards('board')).toEqual(await a.rx.listCards('board'));
});
it('gardens only reviewed old covered files and a fresh profile recovers after interrupted deletion', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Garden', 'project'), card = await a.rx.addItem({ projectId: project.id, content: 'Before' });
  await a.service.sync(project.id, true); await a.rx.updateItem(card.id, { content: 'After' }); await a.service.sync(project.id, true);
  for (let n = 0; n < 4; n++) await a.service.compact(project.id);
  const plan = await a.service.previewGardening(project.id);
  expect(plan.eligibleSegmentIds).toHaveLength(1); expect(plan.eligibleSnapshots).toBe(2);
  await expect(a.service.garden(project.id, [])).rejects.toThrow(/History changed/);
  const first = fake.files.get(plan.eligibleFileIds[0])!; first.trashed = true;
  // Simulate a crash after the first deletion; a fresh preview is required.
  const remaining = await a.service.previewGardening(project.id);
  await a.service.garden(project.id, remaining.eligibleFileIds);
  const b = await client(fake, layout); await b.service.sync(project.id, true);
  expect(await b.rx.listCards(project.id)).toEqual(await a.rx.listCards(project.id));
  expect((await b.rx.listCards(project.id))[0].content).toBe('After');
  expect(fake.files.get(layout.projectFileId!)?.trashed).not.toBe(true);
});
it('revalidates Drive permission before synchronization and refuses later local writes', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Revocation', 'project'), card = await a.rx.addItem({ projectId: project.id, content: 'Retained' });
  await a.service.sync(project.id, true); await a.rx.updateItem(card.id, { content: 'Unpublished' });
  fake.role = 'revoked';
  await expect(a.service.sync(project.id, true)).rejects.toThrow(/revoked/);
  await expect(a.rx.updateItem(card.id, { content: 'Forbidden' })).rejects.toThrow(/editing access/);
  expect((await a.rx.operationSource.local.outbox(project.id, true)).length).toBe(1);
});
it('reviews a retained legacy draft as a property operation without reverting another editor content', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Draft review', 'project'), card = await a.rx.addItem({ projectId: project.id, content: 'Original content' });
  const base = (await a.rx.journal.committedEntries()).find(entry => entry.documentId === card.id)!;
  await a.service.sync(project.id, true);
  const draft = { id: 'retained-draft', boardId: project.id, base, value: { ...base.value, title: 'Reviewed title' }, deviceKeyId: 'retained-device', authorityKeyId: 'retained-authority', reason: 'expired', createdAt: '2026-01-01T00:00:00Z' } as any;
  await a.rx.journal.pendingEdits.put(draft);
  await a.rx.updateItem(card.id, { content: 'Other editor content' }); await a.service.sync(project.id, true);
  expect((await a.rx.listPendingWork()).some(edit=>edit.id === draft.id)).toBe(true);
  await a.rx.reviewPendingWork(draft.id, [draft.id]); await a.service.sync(project.id, true);
  expect((await a.rx.listCards(project.id))[0]).toMatchObject({ title: 'Reviewed title', content: 'Other editor content' });
  expect((await a.rx.listPendingWork()).some(edit=>edit.id === draft.id)).toBe(false);
  expect(await a.rx.journal.pendingEdits.get(draft.id)).toEqual(draft);
});
it('keeps a fresh viewer legacy content readable before any editor has migrated the board', async () => {
  const { serializeProjectSnapshot } = await import('../../src/sync/snapshot');
  const fake = new ImmutableDriveFake(), layout = { folderId: 'folder', projectFileId: 'legacy' }, stamp = '2026-01-01T00:00:00Z';
  const project = { id: 'board', name: 'Readable legacy', template: 'project' as const, revision: 1, createdAt: stamp, updatedAt: stamp };
  fake.files.set('legacy', { id: 'legacy', name: 'project.json', parents: ['folder'], body: serializeProjectSnapshot(project, [{ id: 'card', projectId: 'board', content: 'View before upgrade', type: 'note', status: 'candidate', order: 0, createdAt: stamp, updatedAt: stamp }]), createdTime: stamp });
  fake.role = 'viewer'; const a = await client(fake, layout);
  await expect(a.service.sync('board', true)).rejects.toThrow(/read-only/);
  expect((await a.rx.listCards('board'))[0].content).toBe('View before upgrade');
  await expect(a.rx.updateItem('card', { content: 'Forbidden' })).rejects.toThrow(/view-only/);
  expect(fake.requests.some(request => request.method !== 'GET')).toBe(false);
});

it('preserves empty text on existing cards during migration and later operation publication', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Empty text compatibility', 'project'), card = await a.rx.addItem({ projectId: project.id, content: '' });
  await a.service.sync(project.id, true); await a.rx.updateItem(card.id, { title: 'A title without body text' }); await a.service.sync(project.id, true);
  const b = await client(fake, layout); await b.service.sync(project.id, true);
  expect((await b.rx.listCards(project.id))[0]).toMatchObject({ content: '', title: 'A title without body text' });
});
it('recovers an offline legacy fork after owner deletion and compaction without recreating the shared board', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Owner deleted', 'project'), card = await a.rx.addItem({ projectId: project.id, content: 'Shared card' });
  await a.service.sync(project.id, true);
  const b = await client(fake, layout); await b.rx.importProject(project, [{ ...card, content: 'Offline legacy fork' }]);
  await a.rx.deleteProject(project.id); await a.service.flushRemoval(project.id); await a.service.compact(project.id);
  await b.service.sync(project.id, true);
  expect(await b.rx.getProject(project.id)).toBeNull();
  const recovery = (await b.rx.listProjects()).find(project => project.name.endsWith('(local recovery)'))!;
  expect((await b.rx.listCards(recovery.id))[0].content).toBe('Offline legacy fork');
});

it('closes a late WebRTC connection when the user disables the transport during setup', async () => {
  const { vi } = await import('vitest');
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  let finish!: (transport: { broadcast: () => Promise<boolean>; close: () => Promise<void> }) => void;
  const close = vi.fn(async () => {}), realtime = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const a = await client(fake, layout, undefined, { realtime });
  const project = await a.rx.createProject('Toggle race', 'project'), session = await a.service.open(project.id);
  const opening = session.setRealtime(true); await Promise.resolve();
  await session.setRealtime(false); finish({ broadcast: async () => true, close }); await opening;
  expect(close).toHaveBeenCalledOnce();
});
