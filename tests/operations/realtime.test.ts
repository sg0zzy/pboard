import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PboardSignal, PboardSignaling } from '../../src/collab/signaling';
import type { Frontier, Operation } from '../../src/sync/operations/protocol';
import { createOperationRealtime } from '../../src/sync/operations/realtime';

/** Loopback DataChannel and peer connection: no real ICE, so frame rules, limits and
 * permission gates are observed as the transport itself enforces them. Delivery is
 * microtask-based so fake timers can advance the revalidation interval deterministically. */
type FakeChannel = {
  readyState: string; bufferedAmount: number; frames: string[]; peer?: FakeChannel;
  onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: unknown }) => void;
  send: (text: string) => void; close: () => void;
};
type FakeDescription = { type: string; sdp: string };
type FakeConnection = {
  signalingState: string; connectionState: string; closed: number;
  localDescription?: FakeDescription & { toJSON: () => unknown };
  remoteDescriptions: FakeDescription[]; dataChannels: string[];
  ondatachannel?: (event: { channel: FakeChannel }) => void;
  onicecandidate?: (event: { candidate: unknown }) => void;
  onconnectionstatechange?: () => void;
  createDataChannel: (label: string) => FakeChannel;
  createOffer: () => Promise<FakeDescription>;
  createAnswer: () => Promise<FakeDescription>;
  setLocalDescription: (description: FakeDescription) => Promise<void>;
  setRemoteDescription: (description: FakeDescription) => Promise<void>;
  close: () => void;
};
type Node = {
  id: string; connections: FakeConnection[]; channels: FakeChannel[];
  signals: Array<{ to: string; signal: PboardSignal }>; errors: string[]; open: string[];
  applied: Operation[]; recovered: number; left: boolean; allowRead: boolean; allowWrite: boolean;
  frontier: Frontier;
  roster?: (peers: string[]) => void; signal?: (from: string, signal: PboardSignal) => void;
};

function fakeChannel(node: Node): FakeChannel {
  const value: FakeChannel = {
    readyState: 'open', bufferedAmount: 0, frames: [],
    send: text => {
      value.frames.push(text);
      const target = value.peer;
      queueMicrotask(() => target?.onmessage?.({ data: text }));
    },
    close: () => {
      if (value.readyState === 'closed') return;
      value.readyState = 'closed';
      queueMicrotask(() => value.onclose?.());
    },
  };
  node.channels.push(value);
  return value;
}

function connectionFor(node: Node, other: Node): FakeConnection {
  const connection: FakeConnection = {
    signalingState: 'stable', connectionState: 'connected', closed: 0,
    remoteDescriptions: [], dataChannels: [],
    createDataChannel: label => {
      connection.dataChannels.push(label);
      const local = fakeChannel(node), remote = fakeChannel(other);
      local.peer = remote; remote.peer = local;
      queueMicrotask(() => {
        other.connections.at(-1)?.ondatachannel?.({ channel: remote });
        queueMicrotask(() => { local.onopen?.(); remote.onopen?.(); });
      });
      return local;
    },
    createOffer: async () => ({ type: 'offer', sdp: `offer-${node.id}` }),
    createAnswer: async () => ({ type: 'answer', sdp: `answer-${node.id}` }),
    setLocalDescription: async description => {
      connection.localDescription = { type: description.type, sdp: description.sdp, toJSON: () => description };
      connection.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
      queueMicrotask(() => connection.onicecandidate?.({ candidate: { candidate: `gathered-${node.id}` } }));
      queueMicrotask(() => connection.onicecandidate?.({ candidate: null }));
    },
    setRemoteDescription: async description => {
      connection.remoteDescriptions.push(description);
      connection.signalingState = connection.signalingState === 'have-local-offer' ? 'stable'
        : description.type === 'offer' ? 'have-remote-offer' : 'stable';
    },
    close: () => { connection.closed += 1; connection.connectionState = 'closed'; },
  };
  node.connections.push(connection);
  return connection;
}

const frame = (id: string, index: number, total: number, text: string) =>
  JSON.stringify({ id, index, total, text });
const inject = (node: Node, data: unknown) => node.channels[0].onmessage?.({ data });
const edit = (content: string): Operation => ({
  schemaVersion: 1, boardId: 'board', actorId: 'peer-1', seq: 1, opId: `op-${content}`,
  clock: 1, deps: { base: 2 }, collection: 'cards', entityId: 'card', kind: 'patch',
  fields: { content }, unset: [],
});

async function connect(options: { roster?: string[] } = {}) {
  const nodes: Node[] = [0, 1].map(index => ({
    id: `peer-${index}`, connections: [], channels: [], signals: [], errors: [], open: [],
    applied: [], recovered: 0, left: false, allowRead: true, allowWrite: true,
    frontier: { base: 2 },
  }));
  const transports = await Promise.all(nodes.map((node, index) => createOperationRealtime({
    signaling: {
      join: async onRoster => {
        node.roster = onRoster;
        const peers = options.roster ?? [nodes[1 - index].id];
        onRoster(peers);
        return { peerId: node.id, peers };
      },
      sendSignal: async (to, signal) => {
        node.signals.push({ to, signal });
        nodes.find(candidate => candidate.id === to)?.signal?.(node.id, signal);
      },
      onSignal: handler => { node.signal = handler; },
      leave: async () => { node.left = true; },
    } satisfies PboardSignaling,
    canRead: async () => node.allowRead,
    canWrite: async () => node.allowWrite,
    receive: async operations => { node.applied.push(...operations); },
    frontier: () => node.frontier,
    recover: async () => { node.recovered += 1; },
    state: (peers, error) => { node.open = peers; if (error) node.errors.push(error); },
    revalidateMs: 1000,
    createPeer: () => connectionFor(node, nodes[1 - index]) as unknown as RTCPeerConnection,
  })));
  await vi.advanceTimersByTimeAsync(0);
  return { nodes, transports };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('realtime transport frame rules', () => {
  it('reassembles a large text edit split into transport-sized frames in order', async () => {
    const { nodes, transports } = await connect();
    const message = JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'operations', operations: [edit('y'.repeat(10000))] });
    for (let n = 0; n < message.length; n += 8000) {
      inject(nodes[1], frame('msg-1', n / 8000, Math.ceil(message.length / 8000), message.slice(n, n + 8000)));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].applied).toEqual([edit('y'.repeat(10000))]);
    expect(nodes[1].errors).toEqual([]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('refuses a message above the frame budget so durable Drive delivery stays the path', async () => {
    const { nodes, transports } = await connect();
    expect(await transports[0].broadcast([edit('z'.repeat(8000 * 128))])).toBe(false);
    expect(nodes[1].applied).toEqual([]);
    expect(await transports[0].broadcast([edit('z'.repeat(100))])).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].applied).toEqual([edit('z'.repeat(100))]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('stops sending to a peer whose channel buffer is over the limit and resumes once it drains', async () => {
    const { nodes, transports } = await connect();
    const out = nodes[0].channels[0];
    out.bufferedAmount = 2 * 1024 * 1024 + 1;
    expect(await transports[0].broadcast([edit('Slowed edit')])).toBe(false);
    out.bufferedAmount = 0;
    expect(await transports[0].broadcast([edit('Drained edit')])).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].applied).toEqual([edit('Drained edit')]);
    expect(nodes[1].errors).toEqual([]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('refuses a frame whose index is ahead of the buffer instead of stitching it in', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('msg-2', 1, 2, 'ahead'));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Out-of-order realtime frame')]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    expect(nodes[1].applied).toEqual([]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('caps incomplete buffers at sixteen concurrent messages', async () => {
    const { nodes, transports } = await connect();
    for (let n = 0; n < 16; n++) inject(nodes[1], frame(`msg-${n}`, 0, 2, 'x'));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([]);
    inject(nodes[1], frame('msg-16', 0, 2, 'x'));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Too many incomplete realtime messages')]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('refuses a frame whose total falls outside the one-to-one-hundred-twenty-eight window', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('msg-3', 0, 0, 'x'));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Invalid realtime frame')]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('refuses a frame text longer than the transport frame size', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('msg-4', 0, 1, 'x'.repeat(8001)));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Invalid realtime frame')]);
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport permission gates', () => {
  it('refuses a foreign realtime protocol instead of applying its message', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('msg-7', 0, 1, JSON.stringify({ protocol: 'other-app', kind: 'have', frontier: { base: 2 } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Upgrade Pboard: unsupported realtime protocol')]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('refuses an operation batch larger than one hundred twenty-eight entries', async () => {
    const { nodes, transports } = await connect();
    const message = JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'operations', operations: Array.from({ length: 129 }, () => edit('x')) });
    // the batch no longer fits one frame, so it arrives as a multi-frame message
    for (let n = 0; n < message.length; n += 8000) {
      inject(nodes[1], frame('msg-8', n / 8000, Math.ceil(message.length / 8000), message.slice(n, n + 8000)));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Invalid realtime message')]);
    expect(nodes[1].applied).toEqual([]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('refuses an operation batch from a peer that lost editing access before it is processed', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('msg-9', 0, 1, JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'operations', operations: [edit('Revoked edit')] })));
    nodes[1].allowWrite = false;
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Peer no longer has Drive editing access')]);
    expect(nodes[1].applied).toEqual([]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('silently closes a peer whose read access was revoked, even on an established channel', async () => {
    const { nodes, transports } = await connect();
    nodes[1].allowRead = false;
    inject(nodes[1], frame('msg-10', 0, 1, JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'operations', operations: [edit('Denied edit')] })));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([]);
    expect(nodes[1].applied).toEqual([]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('revokes an established peer at the revalidation interval so access cannot outlive the folder share', async () => {
    const { nodes, transports } = await connect();
    expect(nodes[1].open).toEqual(['peer-0']);
    nodes[1].allowRead = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(nodes[1].open).toEqual([]);
    expect(nodes[1].errors).toEqual([]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    expect(nodes[1].connections[0].closed).toBe(1);
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport in-flight depth', () => {
  it('drops a peer once more than 256 messages are pending at once', async () => {
    const { nodes, transports } = await connect();
    const handshake = JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'have', frontier: { base: 2 } });
    // a slot releases only when its receive settles, so the cap is reached by delivering
    // more messages than the transport can drain; the drop itself is silent
    for (let n = 0; n < 257; n++) inject(nodes[1], frame(`pending-${n}`, 0, 1, handshake));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].open).toEqual([]);
    expect(nodes[1].errors).toEqual([]);
    expect(nodes[1].applied).toEqual([]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    expect(nodes[1].connections[0].closed).toBe(1);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('drops a peer that sends binary frame data instead of text', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], new Uint8Array([1, 2, 3]));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport chunk windows', () => {
  const message = JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'operations', operations: [edit('x')] });

  it('keeps a partial message inside its window and evicts one that stalls past it', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('ttl-1', 0, 2, message.slice(0, 60)));
    await vi.advanceTimersByTimeAsync(29000);
    inject(nodes[1], frame('ttl-1', 1, 2, message.slice(60)));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].applied).toEqual([edit('x')]);
    inject(nodes[1], frame('ttl-2', 0, 2, message.slice(0, 60)));
    await vi.advanceTimersByTimeAsync(31000);
    inject(nodes[1], frame('ttl-2', 1, 2, message.slice(60)));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Out-of-order realtime frame')]);
    expect(nodes[1].applied).toEqual([edit('x')]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport roster', () => {
  it('connects only the peers the roster names and drops a peer removed from it', async () => {
    const { nodes, transports } = await connect({ roster: [] });
    expect(nodes[0].connections.length).toBe(0);
    nodes[0].roster!([nodes[1].id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].open).toEqual([nodes[1].id]);
    nodes[0].roster!([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].open).toEqual([]);
    expect(nodes[0].channels[0].readyState).toBe('closed');
    expect(nodes[0].connections[0].closed).toBe(1);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('will not open a channel for a rostered peer that read access denies', async () => {
    const { nodes, transports } = await connect({ roster: [] });
    nodes[0].allowRead = false;
    nodes[0].roster!([nodes[1].id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].connections.length).toBe(0);
    nodes[0].allowRead = true;
    nodes[0].roster!([nodes[1].id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].connections.length).toBe(1);
    expect(nodes[0].open).toEqual([nodes[1].id]);
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport signalling', () => {
  it('lets the lower peer id open the channel and the higher peer id answer', async () => {
    const { nodes, transports } = await connect();
    expect(nodes[0].connections[0].dataChannels).toEqual(['pboard-operations-v1']);
    expect(nodes[1].connections[0].dataChannels).toEqual([]);
    expect(nodes[1].connections[0].remoteDescriptions).toEqual([{ type: 'offer', sdp: 'offer-peer-0' }]);
    expect(nodes[1].connections[0].localDescription?.type).toBe('answer');
    expect(nodes[0].connections[0].remoteDescriptions).toEqual([{ type: 'answer', sdp: 'answer-peer-1' }]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('ignores an SDP that does not match the connection phase', async () => {
    const { nodes, transports } = await connect();
    nodes[1].signal!(nodes[0].id, { description: { type: 'answer', sdp: 'late-answer' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].connections[0].remoteDescriptions.length).toBe(1);
    expect(nodes[1].errors).toEqual([]);
    expect(nodes[1].open).toEqual([nodes[0].id]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('drops a peer that sends a malformed SDP', async () => {
    const { nodes, transports } = await connect();
    nodes[0].signal!('peer-1', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].errors).toEqual([expect.stringContaining('Invalid SDP')]);
    expect(nodes[0].open).toEqual([]);
    expect(nodes[0].channels[0].readyState).toBe('closed');
    expect(nodes[0].connections[0].closed).toBe(1);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('signals the local description only once ICE gathering completes', async () => {
    const { nodes, transports } = await connect();
    expect(nodes[0].signals.length).toBe(1);
    nodes[0].connections[0].onicecandidate?.({ candidate: { candidate: 'candidate-1' } });
    expect(nodes[0].signals.length).toBe(1);
    nodes[0].connections[0].onicecandidate?.({ candidate: null });
    expect(nodes[0].signals.length).toBe(2);
    await transports[0].close();
    nodes[0].connections[0].onicecandidate?.({ candidate: null });
    expect(nodes[0].signals.length).toBe(2);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('closes a data channel that belongs to a connection already replaced', async () => {
    const { nodes, transports } = await connect();
    nodes[0].connections[0].connectionState = 'failed';
    nodes[0].connections[0].onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].open).toEqual([]);
    nodes[0].roster!([nodes[1].id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].connections.length).toBe(2);
    const live = nodes[0].channels[1];
    expect(live.readyState).toBe('open');
    const stale = fakeChannel(nodes[0]);
    nodes[0].connections[0].ondatachannel?.({ channel: stale });
    expect(stale.readyState).toBe('closed');
    expect(live.readyState).toBe('open');
    expect(nodes[0].open).toEqual([nodes[1].id]);
    expect(nodes[0].errors).toEqual([]);
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport broadcast', () => {
  it('sends to an open peer and stops once read access is revoked', async () => {
    const { nodes, transports } = await connect();
    const sent = nodes[0].channels[0].frames.length;
    expect(await transports[0].broadcast([edit('x')])).toBe(true);
    expect(nodes[0].channels[0].frames.length).toBe(sent + 1);
    const delivered: unknown = JSON.parse(JSON.parse(nodes[0].channels[0].frames.at(-1)!).text);
    expect(delivered).toEqual({ protocol: 'pboard-operations-v1', kind: 'operations', operations: [edit('x')] });
    nodes[0].allowRead = false;
    expect(await transports[0].broadcast([edit('y')])).toBe(false);
    expect(nodes[0].channels[0].frames.length).toBe(sent + 1);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('reports nothing sent when no channel is open', async () => {
    const { nodes, transports } = await connect({ roster: [] });
    expect(nodes[0].channels.length).toBe(0);
    expect(await transports[0].broadcast([edit('x')])).toBe(false);
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport close', () => {
  it('leaves the room and ignores everything delivered afterwards', async () => {
    const { nodes, transports } = await connect();
    const message = JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'operations', operations: [edit('After close')] });
    await transports[0].close();
    expect(nodes[0].left).toBe(true);
    expect(nodes[0].open).toEqual([]);
    expect(nodes[0].channels[0].readyState).toBe('closed');
    expect(await transports[0].broadcast([edit('After close')])).toBe(false);
    inject(nodes[0], frame('late-1', 0, 1, message));
    nodes[0].signal!('peer-1', { description: { type: 'offer', sdp: 'late-offer' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[0].applied).toEqual([]);
    expect(nodes[0].errors).toEqual([]);
    expect(nodes[0].connections.length).toBe(1);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('drops every peer when the transport closes', async () => {
    const { nodes, transports } = await connect();
    await transports[1].close();
    expect(nodes[1].left).toBe(true);
    expect(nodes[1].open).toEqual([]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    expect(nodes[1].connections[0].closed).toBe(1);
    await Promise.all(transports.map(transport => transport.close()));
  });
});

describe('realtime transport frontier handshake', () => {
  const have = (frontier: Frontier) => JSON.stringify({ protocol: 'pboard-operations-v1', kind: 'have', frontier });

  it('does not recover from a peer that already agrees on the frontier', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('match-1', 0, 1, have({ base: 2 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].recovered).toBe(0);
    expect(nodes[1].errors).toEqual([]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('asks for recovery when a peer reports a different frontier', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('diverge-1', 0, 1, have({ base: 2, 'peer-0': 4 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].recovered).toBe(1);
    expect(nodes[1].errors).toEqual([]);
    await Promise.all(transports.map(transport => transport.close()));
  });

  it('drops a peer that reports a frontier with no operation sequence', async () => {
    const { nodes, transports } = await connect();
    inject(nodes[1], frame('empty-1', 0, 1, have({ base: 0 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes[1].errors).toEqual([expect.stringContaining('Invalid operation frontier')]);
    expect(nodes[1].recovered).toBe(0);
    expect(nodes[1].open).toEqual([]);
    expect(nodes[1].channels[0].readyState).toBe('closed');
    await Promise.all(transports.map(transport => transport.close()));
  });
});
