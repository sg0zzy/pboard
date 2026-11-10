// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ legacySync: vi.fn() }));
vi.mock('../src/platform/browser', () => ({ browser: { permissions: { request: vi.fn() } } }));
vi.mock('../src/sync/browser', () => ({
  boardCollaboration: { settings: async () => ({ provider: 'websocket', url: 'wss://relay.example/ws' }), identitySharing: { sync: mocks.legacySync } },
  collaborationManager: { stop: async () => {} }
}));
vi.mock('../src/sidebar/components/BoardRelayHealControls', () => ({ BoardRelayHealControls: () => null }));
vi.mock('../src/sidebar/components/BoardRetentionControls', () => ({ BoardRetentionControls: () => null }));
import { BoardCollaborationControls } from '../src/sidebar/components/BoardCollaborationControls';

it('shows Drive-based collaboration without starting legacy enrollment', async () => {
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  try {
    await act(async () => { root.render(<BoardCollaborationControls projectId="board" onChanged={() => {}} />); });
    expect(node.textContent).toContain('Google Drive sharing');
    expect(node.textContent).not.toContain('Manual device pairing');
    expect(mocks.legacySync).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); node.remove(); }
});
