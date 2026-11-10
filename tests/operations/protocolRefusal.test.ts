/**
 * A protocol-family refusal (`malformed`, `invalid_state`, `unknown_action`,
 * `invalid_frame`, `version_unsupported`) is a verdict on *this build's frames*:
 * every further dial answers the same way. These tests pin the two properties
 * that were missing when one browser of a mixed-version pair met the deployed
 * relay — the stop (no dial storm into the reconnect ceiling) and the words
 * (the service's own code reported, not the ceiling's `reconnect:throttled`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protocolRefusal, terminalRefusal } from '../../src/sync/operations/logPolicy';
import { RelaySession, type SessionAttachment } from '../../src/sync/operations/logSession';

describe('protocol refusal classification', () => {
  it('treats the protocol family as terminal, and transient refusals as not', () => {
    for (const code of ['malformed', 'invalid_state', 'invalid_frame', 'unknown_action', 'version_unsupported']) {
      expect(protocolRefusal(code)).toBe(true);
      expect(terminalRefusal(code)).toBe(true);
    }
    // The classes a retry (or the person fixing sharing) can actually cure stay
    // out of the protocol family: their wording still blames the refusal, and
    // `server_busy`/`rate_limit` must keep retrying.
    for (const code of ['unauthorized', 'grant_expired', 'service_auth_required', 'server_busy', 'rate_limit', 'slow_consumer']) {
      expect(protocolRefusal(code)).toBe(false);
    }
    expect(terminalRefusal('slow_consumer')).toBe(false);
  });
});

class Socket {
  static OPEN = 1;
  /** Every socket built so far: the session dials with `new Socket(url)`, so a
   * probe in flight is reached through here, not through the session. */
  static readonly instances: Socket[] = [];
  constructor(_url: string) { Socket.instances.push(this); }
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const welcome = { type: 'welcome', challenge: 'c'.repeat(43), session: 's'.repeat(43), supportedVersions: [1, 2, 3] };

const attachment = (topic: string, failed: (code: string) => void): SessionAttachment => ({
  topic,
  prove: async () => ({ room: `room-${topic}`, deviceKeyId: 'dev', signature: 'sig', authorization: undefined }),
  attached: () => {},
  lost: () => {},
  failed,
  deliver: () => {}
});

afterEach(() => vi.useRealTimers());

describe('a connection the service ends with a protocol verdict', () => {
  it('preserves a refusal when another room is still preparing its proof', async () => {
    const socket = new Socket('wss://relay.example/ws');
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: 'a' });
    session.begin({ socket: socket as unknown as WebSocket, welcome, release: () => {} });
    let finish!: (proof: Awaited<ReturnType<SessionAttachment['prove']>>) => void;
    const second = attachment('b', () => {});
    second.prove = () => new Promise(resolve => { finish = resolve; });
    const firstResult = session.attach(attachment('a', () => {})).catch(error => error);
    const secondResult = session.attach(second).catch(error => error);
    await vi.waitFor(() => { expect(finish).toBeDefined(); expect(socket.sent.some(frame => frame.type === 'authenticate')).toBe(true); });
    socket.receive({ type: 'error', code: 'malformed' });
    finish({ room: 'room-b', deviceKeyId: 'dev', signature: 'sig', authorization: undefined });
    expect((await firstResult).message).toContain('malformed');
    expect((await secondResult).message).toContain('malformed');
    expect(socket.sent.filter(frame => frame.type === 'attach')).toHaveLength(0);
    session.close();
  });

  it('stops with the service code and refuses every further dial until Reconnect', async () => {
    vi.useFakeTimers();
    const socket = new Socket('wss://relay.example/ws');
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: 'a' });
    session.begin({ socket: socket as unknown as WebSocket, welcome, release: () => {} });
    const failed = vi.fn();
    const attached = session.attach(attachment('a', failed));
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.type === 'authenticate')).toBe(true));
    // The deployed relay's answer to a build whose first frame it cannot parse.
    socket.receive({ type: 'error', code: 'malformed' });
    await expect(attached).rejects.toThrow('malformed');
    expect(failed).toHaveBeenCalledWith('malformed');

    // The stop: `attach` answers with the service's own verdict, and it answers
    // it *without dialling* — the point of the latch is that a person re-opening
    // the board costs the shared dial budget nothing.
    await expect(session.attach(attachment('b', failed))).rejects.toThrow('malformed');
    expect(session.status().dials).toBe(0);
    expect(session.reconnectNow()).toBe(false);
    expect(session.reconnectNow({ redial: false })).toBe(false);

    // The explicit Reconnect gesture is the only resume. What it clears is the
    // stop itself — the verdict may genuinely be worth another try, because the
    // thing that changed can be either side's build — and after it, a dial is
    // attempted again rather than refused from the ledger.
    expect(session.reconnectNow({ userInitiated: true, redial: false })).toBe(true);
    expect(session.status().throttled).toBe(false);
    const resumed = session.attach(attachment('b', failed));
    await vi.waitFor(() => expect(session.status().dials).toBe(1));
    resumed.catch(() => {});
    session.close();
  });

  it('reports the version verdict when a redial meets a relay without protocol 3', async () => {
    vi.useFakeTimers();
    const session = new RelaySession({ url: 'wss://relay.example/ws', Socket: Socket as unknown as typeof WebSocket, topic: 'a' });
    const failed = vi.fn();
    const attached = session.attach(attachment('a', failed));
    await vi.waitFor(() => expect(session.status().dials).toBe(1));
    const probe = Socket.instances.at(-1)!;
    probe.receive({ ...welcome, supportedVersions: [1, 2] });
    await expect(attached).rejects.toThrow(/protocol 3/);
    expect(session.status().throttled).toBe(true);
    // The next handle hears the service's reason (`version_unsupported` is what
    // `dial` recorded), not `reconnect:throttled`.
    await expect(session.attach(attachment('b', failed))).rejects.toThrow('version_unsupported');
    session.close();
  });
});
