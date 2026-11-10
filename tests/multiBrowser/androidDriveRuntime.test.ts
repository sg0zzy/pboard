import { expect, it } from 'vitest';
import { createAndroidSync } from '../../apps/android/src/sync/service';
import { createBrowser, createCloud, logStatusOf } from './fixtures/browser';

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 5000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error('Timed out waiting for Android runtime');
}

it('uses the Android lifecycle with the shared Drive runtime for bidirectional changes and background replay', { timeout: 120_000 }, async () => {
  const cloud = createCloud();
  const firefox = await createBrowser({ label: 'firefox', email: 'same@example.com', cloud });
  const android = await createBrowser({ label: 'android', email: 'same@example.com', cloud });
  const auth = { isConfigured: () => true, getConnectionState: async () => 'connected' as const,
    connect: async () => {}, disconnect: async () => {}, getAccessToken: async () => 'unused' };
  const service = createAndroidSync(async () => android.rx, auth, android.storage,
    (() => android.runtime) as unknown as Parameters<typeof createAndroidSync>[3]);
  try {
    const board = await firefox.rx.createProject('Android lifecycle', 'project');
    await firefox.runtime.googleDrive.syncProject(board.id, { force: true });
    await android.runtime.googleDrive.reconcileAll({ force: true });
    await firefox.runtime.collaborationManager.start(board.id);
    await service.initialize(); await service.selectProject(board.id); await service.setForeground(true);
    await waitFor(() => logStatusOf(android, board.id)?.phase === 'synced');
    await firefox.rx.addItem({ projectId: board.id, content: 'from Firefox' });
    await waitFor(async () => (await android.rx.listCards(board.id)).some(c => c.content === 'from Firefox'));
    await android.rx.addItem({ projectId: board.id, content: 'from Android' });
    await waitFor(async () => (await firefox.rx.listCards(board.id)).some(c => c.content === 'from Android'));
    await service.setForeground(false);
    await firefox.rx.addItem({ projectId: board.id, content: 'while backgrounded' });
    await service.setForeground(true);
    await waitFor(async () => (await android.rx.listCards(board.id)).some(c => c.content === 'while backgrounded'));
    expect(cloud.signaling.sockets).toHaveLength(2);
  } finally { await service.dispose(); await android.close(); await firefox.close(); }
});
