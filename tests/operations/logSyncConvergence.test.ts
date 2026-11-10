import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationLogSync, LOG_PROTOCOL_VERSION, clearReconnectLedger } from '../../src/sync/operations/logSync';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest } from '../../src/collab/security/manifest';
import type { RelayAuthorization } from '../../src/collab/security/relayAdmission';
import type { Frontier, Operation } from '../../src/sync/operations/protocol';

/**
 * Two clients against one log.
 *
 * The single-client tests script the relay's answers; this file models the log's
 * *semantics* instead — append with dedupe before sequence allocation, a replay
 * window filtered by the requested sequence, and publication to every subscriber
 * including the writer, which is what `sync_api::Hub::publish` does. That last part
 * is the point: a device receives the operations it submitted, and nothing but a
 * running pair of clients shows whether that turns into a second application.
 */
const board = 'board-1', topic = `pboard-collab-${board}-cards`, challenge = 'c'.repeat(43), session = 's'.repeat(43);

type Row = { opId: string; seq: number; actorId: string; protocolVersion: number; logicalClock: number; enqueuedAt: number; payload: string };

class BoardLog {
  rows: Row[] = [];
  tabs: Tab[] = [];
  nextSeq = 1;
  checkpointSeq = 0;

  /** Dedupe happens before a sequence is allocated, so a retry cannot burn one. */
  append(tab: Tab, operations: { opId: string; logicalClock?: number; payload: string }[]) {
    return operations.map(input => {
      const existing = this.rows.find(row => row.opId === input.opId);
      if (existing) return { opId: input.opId, seq: existing.seq, duplicate: true };
      const row: Row = { opId: input.opId, seq: this.nextSeq++, actorId: tab.actor, protocolVersion: LOG_PROTOCOL_VERSION,
        logicalClock: input.logicalClock ?? 0, enqueuedAt: 1, payload: input.payload };
      this.rows.push(row);
      return { opId: row.opId, seq: row.seq, duplicate: false };
    });
  }

  publish(row: Row) {
    for (const tab of [...this.tabs]) tab.push({ type: 'sync', action: 'operation', board: tab.room, ...row });
  }
}

class Tab {
  static OPEN = 1;
  readyState = 1;
  room = '';
  actor = '';
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;

  constructor(_url: string | URL, private readonly log: BoardLog) {
    this.log.tabs.push(this);
    queueMicrotask(() => this.push({ type: 'welcome', version: 1, supportedVersions: [1, 2], challenge, session }));
  }

  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  private frame(action: string, fields: Record<string, unknown> = {}) { return { type: 'sync', action, board: this.room, ...fields }; }

  send(raw: string) {
    const message = JSON.parse(raw);
    if (message.type === 'authenticate') {
      this.room = message.room; this.actor = message.deviceKeyId;
      queueMicrotask(() => this.push({ type: 'authenticated', peerId: message.deviceKeyId, session }));
      return;
    }
    if (message.type !== 'sync') return;
    const request = message.request;
    if (request.action === 'subscribe') {
      const after = request.afterSeq ?? 0;
      queueMicrotask(() => this.push(this.frame('window', { operations: this.log.rows.filter(row => row.seq > after),
        liveFromSeq: this.log.nextSeq, checkpointSeq: this.log.checkpointSeq, synced: true })));
    }
    if (request.action === 'submit') {
      const results = this.log.append(this, request.operations);
      queueMicrotask(() => {
        this.push(this.frame('accepted', { results, ackedSeq: results.at(-1)?.seq }));
        for (const result of results) if (!result.duplicate) this.log.publish(this.log.rows.find(row => row.opId === result.opId)!);
      });
    }
  }

  close() { this.readyState = 3; this.log.tabs = this.log.tabs.filter(tab => tab !== this); this.onclose?.({ code: 1000 }); }
}

const socketFor = (log: BoardLog) => class extends Tab { constructor(url: string | URL) { super(url, log); } };
const edit = (actorId: string, seq: number, content: string): Operation => ({ schemaVersion: 1, boardId: board, actorId, seq,
  opId: `${actorId}:${seq}`, clock: seq, deps: (seq > 1 ? { [actorId]: seq - 1 } : {}) as Frontier,
  collection: 'cards', entityId: 'card-1', kind: 'patch', fields: { content }, unset: [] });

let log: BoardLog, keys: StoredDeviceKey[], authorization: RelayAuthorization, cursors: Record<string, number>;

async function connect(log: BoardLog, deviceKeyId: string, applied: Operation[], saved: (seq: number) => void) {
  return await createOperationLogSync({
    boardId: board, topic, url: 'wss://relay.example.test/ws',
    getKey: async () => keys.find(key => key.keyId === deviceKeyId)!,
    getAuthorization: async () => authorization,
    seal: async operation => JSON.stringify(operation), open: async payload => JSON.parse(payload) as Operation,
    receive: async operations => { applied.push(...operations); },
    gap: () => { throw new Error('the log still holds every sequence in this scenario'); },
    cursor: { load: async () => cursors[deviceKeyId] ?? 0, save: async seq => { cursors[deviceKeyId] = seq; saved(seq); } },
    webSocket: socketFor(log) as unknown as typeof WebSocket,
  });
}

beforeEach(async () => {
  clearReconnectLedger(); // One browser context per scenario: backoff history starts empty.
  log = new BoardLog(); cursors = {};
  keys = [await generateDeviceKey(), await generateDeviceKey()];
  const manifest = await signManifest({
    protocol: 2, boardId: board, driveProjectFileId: 'file-1', driveFolderId: 'folder-1', authorityKeyId: keys[0].keyId,
    epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
    devices: keys.map((key, index) => ({ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: index === 0 ? 'owner' : 'editor' })),
  }, keys[0]);
  authorization = { authority: keys[0].publicJwk, manifest };
});

afterEach(() => { for (const tab of log.tabs) tab.close(); log.tabs.length = 0; });

describe('two operation-log clients on one board', () => {
  it('delivers an edit to the other device and does not apply the author a second time', async () => {
    const [a, b] = [keys[0].keyId, keys[1].keyId];
    const appliedA: Operation[] = [], appliedB: Operation[] = [];
    const first = await connect(log, a, appliedA, () => {});
    const second = await connect(log, b, appliedB, () => {});
    await vi.waitFor(() => { expect(first.status().phase).toBe('synced'); expect(second.status().phase).toBe('synced'); });

    expect(await first.broadcast([edit('device-a', 1, 'Authored once')])).toBe(true);
    await vi.waitFor(() => { expect(appliedB.map(operation => operation.opId)).toContain('device-a:1'); });

    // The hub answers every subscriber, author included. The author must not apply
    // it a second time: it already counted that sequence when the log acknowledged
    // its own submission, and rows at or below the applied sequence are dropped —
    // which is also what makes a replayed window harmless after a reconnect.
    expect(appliedA.filter(operation => operation.opId === 'device-a:1')).toHaveLength(0);
    expect(appliedB.filter(operation => operation.opId === 'device-a:1')).toHaveLength(1);
    expect(first.metrics.received).toBe(0);
    expect(second.metrics.received).toBe(1);
    await vi.waitFor(() => { expect(first.status().appliedSeq).toBe(second.status().appliedSeq); });

    await first.close(); await second.close();
  });

  it('replays what a device missed while it was closed, from its own cursor, in order', async () => {
    const [a, b] = [keys[0].keyId, keys[1].keyId];
    const appliedA: Operation[] = [], appliedB: Operation[] = [];
    const first = await connect(log, a, appliedA, () => {});
    await vi.waitFor(() => { expect(first.status().phase).toBe('synced'); });

    const secondSaved: number[] = [];
    const second = await connect(log, b, appliedB, seq => secondSaved.push(seq));
    await vi.waitFor(() => { expect(second.status().phase).toBe('synced'); });
    await second.close();

    for (const [seq, content] of [[1, 'first'], [2, 'second'], [3, 'third']] as const) {
      await first.broadcast([edit('device-a', seq, content)]);
    }
    await vi.waitFor(() => { expect(first.status().appliedSeq).toBe(3); });

    // Reopening the board: the window carries exactly what the stored cursor missed.
    const reopened: Operation[] = [], reopenedSaved: number[] = [];
    const third = await connect(log, b, reopened, seq => reopenedSaved.push(seq));
    await vi.waitFor(() => { expect(third.status().phase).toBe('synced'); });
    expect(reopened.map(operation => operation.fields.content)).toEqual(['first', 'second', 'third']);
    expect(third.status().appliedSeq).toBe(3);
    expect(reopenedSaved.at(-1)).toBe(3);
    await third.close(); await first.close();
  });

  it('answers a resubmission with the original sequence and delivers it only once', async () => {
    const [a, b] = [keys[0].keyId, keys[1].keyId];
    const appliedA: Operation[] = [], appliedB: Operation[] = [];
    const first = await connect(log, a, appliedA, () => {});
    const second = await connect(log, b, appliedB, () => {});
    await vi.waitFor(() => { expect(second.status().phase).toBe('synced'); });

    const operation = edit('device-a', 7, 'submitted twice');
    expect(await first.broadcast([operation])).toBe(true);
    expect(await first.broadcast([operation])).toBe(true);

    await vi.waitFor(() => { expect(first.metrics.duplicates).toBe(1); });
    expect(log.rows.filter(row => row.opId === operation.opId)).toHaveLength(1);
    expect(appliedB.filter(applied => applied.opId === operation.opId)).toHaveLength(1);
    expect(log.rows.filter(row => row.opId === operation.opId).at(0)!.seq).toBe(1);
    await first.close(); await second.close();
  });
});
