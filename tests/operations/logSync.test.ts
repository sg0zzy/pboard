import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instantAuthBudget } from '../helpers/authBudget';
import { createOperationLogSync, createOperationLogCodec, describeLogStatus, LOG_PROTOCOL_VERSION, clearReconnectLedger } from '../../src/sync/operations/logSync';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest } from '../../src/collab/security/manifest';
import type { RelayAuthorization } from '../../src/collab/security/relayAdmission';
import { generateBoardContentKey } from '../../src/sync/bufferCrypto';
import type { Frontier, Operation } from '../../src/sync/operations/protocol';

const board = 'board-1', topic = `pboard-collab-${board}-cards`, challenge = 'c'.repeat(43), session = 's'.repeat(43);

/** The board's log identity is the admitted room; tests read it off the authenticate frame. */
let room = '';

class Relay {
  static OPEN = 1;
  static instances: Relay[] = [];
  readyState = 1;
  sent: Record<string, any>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  /** Tests that need to answer selectively turn this off. */
  auto = true;
  nextSeq = 1;
  /** Scripted replay window, because the first subscribe is answered before a test can intervene. */
  static window: Record<string, unknown> = { operations: [], checkpointSeq: 0, synced: true };
  /** Authorization failures happen at authentication, before any request is answered. */
  static reject: string | null = null;
  static lease: Record<string, unknown> = { holder: 'device-1', epoch: 4, expiresAt: Date.now() + 60_000 };
  static commit: Record<string, unknown> = { checkpointSeq: 1, epoch: 4, snapshotSeq: 1, stale: false };
  constructor(_url: string | URL) {
    Relay.instances.push(this);
    queueMicrotask(() => this.push({ type: 'welcome', version: 1, supportedVersions: [1, 2], challenge, session }));
  }
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  frame(action: string, fields: Record<string, unknown> = {}) { return { type: 'sync', action, board: room, ...fields }; }
  get requests() { return this.sent.filter(entry => entry.type === 'sync').map(entry => entry.request); }
  submit() { return this.requests.filter(request => request.action === 'submit').at(-1)!.operations as { opId: string; payload: string }[]; }
  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === 'authenticate') {
      room = message.room;
      queueMicrotask(() => this.push(Relay.reject ? { type: 'error', code: Relay.reject }
        : { type: 'authenticated', peerId: message.deviceKeyId, session }));
    }
    if (message.type === 'sync' && this.auto) this.answer(message.request);
  }
  answer(request: Record<string, any>) {
    if (request.action === 'subscribe') this.push(this.frame(Relay.window.synced === true ? 'window' : 'snapshotRequired', { liveFromSeq: this.nextSeq, ...Relay.window }));
    if (request.action === 'submit') {
      const results = request.operations.map((operation: { opId: string }) => ({ opId: operation.opId, seq: this.nextSeq++, duplicate: false }));
      const ackedSeq = results.at(-1)?.seq;
      this.push(this.frame('accepted', { results, ackedSeq }));
    }
    if (request.action === 'lease') this.push(this.frame('lease', Relay.lease));
    if (request.action === 'commit') this.push(this.frame('committed', { ...Relay.commit,
      checkpointSeq: request.seq, epoch: request.epoch, snapshotSeq: request.snapshotSeq }));
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

const settled = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
/** Signing and manifest verification are real WebCrypto work, so the socket appears a macrotask later. */
const connected = async (which = 0) => { await vi.waitFor(() => { expect(Relay.instances[which]).toBeDefined(); }); await settled(); };
const waited = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));
function operation(seq: number, content = 'edit'): Operation {
  const actorId = 'device-1';
  return { schemaVersion: 1, boardId: board, actorId, seq, opId: `${actorId}:${seq}`, clock: seq,
    deps: (seq > 1 ? { [actorId]: seq - 1 } : {}) as Frontier, collection: 'cards', entityId: 'card-1', kind: 'patch',
    fields: { content }, unset: [] };
}
/** Wire row as the log stores it: sealed by the author, opaque to the relay. */
const row = (seq: number, payload = JSON.stringify(operation(seq))) => ({ opId: `device-1:${seq}`, seq, actorId: 'device-1',
  protocolVersion: LOG_PROTOCOL_VERSION, logicalClock: seq, enqueuedAt: 1, payload });

let key: StoredDeviceKey, authorization: RelayAuthorization, received: Operation[][], saved: number[], gaps: unknown[][], statuses: string[];

async function start(overrides: Record<string, unknown> = {}) {
  return await createOperationLogSync({
    boardId: board, topic, url: 'wss://relay.example.test/ws',
    getKey: async () => key, getAuthorization: async () => authorization,
    seal: async op => JSON.stringify(op), open: async payload => JSON.parse(payload) as Operation,
    receive: async ops => { received.push(ops); },
    gap: gap => { gaps.push([gap]); },
    status: status => { statuses.push(status.phase); },
    cursor: { load: async () => 0, save: async seq => { saved.push(seq); } },
    // The dial gate's own bounds are pinned in `tests/collab/authBudget.test.ts`
    // and the dial path end to end in `tests/operations/relayDialBudget.test.ts`;
    // this suite is about the wire protocol, so it paces nothing.
    authBudget: instantAuthBudget(),
    webSocket: Relay as unknown as typeof WebSocket, ...overrides
  });
}

beforeEach(async () => {
  clearReconnectLedger(); // One browser context per scenario: backoff history starts empty.
  Relay.instances = []; Relay.window = { operations: [], checkpointSeq: 0, synced: true }; Relay.reject = null;
  room = ''; received = []; saved = []; gaps = []; statuses = [];
  key = await generateDeviceKey();
  const manifest = await signManifest({
    protocol: 2, boardId: board, driveProjectFileId: 'file-1', driveFolderId: 'folder-1', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' }]
  }, key);
  authorization = { authority: key.publicJwk, manifest };
});
afterEach(() => { vi.useRealTimers(); Relay.instances = []; });

describe('operation log transport', () => {
  it('authenticates to the admitted room and resumes from the stored cursor', async () => {
    const sync = await start({ cursor: { load: async () => 7, save: async () => {} } });
    try {
      const authenticate = Relay.instances[0].sent[0];
      expect(authenticate.room).toBe(room);
      expect(room).not.toBe(topic); // The log never sees the Drive topic as an identity.
      expect(authenticate.version).toBe(2);
      expect(Relay.instances[0].requests[0]).toEqual({ action: 'subscribe', board: room, afterSeq: 7 });
      expect(sync.status()).toMatchObject({ phase: 'synced', appliedSeq: 7 });
    } finally { await sync.close(); }
  });

  it('applies a replay window in order and advances the cursor only after the engine takes it', async () => {
    Relay.window = { operations: [row(1), row(2)], checkpointSeq: 0, synced: true };
    const taken: number[] = [];
    const started = await start({ receive: async (ops: Operation[]) => { await settled(); taken.push(...ops.map(op => op.seq)); } });
    await settled();
    try {
      expect(taken).toEqual([1, 2]);
      expect(saved).toEqual([2]);
      expect(started.status()).toMatchObject({ phase: 'synced', appliedSeq: 2 });
    } finally { await started.close(); }
  });

  it('acknowledges an edit only once the log has it, and counts a retry as a duplicate', async () => {
    const sync = await start();
    try {
      Relay.instances[0].auto = false;
      const delivered = sync.broadcast([operation(1)]);
      await settled();
      const submitted = Relay.instances[0].submit();
      expect(submitted).toEqual([{ opId: 'device-1:1', protocolVersion: LOG_PROTOCOL_VERSION, logicalClock: 1, payload: JSON.stringify(operation(1)) }]);
      Relay.instances[0].push(Relay.instances[0].frame('accepted', { results: [{ opId: 'device-1:1', seq: 1, duplicate: true }], ackedSeq: 1 }));
      expect(await delivered).toBe(true);
      expect(sync.metrics).toMatchObject({ acked: 1, duplicates: 1 });
      expect(saved).toEqual([1]);
      expect(sync.status().pending).toBe(0);
    } finally { await sync.close(); }
  });

  it('keeps an operation pending across a disconnect and resubmits the same identifier', async () => {
    const sync = await start({ reconnectBaseMs: 1 });
    Relay.instances[0].auto = false;
    const delivered = sync.broadcast([operation(1)]);
    await settled();
    Relay.instances[0].close();               // dies between submit and acknowledgment
    expect(await delivered).toBe(false);
    expect(sync.status().pending).toBe(1);
    await connected(1);                       // backoff, then reconnect
    const second = Relay.instances[1];
    expect(second.requests.map(request => request.action)).toContain('submit');
    const resubmitted = second.submit();
    expect(resubmitted.map(entry => entry.opId)).toEqual(['device-1:1']);
    expect(sync.metrics.resubmitted).toBe(1);
    await sync.close();
  });

  it('drops the connection rather than applying a frame for another board', async () => {
    const sync = await start();
    await waited(1);
    Relay.instances[0].push({ type: 'sync', action: 'operation', board: 'pboard-v2-someone-elses-room', opId: 'device-9:1', seq: 9, payload: '{}' });
    await settled();
    try {
      expect(received).toEqual([]);
      expect(Relay.instances[0].readyState).toBe(3);
    } finally { await sync.close(); }
  });

  it('reports a snapshot requirement instead of pretending an incomplete board is current', async () => {
    Relay.window = { operations: [], checkpointSeq: 39, synced: false,
      gap: { reason: 'snapshot_required', checkpointSeq: 39, checkpointEpoch: 2, snapshotSeq: 39 } };
    const started = await start();
    await settled();
    try {
      expect(received).toEqual([]);
      expect(gaps).toEqual([[{ reason: 'snapshot_required', checkpointSeq: 39, checkpointEpoch: 2, snapshotSeq: 39 }]]);
      expect(started.status()).toMatchObject({ phase: 'snapshot', appliedSeq: 0 });
    } finally { await started.close(); }
  });

  it('refuses to start, and does not retry, when the relay rejects the authorization itself', async () => {
    Relay.reject = 'authorization_changed';
    await expect(start()).rejects.toThrow('authorization_changed');
    expect(Relay.instances[0].readyState).toBe(3);
    // A revoked grant is not a network problem: reconnecting with the same
    // manifest would loop forever and hide the reason from the person who has to
    // re-share the board.
    await waited(30);
    expect(Relay.instances).toHaveLength(1);
  });

  it('closes instead of attributing a reply that nothing asked for', async () => {
    const sync = await start();
    Relay.instances[0].push(Relay.instances[0].frame('accepted', { results: [] }));
    await settled();
    try {
      expect(Relay.instances[0].readyState).toBe(3);
      expect(sync.metrics.acked).toBe(0);
    } finally { await sync.close(); }
  });

  it('serializes overlapping submits so each acknowledgment belongs to its own batch', async () => {
    const sync = await start();
    Relay.instances[0].auto = false;
    const first = sync.broadcast([operation(1)]);
    const second = sync.broadcast([operation(2)]);
    await settled();
    const submits = () => Relay.instances[0].requests.filter(request => request.action === 'submit');
    // One request in flight, because the reply has no identifier: the second batch
    // may not be sent until the first is answered, or its acknowledgment would be
    // attributed to the wrong operations.
    expect(submits().map(request => request.operations.map((op: { opId: string }) => op.opId))).toEqual([['device-1:1']]);
    Relay.instances[0].push(Relay.instances[0].frame('accepted', { results: [{ opId: 'device-1:1', seq: 1, duplicate: false }], ackedSeq: 1 }));
    expect(await first).toBe(true);
    await settled();
    expect(submits().map(request => request.operations.map((op: { opId: string }) => op.opId))).toEqual([['device-1:1'], ['device-1:2']]);
    Relay.instances[0].push(Relay.instances[0].frame('accepted', { results: [{ opId: 'device-1:2', seq: 2, duplicate: false }], ackedSeq: 2 }));
    expect(await second).toBe(true);
    expect(sync.status().pending).toBe(0);
    await sync.close();
  });

  it('seals operations so the relay stores ciphertext bound to the operation identifier', async () => {
    const codec = createOperationLogCodec(await generateBoardContentKey());
    const sync = await start({ seal: codec.seal, open: codec.open });
    try {
      const [submitted] = Relay.instances[0].requests.filter(request => request.action === 'submit').slice(-1) as { operations: { payload: string }[] }[];
      expect(submitted).toBeUndefined();
      await sync.broadcast([operation(1, 'meeting notes for the renovation')]);
      const [sealed] = Relay.instances[0].submit();
      const envelope = JSON.parse(sealed.payload);
      expect(JSON.stringify(envelope)).not.toContain('renovation');
      expect(envelope).toMatchObject({ v: 1, opId: 'device-1:1' });
      Relay.instances[0].push(Relay.instances[0].frame('operation', { opId: 'device-2:1', seq: 4, payload: sealed.payload }));
      await settled();
      // The same ciphertext under a different identifier fails to decrypt: the
      // operation id is authenticated data, not a label.
      expect(received).toEqual([]);
      expect(Relay.instances[0].readyState).toBe(3);
    } finally { await sync.close(); }
  });

  it('never settles the cursor over a sequence it was never shown', async () => {
    const sync = await start();
    Relay.instances[0].auto = false;
    const delivered = sync.broadcast([operation(9)]);
    await settled();
    // Sequence 5 was appended before ours and its broadcast never reached this
    // connection (a subscriber that cannot drain is dropped, not blocked). The
    // cursor must stay put and the missing window must be asked for again.
    Relay.instances[0].push(Relay.instances[0].frame('accepted', { results: [{ opId: 'device-1:9', seq: 5, duplicate: false }], ackedSeq: 5 }));
    expect(await delivered).toBe(true);
    await settled();
    expect(sync.metrics.holes).toBe(1);
    expect(saved).toEqual([0]);
    const subscribes = Relay.instances[0].requests.filter(request => request.action === 'subscribe');
    expect(subscribes.map(request => request.afterSeq)).toEqual([0, 0]);
    // Filling the hole from the log then moves the cursor, and nothing above it
    // is lost: the window arrives as an ordinary replay.
    Relay.instances[0].push(Relay.instances[0].frame('window', { operations: [row(1), row(2)], checkpointSeq: 0, synced: true }));
    await settled();
    expect(received.flat().map(op => op.seq)).toEqual([1, 2]);
    expect(sync.status().appliedSeq).toBe(2);
    expect(sync.metrics.holes).toBe(1);
    await sync.close();
  });

  it('adopts a checkpoint and resumes above it when the log pruned the history', async () => {
    Relay.window = { operations: [], checkpointSeq: 39, synced: false,
      gap: { reason: 'snapshot_required', checkpointSeq: 39, checkpointEpoch: 2, snapshotSeq: 39 } };
    const sync = await start();
    await settled();
    expect(sync.status().phase).toBe('snapshot');
    // The caller has now read the snapshot from Drive; the connection continues
    // from where that snapshot ends rather than asking for pruned operations.
    Relay.window = { operations: [], checkpointSeq: 39, synced: true };
    await sync.resumeFrom(39);
    await settled();
    const subscribes = Relay.instances[0].requests.filter(request => request.action === 'subscribe');
    expect(subscribes.map(request => request.afterSeq)).toEqual([0, 39]);
    expect(sync.status()).toMatchObject({ phase: 'synced', appliedSeq: 39 });
    expect(saved).toContain(39);
    expect(sync.metrics.adoptions).toBe(1);
    await sync.close();
  });

  it('says what a reconnect, an unsent edit and a refusal each mean', () => {
    const status = (phase: string, extra: Record<string, unknown> = {}) => ({ phase, appliedSeq: 3, checkpointSeq: 0, pending: 0, error: null, ...extra } as never);
    expect(describeLogStatus(status('synced'))).toContain('as you type');
    // Waiting to store, reconnecting and being refused are three different answers
    // and only the last one means somebody has to re-share the board.
    expect(describeLogStatus(status('synced', { pending: 2 }))).toMatch(/2 edits still waiting/);
    expect(describeLogStatus(status('synced', { pending: 1 }))).toMatch(/1 edit still waiting/);
    expect(describeLogStatus(status('offline'))).toContain('Reconnecting');
    expect(describeLogStatus(status('snapshot'))).toContain('snapshot');
    expect(describeLogStatus(status('error', { error: 'authorization_changed' }))).toContain('authorization_changed');
  });

  it('grants a consolidation lease and records snapshot evidence with that epoch', async () => {
    const sync = await start();
    try {
      const lease = await sync.lease();
      expect(lease).toMatchObject({ epoch: 4 });
      const commit = await sync.commit(lease, 12, 12, 'drive-etag');
      expect(commit).toMatchObject({ checkpointSeq: 12, snapshotSeq: 12, stale: false });
      expect(sync.status()).toMatchObject({ phase: 'synced', checkpointSeq: 12 });
      const committed = Relay.instances[0].requests.find(request => request.action === 'commit');
      expect(committed).toMatchObject({ epoch: 4, seq: 12, snapshotSeq: 12, driveEtag: 'drive-etag' });
    } finally { await sync.close(); }
  });
});
