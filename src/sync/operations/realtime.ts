import type { PboardSignaling } from '../../collab/signaling';
import { canonical, validateFrontier, type Frontier, type Operation } from './protocol';
import { parseStrictJson } from '../../collab/security/canonical';

/** DataChannel delivery only. SDP initiator ordering does not confer board authority.
 * Drive-backed signaling must verify the record owner against the current folder
 * ACL; permission revalidation closes established channels on revocation. */
export async function createOperationRealtime(options: {
  signaling: PboardSignaling; canRead: (peerId: string) => Promise<boolean>; canWrite: (peerId: string) => Promise<boolean>;
  receive: (operations: Operation[]) => Promise<void>; frontier: () => Frontier; recover: () => Promise<void>;
  state?: (peers: string[], error?: string) => void; config?: RTCConfiguration;
  revalidateMs?: number; createPeer?: (config?: RTCConfiguration) => RTCPeerConnection;
}) {
  const peers = new Map<string, { connection: RTCPeerConnection; channel?: RTCDataChannel }>();
  const chunks = new Map<string, { parts: string[]; total: number; peer: string; bytes: number; at: number }>();
  let closed = false, ownId = '', roster: string[] = [];
  let rosterQueue: Promise<unknown> = Promise.resolve();
  const announce = (error?: string) => options.state?.([...peers].filter(([, value]) => value.channel?.readyState === 'open').map(([id]) => id), error);
  const drop = (id: string) => { const peer = peers.get(id); peers.delete(id); peer?.channel?.close(); peer?.connection.close(); for (const [key, value] of chunks) if (value.peer === id) chunks.delete(key); announce(); };
  function send(channel: RTCDataChannel, value: unknown) {
    if (channel.readyState !== 'open' || channel.bufferedAmount > 2 * 1024 * 1024) return false;
    const body = canonical(value), id = crypto.randomUUID();
    if (body.length > 8000 * 128) return false; // Large text edits use durable Drive delivery.
    for (let n = 0; n < body.length; n += 8000) channel.send(JSON.stringify({ id, index: n / 8000, total: Math.ceil(body.length / 8000), text: body.slice(n, n + 8000) }));
    return true;
  }
  async function receive(peerId: string, text: string) {
    if (closed || !await options.canRead(peerId)) { drop(peerId); return; }
    const frame = parseStrictJson(text) as any;
    if (!frame || typeof frame.id !== 'string' || frame.id.length > 100 || !Number.isInteger(frame.index) || frame.index < 0
      || !Number.isInteger(frame.total) || frame.total < 1 || frame.total > 128 || typeof frame.text !== 'string' || frame.text.length > 8000) throw new Error('Invalid realtime frame');
    const key = `${peerId}:${frame.id}`, buffered = chunks.get(key) ?? { parts: [] as string[], total: frame.total, peer: peerId, bytes: 0, at: Date.now() };
    if (!chunks.has(key) && chunks.size >= 16) throw new Error('Too many incomplete realtime messages');
    if (buffered.total !== frame.total || frame.index !== buffered.parts.length) throw new Error('Out-of-order realtime frame');
    buffered.parts.push(frame.text); buffered.bytes += frame.text.length;
    if (buffered.bytes > 1024 * 1024) throw new Error('Realtime message exceeds size limit');
    chunks.set(key, buffered);
    if (buffered.parts.length !== buffered.total) return;
    chunks.delete(key);
    const value = parseStrictJson(buffered.parts.join(''), 4 * 1024 * 1024) as any;
    if (value?.protocol !== 'pboard-operations-v1') throw new Error('Upgrade Pboard: unsupported realtime protocol');
    if (value.kind === 'have') { validateFrontier(value.frontier); if (canonical(value.frontier) !== canonical(options.frontier())) void options.recover().catch(error => announce(String(error))); }
    else if (value.kind === 'operations' && Array.isArray(value.operations) && value.operations.length <= 128) {
      if (!await options.canWrite(peerId)) throw new Error('Peer no longer has Drive editing access');
      await options.receive(value.operations);
    } else throw new Error('Invalid realtime message');
  }
  function channel(id: string, connection: RTCPeerConnection, data: RTCDataChannel) {
    const peer = peers.get(id); if (!peer || peer.connection !== connection) { data.close(); return; }
    peer.channel = data; let tail: Promise<unknown> = Promise.resolve(), queued = 0;
    data.onopen = () => { send(data, { protocol: 'pboard-operations-v1', kind: 'have', frontier: options.frontier() }); announce(); };
    data.onclose = () => { if (peers.get(id)?.channel === data) drop(id); };
    data.onmessage = event => {
      if (typeof event.data !== 'string' || ++queued > 256) { drop(id); return; }
      tail = tail.then(() => receive(id, event.data)).catch(error => { announce(String(error)); drop(id); }).finally(() => { queued--; });
    };
  }
  function connection(id: string) {
    const present = peers.get(id); if (present) return present.connection;
    const pc = options.createPeer?.(options.config) ?? new RTCPeerConnection(options.config);
    peers.set(id, { connection: pc });
    pc.ondatachannel = event => channel(id, pc, event.channel);
    pc.onicecandidate = event => { if (!event.candidate && pc.localDescription && !closed) void options.signaling.sendSignal(id, { description: pc.localDescription.toJSON() }).catch(error => announce(String(error))); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) drop(id); };
    return pc;
  }
  async function reconcile(next: string[]) {
    roster = next;
    if (!ownId || closed) return;
    for (const id of peers.keys()) if (!next.includes(id)) drop(id);
    for (const id of next) {
      if (id === ownId || peers.has(id) || !await options.canRead(id) || closed) continue;
      const pc = connection(id);
      if (ownId < id) {
        channel(id, pc, pc.createDataChannel('pboard-operations-v1'));
        await pc.setLocalDescription(await pc.createOffer());
      }
    }
  }
  options.signaling.onSignal((id, input) => {
    void (async () => {
      if (closed || !await options.canRead(id)) return;
      const description = (input as any)?.description;
      if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 65536) throw new Error('Invalid SDP');
      const pc = connection(id);
      if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') return;
      if (description.type === 'offer' && pc.signalingState !== 'stable') return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') await pc.setLocalDescription(await pc.createAnswer());
    })().catch(error => { announce(String(error)); drop(id); });
  });
  try {
    const joined = await options.signaling.join(next => {
      roster = next;
      if (ownId) rosterQueue = rosterQueue.then(() => reconcile(next)).catch(error => announce(String(error)));
    });
    ownId = joined.peerId;
    await reconcile([...new Set([...joined.peers, ...roster])]);
  } catch (error) {
    closed = true; for (const id of [...peers.keys()]) drop(id); await options.signaling.leave().catch(() => undefined); throw error;
  }
  const revalidate = setInterval(() => {
    for (const id of peers.keys()) void options.canRead(id).then(allowed => { if (!allowed) drop(id); }).catch(() => drop(id));
    rosterQueue = rosterQueue.then(() => reconcile(roster)).catch(error => announce(String(error)));
    for (const [key, chunk] of chunks) if (Date.now() - chunk.at > 30000) chunks.delete(key);
  }, options.revalidateMs ?? 10000);
  return {
    async broadcast(operations: Operation[]) {
      let sent = false;
      for (const [id, peer] of peers) if (peer.channel && await options.canRead(id)) sent = send(peer.channel, { protocol: 'pboard-operations-v1', kind: 'operations', operations }) || sent;
      return sent;
    },
    async close() { closed = true; clearInterval(revalidate); for (const id of [...peers.keys()]) drop(id); chunks.clear(); await options.signaling.leave(); }
  };
}
