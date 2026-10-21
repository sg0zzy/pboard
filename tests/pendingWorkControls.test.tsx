// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PendingWorkControls } from '../src/sidebar/components/PendingWorkControls';
const save = vi.hoisted(() => vi.fn());
vi.mock('../src/sidebar/download', () => ({ downloadBlob: save }));
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); node = document.createElement('div'); document.body.append(node); root = createRoot(node); save.mockClear(); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
function edits(canReview: boolean) { return ['one', 'two'].map(id => ({ id, boardId: 'board', base: { collection: 'cards', documentId: 'card' }, value: { content: `${id} retained version` }, boardMissing: false, boardName: 'My board', canReview, reason: canReview ? 'Review recovered work' : 'Waiting for current board authorization' })) as any; }
it('shows every parallel pending version and keeps viewer exports available while publication is disabled', async () => {
  const api = { listPendingWork: vi.fn(async () => edits(false)), exportPendingWork: vi.fn(async () => ({ format: 'pboard-pending-work-v1' as const, boardId: 'board', edits: [], images: [] })), reviewPendingWork: vi.fn() };
  await act(async () => root.render(<PendingWorkControls api={api} />));
  expect(node.textContent).toContain('Synchronization pending (2)'); expect(node.textContent).toContain('one retained version'); expect(node.textContent).toContain('two retained version');
  const review = [...node.querySelectorAll('button')].filter(b => b.textContent?.startsWith('Keep this version'));
  expect(review.every(button => button.disabled)).toBe(true);
  await act(async () => [...node.querySelectorAll('button')].find(b => b.textContent?.startsWith('Export'))!.click());
  expect(api.exportPendingWork).toHaveBeenCalledWith('board'); expect(save).toHaveBeenCalledOnce(); expect(api.reviewPendingWork).not.toHaveBeenCalled();
});
it('sends the selected version and exact reviewed parallel IDs for an explicit new edit', async () => {
  const api = { listPendingWork: vi.fn(async () => edits(true)), reviewPendingWork: vi.fn(async () => {}) };
  await act(async () => root.render(<PendingWorkControls api={api} />));
  await act(async () => [...node.querySelectorAll('button')].find(b => b.textContent?.startsWith('Keep this version'))!.click());
  expect(api.reviewPendingWork).toHaveBeenCalledWith('one', ['one', 'two']);
});
it('groups work on removed boards as retained evidence with a restore action, and never deletes it', async () => {
  const unhideProject = vi.fn(async () => {});
  const mixed = [ { id: 'held', boardId: 'gone', value: { id: 'x', content: 'held version' }, base: { collection: 'cards', documentId: 'card' },
    boardMissing: true, boardName: 'Old board', canReview: false, reason: 'This board was removed from this account’s list. Its work stays here; restore the board to review it.' },
    ...edits(true) ];
  const api = { listPendingWork: vi.fn(async () => mixed), unhideProject, exportPendingWork: vi.fn(async () => ({ format: 'pboard-pending-work-v1' as const, boardId: 'gone', edits: [], images: [] })) };
  await act(async () => root.render(<PendingWorkControls api={api} />));
  expect(node.textContent).toContain('Synchronization pending (2)');
  expect(node.textContent).toContain('Retained pending work on removed boards (1)');
  const restore = [...node.querySelectorAll('button')].find(b => b.textContent === 'Restore board to the list');
  expect(restore).toBeTruthy();
  await act(async () => restore!.click());
  expect(unhideProject).toHaveBeenCalledWith('gone');
});
it('reviews only versions of the selected document when a board has other pending edits', async () => {
  const api = { listPendingWork: vi.fn(async () => [...edits(true),
    { ...edits(true)[0], id: 'different-card', base: { collection: 'cards', documentId: 'other-card' } },
    { ...edits(true)[0], id: 'board-metadata', base: { collection: 'projects', documentId: 'board' } }]), reviewPendingWork: vi.fn(async () => {}) };
  await act(async () => root.render(<PendingWorkControls api={api} />));
  await act(async () => [...node.querySelectorAll('button')].find(b => b.textContent?.startsWith('Keep this version'))!.click());
  expect(api.reviewPendingWork).toHaveBeenCalledWith('one', ['one', 'two']);
});

it('requires confirmation to delete only the removed board’s reviewed pending work and supports cancel', async () => {
  const removed = { ...edits(false)[0], id: 'removed-one', boardId: 'gone', boardMissing: true, boardName: 'Old board' };
  const versions = [removed, { ...removed, id: 'removed-two' }];
  let values = [...versions, ...edits(true)];
  const discardRemovedBoardWork = vi.fn(async () => { values = edits(true); });
  const api = { listPendingWork: vi.fn(async () => values), unhideProject: vi.fn(), discardRemovedBoardWork };
  await act(async () => root.render(<PendingWorkControls api={api} />));
  const button = (text: string) => [...node.querySelectorAll('button')].find(value => value.textContent === text)!;
  await act(async () => button('Permanently delete board').click());
  expect(discardRemovedBoardWork).not.toHaveBeenCalled();
  expect(node.textContent).toContain('Other users’ copies remain intact');
  await act(async () => button('Cancel').click());
  expect(node.querySelector('[aria-label="Confirm permanent deletion"]')).toBeNull();
  await act(async () => button('Permanently delete board').click());
  await act(async () => button('Delete board permanently').click());
  expect(discardRemovedBoardWork).toHaveBeenCalledWith('gone', ['removed-one', 'removed-two']);
  expect(node.textContent).not.toContain('Retained pending work on removed boards');
  expect(node.textContent).toContain('Synchronization pending (2)');
});
