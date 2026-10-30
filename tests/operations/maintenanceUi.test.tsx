// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { BoardMaintenanceControls } from '../../src/sidebar/components/BoardMaintenanceControls';
const api = vi.hoisted(() => ({ role: vi.fn(async () => 'owner'), subscribeRole: vi.fn(async (_: string, _listener: (owner: boolean) => void) => () => {}), compact: vi.fn(async () => 'snapshot'), previewGardening: vi.fn(async () => ({ eligibleSnapshots: 1, eligibleSegmentIds: ['log'], eligibleFileIds: ['snapshot','log'], bytes: 2048, policy: 'Keep three checkpoints and 90 days of history.' })), garden: vi.fn(async () => 2) }));
vi.mock('../../src/sync/browser', () => ({ operationService: api, googleDrive: { getConnectionState: async () => 'connected' } }));
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); api.role.mockResolvedValue('owner'); node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<BoardMaintenanceControls projectId="board" revision={1} />)); }
function button(label: string) { return [...node.querySelectorAll('button')].find(button => button.textContent === label)!; }
it('shows owner controls, keeps compaction separate and confirms the exact reviewed deletion set', async () => {
  await render(); expect(button('Compact')).toBeTruthy();
  await act(async () => button('Compact').click()); expect(api.compact).toHaveBeenCalledWith('board'); expect(api.garden).not.toHaveBeenCalled(); expect(node.textContent).toContain('Snapshot complete');
  await act(async () => button('Review old history').click());
  expect(node.textContent).toContain('1 snapshots and 1 operation segments'); expect(node.textContent).toContain('90 days'); expect(document.activeElement).toBe(button('Cancel')); expect(api.garden).not.toHaveBeenCalled();
  await act(async () => button('Confirm history deletion').click()); expect(api.garden).toHaveBeenCalledWith('board', ['snapshot', 'log']); expect(node.textContent).toContain('2 eligible files');
});
it('hides maintenance from editors and after a live permission downgrade', async () => {
  api.role.mockResolvedValue('editor'); await render(); expect(node.querySelector('details')).toBeNull();
  await act(async () => api.subscribeRole.mock.calls[0][1](true)); expect(button('Compact')).toBeTruthy();
  await act(async () => api.subscribeRole.mock.calls[0][1](false)); expect(node.querySelector('details')).toBeNull();
});
it('prevents repeated activation while a snapshot is being created', async () => {
  let finish!: (value: string) => void; api.compact.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); await act(async () => { button('Compact').click(); button('Compact').click(); });
  expect(api.compact).toHaveBeenCalledTimes(1); expect(button('Compact').disabled).toBe(true); expect(node.textContent).toContain('Compacting');
  await act(async () => finish('done')); expect(button('Compact').disabled).toBe(false);
});
