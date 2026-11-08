import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instantAuthBudget } from '../helpers/authBudget';
import type { Json } from '../../src/collab/security/canonical';
import { ChangeJournal } from '../../src/storage/changeJournal';
import { LocalOperationStore } from '../../src/sync/operations/localStore';
import { OperationSession } from '../../src/sync/operations/session';
import { OperationEngine } from '../../src/sync/operations/engine';
import { canonical, digest, isKnownVocabulary, validateOperation, type Command, type Frontier, type Operation } from '../../src/sync/operations/protocol';
import { createOperationLogSync } from '../../src/sync/operations/logSync';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest } from '../../src/collab/security/manifest';
import type { RelayAuthorization } from '../../src/collab/security/relayAdmission';
import { ImmutableDriveFake } from './driveFake';

const date = '2026-01-01T00:00:00.000Z';
const board: Command = { collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Board', template: 'project', createdAt: date, updatedAt: date }, unset: [] };
const card: Command = { collection: 'cards', entityId: 'card', kind: 'create', fields: { content: 'Initial', type: 'task', status: 'candidate', orderKey: 'a0', createdAt: date, updatedAt: date }, unset: [] };

/** An operation over vocabulary this build does not know: a structurally sound
 * command over an unknown collection. Built through `unknown` because the type
 * system intentionally cannot name a future collection. */
const futureCommand = (kind: Command['kind'], fields: Record<string, Json>): Command =>
  ({ collection: 'widgets', entityId: 'widget-1', kind, fields, unset: [] }) as unknown as Command;
/** A known collection carrying a field name this build does not list. */
const unknownFieldCommand = (fields: Record<string, Json>): Command =>
  ({ ...card, kind: 'patch', fields: { ...fields, futureRating: 5 }, unset: [] });
const patch = (fields: Record<string, Json>, entityId = 'card'): Command =>
  ({ collection: 'cards', entityId, kind: 'patch', fields, unset: [] });
function operation(actorId: string, seq: number, command: Command, deps: Record<string, number> = {}, clock = 1000 + seq): Operation {
  return { ...structuredClone(command), boardId: 'board', schemaVersion: 1, actorId, seq, opId: `${actorId}:${seq}`, deps: { ...deps, ...(seq > 1 ? { [actorId]: seq - 1 } : {}) }, clock };
}

describe('the engine skips vocabulary it cannot read and never applies it', () => {
  const root = operation('base', 1, board, {}, 1);
  const creation = operation('base', 2, card, { base: 1 }, 2);
  async function engine() { const e = new OperationEngine('board'); await e.receive([root, creation]); return e; }

  it('records the skip, applies siblings in order, and never half-applies', async () => {
    const e = await engine();
    const unknownCollection = operation('future', 1, futureCommand('create', { housing: 'chrome' }));
    const unknownField = operation('future', 2, unknownFieldCommand({ content: 'MUST NOT LAND' }));
    const sibling = operation('future', 3, patch({ title: 'Sibling applied' }));
    await e.receive([unknownCollection, unknownField, sibling]);
    expect(e.entity('cards', 'card')).toMatchObject({ content: 'Initial', title: 'Sibling applied' });
    expect(e.metrics.skipped).toBe(2);
    expect(e.skippedOperations()).toEqual([
      { opId: 'future:1', seq: 1 },
      { opId: 'future:2', seq: 2 },
    ]);
    // The skip never blocks the stream: causality advanced through both
    // unreadable operations, so nothing is pending and the board stays syncable.
    expect(e.pendingCount()).toBe(0);
    expect(e.vector().future).toBe(3);
  });
  it('keeps an operation skipped whole: a known field alongside an unknown one does not land', async () => {
    const e = await engine();
    await e.receive([operation('future', 1, unknownFieldCommand({ content: 'MUST NOT LAND', title: 'MUST NOT LAND EITHER' }))]);
    expect(e.entity('cards', 'card')?.content).toBe('Initial');
    expect(e.skippedOperations()).toEqual([{ opId: 'future:1', seq: 1 }]);
  });
  it('deduplicates and identity-checks skipped operations exactly like applied ones', async () => {
    const e = await engine(), unknown = operation('future', 1, futureCommand('create', { housing: 'chrome' }));
    await e.receive([unknown]); await e.receive([unknown]);
    expect(e.skippedOperations()).toEqual([{ opId: 'future:1', seq: 1 }]);
    expect(e.metrics.duplicates).toBe(1);
    await expect(e.receive([{ ...unknown, fields: { housing: 'wood' } }])).rejects.toThrow(/identity/);
  });
  it('still throws for structural invalidity whatever vocabulary the operation speaks', () => {
    const forged = { ...operation('future', 1, futureCommand('create', {})), opId: 'future:9' };
    const badFrontier = { ...operation('future', 2, futureCommand('create', {})), deps: {} as Frontier };
    const arrayFields = { ...operation('future', 1, futureCommand('create', {})), fields: ['not', 'a', 'record'] };
    const junkKeys = { ...operation('future', 1, futureCommand('create', {})), extra: true };
    for (const op of [forged, badFrontier, arrayFields, junkKeys, { ...forged, schemaVersion: 2 }])
      expect(() => validateOperation(op as Operation, 'board')).toThrow();
  });
  it('carries the skip ledger through checkpoints and joins, and rejects forged markers', async () => {
    const e = await engine(), unknown = operation('future', 1, futureCommand('create', { housing: 'chrome' }));
    await e.receive([unknown]);
    const checkpoint = e.checkpoint();
    expect(checkpoint.skipped).toEqual(['future:1']);
    const resumed = OperationEngine.restore(checkpoint);
    expect(resumed.skippedOperations()).toEqual([{ opId: 'future:1', seq: 1 }]);
    // A skip the checkpoint's receipts cannot attest to is a corrupt checkpoint.
    expect(() => OperationEngine.restore({ ...structuredClone(checkpoint), skipped: ['ghost:1'] })).toThrow(/skipped/);
    expect(() => OperationEngine.restore({ ...structuredClone(checkpoint), skipped: ['future:1', 'future:1'] })).toThrow(/skipped/);
    // Joins keep the refusal: a skip known to any branch is known to the join.
    const clean = await engine();
    const joined = OperationEngine.join([checkpoint, clean.checkpoint()], true);
    expect(joined.skippedOperations()).toEqual([{ opId: 'future:1', seq: 1 }]);
    // Checkpoints of fully understood history stay byte-identical to before.
    expect(clean.checkpoint().skipped).toBeUndefined();
  });
});

describe('the vocabulary predicate', () => {
  it('separates unreadable vocabulary from invalid shape', () => {
    expect(isKnownVocabulary(board)).toBe(true);
    const knownPatch: Command = { ...card, kind: 'patch', fields: { title: 'ok' }, unset: [] };
    const unknownUnset: Command = { ...card, kind: 'patch', fields: {}, unset: ['futureField'] };
    const unsetOfKnownField: Command = { ...card, kind: 'patch', fields: {}, unset: ['content'] };
    expect(isKnownVocabulary(knownPatch)).toBe(true);
    expect(isKnownVocabulary(futureCommand('create', {}))).toBe(false);
    expect(isKnownVocabulary(unknownFieldCommand({ title: 'known plus unknown' }))).toBe(false);
    expect(isKnownVocabulary(unknownUnset)).toBe(false);
    // A known field that merely cannot be unset stays *known* vocabulary: it is
    // invalid, not unreadable, and validateCommand still throws on it.
    expect(isKnownVocabulary(unsetOfKnownField)).toBe(true);
    expect(() => validateOperation(operation('a', 1, unsetOfKnownField), 'board')).toThrow();
  });
});

// --- session level: Drive segments, realtime, and the consolidation refusal ---

const cleanup: (() => Promise<void>)[] = [];
async function client(fake: ImmutableDriveFake, name = crypto.randomUUID()) {
  const journal = new ChangeJournal(name); await journal.open(); const local = new LocalOperationStore(journal);
  const session = new OperationSession({ boardId: 'board', local, drive: fake.store(), role: async () => fake.role, batchDelayMs: 60000 });
  cleanup.push(async () => { await session.close(); journal.close(); });
  await session.open(); return { local, session };
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
async function seeded(fake: ImmutableDriveFake) { const a = await client(fake); await a.session.edit(board); await a.session.edit(card); await a.session.sync(); return a; }

describe('ingestion tolerates future vocabulary without wedging', () => {
  it('applies the siblings of a Drive segment operation whose collection is unknown', async () => {
    const fake = new ImmutableDriveFake();
    await seeded(fake);
    const b = await client(fake);
    await b.session.sync();
    // A future client publishes a segment whose middle operation names a
    // collection this build has never heard of.
    const segment = {
      protocol: 'pboard-operations-v1' as const, boardId: 'board', segmentId: 'seg-future',
      operations: [
        operation('future', 1, patch({ title: 'Sibling before' })),
        operation('future', 2, futureCommand('create', { housing: 'chrome' })),
        operation('future', 3, patch({ content: 'MUST NOT LAND', futureRating: 5 })),
      ],
    };
    fake.files.set('file-future', { id: 'file-future', name: 'operations-seg-future.json', parents: ['folder'],
      body: await canonical({ ...segment, integrity: await digest(segment) }), createdTime: new Date().toISOString() });
    // The sync completes: the unknown operation is skipped, its known siblings
    // apply in order, and nothing about the batch rejects the poll.
    await b.session.sync(true);
    expect(b.session.state().cards[0]).toMatchObject({ content: 'Initial', title: 'Sibling before' });
    await expect(b.session.prepareLogSnapshot()).rejects.toThrow(/cannot read/);
  });
  it('skips future vocabulary delivered over realtime and records it', async () => {
    const fake = new ImmutableDriveFake();
    await seeded(fake);
    const b = await client(fake); await b.session.sync();
    await b.session.receiveRealtime([
      operation('future', 1, futureCommand('create', { housing: 'chrome' })),
      operation('future', 2, patch({ title: 'Realtime sibling' })),
    ]);
    expect(b.session.state().cards[0]).toMatchObject({ title: 'Realtime sibling', content: 'Initial' });
    await expect(b.session.prepareLogSnapshot()).rejects.toThrow(/cannot read/);
  });
  it('refuses a log snapshot while anything is skipped, and publishes when nothing is', async () => {
    const fake = new ImmutableDriveFake();
    const a = await seeded(fake);
    const { snapshot } = await a.session.prepareLogSnapshot();
    expect(Object.keys(snapshot.checkpoint.receipts)).toHaveLength(2);
    await a.session.receiveRealtime([operation('future', 1, futureCommand('create', { housing: 'chrome' }))]);
    await expect(a.session.prepareLogSnapshot()).rejects.toThrow(/cannot read/);
    // The log path is the only snapshot path: it is also the path that would
    // authorize gardening, so this refusal is the whole guard.
  });
});

// --- log transport: the cursor advances past an unsupported row ---

const logBoard = 'board-1', topic = `pboard-collab-${logBoard}-cards`, challenge = 'c'.repeat(43), logSession = 's'.repeat(43);
let room = '';
type RelayFrame = { type?: string; room?: string; deviceKeyId?: string; request?: Record<string, unknown> };
class Relay {
  static OPEN = 1;
  static instances: Relay[] = [];
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  auto = true;
  nextSeq = 1;
  static window: Record<string, unknown> = { operations: [], checkpointSeq: 0, synced: true };
  static reject: string | null = null;
  constructor(_url: string | URL) {
    Relay.instances.push(this);
    queueMicrotask(() => this.push({ type: 'welcome', version: 1, supportedVersions: [1, 2], challenge, session: logSession }));
  }
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  frame(action: string, fields: Record<string, unknown> = {}) { return { type: 'sync', action, board: room, ...fields }; }
  send(raw: string) {
    const message = JSON.parse(raw) as RelayFrame;
    if (message.type === 'authenticate') {
      room = message.room!;
      const deviceKeyId = message.deviceKeyId!;
      queueMicrotask(() => this.push(Relay.reject ? { type: 'error', code: Relay.reject }
        : { type: 'authenticated', peerId: deviceKeyId, session: logSession }));
    }
    if (message.type === 'sync' && this.auto && message.request) this.answer(message.request);
  }
  answer(request: Record<string, unknown>) {
    if (request.action === 'subscribe') this.push(this.frame('window', { liveFromSeq: this.nextSeq, ...Relay.window }));
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
const settled = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const logOperation = (seq: number, over: Record<string, unknown> = {}): Operation => ({
  schemaVersion: 1, boardId: logBoard, actorId: 'device-1', seq, opId: `device-1:${seq}`, clock: seq,
  deps: (seq > 1 ? { 'device-1': seq - 1 } : {}) as Frontier, collection: 'cards', entityId: 'card-1', kind: 'patch',
  fields: { content: `edit ${seq}` }, unset: [], ...over,
}) as Operation;
const logRow = (seq: number, payload = JSON.stringify(logOperation(seq))) => ({ opId: `device-1:${seq}`, seq, payload });
/** Row as the log stores it: structurally valid, over a collection this build lacks. */
const futureRow = (seq: number) => logRow(seq, JSON.stringify(logOperation(seq, {
  collection: 'widgets', entityId: 'widget-1', kind: 'create', fields: { housing: 'chrome' },
})));

let key: StoredDeviceKey, authorization: RelayAuthorization;
async function startLog(overrides: Record<string, unknown> = {}) {
  return await createOperationLogSync({
    boardId: logBoard, topic, url: 'wss://relay.example.test/ws',
    getKey: async () => key, getAuthorization: async () => authorization,
    seal: async op => JSON.stringify(op), open: async payload => JSON.parse(payload) as Operation,
    receive: async () => {},
    cursor: { load: async () => 0, save: async () => {} },
    authBudget: instantAuthBudget(),
    webSocket: Relay as unknown as typeof WebSocket, ...overrides,
  });
}
beforeEach(async () => {
  Relay.instances = []; Relay.window = { operations: [], checkpointSeq: 0, synced: true }; Relay.reject = null;
  room = '';
  key = await generateDeviceKey();
  const manifest = await signManifest({
    protocol: 2, boardId: logBoard, driveProjectFileId: 'file-1', driveFolderId: 'folder-1', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' }],
  }, key);
  authorization = { authority: key.publicJwk, manifest };
});
afterEach(() => { vi.useRealTimers(); Relay.instances = []; });

describe('the log transport advances past unsupported operations instead of wedging', () => {
  it('applies the understood rows, hands the batch on, and advances the cursor past the unknown one', async () => {
    // Before tolerance this window rejected at validation on every reconnect:
    // the cursor never passed sequence 2 and the board never caught up again.
    Relay.window = { operations: [logRow(1), futureRow(2), logRow(3)], checkpointSeq: 0, synced: true };
    const taken: Operation[][] = [], saved: number[] = [];
    const sync = await startLog({
      receive: async (ops: Operation[]) => { taken.push(ops); },
      cursor: { load: async () => 0, save: async (seq: number) => { saved.push(seq); } },
    });
    await settled();
    try {
      expect(taken.flat().map(op => op.seq)).toEqual([1, 2, 3]);
      expect(saved.at(-1)).toBe(3);
      expect(sync.status()).toMatchObject({ phase: 'synced', appliedSeq: 3 });
      expect(sync.metrics.skipped).toBe(1);
    } finally { await sync.close(); }
  });
  it('still fails the batch — and holds the cursor — for a structurally invalid operation', async () => {
    Relay.window = { operations: [logRow(1), logRow(2, JSON.stringify(logOperation(2, { schemaVersion: 2 })))], checkpointSeq: 0, synced: true };
    const saved: number[] = [];
    await expect(startLog({ cursor: { load: async () => 0, save: async (seq: number) => { saved.push(seq); } } })).rejects.toThrow();
    expect(saved).toEqual([]);
  });
});
