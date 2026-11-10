import { describe, expect, it, vi } from 'vitest';
import { requestGoogleDriveAdmission } from '../../src/sync/operations/googleDriveAdmission';

const input = { relayUrl: 'wss://relay.example/ws', credentials: { idToken: 'identity', accessToken: 'access' },
  boardId: 'board', folderId: 'folder', challenge: 'c'.repeat(43), session: 's'.repeat(43), now: () => 1_000_000 };
const admission = { ticket: 't'.repeat(43), room: `pboard-drive-${'r'.repeat(43)}`, expiresAt: 1120 };

describe('Google Drive admission', () => {
  it('sends the socket binding and credentials to the relay without following redirects', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(admission)));
    expect(await requestGoogleDriveAdmission({ ...input, fetcher })).toEqual(admission);
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.example/drive/admit');
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(JSON.parse(request.body as string)).toEqual({ ...input.credentials, boardId: input.boardId, folderId: input.folderId,
      challenge: input.challenge, session: input.session });
  });
  it('rejects insecure remote relays, malformed decisions and expired grants', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(admission)));
    await expect(requestGoogleDriveAdmission({ ...input, relayUrl: 'ws://relay.example/ws', fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    for (const result of [{ ...admission, ticket: 'bad' }, { ...admission, room: 'other' }, { ...admission, expiresAt: 1000 }, { ...admission, expiresAt: 1121 }]) {
      await expect(requestGoogleDriveAdmission({ ...input, fetcher: async () => new Response(JSON.stringify(result)) })).rejects.toThrow();
    }
    await expect(requestGoogleDriveAdmission({ ...input, fetcher: async () => new Response('', { status: 403 }) })).rejects.toThrow('403');
  });
});
