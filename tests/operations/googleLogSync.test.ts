import { afterEach, expect, it, vi } from 'vitest';
import { createOperationLogSync, clearReconnectLedger } from '../../src/sync/operations/logSync';
import { instantAuthBudget } from '../helpers/authBudget';

const challenge = 'c'.repeat(43), session = 's'.repeat(43), room = `pboard-drive-${'r'.repeat(43)}`;
class Relay {
  static OPEN = 1;
  static instances: Relay[] = [];
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: Record<string, any>[] = [];
  constructor() {
    Relay.instances.push(this);
    queueMicrotask(() => this.push({ type: 'welcome', version: 1, supportedVersions: [3], challenge, session }));
  }
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(raw: string) {
    const frame = JSON.parse(raw); this.sent.push(frame);
    if (frame.type === 'authenticate') queueMicrotask(() => this.push({ type: 'authenticated', version: 3, session, role: 'editor' }));
    if (frame.type === 'sync' && frame.request.action === 'subscribe') queueMicrotask(() => this.push({ type: 'sync', action: 'window', board: room,
      operations: [], checkpointSeq: 0, liveFromSeq: 1, synced: true }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
}
afterEach(() => { clearReconnectLedger(); Relay.instances = []; });

it('opens the operation log with a Drive ticket and never asks for device authority', async () => {
  const getKey = vi.fn(async (): Promise<never> => { throw new Error('unexpected device key'); });
  const getAuthorization = vi.fn(async (): Promise<never> => { throw new Error('unexpected manifest'); });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ room, ticket: 't'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 120 })));
  const log = await createOperationLogSync({ boardId: 'board', topic: 'board', url: 'wss://relay.example/ws', getKey, getAuthorization,
    googleDrive: { folderId: 'folder', actorId: 'actor', getCredentials: async () => ({ idToken: 'id', accessToken: 'access' }), fetcher },
    seal: async () => '', open: async () => { throw new Error('unexpected row'); }, receive: async () => {},
    webSocket: Relay as unknown as typeof WebSocket, authBudget: instantAuthBudget() });
  try {
    expect(log.status().phase).toBe('synced');
    expect(getKey).not.toHaveBeenCalled(); expect(getAuthorization).not.toHaveBeenCalled();
    expect(Relay.instances[0].sent[0]).toMatchObject({ type: 'authenticate', version: 3, room, deviceKeyId: 'actor', signature: '', serviceAdmission: 't'.repeat(43) });
    expect(Relay.instances[0].sent[0]).not.toHaveProperty('authorization');
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { await log.close(); }
});
