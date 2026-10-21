// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ connected: false, dirty: true, status: 'pending', connect: vi.fn(), authorize: vi.fn(), reconcile: vi.fn(), sync: vi.fn() }));
vi.mock('../src/platform/browser', () => ({ browser: { storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } } }));
vi.mock('../src/sync/browser', () => ({ googleAuth: { isConfigured: () => true, connect: m.connect },
  googleDrive: { getConnectionState: async () => m.connected ? 'connected' : 'disconnected' },
  driveSyncState: { get: async () => ({ projectId: 'board', dirty: m.dirty, status: m.status }) }, authorizePrivatePersistence: m.authorize }));
vi.mock('../src/sync/client', () => ({ requestDriveReconciliation: m.reconcile, requestProjectSync: m.sync }));
import { DriveSyncControls } from '../src/sidebar/components/DriveSyncControls';
import { driveSyncState } from '../src/sync/browser';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); m.connected = false; m.dirty = true; m.status = 'pending';
  m.connect.mockImplementation(async () => { m.connected = true; }); m.authorize.mockResolvedValue(undefined); m.sync.mockResolvedValue({ ok: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const render = async () => { await act(async () => root.render(<DriveSyncControls projectId="board" />)); };
const click = async (selector: string) => { await act(async () => { (host.querySelector(selector) as HTMLButtonElement).click(); }); };
it('does not enroll any board or start recovery after failed Google authentication', async () => {
  m.connect.mockRejectedValueOnce(Error('Login cancelled')); await render(); await click('button');
  expect(m.authorize).not.toHaveBeenCalled(); expect(m.reconcile).not.toHaveBeenCalled(); expect(host.textContent).toContain('Login cancelled');
});
it('shows the disclosure and records account-scoped enrollment only after successful login', async () => {
  await render(); expect(host.textContent).toContain('selected Google account'); await click('button');
  expect(m.authorize).toHaveBeenCalledOnce(); expect(m.reconcile).toHaveBeenCalledOnce();
  expect(m.connect.mock.invocationCallOrder[0]).toBeLessThan(m.authorize.mock.invocationCallOrder[0]);
  expect(m.authorize.mock.invocationCallOrder[0]).toBeLessThan(m.reconcile.mock.invocationCallOrder[0]);
});
it('the explicit Sync now action enrolls only the selected board before uploading', async () => {
  m.connected = true; await render(); await click('button[aria-label="Sync current project to Google Drive now"]');
  expect(m.authorize).toHaveBeenCalledWith('board'); expect(m.sync).toHaveBeenCalledWith('board');
  expect(m.authorize.mock.invocationCallOrder[0]).toBeLessThan(m.sync.mock.invocationCallOrder[0]);
});
it.each(['synced', 'syncing'])('allows an explicit sync despite cached %s state', async status => {
  m.connected = true; m.dirty = false; m.status = status;
  await render();
  const button = host.querySelector<HTMLButtonElement>('.drive-sync-button')!;
  expect(button.disabled).toBe(false);
  await click('.drive-sync-button');
  expect(m.sync).toHaveBeenCalledWith('board');
  expect(host.textContent).toContain('Drive sync complete');
});
it('shows immediate progress while authorization is pending and prevents duplicate clicks', async () => {
  m.connected = true;
  let release!: () => void;
  m.authorize.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  await render(); await click('.drive-sync-button');
  expect(host.textContent).toContain('Syncing…');
  expect(host.querySelector<HTMLButtonElement>('.drive-sync-button')!.disabled).toBe(true);
  await click('.drive-sync-button'); expect(m.authorize).toHaveBeenCalledOnce(); expect(m.sync).not.toHaveBeenCalled();
  await act(async () => { release(); });
  expect(m.sync).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLButtonElement>('.drive-sync-button')!.disabled).toBe(false);
});
it('shows a visible pending result rather than claiming that retained work is synchronized', async () => {
  m.connected = true; m.sync.mockResolvedValueOnce({ ok: true, pending: true });
  await render(); await click('.drive-sync-button');
  expect(host.textContent).toContain('Drive synchronization is still pending');
});
it('shows a visible failure and leaves manual retry available', async () => {
  m.connected = true; m.sync.mockResolvedValueOnce({ ok: false, reason: 'Drive unavailable' });
  await render(); await click('.drive-sync-button');
  expect(host.querySelector('.drive-sync-feedback')?.textContent).toBe('Drive unavailable');
  expect(host.querySelector<HTMLButtonElement>('.drive-sync-button')!.disabled).toBe(false);
});

it('keeps each board sync running across switches and does not let another board completion unlock it or replace its feedback', async () => {
  m.connected = true;
  let completeA!: (value: unknown) => void, completeB!: (value: unknown) => void;
  m.sync.mockImplementationOnce(() => new Promise(resolve => { completeA = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { completeB = resolve; }));
  const select = async (projectId: string) => { await act(async () => root.render(<DriveSyncControls projectId={projectId} />)); };
  const disabled = () => host.querySelector<HTMLButtonElement>('.drive-sync-button')!.disabled;
  await select('board'); await click('.drive-sync-button');
  expect(disabled()).toBe(true);
  await select('other-board');
  expect(disabled()).toBe(false); expect(host.textContent).not.toContain('Syncing…');
  await click('.drive-sync-button');
  expect(disabled()).toBe(true);
  expect(m.sync.mock.calls.map(call => call[0])).toEqual(['board', 'other-board']);
  await select('board');
  expect(disabled()).toBe(true);
  await click('.drive-sync-button'); expect(m.sync).toHaveBeenCalledTimes(2);
  await select('other-board');
  await act(async () => { completeA({ ok: false, reason: 'Board A failed' }); });
  expect(disabled()).toBe(true); expect(host.textContent).toContain('Syncing…');
  expect(host.textContent).not.toContain('Board A failed');
  await act(async () => { completeB({ ok: true }); });
  expect(disabled()).toBe(false); expect(host.textContent).toContain('Drive sync complete');
  await select('board'); expect(disabled()).toBe(false);
});

it('continues authorization and then uploads the originally requested board after switching', async () => {
  m.connected = true;
  let authorizeA!: () => void;
  m.authorize.mockImplementationOnce(() => new Promise<void>(resolve => { authorizeA = resolve; }));
  await render(); await click('.drive-sync-button');
  await act(async () => root.render(<DriveSyncControls projectId="other-board" />));
  expect(host.querySelector<HTMLButtonElement>('.drive-sync-button')!.disabled).toBe(false);
  await click('.drive-sync-button');
  expect(m.sync).toHaveBeenCalledWith('other-board');
  await act(async () => { authorizeA(); });
  expect(m.sync.mock.calls.map(call => call[0])).toEqual(['other-board', 'board']);
  expect(m.authorize.mock.calls.map(call => call[0])).toEqual(['board', 'other-board']);
  expect(host.querySelector<HTMLButtonElement>('.drive-sync-button')!.disabled).toBe(false);
});

it('ignores an old board status read that completes after the newly selected board status', async () => {
  m.connected = true;
  let release!: (value: any) => void;
  vi.spyOn(driveSyncState, 'get').mockImplementation(async id => id === 'board'
    ? new Promise(resolve => { release = resolve; })
    : { projectId: id, dirty: true, status: 'error', error: 'Current board needs retry' });
  await render();
  await act(async () => root.render(<DriveSyncControls projectId="other-board" />));
  expect(host.querySelector('.drive-status')?.getAttribute('title')).toContain('Current board needs retry');
  await act(async () => { release({ projectId: 'board', dirty: false, status: 'synced' }); });
  expect(host.querySelector('.drive-status')?.getAttribute('title')).toContain('Current board needs retry');
});
