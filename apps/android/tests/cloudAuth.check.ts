import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAndroidGoogleAuth } from '../src/sync/auth';
import { createSyncStorage } from '../src/sync/storage';

beforeEach(() => localStorage.clear());
describe('Android Google authorization', () => {
  it('requires explicit connection, keeps tokens in memory and restores silent authorization after restart', async () => {
    const storage = createSyncStorage();
    const plugin = { authorize: vi.fn().mockResolvedValue({ accessToken: 'private-token' }), disconnect: vi.fn() };
    const auth = createAndroidGoogleAuth(storage, plugin, true);
    await expect(auth.getAccessToken()).rejects.toThrow('not connected');
    await auth.connect();
    expect(plugin.authorize).toHaveBeenCalledWith({ interactive: true, forceRefresh: false });
    await expect(auth.getAccessToken()).resolves.toBe('private-token');
    expect(plugin.authorize).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(localStorage)).not.toContain('private-token');
    const restored = createAndroidGoogleAuth(storage, plugin, true);
    expect(await restored.getConnectionState()).toBe('connected');
    await restored.getAccessToken();
    expect(plugin.authorize).toHaveBeenLastCalledWith({ interactive: false, forceRefresh: false });
  });
  it('coalesces token renewal and retries a rejected token without opening consent UI', async () => {
    const plugin = { authorize: vi.fn().mockResolvedValue({ accessToken: 'token' }), disconnect: vi.fn() };
    const auth = createAndroidGoogleAuth(createSyncStorage(), plugin, true);
    await auth.connect();
    await Promise.all([auth.getAccessToken(true), auth.getAccessToken(true)]);
    expect(plugin.authorize).toHaveBeenCalledTimes(2);
    expect(plugin.authorize).toHaveBeenLastCalledWith({ interactive: false, forceRefresh: true });
    plugin.authorize.mockRejectedValueOnce(new Error('Reconnect in Settings'));
    await expect(auth.getAccessToken(true)).rejects.toThrow('Reconnect');
    await expect(auth.getAccessToken(true)).resolves.toBe('token');
  });
  it('does not mark cancelled authorization connected, and clears local connection even when native cache clearing fails', async () => {
    const plugin = { authorize: vi.fn().mockRejectedValueOnce(new Error('cancelled')), disconnect: vi.fn().mockRejectedValue(new Error('cache')) };
    const auth = createAndroidGoogleAuth(createSyncStorage(), plugin, true);
    await expect(auth.connect()).rejects.toThrow('cancelled');
    expect(await auth.getConnectionState()).toBe('disconnected');
    plugin.authorize.mockResolvedValue({ accessToken: 'token' });
    await auth.connect();
    await expect(auth.disconnect()).rejects.toThrow('cache');
    expect(await auth.getConnectionState()).toBe('disconnected');
    await expect(auth.getAccessToken()).rejects.toThrow('not connected');
  });
  it('rejects a token returned after disconnection and never invokes native auth on web', async () => {
    let resolve!: (result: { accessToken: string }) => void;
    const plugin = { authorize: vi.fn().mockImplementation(() => new Promise(result => { resolve = result; })), disconnect: vi.fn() };
    const auth = createAndroidGoogleAuth(createSyncStorage(), plugin, true);
    const connecting = auth.connect();
    await auth.disconnect();
    resolve({ accessToken: 'late-token' });
    await expect(connecting).rejects.toThrow('disconnected');
    expect(await auth.getConnectionState()).toBe('disconnected');
    const web = createAndroidGoogleAuth(createSyncStorage(), plugin, false);
    expect(web.isConfigured()).toBe(false);
    await expect(web.connect()).rejects.toThrow('installed Android');
    expect(plugin.authorize).toHaveBeenCalledTimes(1);
  });
});
