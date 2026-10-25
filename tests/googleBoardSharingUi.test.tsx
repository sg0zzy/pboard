// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoardCollaborationControls } from '../src/sidebar/components/BoardCollaborationControls';

const f = vi.hoisted(() => ({ sync: vi.fn(), getProject: vi.fn(), selectProject: vi.fn(), start: vi.fn(), stop: vi.fn(), getCurrentProject: vi.fn() }));
vi.mock('../src/platform/browser', () => ({ browser: { permissions: { request: vi.fn() } } }));
vi.mock('../src/storage/browser', () => ({ repository: { getProject: f.getProject, selectProject: f.selectProject, getCurrentProject: f.getCurrentProject } }));
vi.mock('../src/sync/browser', () => ({
  boardCollaboration: { settings: async () => ({ provider: 'websocket', url: 'wss://pboard.cecosl.ovh/ws' }), ownsAuthority: async () => false,
    identitySharing: { sync: f.sync, collaborators: async () => [] }, pairing: { pending: async () => null } },
  collaborationManager: { start: f.start, stop: f.stop, state: () => ({ error: null, ready: true, role: 'editor', connectedPeers: [] }) }
}));
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
const reply = (ready = false) => ({ email: 'b@example.test', boards: [{ publication: { policy: { boardId: 'invited-board', ownerEmail: 'a@example.test' } } }], ready: ready ? ['invited-board'] : [] });
const buttons = () => [...container.querySelectorAll('button')].filter(b => b.getAttribute('aria-label')?.startsWith('Open shared board'));
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.sync.mockResolvedValue(reply()); f.getProject.mockResolvedValue(null); f.start.mockResolvedValue(undefined); f.stop.mockResolvedValue(undefined);
  f.getCurrentProject.mockResolvedValue({ id: 'previous-board' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('shows a newly discovered invitation outside collapsed settings, waits for the signed grant, then opens received content', async () => {
  const changed = vi.fn();
  await act(async () => root.render(<BoardCollaborationControls projectId={null} onChanged={changed} />));
  const inbox = container.querySelector('[aria-label="Shared board invitations"]')!;
  expect(inbox).not.toBeNull(); expect(inbox.closest('details')).toBeNull();
  expect(inbox.textContent).toContain('a@example.test'); expect(inbox.textContent).toContain('Waiting for owner');
  expect(buttons()).toHaveLength(0); expect(f.start).not.toHaveBeenCalled();
  f.sync.mockResolvedValue(reply(true));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(buttons()).toHaveLength(1);
  f.start.mockImplementation(async () => { f.getProject.mockResolvedValue({ id: 'invited-board' }); });
  await act(async () => buttons()[0].click());
  expect(f.start).toHaveBeenCalledWith('invited-board');
  expect(f.selectProject).toHaveBeenCalledWith('invited-board');
  expect(changed).toHaveBeenCalledOnce();
});
it('refreshes on focus, never offers boards without invitations, and removes stale invitations when validation fails', async () => {
  f.sync.mockResolvedValue({ email: 'b@example.test', boards: [], ready: [] });
  await act(async () => root.render(<BoardCollaborationControls projectId={null} onChanged={() => {}} />));
  expect(container.querySelector('[aria-label="Shared board invitations"]')).toBeNull();
  f.sync.mockResolvedValue(reply(true));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(buttons()).toHaveLength(1);
  f.sync.mockRejectedValue(new Error('Invalid board identity policy'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(buttons()).toHaveLength(0);
  expect(container.textContent).toContain('Invalid board identity policy');
  expect(f.start).not.toHaveBeenCalled();
});
it('restores the previous live session after a failed open without selecting a missing board', async () => {
  f.sync.mockResolvedValue(reply(true));
  f.start.mockRejectedValueOnce(new Error('Grant expired'));
  await act(async () => root.render(<BoardCollaborationControls projectId="previous-board" onChanged={() => {}} />));
  await act(async () => buttons()[0].click());
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.start.mock.calls.map(call => call[0])).toEqual(['invited-board', 'previous-board']);
  expect(f.selectProject).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Grant expired');
});
it('keeps permitted invitations actionable when another board hits the directory quota', async () => {
  f.sync.mockResolvedValue({ ...reply(true), issues: [{ boardId: 'other-board', code: 'directory_capacity' }] });
  await act(async () => root.render(<BoardCollaborationControls projectId={null} onChanged={() => {}} />));
  expect(buttons()).toHaveLength(1);
  expect(container.textContent).toContain('rendezvous board directory is full');
  expect(container.textContent).toContain('private Drive synchronization continue independently');
  expect(f.start).not.toHaveBeenCalled();
});
it('separates the account’s own boards from invitations and routes them to Drive restore', async () => {
  f.sync.mockResolvedValue({ email: 'b@example.test', boards: [
    { publication: { policy: { boardId: 'own-board', ownerEmail: 'B@Example.test' } } },
    { publication: { policy: { boardId: 'invited-board', ownerEmail: 'a@example.test' } } }
  ], ready: ['own-board', 'invited-board'] });
  await act(async () => root.render(<BoardCollaborationControls projectId={null} onChanged={() => {}} />));
  const own = container.querySelector('[aria-label="Your boards to restore"]')!;
  const inbox = container.querySelector('[aria-label="Shared board invitations"]')!;
  expect(own.textContent).toContain('own-board'.slice(0, 8));
  expect(own.textContent).toContain('Connect Google Drive');
  expect(own.querySelector('button')).toBeNull();
  // Only the foreign board counts as an invitation, and case-insensitively.
  expect(inbox.textContent).toContain('1 shared board');
  expect(inbox.textContent).not.toContain('own-board'.slice(0, 8));
  expect(buttons()).toHaveLength(1);
  expect(f.start).not.toHaveBeenCalled();
});
