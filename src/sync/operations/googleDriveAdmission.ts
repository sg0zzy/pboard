/** Request a short-lived, socket-bound Drive authorization decision. */
export type GoogleDriveCredentials = { idToken: string; accessToken: string };
export type DriveAdmission = { ticket: string; room: string; expiresAt: number };

export async function requestGoogleDriveAdmission(options: {
  relayUrl: string;
  credentials: GoogleDriveCredentials;
  boardId: string;
  folderId: string;
  challenge: string;
  session: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<DriveAdmission> {
  const relay = new URL(options.relayUrl);
  if (relay.username || relay.password || relay.search || relay.hash ||
      (relay.protocol !== 'wss:' && !(relay.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname)))) {
    throw new Error('Invalid Drive admission relay URL');
  }
  relay.protocol = relay.protocol === 'wss:' ? 'https:' : 'http:';
  relay.pathname = '/drive/admit';
  const response = await (options.fetcher ?? fetch)(relay.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: options.credentials.idToken, accessToken: options.credentials.accessToken,
      boardId: options.boardId, folderId: options.folderId, challenge: options.challenge, session: options.session }),
    cache: 'no-store', credentials: 'omit', redirect: 'error'
  });
  if (!response.ok) throw new Error(`Drive admission failed (${response.status})`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('Invalid Drive admission response');
  const result = value as Record<string, unknown>;
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (typeof result.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.ticket) ||
      typeof result.room !== 'string' || !/^pboard-drive-[A-Za-z0-9_-]{43}$/.test(result.room) ||
      typeof result.expiresAt !== 'number' || !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= now || result.expiresAt > now + 120) {
    throw new Error('Invalid Drive admission response');
  }
  return { ticket: result.ticket, room: result.room, expiresAt: result.expiresAt };
}

/** Build a room proof for the multiplexed socket, without a device authority. */
export async function createGoogleDriveRoomProof(options: {
  relayUrl: string;
  boardId: string;
  folderId: string;
  accountRoom?: boolean;
  actorId: string;
  getCredentials(): Promise<GoogleDriveCredentials>;
  welcome: import('./logSession').SessionWelcome;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<import('./logSession').RoomProof> {
  const admit = async (welcome: import('./logSession').SessionWelcome) => requestGoogleDriveAdmission({
    relayUrl: options.relayUrl, boardId: options.accountRoom ? '' : options.boardId, folderId: options.accountRoom ? '' : options.folderId,
    credentials: await options.getCredentials(), challenge: welcome.challenge, session: welcome.session,
    fetcher: options.fetcher, now: options.now
  });
  const admission = await admit(options.welcome);
  return { room: admission.room, deviceKeyId: options.actorId, signature: '', authorization: undefined,
    serviceAdmission: admission.ticket, google: { expiresAt: admission.expiresAt, renew: admit } };
}
