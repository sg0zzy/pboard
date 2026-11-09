import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelaySession, type SessionAttachment } from '../../src/sync/operations/logSession';

class Socket {
  static OPEN = 1;
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
