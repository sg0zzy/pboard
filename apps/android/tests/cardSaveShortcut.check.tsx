import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { CardFormScreen, type CardDraft } from '../src/screens/CardFormScreen';
import type { Project, BoardItem } from '../src/storage/repository';
const project: Project = { id: 'board', name: 'Board', template: 'project', revision: 1, createdAt: '', updatedAt: '' };
const card: BoardItem = { id: 'card', projectId: 'board', content: 'A note', type: 'note', status: 'candidate', order: 0, createdAt: '', updatedAt: '' };
let host: HTMLDivElement; let root: Root; let save = vi.fn<(draft: CardDraft) => void>();
function render(busy = false, value: BoardItem | undefined = card) {
  act(() => root.render(<CardFormScreen project={project} card={value} busy={busy} onBack={vi.fn()} onChange={vi.fn()} onSave={save} />));
}
function touch(element: Element, type: string, x = 40, y = 120, fingers = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperties(event, {
    touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : Array.from({ length: fingers }, () => point) },
    changedTouches: { value: [point] },
  });
  act(() => element.dispatchEvent(event)); return event;
}
function tap(element: Element) { touch(element, 'touchstart'); return touch(element, 'touchend'); }
function doubleTap(element: Element) { tap(element); act(() => vi.advanceTimersByTime(100)); return tap(element); }
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); save = vi.fn<(draft: CardDraft) => void>(); render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
describe('card editor double-tap save shortcut', () => {
  it('saves through the form once on double tap, including a compatibility double-click', () => {
    const text = host.querySelector('textarea')!;
    const event = doubleTap(text);
    expect(event.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith({ title: '', content: 'A note', type: 'note', status: 'candidate' });
    act(() => text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('does not save on single taps, swipes, holds or cancelled touches', () => {
    const text = host.querySelector('textarea')!;
    tap(text); expect(save).not.toHaveBeenCalled();
    touch(text, 'touchstart'); touch(text, 'touchmove', 40, 160); touch(text, 'touchend', 40, 160);
    touch(text, 'touchstart'); act(() => vi.advanceTimersByTime(450)); touch(text, 'touchend');
    touch(text, 'touchstart'); touch(text, 'touchcancel');
    tap(text); expect(save).not.toHaveBeenCalled();
  });
  it('does not save blank cards or while a save is in progress', () => {
    act(() => root.render(null));
    act(() => root.render(<CardFormScreen project={project} busy={false} onBack={vi.fn()} onChange={vi.fn()} onSave={save} />));
    // No card means empty title and content.
    const empty = host.querySelector('textarea')!;
    doubleTap(empty); expect(save).not.toHaveBeenCalled();
    act(() => root.render(null)); render(true);
    doubleTap(host.querySelector('textarea')!); expect(save).not.toHaveBeenCalled();
  });
  it('leaves selectors and active IME composition alone', () => {
    doubleTap(host.querySelector('select')!); expect(save).not.toHaveBeenCalled();
    const text = host.querySelector('textarea')!;
    act(() => text.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    doubleTap(text); expect(save).not.toHaveBeenCalled();
    act(() => text.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    doubleTap(text); expect(save).toHaveBeenCalledTimes(1);
  });
});
