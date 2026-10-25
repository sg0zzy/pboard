import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { DriveFixture, openDevice, sampleImage, type RecoveryDevice } from './harness';
import { createPrivateDriveHistory } from '../../src/sync/privateDriveHistory';
import { createGoogleDriveProvider } from '../../src/sync/googleDriveProvider';
import { createDriveTombstoneStore } from '../../src/sync/state';
import { canonicalize, type Json } from '../../src/collab/security/canonical';
import { hashBlob } from '../../src/storage/blobStore';
import { makeChange } from '../../src/storage/changeJournal';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { signManifest, verifyManifest } from '../../src/collab/security/manifest';
import { installLiveBoardMutations, withUntrustedImport } from '../../src/collab/security/liveMutations';

const devices: RecoveryDevice[] = [];
afterEach(async () => { for (const device of devices.splice(0)) await device.destroy(); });
async function open(cloud: DriveFixture, account?: string) { const d = await openDevice(cloud, account); devices.push(d); return d; }
async function pair() {
  const cloud = new DriveFixture(), a = await open(cloud), b = await open(cloud);
  const board = await a.repo.createProject('Private causal recovery', 'project');
  const first = await a.repo.addItem({ projectId: board.id, title: 'Original title', content: 'Base one', image: sampleImage });
  const second = await a.repo.addItem({ projectId: board.id, content: 'Base two' });
  await a.provider.syncProject(board.id); await b.provider.reconcileAll();
  return { cloud, a, b, board, first, second };
}

it('retains simultaneous immutable uploads despite last-writer snapshot replacement, restoring both offline edits after both sources are lost', async () => {
  const { cloud, a, b, board, first, second } = await pair();
  await a.repo.updateItem(first.id, { content: 'Offline A' }); await b.repo.updateItem(second.id, { content: 'Offline B' });
  const gate = cloud.pauseNext('upload'), sending = a.provider.syncProject(board.id);
  await gate.started;
  try { await b.provider.syncProject(board.id); } finally { gate.release(); }
  await sending;
  await a.destroy(); await b.destroy();
  const c = await open(cloud); await c.provider.reconcileAll();
  expect((await c.repo.getCard(first.id))?.content).toBe('Offline A');
  expect((await c.repo.getCard(second.id))?.content).toBe('Offline B');
  expect((await c.repo.exportProject(board.id)).items.find(i => i.id === first.id)?.image).toEqual(sampleImage);
  expect(await c.repo.listConflicts()).toEqual([]);
});

it('selects a recovered board after an empty legacy-to-RxDB migration', async () => {
  const { cloud, board } = await pair(); const c = await open(cloud);
  await c.repo.db.settings.upsert({ id: 'currentProjectId', value: '' });
  await c.provider.reconcileAll();
  expect((await c.repo.getCurrentProject())?.id).toBe(board.id);
});

it('restores missing same-account boards after the source device is lost despite an unrelated corrupt archive, then retries it safely', async () => {
  const cloud = new DriveFixture(), a = await open(cloud);
  const broken = await a.repo.createProject('Broken archive', 'project');
  const healthy = await a.repo.createProject('Missing board', 'project');
  const historyOnly = await a.repo.createProject('Missing without compatibility snapshot', 'project');
  const card = await a.repo.addItem({ projectId: healthy.id, content: 'Already backed up on A', image: sampleImage });
  for (const board of [broken, healthy, historyOnly]) {
    await a.provider.syncProject(board.id);
    expect(await a.state.get(board.id)).toMatchObject({ status: 'synced', dirty: false });
  }
  const compatibility = cloud.transport('account-a');
  await compatibility.delete((await compatibility.findProjectFile(historyOnly.id))!.id);
  const history = cloud.transport('account-a', 'history-');
  const file = (await history.listProjectFiles()).find(f => f.name.startsWith(`history-${broken.id}_`))!;
  const saved = await history.download(file.id), corrupt = JSON.parse(saved);
  corrupt.changes[0].value.name = 'Unverified change';
  await history.upload(file.name.slice('history-'.length, -'.pboard'.length), JSON.stringify(corrupt), file.id);
  await a.destroy(); // no WebRTC/owner browser is available for recovery
  const b = await open(cloud);
  const local = await b.repo.createProject('Keep local work', 'project');
  await expect(b.provider.reconcileAll()).rejects.toThrow('identity');
  expect(await b.repo.getProject(broken.id)).toBeNull();
  expect(await b.state.get(broken.id)).toMatchObject({ status: 'error', dirty: true });
  expect(await b.repo.getProject(healthy.id)).not.toBeNull();
  expect(await b.repo.getProject(historyOnly.id)).not.toBeNull();
  expect(await b.repo.getProject(local.id)).not.toBeNull();
  expect((await b.repo.getCard(card.id))?.content).toBe('Already backed up on A');
  expect((await b.repo.exportProject(healthy.id)).items.find(c => c.id === card.id)?.image).toEqual(sampleImage);
  const count = await b.repo.journal.entries.count();
  await expect(b.provider.reconcileAll()).rejects.toThrow('identity');
  expect(await b.repo.journal.entries.count()).toBe(count);
  await history.upload(file.name.slice('history-'.length, -'.pboard'.length), saved, file.id);
  await b.provider.reconcileAll();
  expect(await b.repo.getProject(broken.id)).not.toBeNull();
  expect(await b.state.get(broken.id)).toMatchObject({ status: 'synced', dirty: false });
});

it('isolates an unreadable compatibility snapshot without overwriting it or blocking other missing boards', async () => {
  const cloud = new DriveFixture(), a = await open(cloud);
  const broken = await a.repo.createProject('Unreadable snapshot', 'project');
  const healthy = await a.repo.createProject('Independent recovery', 'project');
  await a.provider.syncProject(broken.id); await a.provider.syncProject(healthy.id);
  const transport = cloud.transport('account-a'), file = (await transport.findProjectFile(broken.id))!;
  const saved = await transport.download(file.id);
  await transport.upload(broken.id, 'invalid snapshot', file.id);
  await a.destroy();
  const b = await open(cloud);
  await expect(b.provider.reconcileAll()).rejects.toThrow('incomplete');
  expect(await b.repo.getProject(healthy.id)).not.toBeNull();
  expect(await b.repo.getProject(broken.id)).toBeNull();
  expect(await transport.download(file.id)).toBe('invalid snapshot');
  await transport.upload(broken.id, saved, file.id);
  await b.provider.reconcileAll();
  expect(await b.repo.getProject(broken.id)).not.toBeNull();
});

it('restores account-private boards even when ordering and legacy invitation discovery fail', async () => {
  const cloud = new DriveFixture(), a = await open(cloud);
  const board = await a.repo.createProject('Independent private restore', 'project');
  await a.provider.syncProject(board.id); await a.destroy();
  const b = await open(cloud);
  const history = createPrivateDriveHistory({ transport: cloud.transport('account-a', 'history-'), snapshots: b.snapshots,
    snapshotTransport: cloud.transport('account-a'), getRepository: async () => b.repo, getAccountId: async () => 'account-a' });
  const provider = createGoogleDriveProvider({ auth: b.auth, transport: cloud.transport('account-a'), snapshots: b.snapshots,
    syncState: b.state, tombstones: createDriveTombstoneStore(b.storage), history,
    syncPreferences: async () => { throw new Error('Ordering unavailable'); },
    beforeReconcile: async () => { throw new Error('Legacy invitation discovery unavailable'); } });
  await expect(provider.reconcileAll()).rejects.toThrow('incomplete');
  expect(await b.repo.getProject(board.id)).not.toBeNull();
  expect(await b.state.get(board.id)).toMatchObject({ status: 'synced', dirty: false });
  expect(await b.repo.journal.permissions.get(board.id)).toBeUndefined(); // no authority from login/recovery
});

it('recovers directly from committed history when the compatibility upload never completed', async () => {
  const cloud = new DriveFixture(), a = await open(cloud);
  const board = await a.repo.createProject('History-only recovery', 'project');
  const card = await a.repo.addItem({ projectId: board.id, content: 'Durable without the v1 cache', image: sampleImage });
  const compatibility = { ...cloud.transport('account-a'), upload: async () => { throw new Error('Compatibility upload interrupted'); } };
  const history = createPrivateDriveHistory({ snapshots: a.snapshots, transport: cloud.transport('account-a', 'history-'), snapshotTransport: compatibility,
    getRepository: async () => a.repo, getAccountId: async () => 'account-a' });
  const provider = createGoogleDriveProvider({ auth: a.auth, transport: cloud.transport('account-a'), snapshots: a.snapshots, history,
    syncState: a.state, tombstones: createDriveTombstoneStore(a.storage) });
  await expect(provider.syncProject(board.id)).rejects.toThrow('Compatibility upload interrupted');
  expect(cloud.snapshots('account-a')).toEqual([]); expect(cloud.histories('account-a').length).toBeGreaterThan(0);
  await a.destroy();
  const b = await open(cloud); const recovered = await b.provider.pullProject(board.id);
  expect(recovered?.items.find(item => item.id === card.id)).toMatchObject({ content: 'Durable without the v1 cache', image: sampleImage });
});

it('automatically merges independent private fields by common ancestry, and converges under repeated recovery', async () => {
  const { cloud, a, b, board, first } = await pair();
  await a.repo.updateItem(first.id, { title: 'A title' }); await b.repo.updateItem(first.id, { content: 'B content' });
  await a.provider.syncProject(board.id); await b.provider.syncProject(board.id); await a.provider.reconcileAll();
  for (const device of [a, b]) await device.provider.reconcileAll();
  for (const device of [a, b]) expect(await device.repo.getCard(first.id)).toMatchObject({ title: 'A title', content: 'B content' });
  const before = cloud.histories('account-a').length;
  await a.provider.reconcileAll(); await b.provider.reconcileAll();
  expect(cloud.histories('account-a')).toHaveLength(before);
  expect(await a.repo.listConflicts()).toEqual([]);
});

it('persists conflicting text, parallel drafts and an explicit resolution through Drive without any surviving peer', async () => {
  const { cloud, a, b, board, first } = await pair();
  await a.repo.updateItem(first.id, { content: 'A variant' }); await b.repo.updateItem(first.id, { content: 'B variant' });
  await a.provider.syncProject(board.id); await b.provider.syncProject(board.id); await a.provider.reconcileAll();
  const conflict = (await a.repo.listConflicts()).find(c => c.documentId === first.id)!;
  expect(conflict.result.variants.map(v => v.value.content).sort()).toEqual(['A variant', 'B variant']);
  for (const writerId of ['a-window', 'b-window']) await a.repo.saveConflictDraft(conflict, { writerId, heads: conflict.result.heads,
    variantId: conflict.result.heads[0], title: writerId, content: `Unfinished ${writerId}` });
  await a.state.markDirty(board.id); await a.provider.syncProject(board.id);
  expect(await a.state.get(board.id)).toMatchObject({ dirty: false, status: 'synced' });
  expect((await a.repo.listConflicts()).some(c => c.documentId === first.id)).toBe(true);
  await a.destroy(); await b.destroy();
  const c = await open(cloud); await c.provider.reconcileAll();
  const restored = (await c.repo.listConflicts()).find(entry => entry.documentId === first.id)!;
  expect(restored.result.variants).toHaveLength(2); expect(restored.drafts.map(d => d.content).sort()).toEqual(['Unfinished a-window', 'Unfinished b-window']);
  await c.repo.resolveConflict({ ...restored, heads: restored.result.heads, variantId: restored.result.heads[0], edits: { title: 'Reviewed', content: 'Reviewed resolution' } });
  await c.provider.syncProject(board.id); await c.destroy();
  const d = await open(cloud); await d.provider.reconcileAll();
  expect((await d.repo.getCard(first.id))?.content).toBe('Reviewed resolution');
  expect((await d.repo.listConflicts()).filter(c => c.documentId === first.id)).toEqual([]);
  expect((await d.repo.journal.entries.toArray()).filter(c => ['A variant', 'B variant'].includes(String(c.value.content)))).toHaveLength(2);
});

it('keeps edit/delete variants, restores tombstones, and does not resurrect an acknowledged ancestor', async () => {
  const { cloud, a, b, board, first } = await pair();
  await a.repo.deleteItem(first.id); await b.repo.updateItem(first.id, { content: 'Concurrent edit' });
  await a.provider.syncProject(board.id); await b.provider.syncProject(board.id); await a.provider.reconcileAll();
  const conflict = (await a.repo.listConflicts()).find(c => c.documentId === first.id)!;
  expect(conflict.result.reason).toBe('concurrent-delete');
  const deletion = conflict.result.variants.find(v => v.value.deletedAt)!;
  await a.repo.resolveConflict({ ...conflict, heads: conflict.result.heads, variantId: deletion.id });
  await a.provider.syncProject(board.id); await b.provider.reconcileAll();
  expect(await b.repo.getCard(first.id)).toBeNull();
  await a.destroy(); await b.destroy(); const c = await open(cloud); await c.provider.reconcileAll();
  expect(await c.repo.getCard(first.id)).toBeNull();
  expect((await c.repo.reconciliation.inspect({ boardId: board.id, collection: 'cards', documentId: first.id })).kind).toBe('deleted');
});

it('retains independent additions and monotonic append metadata rather than creating an ordering conflict', async () => {
  const { a, b, board } = await pair();
  const aa = await a.repo.addItem({ projectId: board.id, content: 'A addition' }); const bb = await b.repo.addItem({ projectId: board.id, content: 'B addition' });
  await a.provider.syncProject(board.id); await b.provider.syncProject(board.id); await a.provider.reconcileAll();
  expect((await a.repo.listCards(board.id)).map(c => c.id)).toEqual(expect.arrayContaining([aa.id, bb.id]));
  expect(await a.repo.listConflicts()).toEqual([]);
});

it('preserves old-client snapshots as unknown branches while retaining existing local edits and absent cards', async () => {
  const { cloud, a, board, first, second } = await pair();
  await a.repo.updateItem(first.id, { content: 'Unsynchronized local edit' });
  const old = cloud.snapshots('account-a')[0]; old.items = old.items.filter(i => i.id === first.id); old.items[0].content = 'Old client edit';
  old.project.updatedAt = '2099-01-01T00:00:00Z';
  const transport = cloud.transport('account-a'), file = (await transport.findProjectFile(board.id))!;
  await transport.upload(board.id, JSON.stringify(old), file.id);
  await a.provider.reconcileAll();
  expect(await a.repo.getCard(second.id)).not.toBeNull();
  const retained = (await a.repo.listConflicts()).find(c => c.documentId === first.id)!;
  expect(retained.result.variants.map(v => v.value.content)).toEqual(expect.arrayContaining(['Unsynchronized local edit', 'Old client edit']));
});

it('rejects corrupt history without applying its projection or acknowledging it', async () => {
  const { cloud, a, board, first } = await pair();
  const transport = cloud.transport('account-a', 'history-'), file = (await transport.listProjectFiles())[0];
  const contents = JSON.parse(await transport.download(file.id)); contents.changes[0].value.name = 'Tampered';
  await transport.upload(file.name.slice('history-'.length, -'.pboard'.length), JSON.stringify(contents), file.id);
  const before = await a.repo.exportProject(board.id);
  await expect(a.provider.reconcileAll()).rejects.toThrow(/identity/);
  expect(await a.repo.exportProject(board.id)).toEqual(before); expect((await a.repo.getCard(first.id))?.content).toBe('Base one');
});

it('rejects cross-board graph references even inside a correctly content-addressed private file', async () => {
  const { cloud, a, board, first } = await pair();
  const root = (await a.repo.reconciliation.inspect({ boardId: board.id, collection: 'cards', documentId: first.id })).variants[0];
  const wrong = await makeChange({ boardId: 'foreign', collection: 'cards', documentId: first.id, ancestry: 'known', parents: [root.id], value: { ...root.value, projectId: 'foreign' } });
  const bundle = { format: 'pboard-private-history', version: 1, boardId: board.id, changes: [wrong], images: [], drafts: [], snapshots: [] };
  const contents = canonicalize(bundle as unknown as Json), hash = await hashBlob(new Blob([contents]));
  await cloud.transport('account-a', 'history-').upload(`${board.id}_${hash}`, contents);
  await expect(a.provider.reconcileAll()).rejects.toThrow('cross-board');
});

it('protects an established board/account binding and keeps another account private', async () => {
  const { cloud, a, board } = await pair();
  await expect(a.providerFor('account-b').reconcileAll()).rejects.toThrow('another private Drive account');
  expect(cloud.histories('account-b')).toEqual([]); expect(cloud.snapshots('account-b')).toEqual([]);
  expect(await a.repo.getProject(board.id)).not.toBeNull();
});

it('uses the captured account transport if the global account changes during an upload', async () => {
  const cloud = new DriveFixture(), a = await open(cloud); const board = await a.repo.createProject('Session-bound bytes', 'project');
  let identity = 'account-a';
  const history = createPrivateDriveHistory({ snapshots: a.snapshots, transport: cloud.transport('account-a', 'history-'), getRepository: async () => a.repo,
    getAccountId: async () => identity, captureSession: async () => ({ account: identity, history: cloud.transport(identity, 'history-'), snapshots: cloud.transport(identity) }) });
  const provider = createGoogleDriveProvider({ auth: a.auth, transport: cloud.transport('account-a'), snapshots: a.snapshots, syncState: a.state,
    tombstones: createDriveTombstoneStore(a.storage), history });
  const hold = cloud.pauseNext('upload'), writing = provider.syncProject(board.id); await hold.started;
  identity = 'account-b'; hold.release(); await writing;
  expect(cloud.histories('account-a')).toHaveLength(1); expect(cloud.histories('account-b')).toEqual([]);
  expect(await a.state.get(board.id)).toMatchObject({ dirty: true });
});

it('retains new local edits made during a held history upload and delivers them on retry', async () => {
  const { cloud, a, board, first, second } = await pair();
  await a.repo.updateItem(first.id, { content: 'Before upload' });
  const hold = cloud.pauseNext('upload'), sending = a.provider.syncProject(board.id); await hold.started;
  try { await a.repo.updateItem(second.id, { content: 'While upload was held' }); } finally { hold.release(); }
  await sending; expect(await a.state.get(board.id)).toMatchObject({ dirty: true });
  await a.restart(); await a.provider.syncProject(board.id);
  const c = await open(cloud); await c.provider.reconcileAll();
  expect((await c.repo.getCard(second.id))?.content).toBe('While upload was held');
});

it('never performs account HTTP verification while materialization holds the local command queue', async () => {
  const { cloud, board } = await pair(); const c = await open(cloud);
  let materializing = false;
  const apply = c.repo.privateRecovery.apply.bind(c.repo.privateRecovery);
  vi.spyOn(c.repo.privateRecovery, 'apply').mockImplementation(async (...args) => {
    materializing = true; try { return await apply(...args); } finally { materializing = false; }
  });
  const history = createPrivateDriveHistory({ snapshots: c.snapshots, transport: cloud.transport('account-a', 'history-'),
    snapshotTransport: cloud.transport('account-a'), getRepository: async () => c.repo,
    getAccountId: async () => { expect(materializing).toBe(false); return 'account-a'; } });
  await history.sync(board.id, cloud.snapshots('account-a'), async () => true);
  expect(await c.repo.getProject(board.id)).not.toBeNull();
});

it('does not clear a new edit made between history completion and the compatibility upload', async () => {
  const { cloud, a, board, first } = await pair();
  const history = createPrivateDriveHistory({ snapshots: a.snapshots, transport: cloud.transport('account-a', 'history-'),
    snapshotTransport: cloud.transport('account-a'), getRepository: async () => a.repo, getAccountId: async () => 'account-a' });
  const sync = history.sync.bind(history); let injected = false;
  vi.spyOn(history, 'sync').mockImplementation(async (...args) => {
    const bound = await sync(...args);
    if (!injected) { injected = true; await a.repo.updateItem(first.id, { content: 'After history commit' }); }
    return bound;
  });
  const provider = createGoogleDriveProvider({ auth: a.auth, transport: cloud.transport('account-a'), snapshots: a.snapshots,
    syncState: a.state, tombstones: createDriveTombstoneStore(a.storage), history });
  await provider.reconcileAll();
  expect(await a.state.get(board.id)).toMatchObject({ dirty: true });
  await a.provider.syncProject(board.id); expect(await a.state.get(board.id)).toMatchObject({ dirty: false });
});

it('does not resurrect a causally deleted board from its stale compatibility snapshot', async () => {
  const { cloud, a, b, board } = await pair();
  await a.repo.deleteProject(board.id); await a.provider.reconcileAll();
  await b.provider.reconcileAll(); expect(await b.repo.getProject(board.id)).toBeNull();
  await a.destroy(); await b.destroy();
  const c = await open(cloud); await c.provider.reconcileAll();
  expect(await c.repo.getProject(board.id)).toBeNull();
  expect((await c.repo.reconciliation.inspect({ boardId: board.id, collection: 'projects', documentId: board.id })).kind).toBe('deleted');
});

it('recovers a hidden board deletion conflict into the archive without making the board visible', async () => {
  const { cloud, a, b, board, first } = await pair();
  await b.repo.updateItem(first.id, { content: 'Concurrent surviving work' });
  await a.repo.deleteProject(board.id); await a.provider.reconcileAll(); await b.provider.syncProject(board.id);
  const c = await open(cloud);
  const history = createPrivateDriveHistory({ snapshots: c.snapshots, transport: cloud.transport('account-a', 'history-'), snapshotTransport: cloud.transport('account-a'),
    getRepository: async () => c.repo, getAccountId: async () => 'account-a' });
  const provider = createGoogleDriveProvider({ auth: c.auth, snapshots: c.snapshots, transport: cloud.transport('account-a'), history,
    syncState: c.state, tombstones: createDriveTombstoneStore(c.storage), isDeletedProject: async () => true });
  await provider.reconcileAll();
  expect(await c.repo.getProject(board.id)).toBeNull();
  const conflict = (await c.repo.listConflicts()).find(c => c.collection === 'projects')!;
  expect(conflict.result.reason).toBe('concurrent-delete'); expect(conflict.restriction).toContain('Restore this board');
});


it('preserves detached author proofs through private backup and fresh-device recovery without restoring authority', async () => {
  const cloud = new DriveFixture();
  const a = await open(cloud), board = await a.repo.createProject('Proof backup', 'project');
  await a.grants.configure({ provider: 'websocket', url: 'wss://fixture.example.test/ws' }); await a.grants.initialize(board.id);
  const security = (await a.grants.security(board.id))!;
  const { installLiveBoardMutations } = await import('../../src/collab/security/liveMutations');
  const { verifyJournalChange } = await import('../../src/collab/security/journalProof');
  const guard = await installLiveBoardMutations({ projectId: board.id, cards: a.repo.db.cards, projects: a.repo.db.projects, security, attestExisting: true });
  const card = await a.repo.addItem({ projectId: board.id, content: 'Signed recovery' });
  const source = (await a.repo.journal.entries.toArray()).find(e => e.documentId === card.id)!;
  await a.provider.syncProject(board.id); await guard.uninstall(); await a.destroy();
  const b = await open(cloud); await b.provider.reconcileAll();
  const restored = (await b.repo.journal.entries.get(source.id))!;
  expect(restored.proof).toEqual(source.proof); await verifyJournalChange(restored, restored.proof, security);
  expect(await b.grants.ownsAuthority(board.id)).toBe(false); expect(await b.grants.localBundle(board.id)).toBeNull();
});

it('syncs the selected board without downloading another board’s history', async () => {
  const cloud = new DriveFixture(), source = await openDevice(cloud); devices.push(source);
  const selected = await source.repo.createProject('Selected manual board', 'project');
  const other = await source.repo.createProject('Unrelated board', 'project');
  await source.repo.addItem({ projectId: selected.id, content: 'Selected content' });
  await source.repo.addItem({ projectId: other.id, content: 'Unrelated history' });
  await source.provider.syncProject(selected.id); await source.provider.syncProject(other.id);
  const transport = cloud.transport('account-a', 'history-');
  const unrelated = new Set((await transport.listProjectFiles()).filter(file => file.name.startsWith(`history-${other.id}_`)).map(file => file.id));
  expect(unrelated.size).toBeGreaterThan(0);
  const download = vi.fn(async (id: string) => {
    if (unrelated.has(id)) throw new Error('Unrelated history must not block selected-board synchronization');
    return transport.download(id);
  });
  const history = createPrivateDriveHistory({ transport: { ...transport, download }, snapshots: source.snapshots,
    getRepository: async () => source.repo, getAccountId: async () => 'account-a', snapshotTransport: cloud.transport('account-a') });
  await expect(history.sync(selected.id, [], async () => true)).resolves.not.toBeNull();
  expect(download).toHaveBeenCalled();
  expect(download.mock.calls.every(([id]) => !unrelated.has(id))).toBe(true);
});

// The user-reported same-account asymmetry: two browsers on one Google
// account share the private history chain, so the second browser's
// private-backup capture seeds `baseline` journal roots. When the first
// browser later deletes a card, those unproven roots must rebaseline against
// the verified author chain silently — like cross-browser bootstrap residue —
// instead of parking a "Conflict requires resolution" panel on a board where
// nobody authored a competing edit.
it('replicates a signed card delete to a second same-account browser without a conflict panel', async () => {
  const cloud = new DriveFixture(), a = await open(cloud), b = await open(cloud);
  const board = await a.repo.createProject('Signed two-browser board', 'project');
  const legacy = await a.repo.addItem({ projectId: board.id, content: 'Created before sharing' });
  await a.provider.syncProject(board.id);
  await b.provider.reconcileAll(); // B holds the card with baseline capture residue only.
  const keyA = await generateDeviceKey(), keyB = await generateDeviceKey();
  const payload = { protocol: 2 as const, boardId: board.id, driveProjectFileId: '', driveFolderId: '',
    authorityKeyId: keyA.keyId, epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: keyA.keyId, publicKey: keyA.publicJwk, role: 'owner' as const }, { deviceKeyId: keyB.keyId, publicKey: keyB.publicJwk, role: 'editor' as const }] };
  const manifest = await verifyManifest(await signManifest(payload, { privateJwk: keyA.privateJwk }), keyA.publicJwk, keyA.keyId);
  const securityA = { boardId: board.id, manifest, signer: { deviceKeyId: keyA.keyId, privateJwk: keyA.privateJwk }, ownSessionId: 'session-a' };
  const securityB = { boardId: board.id, manifest, signer: { deviceKeyId: keyB.keyId, privateJwk: keyB.privateJwk }, ownSessionId: 'session-b' };
  const guardA = await installLiveBoardMutations({ projectId: board.id, cards: a.repo.db.cards, projects: a.repo.db.projects, security: securityA, attestExisting: true });
  await a.repo.updateItem(legacy.id, { content: 'Edited after sharing' });
  await a.provider.syncProject(board.id);
  await b.provider.reconcileAll();
  // B's document bytes drift from the signed chain (pre-seal snapshot era):
  // exactly the state where B's private-backup capture seeds a `baseline`
  // journal root for the card.
  const doc = (await b.repo.db.cards.findOne(legacy.id).exec())!;
  await withUntrustedImport([b.repo.db.cards], async () => {
    await doc.incrementalPatch({ _sec: null as never, updatedAt: new Date(Date.now() - 60000).toISOString() });
  });
  await b.repo.privateRecovery.capture(board.id);
  await installLiveBoardMutations({ projectId: board.id, cards: b.repo.db.cards, projects: b.repo.db.projects, security: securityB });
  expect(await b.repo.listConflicts()).toEqual([]);
  // The author deletes; the second browser replicates through Drive history.
  await a.repo.deleteItem(legacy.id);
  await a.provider.syncProject(board.id);
  await b.provider.reconcileAll();
  expect(await b.repo.listConflicts()).toEqual([]);
  expect((await b.repo.getCard(legacy.id))).toBeNull();
  expect((await b.repo.db.cards.findOne(legacy.id).exec())?.toJSON().deletedAt).toBeTruthy();
  expect((await b.repo.reconciliation.inspect({ boardId: board.id, collection: 'cards', documentId: legacy.id })).kind).toBe('deleted');
  expect(await a.repo.listConflicts()).toEqual([]);
  await guardA.uninstall();
});
