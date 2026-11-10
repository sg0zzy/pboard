// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoardRetentionControls } from '../../src/sidebar/components/BoardRetentionControls';

const plan = { eligibleSegmentIds: ['log'], eligibleSnapshotIds: ['snapshot-1'], retainedSnapshotIds: ['a', 'b', 'c'], eligibleFileIds: ['snapshot-1', 'log'], eligibleSnapshots: 1, bytes: 2048, policy: 'Keep three checkpoints and 90 days of history.' };
const api = vi.hoisted(() => ({
  role: vi.fn(async () => 'owner'),
  subscribeRole: vi.fn(async (_: string, _listener: (owner: boolean) => void) => () => {}),
  previewGardening: vi.fn(async () => ({ eligibleSegmentIds: ['log'], eligibleSnapshotIds: ['snapshot-1'], retainedSnapshotIds: ['a', 'b', 'c'], eligibleFileIds: ['snapshot-1', 'log'], eligibleSnapshots: 1, bytes: 2048, policy: 'Keep three checkpoints and 90 days of history.' })),
  garden: vi.fn(async () => 2),
}));
vi.mock('../../src/sync/browser', () => ({ operationService: api, googleDrive: { getConnectionState: async () => 'connected' } }));
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); api.role.mockResolvedValue('owner'); api.subscribeRole.mockImplementation(async (_: string, _listener: (owner: boolean) => void) => () => {}); api.previewGardening.mockResolvedValue(plan); api.garden.mockResolvedValue(2); node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<BoardRetentionControls projectId="board" />)); }
function button(label: string) { return [...node.querySelectorAll('button')].find(button => button.textContent === label)!; }

it('never shows a deletion button before a preview, and deletes only the exact reviewed set', async () => {
  await render();
  // Mandatory preview: the confirmation control does not exist until the plan does.
  expect(node.querySelector('.board-retention-preview')).toBeNull();
  expect(node.textContent).not.toContain('Confirm history deletion');
  await act(async () => button('Review old history').click());
  expect(api.previewGardening).toHaveBeenCalledWith('board');
  expect(api.garden).not.toHaveBeenCalled();
  expect(node.textContent).toContain('1 snapshots and 1 operation segments');
  expect(node.textContent).toContain('90 days');
  expect(document.activeElement).toBe(button('Cancel'));
  await act(async () => button('Confirm history deletion').click());
  expect(api.garden).toHaveBeenCalledWith('board', ['snapshot-1', 'log']);
  expect(node.textContent).toContain('2 eligible files');
});

it('cancel discards the reviewed plan without deleting anything', async () => {
  await render();
  await act(async () => button('Review old history').click());
  await act(async () => button('Cancel').click());
  expect(node.querySelector('.board-retention-preview')).toBeNull();
  await act(async () => { expect(button('Confirm history deletion')).toBeUndefined(); });
  expect(api.garden).not.toHaveBeenCalled();
});

it('a deletion refused as superseded is reported, not retried silently', async () => {
  api.garden.mockRejectedValueOnce(new Error('History changed. Review a fresh gardening preview.'));
  await render();
  await act(async () => button('Review old history').click());
  await act(async () => button('Confirm history deletion').click());
  expect(node.textContent).toContain('History changed. Review a fresh gardening preview.');
  expect(api.garden).toHaveBeenCalledTimes(1);
});

it('a plan with nothing eligible offers no confirmation', async () => {
  api.previewGardening.mockResolvedValueOnce({ ...plan, eligibleSegmentIds: [], eligibleSnapshotIds: [], eligibleFileIds: [], eligibleSnapshots: 0, bytes: 0 });
  await render();
  await act(async () => button('Review old history').click());
  expect(button('Confirm history deletion').disabled).toBe(true);
});

it('hides retention from editors and after a live permission downgrade', async () => {
  api.role.mockResolvedValue('editor'); await render(); expect(node.querySelector('details')).toBeNull();
  await render();
  await act(async () => (api.subscribeRole.mock.calls[0]![1] as (owner: boolean) => void)(true));
  expect(button('Review old history')).toBeTruthy();
  await act(async () => (api.subscribeRole.mock.calls[0]![1] as (owner: boolean) => void)(false));
  expect(node.querySelector('details')).toBeNull();
});

it('prevents a second review while one is running', async () => {
  let finish!: (value: typeof plan) => void;
  api.previewGardening.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => { button('Review old history').click(); button('Review old history').click(); });
  expect(api.previewGardening).toHaveBeenCalledTimes(1);
  expect(button('Review old history').disabled).toBe(true);
  await act(async () => finish(plan));
  expect(button('Review old history').disabled).toBe(false);
});
