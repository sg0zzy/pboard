/**
 * The reconnect posture: what may reconnect, how fast, and when it must stop.
 * A relay tunnel the proxy aged out is expected (hidden tab); a connect-to-die
 * loop must climb the backoff ladder and eventually stop; a refused admission
 * is terminal. Each of these was broken in the field at once: a churning
 * browser reconnected every failed identity exchange immediately and took the
 * whole shared request budget down with it.
 *
 * Timers here are deliberately real and small: every positive assertion is
 * driven by `vi.waitFor` on the actual condition, and the only fixed waits
 * observe *silence* (nothing reconnected), which no event can signal — and a
 * fake clock would test the fake, not the `Date.now()`-based ceiling ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instantAuthBudget } from '../helpers/authBudget';
import { createOperationLogSync, clearReconnectLedger } from '../../src/sync/operations/logSync';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';
import { signManifest } from '../../src/collab/security/manifest';
import type { RelayAuthorization } from '../../src/collab/security/relayAdmission';
import type { Operation } from '../../src/sync/operations/protocol';

const board = 'board-heal', topic = `pboard-collab-${board}-cards`, challenge = 'c'.repeat(43), session = 's'.repeat(43);
let room = '';

class Relay {
  static OPEN = 1;
  static instances: Relay[] = [];
  static window: Record<string, unknown> = { operations: [], checkpointSeq: 0, synced: true };
  /** Answer `authenticate` with an error frame instead of `authenticated`. */
  static reject: string | null = null;
  /** Accept the socket but never welcome it: a connection stuck in `connecting`. */
  static silent = false;
  /** Answer `subscribe` (off: authenticate works, the replay window never lands). */
  static auto = true;
  /** Demand service admission on the welcome, exercising the caller's hook. */
  static requireAdmission = false;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  nextSeq = 1;
  constructor(_url: string | URL) {
    Relay.instances.push(this);
    queueMicrotask(() => {
      if (Relay.silent) return;
      this.push({ type: 'welcome', version: 1, supportedVersions: [1, 2], challenge, session,
        ...(Relay.requireAdmission ? { requiresServiceAdmission: true } : {}) });
    });
  }
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(raw: string) {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'authenticate') {
      room = message.room as string;
      queueMicrotask(() => this.push(Relay.reject ? { type: 'error', code: Relay.reject }
        : { type: 'authenticated', peerId: message.deviceKeyId, session }));
    }
    if (message.type === 'sync' && Relay.auto && message.request) this.answer(message.request as Record<string, unknown>);
  }
  answer(request: Record<string, unknown>) {
    if (request.action === 'subscribe')
      this.push({ type: 'sync', action: 'window', board: room, liveFromSeq: this.nextSeq, ...Relay.window });
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

const settled = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const waited = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));
const appeared = async (count: number) => { await vi.waitFor(() => { expect(Relay.instances.length).toBe(count); }, { timeout: 1_000 }); await settled(); };

let key: StoredDeviceKey, authorization: RelayAuthorization;

async function start(overrides: Record<string, unknown> = {}) {
  return await createOperationLogSync({
    boardId: board, topic, url: 'wss://relay.example.test/ws',
    getKey: async () => key, getAuthorization: async () => authorization,
    seal: async op => JSON.stringify(op), open: async payload => JSON.parse(payload) as Operation,
    receive: async () => {}, gap: async () => {}, status: () => {},
    cursor: { load: async () => 0, save: async () => {} },
    // Reconnect *posture*, not rate behaviour: the dial gate paces nothing here,
    // so a real budget shared by this file's scenarios cannot decide an outcome
    // these tests are asserting (see `tests/operations/relayDialBudget.test.ts`).
    authBudget: instantAuthBudget(),
    webSocket: Relay as unknown as typeof WebSocket, ...overrides
  });
}

beforeEach(async () => {
  clearReconnectLedger();
  Relay.instances = []; Relay.window = { operations: [], checkpointSeq: 0, synced: true };
  Relay.reject = null; Relay.silent = false; Relay.auto = true; Relay.requireAdmission = false;
  room = '';
  key = await generateDeviceKey();
  const manifest = await signManifest({
    protocol: 2, boardId: board, driveProjectFileId: 'file-1', driveFolderId: 'folder-1', authorityKeyId: key.keyId,
    epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
    devices: [{ deviceKeyId: key.keyId, publicKey: key.publicJwk, role: 'owner' }]
  }, key);
  authorization = { authority: key.publicJwk, manifest };
});
afterEach(() => { vi.useRealTimers(); Relay.instances = []; });

describe('reconnect posture', () => {
  it('keeps climbing the backoff ladder across connections that authenticated but never synced', async () => {
    // The connect-to-die loop: each socket authenticates (the upgrade and the
    // identity round succeed) and dies before the replay window lands.
    // Forgiving `authenticated` resets the delay to the base every time —
    // exactly the storm that locks both browsers out of the shared budget.
    const ring: { reason: string; delayMs: number }[] = [];
    const handle = await start({ reconnects: ring, reconnectBaseMs: 20 });
    await appeared(1);
    Relay.auto = false; // authenticated now, but the window never lands
    for (let kill = 1; kill <= 3; kill++) {
      Relay.instances.at(-1)!.close();
      await appeared(1 + kill);
    }
    const delays = ring.map(entry => entry.delayMs); // newest first
    expect(delays.length).toBeGreaterThanOrEqual(3);
    // The ladder: ~20, ~40, ~80 ms (±25 % jitter, non-overlapping windows).
    expect(delays[0]).toBeGreaterThan(delays[1]);
    expect(delays[1]).toBeGreaterThan(delays[2]);
    expect(handle.status().phase).not.toBe('synced'); // never forgiven back to healthy
  });

  it('will not skip backoff for a connection that never got healthy', async () => {
    const handle = await start({ reconnectBaseMs: 30_000 });
    await appeared(1);
    Relay.silent = true; // the retry itself now dies mid-connect
    Relay.instances[0].close(); // a healthy tunnel ends
    await settled();
    expect(handle.reconnectNow()).toBe(true); // justified: it ended healthy
    await appeared(2);
    Relay.instances[1].close(); // ... and that attempt never authenticated
    await settled();
    expect(handle.reconnectNow()).toBe(false); // a failing connection does not own the schedule
    await waited(60); // silence: nothing scheduled may fire this early
    expect(Relay.instances.length).toBe(2);
  });

  it('reconnects a healthy tunnel the proxy aged out without waiting for backoff', async () => {
    const handle = await start({ reconnectBaseMs: 50_000 }); // the timer would take ~forever
    await appeared(1);
    Relay.instances[0].close(); // clean close of a synced connection
    await settled();
    expect(handle.status().phase).toBe('offline');
    expect(handle.reconnectNow()).toBe(true);
    await appeared(2);
    expect(handle.status().phase).toBe('synced');
  });

  it('stops a reconnect loop inside the ceiling window and only an explicit Reconnect resumes it', async () => {
    const handle = await start({ reconnectCeiling: 3, reconnectCeilingMs: 60_000, reconnectBaseMs: 10 });
    await appeared(1);
    Relay.instances[0].close();
    await appeared(2);
    Relay.instances[1].close();
    await appeared(3); // three attempts inside the window: the ceiling is spent
    Relay.instances[2].close();
    await vi.waitFor(() => { expect(handle.status().throttled).toBe(true); }, { timeout: 1_000 });
    expect(handle.status().error).toBe('reconnect:throttled');
    const frozen = Relay.instances.length;
    await waited(80); // several base delays of silence: only a person resumes this
    expect(Relay.instances.length).toBe(frozen);
    // The ledger belongs to the board, not the handle: re-creating the room
    // (a fresh connection for the same board) is not an escape hatch.
    const ceiling = { reconnectCeiling: 3, reconnectCeilingMs: 60_000, reconnectBaseMs: 10 };
    await expect(start(ceiling)).rejects.toThrow('reconnect:throttled');
    // The explicit owner action passes the ceiling once — they may have fixed
    // something real — and clears the ledger for the handle it drives.
    const bypassed = await start({ ...ceiling, reconnectCeilingBypassOnce: true });
    await appeared(frozen + 1);
    expect(bypassed.status().phase).toBe('synced');
    // The bypass was spent by that one connection: the same failure behind it
    // meets the ceiling again instead of getting a free channel.
    Relay.instances.at(-1)!.close();
    await vi.waitFor(() => { expect(bypassed.status().throttled).toBe(true); }, { timeout: 1_000 });
    bypassed.reconnectNow({ userInitiated: true });
    await appeared(frozen + 2);
    expect(bypassed.status().throttled).toBe(false);
  });

  it('treats a refused admission on a later connection as terminal, not retryable', async () => {
    let exchangeFails = false;
    const handle = await start({
      reconnectBaseMs: 10,
      getServiceAdmission: async () => {
        if (exchangeFails) throw new Error('identity exchange refused: 403 authorization_changed');
        return 'a'.repeat(43);
      },
      isTerminalAdmissionError: (error: unknown) => error instanceof Error && error.message.includes('403'),
    });
    await appeared(1); // healthy: admission hook passed
    Relay.requireAdmission = true;
    exchangeFails = true; // the identity behind this socket was superseded
    Relay.instances[0].close();
    await appeared(2); // backoff does its one next step
    await vi.waitFor(() => { expect(handle.status().error).toBe('admission:refused'); }, { timeout: 1_000 });
    const frozen = Relay.instances.length;
    await waited(80); // silence: no retry can succeed with a superseded authorization
    expect(Relay.instances.length).toBe(frozen);
    expect(handle.reconnectNow()).toBe(false); // automatic triggers stay down
    exchangeFails = false; // the owner re-enrolled; only now may a socket open
    expect(handle.reconnectNow({ userInitiated: true })).toBe(true);
    await appeared(frozen + 1);
    expect(handle.status().phase).toBe('synced');
  });
});
