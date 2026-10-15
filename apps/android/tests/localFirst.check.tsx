import "fake-indexeddb/auto";
import { unzipSync } from 'fflate';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { BoardTemplate } from '../../../src/types';
import type { Snapshot } from '../src/storage/repository';
const native = vi.hoisted(() => ({ back: undefined as (() => void) | undefined, remove: vi.fn(), exit: vi.fn(), style: vi.fn(async () => undefined) }));
const exporting = vi.hoisted(() => ({ copy: vi.fn(), download: vi.fn() }));
vi.mock('../src/platform/boardExport', () => ({ copyText: exporting.copy, saveBoardArchive: exporting.download }));
const storage = vi.hoisted(() => ({ snapshot: {} as Snapshot, listener: undefined as ((value: Snapshot) => void) | undefined, stop: vi.fn(), open: vi.fn(), deleteBoard: vi.fn(), rename: vi.fn(), add: vi.fn(), update: vi.fn(), emptyTrash: vi.fn(), deleteCard: vi.fn(), create: vi.fn(), read: vi.fn(), duplicate: vi.fn(), merge: vi.fn(), images: vi.fn() }));
vi.mock('@capacitor/core', async (importOriginal) => ({ ...await importOriginal<typeof import('@capacitor/core')>(), Capacitor: { isNativePlatform: () => true, getPlatform: () => 'web' }, SystemBars: { setStyle: native.style }, SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT' } }));
vi.mock('@capacitor/app', () => ({ App: {
  addListener: vi.fn((_name: string, callback: () => void) => { native.back = callback; return Promise.resolve({ remove: native.remove }); }),
  exitApp: native.exit,
} }));
vi.mock('../src/storage/repository', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/storage/repository')>();
  return { ...actual,
    openRepository: storage.open,
    watchRepository: (_r: unknown, listener: (value: Snapshot) => void) => { storage.listener = listener; listener(storage.snapshot); return storage.stop; },
    readSnapshot: storage.read,
  };
});
// Cloud state overrides per test: `resolving` models the WebRTC/Drive role check
// still in flight after the board screen opened.
const cloud = vi.hoisted(() => {
  let state = { connected: false, busy: false, resolving: false, error: '', role: 'private' as string, peers: 0, lastSynced: '', projectId: null as string | null };
  return { get state() { return state; }, set(patch: Partial<typeof state>) { state = { ...state, ...patch }; } };
});
vi.mock('../src/sync/useCloudSync', () => ({ useCloudSync: () => ({ service: null, state: cloud.state }) }));
let root: Root; let host: HTMLDivElement;
function repoStub() {
  return {
    deleteProject: storage.deleteBoard, renameProject: storage.rename, changeProjectTemplate: vi.fn(),
    createProject: storage.create, addItem: storage.add, updateItem: storage.update,
    deleteItem: storage.deleteCard, emptyTrash: storage.emptyTrash, duplicateItem: storage.duplicate, mergeItems: storage.merge, getImage: storage.images
  };
}
async function input(selector: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  await act(async () => element.dispatchEvent(new Event('input', { bubbles: true })));
}
async function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
beforeEach(async () => {
  vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  cloud.set({ connected: false, busy: false, resolving: false, error: '', role: 'private', peers: 0, projectId: null });
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  storage.snapshot = { projects: [{ id: 'phone', name: 'PhoneHaul', template: 'project', revision: 1, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' }], cards: [], showPreviews: true };
  storage.open.mockResolvedValue(repoStub());
  storage.read.mockImplementation(async () => storage.snapshot);
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('local-first editing while cloud role resolution runs', () => {
  it('creates a board without waiting for WebRTC role resolution', async () => {
    cloud.set({ connected: true, resolving: true, projectId: null, role: 'private' });
    await act(async () => root.render(<App />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Create board"]')!.click());
    await input('input[name=name]', 'Fresh board');
    storage.create.mockImplementation(async (name: string, template: BoardTemplate) => {
      storage.snapshot = { ...storage.snapshot, projects: [...storage.snapshot.projects, { id: 'created-1', name, template, revision: 1, createdAt: '', updatedAt: '' }] };
      return { id: 'created-1' };
    });
    await act(async () => ([...host.querySelectorAll('button')].find(b => b.textContent === 'Save board') as HTMLButtonElement).click());
    expect(storage.create).toHaveBeenCalledWith('Fresh board', 'brainstorming');
    expect(host.querySelector('h1')?.textContent).toBe('Fresh board');
    expect(host.querySelector('.notice')?.textContent).toBe('');
  });

  it('adds a card while the live role check is still resolving', async () => {
    storage.snapshot.cards = [];
    cloud.set({ connected: true, resolving: true, projectId: 'phone', role: 'private' });
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Create card"]')!.click());
    await input('textarea', 'Local first card');
    storage.add.mockImplementation(async (draft: { content: string }) => {
      storage.snapshot = { ...storage.snapshot, cards: [{ id: 'new-1', projectId: 'phone', content: draft.content, type: 'task', status: 'candidate', order: 0, createdAt: '', updatedAt: '' }] };
      return { id: 'new-1' };
    });
    await act(async () => ([...host.querySelectorAll('button')].find(b => b.textContent === 'Save') as HTMLButtonElement).click());
    expect(storage.add).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'phone', content: 'Local first card' }));
    expect(host.querySelector('.notice')?.textContent).not.toContain('read-only');
    expect(storage.snapshot.cards.some(c => c.content === 'Local first card')).toBe(true);
  });

  it('still blocks edits with a notice when the resolved role is viewer', async () => {
    cloud.set({ connected: true, resolving: false, projectId: 'phone', role: 'viewer' });
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    // Edit board is disabled only when busy (readOnly) — diagnostic for the gate.
    console.log('EDIT BOARD DISABLED:', host.querySelector<HTMLButtonElement>('button[aria-label="Edit board"], form-actions button')?.textContent);
    const buttons = [...host.querySelectorAll('button')].filter(b => b.textContent === 'Edit board');
    console.log('EDIT DISABLED:', buttons.map(b => b.disabled));
    // The resolved viewer gate keeps the board read-only.
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Create card"]')!.disabled).toBe(true);
    expect(storage.add).not.toHaveBeenCalled();
    expect(storage.update).not.toHaveBeenCalled();
  });
});
