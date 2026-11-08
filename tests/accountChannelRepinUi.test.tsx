// @vitest-environment jsdom
/**
 * The collaboration panel's account section: the only place the explicit
 * account re-pin is offered, and only in the state it exists for.
 *
 * The rule under test is about restraint as much as about the button: an
 * account channel that is working, starting, or failing for a different reason
 * must not show a "trust the published authorization" action at all — the act
 * is one-way, so it must never be reachable from a state where the question
 * does not arise.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  status: vi.fn(),
  repin: vi.fn(),
  listeners: new Set<() => void>(),
  subscribe: vi.fn((listener: () => void) => { f.listeners.add(listener); return () => { f.listeners.delete(listener); }; }),
  changed: vi.fn()
}));

vi.mock('../src/platform/browser', () => ({ browser: { permissions: { request: vi.fn() } } }));
vi.mock('../src/storage/browser', () => ({ repository: {} }));
vi.mock('../src/sync/browser', () => ({
  healRelay: async () => 'idle:no-room',
  boardCollaboration: { settings: async () => ({ provider: 'websocket', url: 'wss://pboard.cecosl.ovh/ws' }), ownsAuthority: async () => false,
    identitySharing: { sync: async () => ({ email: '', boards: [], ready: [] }), collaborators: async () => [] }, pairing: { pending: async () => null } },
  collaborationManager: { stop: async () => {}, state: () => ({ error: null, ready: false, role: 'private', connectedPeers: [] }) },
  googleDrive: { getConnectionState: async () => 'disconnected' },
  operationService: { subscribeRole: async (_: string, __: (owner: boolean) => void) => () => {}, role: async () => 'editor', previewGardening: async () => { throw new Error('unused'); }, garden: async () => { throw new Error('unused'); } },
  accountChannel: { status: f.status, subscribe: f.subscribe, repinPublishedAuthority: f.repin }
}));

import { BoardCollaborationControls } from '../src/sidebar/components/BoardCollaborationControls';

let container: HTMLDivElement, root: Root;

const foreignStatus = {
  account: 'acct', state: 'absent-pin', reason: 'no account pin', appliedSeq: 0, lastKind: null, outbox: 27,
  deferred: 0, deferredBoards: [], skipped: {}, appliedByKind: {}, error: null, reconnectReason: null, throttled: false,
  authority: { state: 'failed', reason: 'Google Drive holds an account authorization signed by a different authority than this browser\'s pin; the pin was left untouched' }
};

const button = (label: string) => [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label);
const text = () => container.textContent ?? '';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('DEV', false);
  f.listeners.clear();
  f.status.mockReturnValue(foreignStatus);
  f.repin.mockReset();
  f.changed.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function render() {
  await act(async () => { root.render(<BoardCollaborationControls projectId="board" onChanged={f.changed} />); });
}

it('offers the re-pin in a foreign account state, with the warning and the queued count', async () => {
  await render();
  expect(text(), 'the action is present in the state it exists for').toContain('Trust the published account authorization');
  expect(text(), 'the warning says what trusting the published file means').toMatch(/whoever can write it would become the account.s authority/);
  expect(text(), 'and that the move is one-way').toMatch(/one-way/);
  expect(text(), 'the queued records are stated').toContain('27 queued account records are waiting');
  expect(text(), 'the channel\'s own cause is carried, not paraphrased away').toContain('signed by a different authority');
});

it('reports the new fingerprint, the channel state and whether this browser can renew', async () => {
  f.repin.mockResolvedValue({ authorityKeyId: 'B'.repeat(43), previousAuthorityKeyId: 'A'.repeat(43),
    canRenew: false, channelState: 'failed', channelReason: 'no account content key', outbox: 27, queuedBefore: 27, unchanged: false });
  await render();
  await act(async () => { button('Trust the published account authorization')!.click(); });
  expect(f.repin).toHaveBeenCalledOnce();
  expect(f.changed, 'the panel tells its host that collaboration state moved').toHaveBeenCalled();
  expect(text(), 'the new authority fingerprint prefix is shown').toContain('BBBBBBBBBBBB');
  expect(text(), 'and the one it replaced').toContain('AAAAAAAAAAAA');
  expect(text(), 'the channel state after the pass is named').toContain('no account content key');
  expect(text(), 'the honest consequence is stated, not softened').toMatch(/can never renew the account authorization/);
  expect(text(), 'and the queued records are accounted for').toContain('27 still queued');
});

it('says the records were flushed when the room came up, and keeps saying it after the state moves', async () => {
  f.repin.mockImplementation(async () => {
    // The pass changed the channel: the next status read is the room working.
    f.status.mockReturnValue({ ...foreignStatus, state: 'connected', reason: 'ready', outbox: 0,
      authority: { state: 'adopted', reason: 'the account authority pin was reused; this browser holds its key' } });
    return { authorityKeyId: 'C'.repeat(43), previousAuthorityKeyId: 'A'.repeat(43),
      canRenew: true, channelState: 'connected', channelReason: 'ready', outbox: 0, queuedBefore: 27, unchanged: false };
  });
  await render();
  await act(async () => { button('Trust the published account authorization')!.click(); });
  expect(text(), 'a browser holding the key is told it can renew').toMatch(/can renew the account authorization/);
  expect(text(), 'and the queue is reported as it ended').toContain('they have been flushed');
  // The channel is `connected` now, so the offer must be gone — but the answer the
  // person asked for must not disappear with it.
  expect(button('Trust the published account authorization'),
    'the one-way offer is withdrawn once it has been taken').toBeUndefined();
  expect(text(), 'the outcome outlives the state it was offered in').toContain('Account room: re-pin result');
});

it('shows the refusal verbatim and keeps the action available to retry', async () => {
  f.repin.mockRejectedValue(new Error('The published authorization does not list this browser\'s account device; ask the authority browser to admit this device first, and nothing was changed'));
  await render();
  await act(async () => { button('Trust the published account authorization')!.click(); });
  expect(text(), 'the exact failed check reaches the person').toContain('does not list this browser\'s account device');
  expect(text(), 'and it says nothing was changed').toContain('nothing was changed');
  expect(button('Trust the published account authorization'),
    'a refusal leaves the control usable so the person can act on it').not.toBeUndefined();
});

it('offers nothing when the account channel is healthy or failing for another reason', async () => {
  f.status.mockReturnValue({ ...foreignStatus, state: 'connected', reason: 'ready',
    authority: { state: 'adopted', reason: 'the account authority pin was reused; this browser holds its key' }, outbox: 0 });
  await render();
  expect(button('Trust the published account authorization'),
    'a working account room has nothing to re-pin').toBeUndefined();

  f.status.mockReturnValue({ ...foreignStatus, state: 'absent-pin',
    authority: { state: 'authority-not-local', reason: 'the account authority pin was reused; this browser does not hold its key' } });
  await act(async () => { root.render(<BoardCollaborationControls projectId="board" onChanged={f.changed} />); });
  expect(button('Trust the published account authorization'),
    'a pin that works but lives elsewhere is not a mismatch, and re-pinning would not help').toBeUndefined();
});

it('refreshes from the channel\'s own status event, so another context\'s change is not stale', async () => {
  await render();
  expect(button('Trust the published account authorization')).not.toBeUndefined();
  expect(f.subscribe, 'the section subscribes instead of polling').toHaveBeenCalled();
  f.status.mockReturnValue({ ...foreignStatus, reason: 'ready', state: 'connected',
    authority: { state: 'adopted', reason: 'the account authority pin was reused; this browser holds its key' }, outbox: 0 });
  await act(async () => { for (const listener of f.listeners) listener(); });
  expect(button('Trust the published account authorization'),
    'the action disappears once the channel is genuinely working').toBeUndefined();
});
