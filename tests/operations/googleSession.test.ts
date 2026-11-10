import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelaySession, type SessionAttachment } from '../../src/sync/operations/logSession';
import { instantAuthBudget } from '../helpers/authBudget';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  constructor() { Socket.instances.push(this); }
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const welcome = { type: 'welcome', challenge: 'c'.repeat(43), session: 's'.repeat(43), supportedVersions: [3] };
const ticket = 't'.repeat(43);
const room = 'pboard-drive-test';
afterEach(() => vi.useRealTimers());

describe('Google room renewal', () => {
  it('obtains a fresh ticket when the socket changes during attachment', async () => {
    const old = new Socket(), current = new Socket();
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: room });
    session.begin({ socket: old as unknown as WebSocket, welcome, release: () => {} });
    let finish!: (proof: Awaited<ReturnType<SessionAttachment['prove']>>) => void;
    const prove = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ room, deviceKeyId: 'actor', signature: '', authorization: undefined, serviceAdmission: 'new-ticket' });
    const attached = vi.fn();
    const attachment: SessionAttachment = { topic: room, prove, attached, lost: () => {}, failed: () => {}, deliver: () => {} };
    const result = session.attach(attachment);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const replacementWelcome = { ...welcome, session: 'n'.repeat(43), challenge: 'd'.repeat(43) };
    session.begin({ socket: current as unknown as WebSocket, welcome: replacementWelcome, release: () => {} });
    finish({ room, deviceKeyId: 'actor', signature: '', authorization: undefined, serviceAdmission: 'stale-ticket' });
    await vi.waitFor(() => expect(current.sent.length).toBe(1));
    expect(prove).toHaveBeenCalledTimes(2);
    expect(prove.mock.calls[1][0].session).toBe(replacementWelcome.session);
    expect(current.sent[0]).toMatchObject({ type: 'authenticate', serviceAdmission: 'new-ticket' });
    current.receive({ type: 'authenticated', version: 3, session: replacementWelcome.session, role: 'editor' });
    await expect(result).resolves.toMatchObject({ room, role: 'editor' });
    expect(attached).toHaveBeenCalledOnce();
    session.close();
  });

  it('retries authentication when the first send throws', async () => {
    const socket = new Socket();
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: room });
    session.begin({ socket: socket as unknown as WebSocket, welcome, release: () => {} });
    const send = socket.send.bind(socket);
    socket.send = vi.fn().mockImplementationOnce(() => { throw new Error('socket send failed'); }).mockImplementation(send);
    const make = (id: string): SessionAttachment => ({ topic: id,
      prove: async () => ({ room: id, deviceKeyId: 'actor', signature: '', authorization: undefined, serviceAdmission: ticket }),
      attached: () => {}, lost: () => {}, failed: () => {}, deliver: () => {} });
    await expect(session.attach(make('first'))).rejects.toThrow('socket send failed');
    const next = session.attach(make('second'));
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    expect(socket.sent[0].type).toBe('authenticate');
    socket.receive({ type: 'authenticated', version: 3, session: welcome.session, role: 'editor' });
    await next;
    session.close();
  });

  it('ignores late messages from a replaced socket', async () => {
    const old = new Socket(), current = new Socket();
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: room });
    session.begin({ socket: old as unknown as WebSocket, welcome, release: () => {} });
    session.begin({ socket: current as unknown as WebSocket, welcome, release: () => {} });
    old.receive({ type: 'error', code: 'malformed' });
    expect(session.connected()).toBe(true);
    expect(session.status().throttled).toBe(false);
    session.close();
  });

  it('authenticates a replacement socket when the old socket closes before its close event', async () => {
    Socket.instances = [];
    const socket = new Socket();
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: room, authBudget: instantAuthBudget() });
    session.begin({ socket: socket as unknown as WebSocket, welcome, release: () => {} });
    const make = (id: string): SessionAttachment => ({ topic: id,
      prove: async () => ({ room: id, deviceKeyId: 'actor', signature: '', authorization: undefined, serviceAdmission: ticket }),
      attached: () => {}, lost: () => {}, failed: () => {}, deliver: () => {} });
    const first = session.attach(make('first'));
    await vi.waitFor(() => expect(socket.sent[0]?.type).toBe('authenticate'));
    socket.receive({ type: 'authenticated', version: 3, session: welcome.session, role: 'editor' });
    await first;
    // Firefox has changed readyState but has not dispatched onclose yet.
    socket.readyState = 3;
    const second = session.attach(make('second'));
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
    const replacement = Socket.instances[1];
    replacement.receive(welcome);
    await vi.waitFor(() => expect(replacement.sent.length).toBeGreaterThan(0));
    expect(replacement.sent[0].type).toBe('authenticate');
    replacement.receive({ type: 'authenticated', version: 3, session: welcome.session, role: 'editor' });
    await vi.waitFor(() => expect(replacement.sent.some(frame => frame.type === 'attach')).toBe(true));
    const attach = replacement.sent.find(frame => frame.type === 'attach')!;
    replacement.receive({ type: 'attached', room: attach.room, role: 'editor' });
    await second;
    session.close();
  });

  it('does not send a renewal that completes after the room is detached', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const socket = new Socket();
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: room });
    session.begin({ socket: socket as unknown as WebSocket, welcome, release: () => {} });
    let finish!: (value: { ticket: string; room: string; expiresAt: number }) => void;
    const renew = vi.fn(() => new Promise<{ ticket: string; room: string; expiresAt: number }>(resolve => { finish = resolve; }));
    const failed = vi.fn();
    const attachment: SessionAttachment = { topic: room,
      prove: async () => ({ room, deviceKeyId: 'actor', signature: '', authorization: undefined, serviceAdmission: ticket,
        google: { expiresAt: 1120, renew } }), attached: () => {}, lost: () => {}, failed, deliver: () => {} };
    const attached = session.attach(attachment);
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.type === 'authenticate')).toBe(true));
    socket.receive({ type: 'authenticated', version: 3, session: welcome.session, role: 'editor' });
    await attached;
    await vi.advanceTimersByTimeAsync(90_000);
    session.detach(room, attachment);
    finish({ ticket, room, expiresAt: 1180 });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.some(frame => frame.type === 'renewGoogle')).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    session.close();
  });

  it('renews on the same socket, applies role changes, and detaches if the next renewal fails', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const socket = new Socket();
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: room });
    session.begin({ socket: socket as unknown as WebSocket, welcome, release: () => {} });
    const renew = vi.fn()
      .mockResolvedValueOnce({ ticket, room, expiresAt: 1180 })
      .mockRejectedValueOnce(new Error('revoked'));
    const failed = vi.fn(), roleChanged = vi.fn();
    const attachment: SessionAttachment = { topic: room,
      prove: async () => ({ room, deviceKeyId: 'actor', signature: '', authorization: undefined, serviceAdmission: ticket,
        google: { expiresAt: 1120, renew } }),
      attached: () => {}, lost: () => {}, failed, roleChanged, deliver: () => {} };
    const attached = session.attach(attachment);
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.type === 'authenticate')).toBe(true));
    socket.receive({ type: 'authenticated', version: 3, session: welcome.session, role: 'editor' });
    await attached;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(renew).toHaveBeenCalledOnce();
    expect(socket.sent).toContainEqual({ type: 'renewGoogle', room, serviceAdmission: ticket });
    socket.receive({ type: 'renewedGoogle', room, role: 'viewer' });
    expect(roleChanged).toHaveBeenCalledWith('viewer');
    expect(session.isAttached(room)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toHaveBeenCalledWith('service_auth_required');
    expect(session.isAttached(room)).toBe(false);
    expect(socket.readyState).toBe(Socket.OPEN);
    expect(socket.sent).toContainEqual({ type: 'detach', room });
    session.close();
  });
});
