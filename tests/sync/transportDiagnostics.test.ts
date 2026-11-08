/**
 * Per-connection transport diagnostics: the record that attributes a `/ws`
 * upgrade in the browser's network panel to the subsystem that dialled it.
 *
 * The module reads `__PBOARD_DIAGNOSTICS__` when it *loads*, exactly as
 * `collab/counters` does, so every case is loaded after the flag is stubbed —
 * otherwise the production half could not run at all.
 *
 * The last case drives the real `RelaySession.probe`, because the record has to
 * be taken by the code that constructs the socket, not only by the helper the
 * unit cases call: a ledger that is correct in isolation and never written by
 * the transport would answer nothing about a real connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as diagnostics from '../../src/sync/transportDiagnostics';

type Diagnostics = typeof diagnostics;

/** Loads the module after the build flag is stubbed: the boundary under test. */
async function load(enabled: boolean): Promise<Diagnostics> {
  vi.stubGlobal('__PBOARD_DIAGNOSTICS__', enabled);
  vi.resetModules();
  return await import('../../src/sync/transportDiagnostics');
}

/** A socket stand-in with only what the tracker touches: `close` (which it
 * shadows to learn who asked) and the type it has to satisfy at the boundary. */
function fakeSocket(): { close: (code?: number, reason?: string) => void; closed: boolean } & WebSocket {
  const socket = {
    closed: false,
    close() { this.closed = true; }
  };
  return socket as unknown as { close: (code?: number, reason?: string) => void; closed: boolean } & WebSocket;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('a dial', () => {
  it('records a unique id, the trigger, the room and the device prefix', async () => {
    const module = await load(true);
    const first = module.trackTransportSocket(fakeSocket(), 'courier:foreign-row', 'pboard-collab-board-1-cards', 'board-device:board-1:0123456789abcdef') as diagnostics.TransportDial;
    const second = module.trackTransportSocket(fakeSocket(), 'session:attach', 'pboard-collab-board-1-cards', 'board-device:board-1:fedcba9876543210') as diagnostics.TransportDial;

    // Unique and monotonic: the order dials actually happened is what makes a
    // concurrent pair distinguishable from a sequential one.
    expect(second.id).toBeGreaterThan(first.id);
    expect(new Set([first.id, second.id]).size).toBe(2);

    const { history } = module.transportSnapshot();
    expect(history.map(entry => entry.trigger)).toEqual(['courier:foreign-row', 'session:attach']);
    expect(history.map(entry => entry.device)).toEqual(['board-de', 'board-de']);
  });

  it('stores the id, trigger, room and a device prefix that is not the key', async () => {
    const module = await load(true);
    const dial = module.trackTransportSocket(fakeSocket(), 'courier:foreign-row', 'pboard-collab-board-1-cards', 'board-device:board-1:0123456789abcdef') as diagnostics.TransportDial;
    const snapshot = module.transportSnapshot();
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({
      id: dial.id,
      trigger: 'courier:foreign-row',
      room: 'pboard-collab-board-1-cards',
      // A prefix, deliberately: enough to tell devices apart, useless as a key.
      device: 'board-de',
      open: true,
      close: null,
      lifetimeMs: null
    });
    expect(snapshot.history[0].device).not.toContain('0123456789abcdef');
  });

  it('takes no room or device when the dial has neither', async () => {
    const module = await load(true);
    module.trackTransportSocket(fakeSocket(), 'session:recovery');
    expect(module.transportSnapshot().history[0]).toMatchObject({ room: null, device: null });
  });
});

describe('a close', () => {
  it('records the code, the sanitised reason, the author and the lifetime', async () => {
    const module = await load(true);
    const socket = fakeSocket();
    const dial = module.trackTransportSocket(socket, 'v2:room', 'board') as diagnostics.TransportDial;
    // Server text is untrusted: control characters are not allowed into a paste.
    vi.setSystemTime(new Date('2026-01-01T00:00:01.250Z'));
    dial.closed({ code: 1008, reason: 'policy\u0000 violated\n by server', wasClean: true });

    const entry = module.transportSnapshot().history[0];
    expect(entry.open).toBe(false);
    expect(entry.lifetimeMs).toBe(1250);
    expect(entry.close).toEqual({ code: 1008, reason: 'policy violated by server', by: 'server' });
  });

  it('attributes a close this client asked for to the client, not the server', async () => {
    const module = await load(true);
    const socket = fakeSocket();
    const dial = module.trackTransportSocket(socket, 'courier:pass', 'account') as diagnostics.TransportDial;
    // The browser reports our own close as 1005/clean, which is
    // indistinguishable from a server's clean close — so the call site that
    // asked states it, rather than the socket being wrapped to infer it.
    socket.close();
    dial.closed(undefined, { by: 'client', reason: 'exchange-finished' });
    expect(module.transportSnapshot().history[0].close).toEqual({ code: 1005, reason: 'exchange-finished', by: 'client' });
  });

  it('attributes a failed upgrade to the network, with the protocol\'s 1006', async () => {
    const module = await load(true);
    const dial = module.trackTransportSocket(fakeSocket(), 'session:attach', 'board') as diagnostics.TransportDial;
    dial.closed({ code: 1006, reason: '', wasClean: false });
    expect(module.transportSnapshot().history[0].close).toEqual({ code: 1006, reason: '', by: 'network' });
  });

  it('records a close this client performed but the server caused as a server close', async () => {
    const module = await load(true);
    const socket = fakeSocket();
    const dial = module.trackTransportSocket(socket, 'session:attach', 'board') as diagnostics.TransportDial;
    // A `refused`/`server_shutdown` frame moves the client to call `close()`;
    // the author of the end is the server, not us.
    socket.close();
    dial.closed(undefined, { by: 'server' });
    expect(module.transportSnapshot().history[0].close).toMatchObject({ by: 'server', code: 1005 });

    // The close event the browser then delivers refines the code and reason it
    // reported, and cannot rewrite the author.
    dial.closed({ code: 1000, reason: 'server going away', wasClean: true });
    const snapshot = module.transportSnapshot();
    expect(snapshot.history[0].close).toEqual({ by: 'server', code: 1000, reason: 'server going away' });
    expect(snapshot.closed).toBe(1);
    expect(snapshot.byClose).toEqual({ client: 0, server: 1, network: 0 });
    expect(snapshot.byCloseReason).toEqual({ 'server:1000:server going away': 1 });
  });

  it('records the protocol\'s own refusal code instead of the browser\'s synthetic status', async () => {
    const module = await load(true);
    const socket = fakeSocket();
    const dial = module.trackTransportSocket(socket, 'v2:room', 'board') as diagnostics.TransportDial;
    // A terminal `refused` frame moves the client to call `close()`; the browser
    // then reports 1000, which says nothing. The protocol's code is the answer.
    socket.close();
    dial.closed(undefined, { by: 'server', reason: 'refused:grant_expired' });
    dial.closed({ code: 1000, reason: '', wasClean: true });
    const snapshot = module.transportSnapshot();
    expect(snapshot.history[0].close).toEqual({ by: 'server', code: 1005, reason: 'refused:grant_expired' });
    expect(snapshot.byCloseReason).toEqual({ 'server:1005:refused:grant_expired': 1 });
  });

  it('records the first close only, so a handover cannot count one connection twice', async () => {
    const module = await load(true);
    const dial = module.trackTransportSocket(fakeSocket(), 'session:attach', 'board') as diagnostics.TransportDial;
    dial.closed({ code: 1000, wasClean: true });
    dial.closed({ code: 4000, reason: 'second', wasClean: true });
    const snapshot = module.transportSnapshot();
    expect(snapshot.history[0].close).toEqual({ code: 1000, reason: '', by: 'server' });
    expect(snapshot.closed).toBe(1);
    expect(snapshot.open).toBe(0);
  });

  it('re-attributes a dial that a relay without v3 turned into a private room', async () => {
    const module = await load(true);
    const dial = module.trackTransportSocket(fakeSocket(), 'session:attach', 'board') as diagnostics.TransportDial;
    dial.relabel('v2:room');
    expect(module.transportSnapshot().byTrigger).toEqual({ 'v2:room': 1 });
    expect(module.transportSnapshot().history[0].trigger).toBe('v2:room');
    // Relabelling to the same trigger changes nothing.
    dial.relabel('v2:room');
    expect(module.transportSnapshot().byTrigger).toEqual({ 'v2:room': 1 });
  });

  it('records whether a reconnect was scheduled, and its delay', async () => {
    const module = await load(true);
    const dial = module.trackTransportSocket(fakeSocket(), 'v2:room', 'board') as diagnostics.TransportDial;
    expect(module.transportSnapshot().history[0].reconnect).toEqual({ scheduled: false, delayMs: null });
    dial.closed({ code: 1006, wasClean: false });
    dial.reconnected(2_400.4);
    expect(module.transportSnapshot().history[0].reconnect).toEqual({ scheduled: true, delayMs: 2400 });
  });
});

describe('the history and counters', () => {
  it('keeps the history bounded, newest last, while the counters keep counting', async () => {
    const module = await load(true);
    const dials: diagnostics.TransportDial[] = [];
    for (let index = 0; index < module.MAX_TRANSPORT_HISTORY + 8; index++) {
      dials.push(module.trackTransportSocket(fakeSocket(), 'courier:pass', `board-${index}`) as diagnostics.TransportDial);
    }
    const snapshot = module.transportSnapshot();
    expect(snapshot.history).toHaveLength(module.MAX_TRANSPORT_HISTORY);
    expect(snapshot.dials).toBe(module.MAX_TRANSPORT_HISTORY + 8);
    expect(snapshot.open).toBe(module.MAX_TRANSPORT_HISTORY + 8);
    // The newest are kept, and their ids are still the monotonic ones: the
    // oldest evicted entries are the ones missing, never the ids.
    expect(snapshot.history.at(-1)?.id).toBe(dials.at(-1)?.id);
    const evicted = dials.length - module.MAX_TRANSPORT_HISTORY;
    expect(snapshot.history[0].id).toBe(dials[evicted].id);

    for (const dial of dials) dial.closed({ code: 1000, wasClean: true });
    const closed = module.transportSnapshot();
    expect(closed.closed).toBe(module.MAX_TRANSPORT_HISTORY + 8);
    expect(closed.open).toBe(0);
  });

  it('aggregates dials by trigger and closes by author and reason', async () => {
    const module = await load(true);
    const session = module.trackTransportSocket(fakeSocket(), 'session:attach', 'a') as diagnostics.TransportDial;
    const courier = module.trackTransportSocket(fakeSocket(), 'courier:foreign-row', 'a') as diagnostics.TransportDial;
    module.trackTransportSocket(fakeSocket(), 'courier:foreign-row', 'a');
    session.closed({ code: 1006, wasClean: false });
    courier.closed({ code: 1006, wasClean: false });

    const snapshot = module.transportSnapshot();
    expect(snapshot.byTrigger).toEqual({ 'session:attach': 1, 'courier:foreign-row': 2 });
    expect(snapshot.byClose).toEqual({ client: 0, server: 0, network: 2 });
    expect(snapshot.byCloseReason).toEqual({ 'network:1006': 2 });
  });

  it('distinguishes two concurrent sockets by id and keeps them both open', async () => {
    const module = await load(true);
    const first = module.trackTransportSocket(fakeSocket(), 'session:attach', 'a') as diagnostics.TransportDial;
    const second = module.trackTransportSocket(fakeSocket(), 'courier:pass', 'b') as diagnostics.TransportDial;
    expect(first.id).not.toBe(second.id);
    let snapshot = module.transportSnapshot();
    expect(snapshot.open).toBe(2);
    expect(snapshot.history.filter(entry => entry.open).map(entry => entry.id)).toEqual([first.id, second.id]);

    // Overlap is what tells "sequential" from "concurrent": both were open at
    // the same time, and the second outlives the first.
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    first.closed({ code: 1006, wasClean: false });
    snapshot = module.transportSnapshot();
    expect(snapshot.open).toBe(1);
    expect(snapshot.history.find(entry => entry.id === second.id)).toMatchObject({ open: true, closedAt: null });
  });

  it('clears back to an empty ledger', async () => {
    const module = await load(true);
    module.trackTransportSocket(fakeSocket(), 'session:attach', 'a');
    module.clearTransportDiagnostics();
    expect(module.transportSnapshot()).toMatchObject({
      dials: 0, closed: 0, open: 0, byTrigger: {}, byCloseReason: {}, history: [],
      byClose: { client: 0, server: 0, network: 0 }
    });
  });
});

describe('the console payload', () => {
  it('carries the transport record next to the counters', async () => {
    await load(true);
    const { exposeCollaborationDiagnostics } = await import('../../src/sync/realtimeDiagnostics');
    const module = await import('../../src/sync/transportDiagnostics');
    module.trackTransportSocket(fakeSocket(), 'courier:foreign-row', 'board-a');
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const consoleTable = vi.spyOn(console, 'table').mockImplementation(() => undefined);
    try {
      exposeCollaborationDiagnostics('probe', () => ({ rooms: [] }));
      const payload = await globalThis.pboardCollaboration!() as { transport: ReturnType<typeof module.transportSnapshot> };
      expect(payload.transport).toMatchObject({
        enabled: true, dials: 1, open: 1, byTrigger: { 'courier:foreign-row': 1 }
      });
      expect(payload.transport.history[0]).toMatchObject({ trigger: 'courier:foreign-row', room: 'board-a', open: true });
    } finally { consoleInfo.mockRestore(); consoleTable.mockRestore(); }
  });
});

describe('a build without diagnostics', () => {
  it('records nothing and leaves the socket exactly as it was', async () => {
    const module = await load(false);
    const socket = fakeSocket();
    const close = socket.close;
    const before = Object.getOwnPropertyNames(socket).slice().sort();
    const dial = module.trackTransportSocket(socket, 'session:attach', 'a', 'board-device:x');

    expect(dial).toBeUndefined();
    // The whole point of the disabled path is that it is inert: no property is
    // added, the method is the platform's own, nothing is allocated.
    expect(socket.close).toBe(close);
    expect(Object.getOwnPropertyNames(socket).slice().sort()).toEqual(before);
    expect(module.transportSnapshot()).toMatchObject({ enabled: false, dials: 0, closed: 0, open: 0, history: [] });
    expect(module.transportSnapshot().byTrigger).toEqual({});
  });

  it('connects identically through the real session probe, recording nothing', async () => {
    await load(false);
    const { RelaySession } = await import('../../src/sync/operations/logSession');
    const { instantAuthBudget } = await import('../helpers/authBudget');
    const module = await import('../../src/sync/transportDiagnostics');

    class ProbeSocket {
      static OPEN = 1;
      static instances: ProbeSocket[] = [];
      readyState = 1;
      onmessage?: (event: { data: string }) => void;
      onclose?: (event: { code: number }) => void;
      onerror?: () => void;
      sent: unknown[] = [];
      constructor(_url: string | URL) {
        ProbeSocket.instances.push(this);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'welcome', challenge: 'c'.repeat(43), session: 's'.repeat(43), supportedVersions: [3] }) }));
      }
      send(raw: string) { this.sent.push(JSON.parse(raw)); }
      close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    }

    const session = new RelaySession({
      url: 'wss://relay.example.test/ws',
      Socket: ProbeSocket as unknown as typeof WebSocket,
      topic: 'pboard-collab-board-1-cards',
      authBudget: instantAuthBudget()
    });
    // The handshake is unchanged: the probe still resolves on the welcome.
    const probe = await session.probe();
    expect(probe.socket).toBe(ProbeSocket.instances[0]);
    session.begin(probe);
    expect(session.connected()).toBe(true);
    // Nothing was allocated: no record, no counter, and the socket's own
    // `close` is the class's, not a diagnostics wrapper.
    expect(module.transportSnapshot()).toMatchObject({ enabled: false, dials: 0, open: 0, history: [] });
    expect(ProbeSocket.instances[0].close).toBe(ProbeSocket.prototype.close);
  });
});

describe('the transport wiring', () => {
  it('records a dial and a close from the real session probe', async () => {
    const module = await load(true);
    vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
    const { RelaySession } = await import('../../src/sync/operations/logSession');
    const { instantAuthBudget } = await import('../helpers/authBudget');

    /** A socket that answers the probe's welcome and reports its close. */
    class ProbeSocket {
      static OPEN = 1;
      static instances: ProbeSocket[] = [];
      readyState = 1;
      onmessage?: (event: { data: string }) => void;
      onclose?: (event: { code: number; reason: string; wasClean: boolean }) => void;
      onerror?: () => void;
      constructor(_url: string | URL) {
        ProbeSocket.instances.push(this);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'welcome', challenge: 'c'.repeat(43), session: 's'.repeat(43), supportedVersions: [3] }) }));
      }
      send() {}
      close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: 'bye', wasClean: true }); }
    }

    const session = new RelaySession({
      url: 'wss://relay.example.test/ws',
      Socket: ProbeSocket as unknown as typeof WebSocket,
      topic: 'pboard-collab-board-1-cards',
      identity: 'board-device:board-1:abcdef012345',
      authBudget: instantAuthBudget()
    });
    const probe = await session.probe();
    session.begin(probe);

    let snapshot = module.transportSnapshot();
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({
      trigger: 'session:attach',
      room: 'pboard-collab-board-1-cards',
      device: 'board-de',
      open: true
    });
    expect(snapshot.byTrigger).toEqual({ 'session:attach': 1 });

    ProbeSocket.instances[0].close();
    snapshot = module.transportSnapshot();
    expect(snapshot.open).toBe(0);
    // Nothing wraps the socket, so the event alone is what the ledger has: the
    // browser's own 1000 from the server, not a guess about our intent.
    expect(snapshot.history[0].close).toEqual({ code: 1000, reason: 'bye', by: 'server' });
    expect(snapshot.history[0].lifetimeMs).toBeTypeOf('number');
  });
});
