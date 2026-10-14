import { Capacitor, registerPlugin } from '@capacitor/core';
import type { GoogleAuthProvider } from '../../../../src/sync/googleAuth';
import type { KeyValueStorage } from '../../../../src/storage/repository';

export interface NativeDriveAuth {
  authorize(options: { interactive: boolean; forceRefresh: boolean }): Promise<{ accessToken: string }>;
  disconnect(): Promise<void>;
}
const nativeAuth = registerPlugin<NativeDriveAuth>('GoogleDriveAuth');
const CONNECTED = 'googleDriveConnected';

export function createAndroidGoogleAuth(storage: KeyValueStorage, plugin: NativeDriveAuth = nativeAuth,
  available = Capacitor.getPlatform?.() === 'android'): GoogleAuthProvider {
  let token: string | undefined;
  let expiresAt = 0;
  let refreshing: Promise<string> | undefined;
  let generation = 0;
  async function authorize(interactive: boolean, forceRefresh: boolean): Promise<string> {
    if (!available) throw new Error('Google Drive authorization requires the installed Android app.');
    const current = generation;
    const result = await plugin.authorize({ interactive, forceRefresh });
    if (generation !== current) throw new Error('Google Drive was disconnected.');
    if (!result.accessToken) throw new Error('Google did not return an access token.');
    token = result.accessToken;
    // Native GIS owns token caching/renewal. Keep only a short-lived memory copy.
    expiresAt = Date.now() + 5 * 60_000;
    return token;
  }
  return {
    isConfigured: () => available,
    async connect() {
      await authorize(true, false);
      await storage.set({ [CONNECTED]: true });
    },
    async disconnect() {
      ++generation;
      token = undefined;
      expiresAt = 0;
      await storage.set({ [CONNECTED]: false });
      await plugin.disconnect();
    },
    async getConnectionState() { return available && (await storage.get(CONNECTED))[CONNECTED] === true ? 'connected' : 'disconnected'; },
    async getAccessToken(forceRefresh = false) {
      if ((await storage.get(CONNECTED))[CONNECTED] !== true) throw new Error('Google Drive is not connected.');
      if (!forceRefresh && token && Date.now() < expiresAt) return token;
      return refreshing ??= authorize(false, forceRefresh).finally(() => { refreshing = undefined; });
    },
  };
}
