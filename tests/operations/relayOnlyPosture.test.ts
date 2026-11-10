import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveRuntime } from '../../src/sync/runtime';
import { createRxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { LocalOperationStore } from '../../src/sync/operations/localStore';
import { createOperationService } from '../../src/sync/operations/service';
import { OperationSession } from '../../src/sync/operations/session';
import { setWebRtcDisabled } from '../../src/collab/liveTransport';
import type { Command } from '../../src/sync/operations/protocol';
import { ImmutableDriveFake } from './driveFake';
import { DriveStub } from '../sync/driveStub';
import type { DriveBoardStore } from '../../src/sync/driveBoardStore';

/**
 * The relay-only development posture with a relay that cannot serve the board
 * (production today: an old binary with no key courier and no operation log).
 * The invariant these tests pin: the board must *degrade honestly* — edits
 * ride Drive synchronization, the status text carries the reason, and no path
 * re-drives relay work per synchronization round. The pre-fix world these
 * replace: the edit lands empty-looking under a "Synchronization pending"
 * heading that never drains, while the relay journal logs an identity
 * enrolment every five seconds.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  setWebRtcDisabled(false);
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. The service never re-runs a realtime factory that is refusing (the
//    repeated-handshake half of the production churn).
// ---------------------------------------------------------------------------

async function bareService(fake: ImmutableDriveFake, layout: { folderId: string | null; projectFileId: string | null }, extra: Partial<Parameters<typeof createOperationService>[0]> = {}) {
  const name = `pboardrelayonly${crypto.randomUUID().replaceAll('-', '')}`;
  const rx = await createRxRepository({ name, offlineDrafts: false, blobs: createIndexedDbBlobStore(`${name}images`) });
  const auth = { getAccessToken: async () => 'test', getConnectionState: async (): Promise<'connected'> => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} };
  const service = createOperationService({ auth, fetcher: fake.fetch, getRepository: async () => rx,
    store: { boardFolder: async () => 'folder', snapshotFileId: async () => null } as unknown as DriveBoardStore,
    sharedLayout: async () => layout, recordLayout: async (_, folderId, projectFileId) => { Object.assign(layout, { folderId, projectFileId }); }, stopLegacy: async () => {}, ...extra });
  cleanup.push(async () => { for (const board of rx.operationSource.bindings.keys()) await service.close(board); await rx.db.close(); });
  return { rx, service };
}

it('runs a refusing realtime factory once across repeated enables, retrying only after the backoff window', async () => {
  const layout = { folderId: null as string | null, projectFileId: null as string | null };
  let calls = 0;
  let succeed = false;
  const failing = await bareService(new ImmutableDriveFake(), layout, {
    realtime: async () => { calls++; throw new Error('Board grant service unavailable (HTTP 404). No Google or unrestricted fallback is used.'); },
    realtimeRetryBaseMs: 1_000,
  });
  // A failure clears on success: the retry delay resets once the board attaches.
  const healthyLayout = { folderId: null as string | null, projectFileId: null as string | null };
  const healthy = await bareService(new ImmutableDriveFake(), healthyLayout, {
    realtime: async () => { if (succeed) return { broadcast: async () => true, close: async () => {} }; calls++; throw new Error('still down'); },
    realtimeRetryBaseMs: 1_000,
  });
  const projectA = await failing.rx.createProject('Backoff board', 'project');
  const projectB = await healthy.rx.createProject('Healthy board', 'project');
  await failing.service.sync(projectA.id, true);
  await healthy.service.sync(projectB.id, true);
  const session = await failing.service.open(projectA.id);
  const healthySession = await healthy.service.open(projectB.id);
  vi.useFakeTimers();
  // Four role passes/synchronizations inside the window: the first attach
  // attempt ran, the rest must be refused from the recorded failure without
  // touching the factory — previously every one of them repeated the whole
  // bootstrap (and on production, the journal-enrolling network handshake).
  for (let attempt = 0; attempt < 4; attempt++) await session.setRealtime(true).catch(() => undefined);
  expect(calls).toBe(1);
  // After the window, one retry — the failure must not latch permanently.
  await vi.advanceTimersByTimeAsync(1_000);
  await session.setRealtime(true).catch(() => undefined);
  expect(calls).toBe(2);
  await healthySession.setRealtime(true).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(1_000);
  succeed = true;
  await healthySession.setRealtime(true);
  await healthySession.setRealtime(false);
  const beforeDisable = calls;
  await healthySession.setRealtime(true);
  expect(calls).toBe(beforeDisable);
});

// ---------------------------------------------------------------------------
// 2. The session itself ignores redundant enables (no close/re-open storm on
//    the healthy path, no epoch churn from a per-round `setRealtime(true)`).
// ---------------------------------------------------------------------------

const board: Command = { collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Board', template: 'project', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, unset: [] };
const card: Command = { collection: 'cards', entityId: 'card', kind: 'create', fields: { content: 'Initial', type: 'task', status: 'candidate', orderKey: 'a0', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, unset: [] };
const patch = (fields: Command['fields']): Command => ({ collection: 'cards', entityId: 'card', kind: 'patch', fields, unset: [] });

async function sessionClient(fake = new ImmutableDriveFake(), hooks: Partial<ConstructorParameters<typeof OperationSession>[0]> = {}) {
  const name = crypto.randomUUID();
  const journal = new ChangeJournal(name); await journal.open();
  const local = new LocalOperationStore(journal);
  const session = new OperationSession({ boardId: 'board', local, drive: fake.store(), role: async () => fake.role, batchDelayMs: 60_000, ...hooks });
  cleanup.push(async () => { await session.close(); journal.close(); });
  await session.open();
  return { fake, local, session };
}

it('treats a repeated setRealtime as no work and re-attempts after a failed one', async () => {
  const enabled: boolean[] = [];
  let fail = true;
  const { session } = await sessionClient(new ImmutableDriveFake(), { setRealtimeEnabled: async (value: boolean) => { enabled.push(value); if (value && fail) throw new Error('factory down'); } });
  await session.setRealtime(true).catch(() => undefined);
  await session.setRealtime(true).catch(() => undefined); // still off — must actually retry
  expect(enabled).toEqual([true, true]);
  fail = false;
  await session.setRealtime(true);            // now attached
  await session.setRealtime(true);            // no-op: no second transport
  expect(enabled).toEqual([true, true, true]);
  await session.setRealtime(false);
  await session.setRealtime(false);           // already off — no work
  expect(enabled).toEqual([true, true, true, false]);
});

// ---------------------------------------------------------------------------
// 3. Hypothesis 3 guard: an ordinary create → content → confirm → delete
//    sequence is fully known vocabulary. A skip in it would pin every
//    snapshot and compaction (the skip ledger refuses while non-empty),
//    which is exactly the "pending forever" shape — so its emptiness is a
//    precondition of the degrade, asserted here for the log path.
// ---------------------------------------------------------------------------

it('skips nothing for a normal create, content edit, confirm, and delete sequence', async () => {
  const { fake, session } = await sessionClient();
  await session.edit(board); await session.edit(card); await session.sync();
  await session.edit(patch({ content: 'Typed into the card' }));
  await session.edit(patch({ status: 'confirmed' }));
  await session.edit({ collection: 'cards', entityId: 'card', kind: 'delete', fields: {}, unset: [] });
  await session.sync();
  const b = await sessionClient(fake);
  await b.session.sync(true);
  expect(b.session.state().cards).toHaveLength(0);
  expect(b.session.state().project?.name).toBe('Board');
  // `prepareLogSnapshot` refuses while the skip ledger is non-empty; resolving
  // it here is the assertion that nothing in the sequence was skipped.
  const { snapshot } = await b.session.prepareLogSnapshot();
  expect(Object.keys(snapshot.checkpoint.receipts).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 4. Symptom 1+2 at the repository: with `offlineDrafts: false` (the operation
//    composition roots) an edit to a board that still carries a grant row is
//    written for real and drained by Drive synchronization — never parked as
//    pending work nothing can admit.
// ---------------------------------------------------------------------------

async function relayProfile(stub: DriveStub, data: Record<string, unknown>, relayRequests: string[]) {
  const name = `pboardrelayprofile${crypto.randomUUID().replaceAll('-', '')}`;
  const rx = await createRxRepository({ name, offlineDrafts: false, blobs: createIndexedDbBlobStore(`${name}images`) });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(typeof input === 'string' ? input : input instanceof Request ? input.url : input));
    // Everything that is not Drive is the relay: the explicit setting points
    // at `relay.invalid`, while an unresolved posture resolves to the
    // compiled rendezvous host — both must be observable and both are down.
    if (!url.host.endsWith('googleapis.com')) {
      relayRequests.push(`${String(init?.method ?? 'GET')} ${url.host}${url.pathname}`);
      return new Response('{"error":"not_found"}', { status: 404 });
    }
    return await stub.fetch(url, init);
  };
  const runtime = createDriveRuntime({
    auth: { getAccessToken: async () => 'token', getConnectionState: async () => 'connected', isConfigured: () => true, connect: async () => {}, disconnect: async () => {} },
    storage: { get: async (key: string) => ({ [key]: structuredClone(data[key]) }), set: async value => { Object.assign(data, structuredClone(value)); } },
    getRepository: async () => rx, fetcher: fetcher as typeof fetch,
  });
  cleanup.push(async () => {
    await runtime.collaborationManager.stop();
    for (const id of rx.operationSource.bindings.keys()) await runtime.operationService.close(id);
    await rx.db.close();
  });
  return { runtime, rx };
}

it('writes through and drains Drive synchronization instead of parking never-admissible drafts', async () => {
  const drive = new DriveStub();
  drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const dataA: Record<string, unknown> = {}, relayA: string[] = [];
  const a = await relayProfile(drive, dataA, relayA);
  const project = await a.rx.createProject('Courier-less relay board', 'project');
  const card = await a.rx.addItem({ projectId: project.id, content: 'Created while the relay is down' });
  await a.runtime.googleDrive.syncProject(project.id, { force: true });
  // The state that used to strand everything: the board carries a grant row
  // (a previous authorization experiment left one) while no live board role
  // exists in this build.
  await a.rx.journal.permissions.put({ id: project.id, role: 'editor', deviceKeyId: 'k'.repeat(43), authorityKeyId: 'a'.repeat(43) });
  await a.rx.updateItem(card.id, { content: 'Edited while unbound' });
  expect((await a.rx.listCards(project.id))[0].content).toBe('Edited while unbound');
  // Drive-first: the edit and the delete travel through the ordinary journal
  // and reach the other browser on its next reconciliation.
  await a.runtime.googleDrive.syncProject(project.id, { force: true });
  const dataB: Record<string, unknown> = {}, relayB: string[] = [];
  const b = await relayProfile(drive, dataB, relayB);
  await b.runtime.googleDrive.reconcileAll({ force: true });
  expect((await b.rx.listCards(project.id))[0].content).toBe('Edited while unbound');
  await a.rx.deleteItem(card.id);
  expect(await a.rx.journal.pendingEdits.count()).toBe(0);
  await a.runtime.googleDrive.syncProject(project.id, { force: true });
  await b.runtime.googleDrive.reconcileAll({ force: true });
  expect(await b.rx.listCards(project.id)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 5. Symptom 3 (board propagation) under each provider resolution, and the
//    single source of truth: with the posture on and nothing stored, the
//    realtime path must consult the relay exactly like an explicitly-stored
//    websocket selection does — not silently take the stub the raw stored
//    read implied.
// ---------------------------------------------------------------------------

it('propagates a board created under the posture to the other browser with its content', async () => {
  const drive = new DriveStub();
  drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  for (const settings of [undefined, { provider: 'websocket', url: 'wss://relay.invalid/ws' }] as const) {
    const dataA: Record<string, unknown> = {}, dataB: Record<string, unknown> = {}, relayA: string[] = [], relayB: string[] = [];
    if (settings) dataA.pboardCollaborationSettings = structuredClone(settings);
    const a = await relayProfile(drive, dataA, relayA);
    const b = await relayProfile(drive, dataB, relayB);
    const project = await a.rx.createProject('Visible on the other browser?', 'project');
    await a.rx.addItem({ projectId: project.id, content: 'Typed before any browser was authorized' });
    await a.runtime.googleDrive.syncProject(project.id, { force: true });
    await b.runtime.googleDrive.reconcileAll({ force: true });
    expect(await b.rx.getProject(project.id)).not.toBeNull();
    expect((await b.rx.listCards(project.id))[0]?.content).toBe('Typed before any browser was authorized');
  }
});

it('reports missing Drive identity and avoids relay requests without credentials', async () => {
  setWebRtcDisabled(true);
  const drive = new DriveStub();
  drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const data: Record<string, unknown> = { pboardCollaborationSettings: { provider: 'websocket', url: 'wss://relay.invalid/ws' } };
  const relayRequests: string[] = [];
  const a = await relayProfile(drive, data, relayRequests);
  const project = await a.rx.createProject('Posture board', 'project');
  await a.rx.addItem({ projectId: project.id, content: 'Typed while the relay is down' });
  await a.runtime.googleDrive.syncProject(project.id, { force: true });
  // The board cannot get a live channel. Starting must not fail the board —
  // Drive delivery is unaffected — but the status text must say why, instead
  // of claiming to wait for another browser.
  await a.runtime.collaborationManager.start(project.id);
  expect(a.runtime.collaborationManager.state().error).toContain('Google Drive identity credentials are required');
  // Missing credentials are rejected before sending anything to the relay.
  expect(relayRequests).toHaveLength(0);
  const requestsAfterStart = relayRequests.length;
  for (let round = 0; round < 3; round++) await a.runtime.collaborationManager.refreshRole().catch(() => undefined);
  expect(relayRequests.length).toBe(requestsAfterStart);
  // The same identity requirement applies when the posture is not stored.
  const bareData: Record<string, unknown> = {}, bareRelay: string[] = [];
  const bare = await relayProfile(drive, bareData, bareRelay);
  const bareProject = await bare.rx.createProject('Nothing stored', 'project');
  await bare.runtime.googleDrive.syncProject(bareProject.id, { force: true });
  await bare.runtime.collaborationManager.start(bareProject.id).catch(() => undefined);
  expect(bareRelay).toHaveLength(0);
  expect(bare.runtime.collaborationManager.state().error).toContain('Google Drive identity credentials are required');
});

// ---------------------------------------------------------------------------
// 6. The viewer gate survives `offlineDrafts: false`. The draft wrapper's
//    short-circuit skips only draft *routing*; every base command still runs
//    `assertCanMutate`, whose erasure/revoked/viewer throws sit before the
//    one line the option gates. Each refusal must leave the board byte-equal —
//    a rejected edit is never re-queued as something admission may later trust.
// ---------------------------------------------------------------------------

it('refuses every viewer mutation in the operation build without queueing it', async () => {
  const drive = new DriveStub();
  drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const data: Record<string, unknown> = {}, relay: string[] = [];
  const a = await relayProfile(drive, data, relay);
  const project = await a.rx.createProject('Viewer gate board', 'project');
  const card = await a.rx.addItem({ projectId: project.id, content: 'Original content' });
  const other = await a.rx.addItem({ projectId: project.id, content: 'Merge target' });
  // The viewer grant row: exactly what a Drive viewer's import leaves behind.
  await a.rx.journal.permissions.put({ id: project.id, role: 'viewer', deviceKeyId: 'k'.repeat(43), authorityKeyId: 'a'.repeat(43) });
  await expect(a.rx.addItem({ projectId: project.id, content: 'Viewer add' })).rejects.toThrow(/view-only/);
  await expect(a.rx.updateItem(card.id, { content: 'Viewer edit' })).rejects.toThrow(/view-only/);
  await expect(a.rx.deleteItem(card.id)).rejects.toThrow(/view-only/);
  await expect(a.rx.duplicateItem(card.id)).rejects.toThrow(/view-only/);
  await expect(a.rx.mergeItems(card.id, other.id)).rejects.toThrow(/view-only/);
  await expect(a.rx.renameProject(project.id, 'Renamed by viewer')).rejects.toThrow(/view-only/);
  await expect(a.rx.changeProjectTemplate(project.id, 'project')).rejects.toThrow(/view-only/);
  await expect(a.rx.reorderItems(project.id, [other.id, card.id])).rejects.toThrow(/view-only/);
  await expect(a.rx.moveItem(project.id, card.id, [other.id])).rejects.toThrow(/view-only/);
  await expect(a.rx.rebalanceProject(project.id)).rejects.toThrow(/view-only/);
  await expect(a.rx.emptyTrash(project.id)).rejects.toThrow(/view-only/);
  // `resolveConflict` is deliberately not exercised here: its gate is
  // `restriction()` calling this same `assertCanMutate` (view-only answers
  // "an authorized editor must resolve this conflict"), reaching it requires
  // a live journal conflict, and operation-bound boards are excluded from
  // conflict listing entirely (`api.listConflicts` filters by binding).
  // Nothing was written, queued, or staged for later admission.
  expect(await a.rx.journal.pendingEdits.count()).toBe(0);
  expect((await a.rx.listCards(project.id)).map(card => card.content).sort()).toEqual(['Merge target', 'Original content']);
  expect((await a.rx.getProject(project.id))?.name).toBe('Viewer gate board');
  // A viewer may still *leave* (hide their own copy); that is the documented
  // non-owner delete and it must not erase the board's content.
  await a.rx.deleteProject(project.id);
  expect(await a.rx.journal.boardErasure(project.id)).toBeFalsy();
  expect(await a.rx.journal.pendingEdits.count()).toBe(0);
});

it('cannot mutate an unbound board into a state that later reads as authorized', async () => {
  const drive = new DriveStub();
  drive.defaultPermissions = [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }];
  const data: Record<string, unknown> = {}, relay: string[] = [];
  const a = await relayProfile(drive, data, relay);
  const project = await a.rx.createProject('Unbound then granted', 'project');
  const card = await a.rx.addItem({ projectId: project.id, content: 'Written unbound' });
  await a.rx.updateItem(card.id, { content: 'Edited unbound' });
  // The authorization machinery only ever admits pending-edit drafts; the
  // operation build creates none, so a grant appearing afterwards has nothing
  // to admit and these ordinary Drive-first writes stay ordinary local journal
  // changes — they can never surface as if signed under the new authority.
  await a.rx.journal.permissions.put({ id: project.id, role: 'editor', deviceKeyId: 'k'.repeat(43), authorityKeyId: 'a'.repeat(43) });
  expect(await a.rx.journal.pendingEdits.count()).toBe(0);
  expect((await a.rx.journal.pendingEdits.toArray()).some(e => e.admittedChangeId)).toBe(false);
  expect((await a.rx.listCards(project.id))[0].content).toBe('Edited unbound');
});
