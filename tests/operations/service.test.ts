import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { createOperationService } from '../../src/sync/operations/service';
import { clearLegacyBarrierMemory, legacyBarrierIntact } from '../../src/sync/operations/service';
import { driveHttpError } from '../../src/sync/driveHttp';
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
it('projects a converged edit over a stored document whose newer wall-clock stamp lost the field contest', async () => {
  // Two concurrent edits on the same card land at the same logical clock, and
  // the `updatedAt` register tie-breaks on actor id. The replica whose own edit
  // happened *later* but lost that contest must still project the converged
  // state: its document legitimately carries a newer wall clock than the
  // winning operation's, and the projection guard compares against what the
  // entity's receipted history has *shown* — which includes this device's own
  // retired edit — not against the value the register still displays. Pin the
  // stream identities so a's older edit wins the contest and the timestamps so
  // b's stored stamp is newer, and the old comparison pinned b forever.
  const pinActor = async (rx: RxRepository, boardId: string, actorId: string) => {
    await rx.journal.operationTransaction<void>(boardId, ['operationStreams'], (tx, result) => {
      const request = tx.objectStore('operationStreams').get(boardId);
      request.onsuccess = () => {
        try {
          const stream = request.result as { actorId?: unknown; seq?: unknown } | undefined;
          if (!stream || typeof stream.actorId !== 'string' || stream.seq !== 0) throw new Error('Stream already allocated');
          tx.objectStore('operationStreams').put({ ...stream, actorId });
          result(undefined);
        } catch { tx.abort(); }
      };
      request.onerror = () => { tx.abort(); };
    });
  };
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout); const project = await a.rx.createProject('Contest', 'project');
  const card = await a.rx.addItem({ projectId: project.id, content: 'Original card' });
  await a.service.sync(project.id, true);
  fake.role = 'editor'; const b = await client(fake, layout); await b.service.sync(project.id, true);
  await pinActor(a.rx, project.id, 'zzzz-contest-actor-a'); await pinActor(b.rx, project.id, 'aaaa-contest-actor-b');
  await (await b.service.open(project.id)).edit({ collection: 'cards', entityId: card.id, kind: 'patch',
    fields: { title: 'Edited by B', updatedAt: '2099-01-01T00:00:00.000Z' }, unset: [] });
  expect((await b.rx.listCards(project.id))[0]).toMatchObject({ content: 'Original card', title: 'Edited by B' });
  await a.rx.updateItem(card.id, { content: 'Edited by A' });
  await a.service.sync(project.id, true); await b.service.sync(project.id, true); await a.service.sync(project.id, true);
  expect((await b.rx.listCards(project.id))[0]).toMatchObject({ content: 'Edited by A', title: 'Edited by B' });
  expect(await a.rx.listCards(project.id)).toEqual(await b.rx.listCards(project.id));
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
  await expect(b.service.previewGardening('board')).rejects.toThrow(/owner/);
  fake.role = 'owner';
  const ownerSession = await b.service.open('board');
  { const { snapshot } = await ownerSession.prepareLogSnapshot(); await ownerSession.publishLogSnapshot(snapshot); }
  const c = await client(fake, layout); await c.service.sync('board', true);
  expect(await c.rx.listCards('board')).toEqual(await a.rx.listCards('board'));
});
it('gardens only reviewed old covered files and a fresh profile recovers after interrupted deletion', async () => {
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const a = await client(fake, layout), project = await a.rx.createProject('Garden', 'project'), card = await a.rx.addItem({ projectId: project.id, content: 'Before' });
  await a.service.sync(project.id, true); await a.rx.updateItem(card.id, { content: 'After' }); await a.service.sync(project.id, true);
  const session = await a.service.open(project.id);
  for (let n = 0; n < 4; n++) { const { snapshot } = await session.prepareLogSnapshot(); await session.publishLogSnapshot(snapshot); }
  const plan = await a.service.previewGardening(project.id);
  expect(plan.eligibleSegmentIds).toHaveLength(1); expect(plan.eligibleSnapshots).toBe(2);
  // A plan is spent the moment it is stale: any reviewed set that differs
  // from a fresh preview — missing or extra files — is refused, not truncated.
  await expect(a.service.garden(project.id, [])).rejects.toThrow(/History changed/);
  await expect(a.service.garden(project.id, [...plan.eligibleFileIds, 'already-gardened'])).rejects.toThrow(/History changed/);
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
  await a.rx.deleteProject(project.id); await a.service.flushRemoval(project.id);
  { const removal = await a.service.open(project.id); const { snapshot } = await removal.prepareLogSnapshot(); await removal.publishLogSnapshot(snapshot); }
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

it('treats a deleted legacy checkpoint as a write barrier that still holds', async () => {
  // The locked legacy file stops the pre-protocol path writing beside the
  // operation protocol. A file Drive has deleted cannot be written either, so
  // nothing has to be re-locked — and because this check runs before every sync,
  // reading it the other way round failed every later sync of the board.
  const drive = (body: unknown, failure?: unknown) => ({ metadata: async () => { if (failure) throw failure; return body as never } });
  clearLegacyBarrierMemory();
  expect(await legacyBarrierIntact(drive({ contentRestrictions: [{ readOnly: true }] }), 'barrier-locked')).toBe(true);
  expect(await legacyBarrierIntact(drive({ contentRestrictions: [] }), 'barrier-open')).toBe(false);
  expect(await legacyBarrierIntact(drive(null, driveHttpError(404, 'Google Drive operation storage failed (404)')), 'barrier-gone')).toBe(true);
  await expect(legacyBarrierIntact(drive(null, driveHttpError(500, 'Google Drive operation storage failed (500)')), 'barrier-500')).rejects.toThrow(/500/);
});

it('asks Drive once about a legacy checkpoint it has deleted', async () => {
  // The barrier is verified before every sync of every board. A board migrated
  // from several legacy files, in a library of migrated boards, therefore re-paid
  // a request per deleted file per round — a stream of 404s for information that
  // cannot change, since Drive never reuses a file id.
  let asks = 0;
  const drive = { metadata: async () => { asks += 1; throw driveHttpError(404, 'Google Drive operation storage failed (404)'); } };
  clearLegacyBarrierMemory();
  expect(await legacyBarrierIntact(drive, 'legacy-deleted')).toBe(true);
  for (let sync = 0; sync < 20; sync++) expect(await legacyBarrierIntact(drive, 'legacy-deleted')).toBe(true);
  expect(asks).toBe(1);
  // A failure that is not terminal is asked about again.
  let transient = 0;
  const flaky = { metadata: async () => { transient += 1; throw driveHttpError(503, 'Google Drive operation storage failed (503)'); } };
  for (let attempt = 0; attempt < 2; attempt++) await expect(legacyBarrierIntact(flaky, 'legacy-flaky')).rejects.toThrow(/503/);
  expect(transient).toBe(2);
});

it('stops asking Drive for an image copy Drive can no longer serve', async () => {
  // Image copies are verified after every sync of every board, and only a *success*
  // was ever recorded. On a second browser — which has never downloaded the image, so
  // it must read the listing's candidates — one copy Drive had deleted answered 404 on
  // each pass: asked again forever, because the answer about a deleted id cannot change.
  const layout = { folderId: null as string | null, projectFileId: null as string | null };
  const fake = new ImmutableDriveFake(), a = await client(fake, layout);
  const project = await a.rx.createProject('Board', 'project');
  await a.rx.addItem({ projectId: project.id, content: 'Photo', image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mimeType: 'image/png', width: 1, height: 1 } });
  await a.service.sync(project.id, true);
  const vanished = [...fake.files.values()].find(file => file.name.startsWith('image-'))!;
  fake.files.set('intact-copy', { ...vanished, id: 'intact-copy' }); // a second immutable copy of the same asset
  fake.unreadable.add(vanished.id);
  const b = await client(fake, layout);
  const asked = () => fake.requests.filter(request => request.url.includes(vanished.id) && request.url.includes('alt=media')).length;
  await b.service.sync(project.id, true);
  expect((await b.rx.listCards(project.id))[0].imageId).toBeTruthy(); // the intact copy carried the image across
  const first = asked();
  expect(first).toBeGreaterThan(0); // the listing's candidate was tried, as it has to be at least once
  await b.service.sync(project.id, true);
  await b.service.sync(project.id, true);
  expect(asked()).toBe(first); // never again: Drive's answer about a deleted id is terminal
});

it('holds one journal listener for every open board, released when the last one closes', async () => {
  // The listener used to be per board and per `performOpen`, released only by
  // `close`: a browser that visited twenty boards held twenty listeners for the
  // rest of the session, every one of them woken by every write to any board.
  // The rule is now "at most one while any board is open, none after", counted
  // here on the journal's own subscribe/unsubscribe pairs (the same thing the
  // `journal.listeners` gauge projects, measurable without the diagnostics
  // build). The repository's own listeners exist before the wrapper, so they
  // are outside the count.
  const name = `pboardlisteners${crypto.randomUUID().replaceAll('-', '')}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  let live = 0;
  const subscribe = rx.journal.subscribe.bind(rx.journal);
  rx.journal.subscribe = (listener: (tables: string[]) => void) => {
    live += 1;
    const stop = subscribe(listener);
    let active = true;
    return () => { if (active) { active = false; live -= 1; } stop(); };
  };
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const auth = { getAccessToken: async () => 'test', getConnectionState: async (): Promise<'connected'> => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} };
  const service = createOperationService({ auth, fetcher: fake.fetch, getRepository: async () => rx,
    store: { boardFolder: async () => 'folder', snapshotFileId: async () => null } as unknown as DriveBoardStore,
    sharedLayout: async () => layout, recordLayout: async (_, folderId, projectFileId) => { Object.assign(layout, { folderId, projectFileId }); }, stopLegacy: async () => {} });
  cleanups.push(async () => { for (const board of [...rx.operationSource.bindings.keys()]) await service.close(board); await rx.db.close(); });
  // Three boards this device already owns: the binding is what `open` finds, so
  // the test measures the listener bookkeeping and not the migration path.
  const boards: string[] = [];
  for (let index = 0; index < 3; index++) {
    const project = await rx.createProject(`Board ${index}`, 'project');
    boards.push(project.id);
    await rx.bindOperationBoard({ id: `binding:${project.id}`, kind: 'operation-binding', boardId: project.id,
      folderId: 'folder', role: 'owner', legacyFileIds: [], baseRevision: 0 });
  }
  for (let round = 0; round < 20; round++) {
    await service.open(boards[round % boards.length]);
    // One listener, however many boards have been opened and are still open.
    expect(live, `after ${round + 1} opens`).toBe(1);
  }
  for (const id of boards) await service.close(id);
  expect(live, 'the last close releases the shared listener').toBe(0);
});

it('uploads an image once, and never again on a sync that changed nothing', async () => {
  // `syncImages` runs in the after-sync of every sync of every board, and its
  // "already published" answer used to be the Drive listing alone. The listing
  // is a cached feed (`operations/changes.ts`: a folder is re-listed at most
  // every five minutes), so the sync that uploaded an image had already read a
  // listing that could not name the file it was about to create: the next
  // publishing sync inside that window saw no candidate and uploaded the very
  // same immutable file again, once per sync, for every image on the board.
  // The file name is the image's content hash, so the receipt of "these bytes
  // are published" is what makes the sweep free — the upload count is the whole
  // assertion.
  const fake = new ImmutableDriveFake(), layout = { folderId: null as string | null, projectFileId: null as string | null };
  const name = `pboardimagecount${crypto.randomUUID().replaceAll('-', '')}`;
  const rx = await createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`) });
  const auth = { getAccessToken: async () => 'test', getConnectionState: async (): Promise<'connected'> => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} };
  // The product's own listing cache semantics, with one listing held: `full()`
  // is what `changes.ts` calls when a folder needs a full listing, and until
  // the next one is due it answers the files it captured then.
  let captured: Awaited<ReturnType<typeof fake.store>>['inventory'] extends never ? never : { id: string; name: string }[] = [];
  let listings = 0;
  const cached = {
    inventory: async (_boardId: string, _folderId: string, full: () => Promise<{ id: string; name: string }[]>) => {
      if (!listings) { captured = await full(); listings += 1; }
      return captured;
    },
    forgetBoard: async () => undefined
  };
  const service = createOperationService({ auth, fetcher: fake.fetch, changes: cached as unknown as Parameters<typeof createOperationService>[0]['changes'], getRepository: async () => rx,
    store: { boardFolder: async () => 'folder', snapshotFileId: async () => null } as unknown as DriveBoardStore,
    sharedLayout: async () => layout, recordLayout: async (_, folderId, projectFileId) => { Object.assign(layout, { folderId, projectFileId }); }, stopLegacy: async () => {} });
  cleanups.push(async () => { for (const board of [...rx.operationSource.bindings.keys()]) await service.close(board); await rx.db.close(); });
  const project = await rx.createProject('Images', 'project');
  const one = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bQAAAABJRU5ErkJggg==';
  const two = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  // Every upload *attempt*, including the ones Drive answers 409 to: an attempt
  // is the request a stale listing buys, and the file is immutable, so the
  // second attempt can only be waste.
  const imageUploads = () => fake.uploads.filter(fileName => fileName.startsWith('image-'));
  await rx.addItem({ projectId: project.id, content: 'First image', image: { dataUrl: one, mimeType: 'image/png', width: 1, height: 1 } });
  await service.sync(project.id, true);
  expect(imageUploads()).toHaveLength(1);
  const session = await service.open(project.id);
  // Publishing syncs against the listing captured before that upload: no new
  // images, so no new uploads.
  for (let round = 0; round < 3; round++) await session.sync(false, true);
  expect(imageUploads(), 'a publishing sync with no new image uploads nothing').toHaveLength(1);
  // A new image uploads exactly once, however often it is synced afterwards.
  await rx.addItem({ projectId: project.id, content: 'Second image', image: { dataUrl: two, mimeType: 'image/png', width: 1, height: 1 } });
  for (let round = 0; round < 3; round++) await session.sync(false, true);
  expect(imageUploads(), 'the new image is uploaded once').toHaveLength(2);
  expect(new Set(imageUploads()).size, 'and it is the image that had not been published').toBe(2);
});
