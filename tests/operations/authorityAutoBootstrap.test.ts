import { describe, expect, it, vi } from 'vitest';
import { createAuthorityAutoBootstrap } from '../../src/sync/runtime';

/**
 * The zero-touch consent change, isolated: opening one's own writable board
 * bootstraps its local authority automatically. The factory is deliberately
 * pure about its inputs — connection, Drive role, local bundle, sync — so
 * every gate is observable here without a runtime, a Drive stub, or Google.
 * What the factory delegates *past* `sync` (that `identitySharing.sync`
 * creates an authority only with no local bundle, no advertised authority
 * and no existing signed/legacy trust) is covered by the identity-sharing
 * suites; the panel's checkbox path is unchanged and still available.
 */
function bootstrap(overrides: Partial<{ connected: boolean; role: string | Error; bundle: boolean; fails: unknown }> = {}) {
  const sync = vi.fn(async () => { if (overrides.fails) throw overrides.fails; });
  const boardId = 'board-1';
  const run = createAuthorityAutoBootstrap({
    driveConnected: async () => overrides.connected ?? true,
    hasLocalBundle: async () => overrides.bundle ?? false,
    sync
  });
  const folderRole = vi.fn(async () => { if (overrides.role instanceof Error) throw overrides.role; return overrides.role ?? 'owner'; });
  return { boardId, run, sync, folderRole };
}

describe('automatic authority bootstrap on board open (relay posture)', () => {
  it('bootstraps a writable board that has no local bundle', async () => {
    for (const role of ['owner', 'editor']) {
      const context = bootstrap({ role });
      await context.run(context.boardId, context.folderRole);
      expect(context.sync).toHaveBeenCalledWith(context.boardId);
    }
  });

  it('never bootstraps for a viewer, a revoked board, or a role it cannot read', async () => {
    for (const scenario of [{ role: 'viewer' }, { role: 'revoked' }, { role: new Error('Drive said no') }] as const) {
      const context = bootstrap({ role: scenario.role });
      // A failing role read must not throw either: the board falls back to
      // its existing behaviour, which is the point of the role gate.
      await context.run(context.boardId, context.folderRole);
      expect(context.sync).not.toHaveBeenCalled();
    }
  });

  it('never bootstraps without a connected Google account', async () => {
    const context = bootstrap({ connected: false });
    await context.run(context.boardId, context.folderRole);
    expect(context.sync).not.toHaveBeenCalled();
    // And it does not even ask Drive for the role over the network.
    expect(context.folderRole).not.toHaveBeenCalled();
  });

  it('never bootstraps a board that already has a local bundle — no second authority', async () => {
    const context = bootstrap({ bundle: true });
    await context.run(context.boardId, context.folderRole);
    expect(context.sync).not.toHaveBeenCalled();
  });

  it('propagates a refused bootstrap for the caller to report, after the gates passed', async () => {
    const context = bootstrap({ fails: new Error('This board has existing signed collaboration data.') });
    await expect(context.run(context.boardId, context.folderRole)).rejects.toThrow('existing signed collaboration data');
  });

  it('asks for the role after the bundle check ordering stays cheap: connected, role, bundle', async () => {
    const context = bootstrap();
    await context.run(context.boardId, context.folderRole);
    expect(context.folderRole).toHaveBeenCalledOnce();
    expect(context.sync).toHaveBeenCalledOnce();
  });
});
