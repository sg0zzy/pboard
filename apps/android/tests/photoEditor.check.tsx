import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CardFormScreen } from '../src/screens/CardFormScreen';
import { pickPhoto } from '../src/platform/pickPhoto';
import type { Project, BoardItem } from '../src/storage/repository';
vi.mock('../src/platform/pickPhoto', () => ({ pickPhoto: vi.fn() }));
vi.mock('../src/components/CardImage', () => ({ CardImage: () => <img alt="Photo attached to this card" /> }));
const project: Project = { id: 'board', name: 'Board', template: 'project', revision: 1, createdAt: '', updatedAt: '' };
const image = { dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', width: 100, height: 200 };
let root: Root; let host: HTMLDivElement; let save = vi.fn(); let changed = vi.fn();
function render(card?: BoardItem) { act(() => root.render(<CardFormScreen project={project} card={card} busy={false} onBack={vi.fn()} onChange={changed} onSave={save} />)); }
async function photo() { await act(async () => host.querySelector<HTMLButtonElement>('.photo-picker-button')!.click()); }
beforeEach(() => { vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); save = vi.fn(); changed = vi.fn(); render(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe('photo editor drafts', () => {
  it('allows a photo-only card and saves through the existing toolbar form', async () => {
    expect(host.querySelector<HTMLButtonElement>('.toolbar-save')!.disabled).toBe(true);
    vi.mocked(pickPhoto).mockResolvedValue(image); await photo();
    expect(changed).toHaveBeenLastCalledWith(true); expect(host.querySelector('img')).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('.toolbar-save')!.click());
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: '', title: '', image }));
  });
  it('keeps cancellation clean and lets a new photo be removed before saving', async () => {
    vi.mocked(pickPhoto).mockResolvedValueOnce(null); await photo(); expect(changed).not.toHaveBeenCalled();
    vi.mocked(pickPhoto).mockResolvedValueOnce(image); await photo();
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Remove photo')!.click());
    expect(changed).toHaveBeenLastCalledWith(false); expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.toolbar-save')!.disabled).toBe(true);
  });
  it('retains an existing photo on picker errors and marks its removal as a draft edit', async () => {
    act(() => root.render(null)); render({ id: 'card', projectId: project.id, content: 'Caption', type: 'note', status: 'candidate', order: 0, imageId: 'stored', createdAt: '', updatedAt: '' });
    vi.mocked(pickPhoto).mockRejectedValueOnce(new Error('Bad photo')); await photo();
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Bad photo'); expect(host.querySelector('img')).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Remove photo')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.toolbar-save')!.click());
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ image: null, content: 'Caption' }));
  });
  it('disables Save during picking and preserves text typed while processing a photo', async () => {
    let finish!: (value: typeof image) => void;
    vi.mocked(pickPhoto).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await photo(); expect(host.querySelector<HTMLButtonElement>('.toolbar-save')!.disabled).toBe(true);
    const textarea = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Latest caption');
    await act(async () => textarea.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => finish(image));
    await act(async () => host.querySelector<HTMLButtonElement>('.toolbar-save')!.click());
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: 'Latest caption', image }));
  });
});
