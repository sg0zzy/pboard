import { createOperationDriveStore, type DriveRole } from '../../src/sync/operations/driveStore';
const auth = { getAccessToken: async () => 'test-only', getConnectionState: async (): Promise<'connected'> => 'connected', connect: async () => {}, disconnect: async () => {}, isConfigured: () => true };
export class ImmutableDriveFake {
  files = new Map<string, { id: string; name: string; parents: string[]; body: string; createdTime: string; contentRestrictions?: any[]; trashed?: boolean }>();
  requests: { url: string; method: string }[] = [];
  role: DriveRole = 'owner';
  timeoutNext = false;
  offline = false;
  next = 0;
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (this.offline) throw new Error('Simulated offline network');
    const url = new URL(String(input)), method = init.method ?? 'GET'; this.requests.push({ url: String(input), method });
    if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: [`file-${++this.next}`] });
    if (method === 'POST') {
      const boundary = new Headers(init.headers).get('Content-Type')!.split('boundary=')[1];
      const parts = String(init.body).split(`--${boundary}`);
      const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      const body = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').slice(0, -2);
      if (this.files.has(metadata.id)) return new Response('', { status: 409 });
      this.files.set(metadata.id, { ...metadata, body, createdTime: new Date(Date.parse('2026-01-01T00:00:00Z') + this.next * 1000).toISOString() });
      if (this.timeoutNext) { this.timeoutNext = false; throw new Error('Simulated timeout after successful create'); }
      return Response.json({ id: metadata.id });
    }
    const id = url.pathname.split('/').pop()!;
    if (id === 'folder' && this.role === 'revoked') return new Response('', { status: 403 });
    if (id === 'folder') return Response.json({ id, name: 'board', ownedByMe: this.role === 'owner', capabilities: { canAddChildren: this.role === 'owner' || this.role === 'editor' } });
    if (id === 'files') return Response.json({ files: [...this.files.values()].filter(file => !file.trashed).map(({ body, ...file }) => ({ ...file, size: String(new TextEncoder().encode(body).length) })) });
    const file = this.files.get(id);
    if (!file) return new Response('', { status: 404 });
    if (method === 'PATCH') { Object.assign(file, JSON.parse(String(init.body))); return Response.json(file); }
    return url.searchParams.get('alt') === 'media' ? new Response(file.body)
      : Response.json({ ...file, id, parents: file.parents, size: String(new TextEncoder().encode(file.body).length) });
  };
  store() { return createOperationDriveStore({ auth, folderId: 'folder', boardId: 'board', role: async () => this.role, fetcher: this.fetch }); }
}

