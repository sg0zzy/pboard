import { unzipSync, strFromU8 } from 'fflate';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { HomeScreen } from '../src/screens/HomeScreen';
import type { Snapshot } from '../src/storage/repository';
const native = vi.hoisted(() => ({ back: undefined as (() => void) | undefined, remove: vi.fn(), exit: vi.fn(), style: vi.fn(), themeListener: undefined as (() => void) | undefined, dark: false, removeTheme: vi.fn() }));
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
    watchRepository: (_repository: unknown, listener: (value: Snapshot) => void) => { storage.listener = listener; listener(storage.snapshot); return storage.stop; },
    readSnapshot: storage.read,
  };
});
let root: Root;
let host: HTMLDivElement;
async function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
async function input(selector: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  await act(async () => element.dispatchEvent(new Event('input', { bubbles: true })));
}
async function submit() { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
beforeEach(() => {
  vi.clearAllMocks();
  native.dark = false;
  native.style.mockResolvedValue(undefined);
  window.matchMedia = vi.fn(() => ({ get matches() { return native.dark; }, addEventListener: (_event: string, listener: () => void) => { native.themeListener = listener; }, removeEventListener: native.removeTheme })) as unknown as typeof window.matchMedia;
  storage.snapshot = { projects: [{ id: 'phone', name: 'PhoneHaul', template: 'project', revision: 1, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' }], cards: [], showPreviews: true };
  storage.open.mockResolvedValue({ renameProject: storage.rename, changeProjectTemplate: vi.fn(), createProject: storage.create, addItem: storage.add, updateItem: storage.update, deleteProject: storage.deleteBoard, deleteItem: storage.deleteCard, emptyTrash: storage.emptyTrash, duplicateItem: storage.duplicate, mergeItems: storage.merge, getImage: storage.images });
  storage.deleteBoard.mockImplementation(async (id: string) => { storage.snapshot.projects = storage.snapshot.projects.filter(project => project.id !== id); });
  storage.read.mockImplementation(async () => storage.snapshot);
  storage.create.mockImplementation(async (name: string, template: 'project') => { const project = { ...storage.snapshot.projects[0], id: 'new', name, template }; storage.snapshot.projects.push(project); return project; });
  exporting.copy.mockResolvedValue(true); exporting.download.mockResolvedValue(true); storage.images.mockResolvedValue(null);
  storage.add.mockResolvedValue({}); storage.update.mockResolvedValue(undefined);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('mobile navigation and editing', () => {
  it('copies the same board/section text and downloads the new main archive excluding trash', async () => {
    storage.snapshot.cards = ['candidate', 'done', 'rejected', 'trash'].map((status, order) => ({ id: String(order), projectId: 'phone', content: status + ' text', type: 'task', status: status as 'candidate', order, createdAt: '', updatedAt: '' }));
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Copy board')!.click());
    expect(exporting.copy).toHaveBeenLastCalledWith('PROJECT: PhoneHaul\n\n[task] [candidate] candidate text\n\n[task] [done] done text\n\n[task] [rejected] rejected text');
    await click('Copy done cards'); expect(exporting.copy).toHaveBeenLastCalledWith('PROJECT: PhoneHaul\n\n[task] [done] done text');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Download board')!.click());
    const archive = exporting.download.mock.calls[0][0];
    expect(archive.filename).toBe('PhoneHaul.zip');
    expect(strFromU8(unzipSync(archive.data)['board.txt'])).not.toContain('trash text');
    expect(storage.update).not.toHaveBeenCalled();
    await click('Actions for card 1');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Copy card text')!.click());
    expect(exporting.copy).toHaveBeenLastCalledWith('[task] [candidate] candidate text');
  });
  it('duplicates and inserts below through compact menus, and resets the save-and-add editor', async () => {
    const first = { id: 'first', projectId: 'phone', content: 'First', type: 'task' as const, status: 'candidate' as const, order: 0, createdAt: '', updatedAt: '' };
    storage.snapshot.cards = [first];
    storage.duplicate.mockImplementation(async () => { const duplicate = { ...first, id: 'duplicate', order: 1 }; storage.snapshot.cards = [first, duplicate]; return duplicate; });
    await act(async () => root.render(<App />)); await click('Open PhoneHaul'); await click('Actions for card 1');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Duplicate card')!.click());
    expect(storage.duplicate).toHaveBeenCalledExactlyOnceWith('first'); expect(host.querySelectorAll('[data-card-id]')).toHaveLength(2);
    await click('Actions for card 1');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Add card below')!.click());
    await input('textarea', 'Inserted'); storage.add.mockResolvedValueOnce({ id: 'inserted' });
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Save and add below')!.click());
    expect(storage.add).toHaveBeenLastCalledWith(expect.objectContaining({ afterItemId: 'first', content: 'Inserted' }));
    expect(host.querySelector('h1')?.textContent).toBe('New card'); expect(host.querySelector('textarea')?.value).toBe('');
    await input('textarea', 'Next'); await submit();
    expect(storage.add).toHaveBeenLastCalledWith(expect.objectContaining({ afterItemId: 'inserted', content: 'Next' }));
  });
  it('confirms merges of confirmed source cards and navigates back from target selection', async () => {
    const first = { id: 'first', projectId: 'phone', content: 'Source', type: 'task' as const, status: 'confirmed' as const, order: 0, createdAt: '', updatedAt: '' };
    storage.snapshot.cards = [first, { ...first, id: 'target', content: 'Target', order: 1 }];
    await act(async () => root.render(<App />)); await click('Open PhoneHaul'); await click('Actions for card 1');
    const mergeMenu = () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Merge into another card')!;
    await act(async () => mergeMenu().click());
    expect(host.querySelector('dialog h2')?.textContent).toBe('Merge into card');
    await act(async () => native.back!()); expect(host.querySelector('dialog h2')?.textContent).toBe('Card actions');
    await act(async () => mergeMenu().click()); await click('Merge into Target');
    expect(storage.merge).not.toHaveBeenCalled(); expect(host.querySelector('dialog h2')?.textContent).toBe('Merge confirmed card?');
    await act(async () => host.querySelector<HTMLButtonElement>('dialog .danger')!.click());
    expect(storage.merge).toHaveBeenCalledExactlyOnceWith('first', 'target');
  });
  it('renders Markdown/checklists, updates only the task line and persists a display mode', async () => {
    const card = { id: 'card', projectId: 'phone', content: '**Bold**\n\n- [ ] Ship\n- [x] Test\n\n[Link](https://example.com)', type: 'task' as const, status: 'candidate' as const, order: 0, createdAt: '', updatedAt: '' };
    storage.snapshot.cards = [card];
    storage.update.mockImplementation(async (id, patch) => { storage.snapshot = { ...storage.snapshot, cards: storage.snapshot.cards.map(card => card.id === id ? { ...card, ...patch } : card) }; });
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    expect(host.querySelector('strong')?.textContent).toBe('Bold'); expect(host.querySelector('.card-link')?.getAttribute('href')).toBe('https://example.com');
    await act(async () => host.querySelector<HTMLInputElement>('.task-list input')!.click());
    expect(storage.update).toHaveBeenCalledExactlyOnceWith('card', { content: card.content.replace('[ ] Ship', '[x] Ship') });
    expect(host.querySelector('h1')?.textContent).toBe('PhoneHaul');
    await click('Actions for card 1');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Expanded')!.click());
    expect(storage.update).toHaveBeenLastCalledWith('card', { displayMode: 'expanded' });
    expect(host.querySelector('[data-card-id]')?.classList.contains('display-mode-expanded')).toBe(true);
    expect(host.querySelector('.project-fingerprint')).not.toBeNull();
    storage.update.mockClear(); await click('Actions for card 1');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Expanded')!.click());
    expect(storage.update).not.toHaveBeenCalled();
  });
  it('moves terminal statuses into containers, trashes whole sections and confirms board-scoped emptying', async () => {
    const values = ['candidate', 'done', 'done', 'rejected', 'trash'] as const;
    storage.snapshot.cards = values.map((status, order) => ({ id: String(order), projectId: 'phone', content: status, type: 'task', status, order, createdAt: '', updatedAt: '' }));
    storage.snapshot.cards.push({ ...storage.snapshot.cards[1], id: 'other', projectId: 'other' });
    storage.update.mockImplementation(async (id, patch) => { storage.snapshot = { ...storage.snapshot, cards: storage.snapshot.cards.map(card => card.id === id ? { ...card, ...patch } : card) }; });
    storage.emptyTrash.mockImplementation(async (projectId) => { storage.snapshot = { ...storage.snapshot, cards: storage.snapshot.cards.filter(card => card.projectId !== projectId || card.status !== 'trash') }; });
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await click('Change status of card 1'); await click('done');
    expect(host.querySelector('[data-section-status=done] summary span')?.textContent).toBe('Done (3)');
    expect(host.querySelector('.card-list > .swipe-row')).toBeNull();
    await click('Trash done cards');
    expect(host.querySelector('[data-section-status=done]')).toBeNull();
    expect(storage.snapshot.cards.find(card => card.id === 'other')?.status).toBe('done');
    await click('Trash rejected cards');
    expect(host.querySelector('[data-section-status=rejected]')).toBeNull();
    expect(host.querySelector('[data-section-status=trash] summary span')?.textContent).toBe('Trash (5)');
    await click('Empty trash'); expect(storage.emptyTrash).not.toHaveBeenCalled();
    await act(async () => native.back!()); expect(host.querySelector('dialog')).toBeNull();
    await click('Empty trash');
    await act(async () => host.querySelector<HTMLButtonElement>('dialog .danger')!.click());
    expect(storage.emptyTrash).toHaveBeenCalledExactlyOnceWith('phone');
    expect(host.querySelectorAll('details')).toHaveLength(0);
    expect(storage.snapshot.cards.map(card => card.id)).toEqual(['other']);
  });
  it('puts discarded cards into trash and permits restoring them without changing order', async () => {
    storage.snapshot.cards = [{ id: 'card', projectId: 'phone', content: 'Keep me', type: 'task', status: 'candidate', order: 0, createdAt: '', updatedAt: '' }];
    storage.update.mockImplementation(async (id, patch) => { storage.snapshot = { ...storage.snapshot, cards: storage.snapshot.cards.map(card => card.id === id ? { ...card, ...patch } : card) }; });
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await act(async () => host.querySelector('[data-card-id]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    expect(storage.update).toHaveBeenCalledExactlyOnceWith('card', { status: 'trash' });
    expect(storage.deleteCard).not.toHaveBeenCalled();
    await click('Change status of card 1'); await click('confirmed');
    expect(host.querySelector('[data-section-status=trash]')).toBeNull();
    expect(host.querySelector('.card-list > .swipe-row [data-card-id]')?.getAttribute('data-card-id')).toBe('card');
    expect(storage.snapshot.cards[0].order).toBe(0);
  });
  it('shows matching category/status chips, saves one field and cancels with Android back', async () => {
    storage.snapshot.cards = [{ id: 'card', projectId: 'phone', content: 'Note', type: 'task', status: 'started', order: 0, createdAt: '', updatedAt: '' }];
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await click('Change category of card 1');
    const task = host.querySelector<HTMLButtonElement>('dialog button[aria-label="Task / Next Step"]')!;
    expect(task.getAttribute('aria-pressed')).toBe('true'); expect(document.activeElement).toBe(task);
    const chip = task.querySelector<HTMLElement>('.card-type-label')!;
    expect(chip.style.getPropertyValue('--card-accent')).toBe('#22827d');
    expect(chip.style.getPropertyValue('--card-tint')).toBe('#e4f6f4');
    await click('Goal'); expect(storage.update).toHaveBeenCalledExactlyOnceWith('card', { type: 'goal' });
    expect(host.querySelector('dialog')).toBeNull();
    storage.update.mockClear(); await click('Change status of card 1');
    expect(host.querySelector('dialog .status-started')?.textContent).toBe('started');
    expect(host.querySelector('dialog .status-done')).not.toBeNull();
    expect(host.querySelector('dialog button[aria-pressed="true"]')?.getAttribute('aria-label')).toBe('started');
    await act(async () => native.back!());
    expect(host.querySelector('dialog')).toBeNull(); expect(host.querySelector('h1')?.textContent).toBe('PhoneHaul');
    expect(storage.update).not.toHaveBeenCalled();
    await click('Change status of card 1');
    await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(host.querySelector('dialog')).toBeNull(); expect(storage.update).not.toHaveBeenCalled();
  });
  it('opens a saved board and returns from board/settings using system back', async () => {
    await act(async () => root.render(<App />));
    await click('Open PhoneHaul');
    expect(host.querySelector('h1')?.textContent).toBe('PhoneHaul');
    await act(async () => native.back!());
    await click('Settings');
    expect(host.querySelector('h1')?.textContent).toBe('Settings');
    await act(async () => native.back!());
    expect(host.querySelectorAll('.board-tile')).toHaveLength(1);
    await act(async () => native.back!()); expect(native.exit).toHaveBeenCalledOnce();
  });
  it('shows an honest Drive notice and dismisses it with system back', async () => {
    await act(async () => root.render(<App />));
    await click('Google Drive integration');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('not yet configured');
    await act(async () => native.back!());
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
    expect(native.exit).not.toHaveBeenCalled();
  });
  it('creates a board, opens it and saves a new card', async () => {
    await act(async () => root.render(<App />));
    await click('Create board');
    await input('input[name=name]', 'My board');
    await submit();
    expect(storage.create).toHaveBeenCalledWith('My board', 'brainstorming');
    expect(host.querySelector('h1')?.textContent).toBe('My board');
    await click('Create card');
    expect(document.activeElement).toBe(host.querySelector('textarea'));
    await input('textarea', 'Offline note');
    await submit();
    expect(storage.add).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'new', content: 'Offline note', type: 'note', status: 'candidate' }));
    expect(host.querySelector('h1')?.textContent).toBe('My board');
  });
  it('keeps Save in the card toolbar and submits its associated form', async () => {
    await act(async () => root.render(<App />));
    await click('Open PhoneHaul'); await click('Create card');
    const save = host.querySelector<HTMLButtonElement>('.toolbar button[form="card-editor"]')!;
    expect(save.disabled).toBe(true);
    expect(host.querySelector('main button[type=submit]')).toBeNull();
    await input('textarea', 'Save with keyboard open');
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(storage.add).toHaveBeenCalledWith(expect.objectContaining({ content: 'Save with keyboard open' }));
  });
  it('focuses the tapped text/title field and saves changes from the toolbar', async () => {
    const card = { id: 'card', projectId: 'phone', title: 'A title', content: 'A note', type: 'task' as const, status: 'candidate' as const, order: 0, createdAt: '', updatedAt: '' };
    storage.snapshot.cards = [card];
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await act(async () => host.querySelector('[data-edit-field=content]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(document.activeElement).toBe(host.querySelector('textarea'));
    await input('textarea', 'Changed text');
    await act(async () => host.querySelector<HTMLButtonElement>('.toolbar-save')!.click());
    expect(storage.update).toHaveBeenCalledWith('card', expect.objectContaining({ content: 'Changed text' }));
    await act(async () => host.querySelector('[data-edit-field=title]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(document.activeElement).toBe(host.querySelector('input'));
  });
  it('celebrates successful transitions to done, expires and does not replay on reopening', async () => {
    vi.useFakeTimers();
    try {
      const card = { id: 'card', projectId: 'phone', content: 'Finish this', type: 'task' as const, status: 'to validate' as const, order: 0, createdAt: '', updatedAt: '' };
      storage.snapshot.cards = [card];
      storage.update.mockImplementation(async (id: string, patch: object) => { storage.snapshot.cards = storage.snapshot.cards.map(value => value.id === id ? { ...value, ...patch } : value); });
      await act(async () => root.render(<App />)); await click('Open PhoneHaul');
      expect(host.querySelector('.board-confetti')).toBeNull();
      await click('Change status of card 1'); await click('done');
      expect(host.querySelector('.board-confetti')?.getAttribute('aria-hidden')).toBe('true');
      expect(host.querySelectorAll('.board-confetti-piece').length).toBeGreaterThanOrEqual(36);
      expect(host.querySelectorAll('.board-confetti-piece').length).toBeLessThanOrEqual(44);
      await act(async () => vi.advanceTimersByTime(1000));
      expect(host.querySelector('.board-confetti')).toBeNull();
      await click('Back'); await click('Open PhoneHaul');
      expect(host.querySelector('.board-confetti')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('does not celebrate a failed status write', async () => {
    storage.snapshot.cards = [{ id: 'card', projectId: 'phone', content: 'Finish this', type: 'task', status: 'to validate', order: 0, createdAt: '', updatedAt: '' }];
    storage.update.mockRejectedValueOnce(new Error('Storage unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => root.render(<App />)); await click('Open PhoneHaul');
      await click('Change status of card 1'); await click('done');
      expect(host.querySelector('.board-confetti')).toBeNull();
      expect(host.querySelector('.notice')?.textContent).toContain('Could not save');
    } finally { error.mockRestore(); }
  });
  it('celebrates editor saves reaching done but not content edits on already done cards', async () => {
    storage.snapshot.cards = [{ id: 'card', projectId: 'phone', content: 'Finish this', type: 'task', status: 'to validate', order: 0, createdAt: '', updatedAt: '' }];
    storage.update.mockImplementation(async (id: string, patch: object) => { storage.snapshot.cards = storage.snapshot.cards.map(value => value.id === id ? { ...value, ...patch } : value); });
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await act(async () => host.querySelector('[data-edit-field=content]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    const selects = host.querySelectorAll<HTMLSelectElement>('form select');
    selects[1].value = 'done'; await act(async () => selects[1].dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => host.querySelector<HTMLButtonElement>('.toolbar-save')!.click());
    expect(host.querySelector('.board-confetti')).not.toBeNull();
    await act(async () => host.querySelector('[data-edit-field=content]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(host.querySelector('.board-confetti')).toBeNull();
    await input('textarea', 'Updated done note');
    await act(async () => host.querySelector<HTMLButtonElement>('.toolbar-save')!.click());
    expect(host.querySelector('.board-confetti')).toBeNull();
  });
  it('asks before discarding dirty input and cancels without losing the draft', async () => {
    await act(async () => root.render(<App />));
    await click('Create board'); await input('input[name=name]', 'Draft');
    await act(async () => native.back!());
    expect(host.querySelector('dialog')?.textContent).toContain('Discard changes?');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelector<HTMLInputElement>('input[name=name]')?.value).toBe('Draft');
    await act(async () => native.back!());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Discard')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelector('h1')?.textContent).toBe('pboard');
    expect(storage.create).not.toHaveBeenCalled();
  });
  it('keeps the draft on a write failure and permits retry', async () => {
    storage.create.mockRejectedValueOnce(new Error('Storage full'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => root.render(<App />));
      await click('Create board'); await input('input[name=name]', 'Retry board'); await submit();
      expect(host.querySelector('[role=status]')?.textContent).toContain('Could not save');
      expect(host.querySelector<HTMLInputElement>('input[name=name]')?.value).toBe('Retry board');
      await submit();
      expect(host.querySelector('h1')?.textContent).toBe('Retry board');
    } finally { error.mockRestore(); }
  });
  it('confirms board deletion and cancels without deleting', async () => {
    await act(async () => root.render(<App />)); await click('Open PhoneHaul');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Delete board')!.click());
    expect(storage.deleteBoard).not.toHaveBeenCalled();
    await act(async () => native.back!());
    expect(host.querySelector('dialog')).toBeNull();
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Delete board')!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Delete')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(storage.deleteBoard).toHaveBeenCalledWith('phone');
    expect(host.querySelector('h1')?.textContent).toBe('pboard');
    expect(host.querySelectorAll('.board-tile')).toHaveLength(0);
  });
  it('shows a load error rather than sample boards and retries opening storage', async () => {
    storage.open.mockRejectedValueOnce(new Error('Storage unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => root.render(<App />));
      expect(host.querySelector('[role=alert]')?.textContent).toContain('Could not load');
      expect(host.querySelectorAll('.board-tile')).toHaveLength(0);
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
      expect(host.querySelectorAll('.board-tile')).toHaveLength(1);
    } finally { error.mockRestore(); }
  });
  it('renders safe fallbacks for malformed or missing optional data', async () => {
    await act(async () => root.render(<HomeScreen boards={[{ id: 'bad', name: {}, category: 5, color: [], firstCard: {} }, { id: 'missing' }]} onOpen={vi.fn()} onSettings={vi.fn()} onNotice={vi.fn()} onCreate={vi.fn()} />));
    expect(host.querySelectorAll('.board-tile')).toHaveLength(2);
    for (const text of ['Untitled board', 'Notes', 'No cards yet']) expect(host.textContent).toContain(text);
  });
  it('keeps native system bars readable when the system theme changes', async () => {
    await act(async () => root.render(<App />));
    expect(native.style).toHaveBeenLastCalledWith({ style: 'LIGHT' });
    native.dark = true;
    await act(async () => native.themeListener!());
    expect(native.style).toHaveBeenLastCalledWith({ style: 'DARK' });
    await act(async () => root.render(null));
    expect(native.removeTheme).toHaveBeenCalledWith('change', native.themeListener);
  });
  it('removes database and native back subscriptions on unmount', async () => {
    await act(async () => root.render(<App />));
    await act(async () => root.render(null));
    expect(native.remove).toHaveBeenCalledOnce(); expect(storage.stop).toHaveBeenCalledOnce();
  });
});
