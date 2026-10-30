import { createMemorySignalingScope } from '../../src/collab/signaling';
import { createOperationRealtime } from '../../src/sync/operations/realtime';
import { OperationEngine } from '../../src/sync/operations/engine';
import type { Operation } from '../../src/sync/operations/protocol';
const target = globalThis as typeof globalThis & { probe: { result: unknown } };
target.probe = { result: null };
const wait = async (condition: () => boolean) => { const until = Date.now() + 15000; while (!condition()) { if (Date.now() > until) throw new Error('Native WebRTC probe timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
void (async () => {
  const engines = [new OperationEngine('board'), new OperationEngine('board')], date = '2026-01-01';
  const base: Operation[] = [
    { schemaVersion: 1, boardId: 'board', actorId: 'base', seq: 1, opId: 'base:1', clock: 1, deps: {}, collection: 'projects', entityId: 'board', kind: 'create', fields: { name: 'Board', template: 'project', createdAt: date, updatedAt: date }, unset: [] },
    { schemaVersion: 1, boardId: 'board', actorId: 'base', seq: 2, opId: 'base:2', clock: 2, deps: { base: 1 }, collection: 'cards', entityId: 'card', kind: 'create', fields: { content: 'Initial', type: 'task', status: 'candidate', orderKey: 'a0', createdAt: date, updatedAt: date }, unset: [] }
  ];
  for (const engine of engines) await engine.receive(base);
  const connections: RTCPeerConnection[] = [];
  let connected = [false, false], permit = true, rejected = false;
  async function connect() {
    const scope = createMemorySignalingScope(); connected = [false, false];
    return Promise.all(engines.map((engine, i) => createOperationRealtime({ signaling: scope.create('operations'), revalidateMs: 100, createPeer: config => { const pc = new RTCPeerConnection(config); connections.push(pc); return pc; }, config: { iceServers: [] },
      canRead: async () => true, canWrite: async () => permit, frontier: () => engine.vector(), receive: async ops => { await engine.receive(ops); }, recover: async () => {},
      state: (peers, error) => { connected[i] = peers.length > 0; if (error?.includes('editing access')) rejected = true; }
    })));
  }
  let transports = await connect();
  try {
    await wait(() => connected.every(Boolean));
    const operation: Operation = { schemaVersion: 1, boardId: 'board', actorId: 'a', seq: 1, opId: 'a:1', clock: 3, deps: { base: 2 }, collection: 'cards', entityId: 'card', kind: 'patch', fields: { content: 'Large message '.repeat(6000) }, unset: [] };
    const started = performance.now(); await engines[0].receive([operation]); await transports[0].broadcast([operation]);
    await wait(() => engines[1].entity('cards', 'card')?.content === operation.fields.content);
    const nativeDeliveryMs = performance.now() - started;
    await engines[1].receive([operation]); // Same logical operation later downloaded from Drive.
    if (engines[0].canonicalState() !== engines[1].canonicalState()) throw new Error('Native delivery did not converge');
    await Promise.all(transports.map(transport => transport.close()));
    transports = await connect(); await wait(() => connected.every(Boolean));
    const oldConnections = connections.length;
    connections.at(-1)!.close(); await wait(() => connections.length > oldConnections && connected.every(Boolean));
    const recovered = { ...operation, actorId: 'recovered', opId: 'recovered:1', clock: 4, fields: { title: 'Recovered connection' } };
    await engines[0].receive([recovered]); await transports[0].broadcast([recovered]); await wait(() => engines[1].entity('cards', 'card')?.title === 'Recovered connection');
    permit = false;
    const denied = { ...operation, actorId: 'denied', opId: 'denied:1', clock: 4, fields: { content: 'must not apply' } };
    await transports[0].broadcast([denied]); await wait(() => rejected);
    if (engines[1].entity('cards', 'card')?.content !== operation.fields.content) throw new Error('Revoked peer changed canonical state');
    target.probe.result = { passed: true, nativeDeliveryMs, chunkedCharacters: String(operation.fields.content).length, deterministic: true, duplicateDelivery: true, reconnect: true, failedConnectionRecovery: true, revokedPeerRejected: true };
  } finally { await Promise.all(transports.map(transport => transport.close())); }
})().catch(error => { target.probe.result = { error: error instanceof Error ? error.message : String(error) }; });
