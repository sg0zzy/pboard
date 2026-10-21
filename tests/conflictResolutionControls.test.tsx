// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConflictResolutionControls, type ConflictRecoveryApi } from '../src/sidebar/components/ConflictResolutionControls';
import type { ConflictRecord } from '../src/storage/conflictResolution';

let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
let receive: (records: ConflictRecord[]) => void;
let api: ConflictRecoveryApi;
function record(): ConflictRecord {
  return { boardId: 'board', collection: 'cards', documentId: 'card', boardMissing: false, boardName: 'My board', restriction: null, drafts: [], result: {
    kind: 'conflict', reason: 'concurrent-fields', heads: ['left', 'right'], variants: ['left', 'right'].map(id => ({
      version: 1, boardId: 'board', collection: 'cards', documentId: 'card', id, parents: ['base'], ancestry: 'known',
      value: { id: 'card', projectId: 'board', content: `${id} text`, title: `${id} title`, type: 'note', status: 'candidate' }
    })) } };
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  api = { subscribeConflicts: vi.fn(async listener => { receive = listener; listener([record()]); return () => {}; }),
    saveConflictDraft: vi.fn(async () => {}), resolveConflict: vi.fn(async () => {}) };
  await act(async () => root.render(<ConflictResolutionControls api={api} />));
});
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
const radios = () => [...node.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const button = (label: string) => [...node.querySelectorAll('button')].find(b => b.textContent === label)!;
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('compares retained versions without selecting a timestamp winner; serializes the manual draft before resolving', async () => {
  expect(node.textContent).toContain('Conflict requires resolution (1)');
  expect(radios().every(r => !r.checked)).toBe(true);
  expect(node.textContent).toContain('left text'); expect(node.textContent).toContain('right text');
  await click(radios()[1]);
  const textarea = node.querySelector('textarea')!;
  await input(textarea, 'Reviewed merged text');
  await click(button('Save resolution'));
  expect(api.saveConflictDraft).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'card' }), expect.objectContaining({ content: 'Reviewed merged text', heads: ['left', 'right'] }));
  expect(api.resolveConflict).toHaveBeenCalledWith({ boardId: 'board', collection: 'cards', documentId: 'card', heads: ['left', 'right'], variantId: 'right', edits: { title: 'right title', content: 'Reviewed merged text' } });
});

it('restores a saved manual draft and preserves it when a new concurrent version arrives', async () => {
  const state = record(); state.drafts = [{ id: 'draft', target: '', writerId: 'old-window', heads: state.result.heads, variantId: 'left', title: 'Unfinished', content: 'Saved manual text' }];
  // New component represents an application restart.
  await act(async () => { root.unmount(); root = createRoot(node); api.subscribeConflicts = vi.fn(async listener => { receive = listener; listener([state]); return () => {}; }); root.render(<ConflictResolutionControls api={api} />); });
  expect(node.querySelector('textarea')?.value).toBe('Saved manual text');
  const next = structuredClone(state); next.result.heads.push('third'); next.result.variants.push({ ...next.result.variants[0], id: 'third', value: { ...next.result.variants[0].value, content: 'Third version' } });
  await act(async () => receive([next]));
  expect(node.textContent).toContain('New changes arrived');
  expect(node.querySelector('textarea')?.value).toBe('Saved manual text');
  expect(button('Save resolution').disabled).toBe(true);
  expect(api.resolveConflict).not.toHaveBeenCalled();
  await click(button('I reviewed the new versions; keep my draft'));
  await click(button('Save resolution'));
  expect(api.resolveConflict).toHaveBeenCalledWith(expect.objectContaining({ heads: ['left', 'right', 'third'], edits: { title: 'Unfinished', content: 'Saved manual text' } }));
});

it('keeps a manual draft visible when its starting version is superseded, and preserves its text when choosing a current version', async () => {
  await click(radios()[0]); await input(node.querySelector('textarea')!, 'Still valuable manual text');
  const state = record(); state.result.heads = ['descendant', 'right'];
  state.result.variants[0] = { ...state.result.variants[0], id: 'descendant', parents: ['left'] };
  await act(async () => receive([state]));
  expect(node.querySelector('textarea')?.value).toBe('Still valuable manual text');
  expect(button('Save resolution').disabled).toBe(true);
  await click(radios()[0]);
  expect(node.querySelector('textarea')?.value).toBe('Still valuable manual text');
  await click(button('Save resolution'));
  expect(api.resolveConflict).toHaveBeenCalledWith(expect.objectContaining({ variantId: 'descendant', heads: ['descendant', 'right'], edits: { title: 'left title', content: 'Still valuable manual text' } }));
});

it('shows view-only/expired access and never submits a resolution', async () => {
  const state = record(); state.restriction = 'Current trusted editor authorization is required.';
  await act(async () => receive([state]));
  expect(node.textContent).toContain('Current trusted editor authorization');
  expect(node.querySelector('fieldset')?.disabled).toBe(true);
  await click(radios()[0]); expect(api.resolveConflict).not.toHaveBeenCalled();
});

it('requires an explicit deletion confirmation and does not attach manual text to it', async () => {
  const state = record(); state.result.variants[1].value.deletedAt = '2026-01-01';
  await act(async () => receive([state])); await click(radios()[1]);
  expect(node.querySelector('textarea')).toBeNull();
  await click(button('Confirm deletion resolution'));
  expect(api.resolveConflict).toHaveBeenCalledWith(expect.not.objectContaining({ edits: expect.anything() }));
});

it('shows a failed save while preserving the entered text and all versions', async () => {
  api.resolveConflict = vi.fn(async () => { throw new Error('Access expired; reconnect'); });
  await click(radios()[0]); await input(node.querySelector('textarea')!, 'Keep this draft');
  await click(button('Save resolution'));
  expect(node.textContent).toContain('Access expired; reconnect'); expect(node.querySelector('textarea')?.value).toBe('Keep this draft');
  expect(radios()).toHaveLength(2);
});

it('blocks resolution when the manual draft could not be saved durably', async () => {
  api.saveConflictDraft = vi.fn(async () => { throw new Error('Storage full'); });
  await click(radios()[0]);
  expect(node.textContent).toContain('Draft could not be saved');
  await click(button('Save resolution'));
  expect(api.resolveConflict).not.toHaveBeenCalled();
  expect(node.querySelector('textarea')?.value).toBe('left text');
});

it('offers a reviewed compatible-field preview without automatically publishing it', async () => {
  const state = record(); state.result.kind = 'mergeable'; state.result.preview = { title: 'Combined title', content: 'Combined text' };
  await act(async () => receive([state])); await click(radios()[0]); await click(button('Use combined text'));
  expect(node.querySelector('textarea')?.value).toBe('Combined text'); expect(api.resolveConflict).not.toHaveBeenCalled();
});

it('keeps board conflicts visible independently of the ordinary board list', async () => {
  const state = record(); state.collection = 'projects'; state.restriction = 'Restore this board before applying a resolution. Its versions remain available here.';
  await act(async () => receive([state]));
  expect(node.textContent).toContain('My board — Board'); expect(node.textContent).toContain('Restore this board');
});
it('renews board access on demand and unblocks saving the resolution', async () => {
  const onRenewBoard = vi.fn(async (boardId: string) => ({ role: 'owner' }));
  await act(async () => root.unmount());
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const restricted = record();
  restricted.restriction = 'Current trusted editor authorization is required. Reconnect or renew board access.';
  const unrestricted = record();
  api = { subscribeConflicts: vi.fn(async listener => { listener([restricted]); return () => {}; }),
    listConflicts: vi.fn(async () => [unrestricted]),
    saveConflictDraft: vi.fn(async () => {}), resolveConflict: vi.fn(async () => {}) };
  await act(async () => root.render(<ConflictResolutionControls api={api} onRenewBoard={onRenewBoard} />));
  await click(button('Verify board access and retry'));
  expect(onRenewBoard).toHaveBeenCalledWith('board');
  expect(node.textContent).toContain('Board access verified');
  // The refresh re-evaluated the record: the restriction is gone and the
  // resolution editor is interactive again.
  expect(node.textContent).not.toContain('rechecked when saving');
  await click(radios()[1]);
  // Renewal refreshed the record; the editor is interactive again and saving routes to resolveConflict.
  const area = node.querySelector('textarea');
  await input(area as HTMLTextAreaElement, 'Reviewed merged text');
  await click(button('Save resolution'));
  expect(api.resolveConflict).toHaveBeenCalled();
});
it('offers confirmed permanent board deletion for conflicts left by the earlier pending-only delete action', async () => {
  const permanentlyDeleteBoard = vi.fn(async () => {});
  const listConflicts = vi.fn(async () => []);
  await act(async () => root.render(<ConflictResolutionControls api={{ ...api, permanentlyDeleteBoard, listConflicts }} />));
  await click(button('Permanently delete board'));
  expect(permanentlyDeleteBoard).not.toHaveBeenCalled();
  expect(node.textContent).toContain('private Google Drive backup');
  await click(button('Cancel'));
  expect(permanentlyDeleteBoard).not.toHaveBeenCalled();
  await click(button('Permanently delete board'));
  await click(button('Delete board permanently'));
  expect(permanentlyDeleteBoard).toHaveBeenCalledWith('board');
  expect(node.textContent).not.toContain('Conflict requires resolution');
});
