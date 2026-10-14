import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardScreen } from '../src/screens/BoardScreen';
import { CARD_HOLD_MS } from '../src/interactions/useCardDrag';
import type { BoardItem, Project } from '../src/storage/repository';
const project: Project = { id: 'board', name: 'Board', template: 'project', revision: 1, createdAt: '', updatedAt: '' };
const cards: BoardItem[] = ['a', 'b', 'c'].map((id, order) => ({ id, projectId: project.id, content: id, title: order === 0 ? 'First title' : undefined, type: 'task', status: 'candidate', order, createdAt: '', updatedAt: '' }));
let root: Root; let host: HTMLDivElement; let choose = vi.fn(); let update = vi.fn(); let edit = vi.fn(); let remove = vi.fn(); let drop = vi.fn<(card: BoardItem, ids: string[]) => void>();
function touch(target: Element | Window, type: string, y: number, count = 1, x = 100) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) });
  act(() => target.dispatchEvent(event)); return event;
}
function rect(top: number, height: number) { return { x: 16, y: top, left: 16, right: 396, top, bottom: top + height, width: 380, height, toJSON: () => ({}) } as DOMRect; }
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); drop = vi.fn<(card: BoardItem, ids: string[]) => void>(); edit = vi.fn(); remove = vi.fn(); update = vi.fn(); choose = vi.fn();
  act(() => root.render(<BoardScreen project={project} cards={cards} busy={false} onBack={vi.fn()} onEditBoard={vi.fn()} onDeleteBoard={vi.fn()} onAddCard={vi.fn()} onEditCard={edit} onDeleteCard={remove} onReorderCard={drop} onChooseCardField={choose} onUpdateCard={update} onTrashSection={vi.fn()} onEmptyTrash={vi.fn()} />));
  const scroll = host.querySelector<HTMLElement>('main')!;
  scroll.getBoundingClientRect = () => rect(60, 540);
  for (const card of host.querySelectorAll<HTMLElement>('[data-card-id]')) card.getBoundingClientRect = () => rect(100 + [...host.querySelectorAll('[data-card-id]')].indexOf(card) * 132 - scroll.scrollTop, 120);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
describe('hold and drag cards', () => {
  it('lifts after holding, previews the new order and commits once on release', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS - 1));
    expect(document.querySelector('.drag-ghost')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector('.drag-ghost')).not.toBeNull();
    expect(touch(window, 'touchmove', 500).defaultPrevented).toBe(true);
    expect([...host.querySelectorAll<HTMLElement>('[data-card-id]')].map(element => element.dataset.cardId)).toEqual(['b', 'c', 'a']);
    const placeholders = host.querySelectorAll<HTMLElement>('.drag-placeholder');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].dataset.cardId).toBe('a');
    expect([...host.querySelectorAll<HTMLElement>('[data-card-id]')].indexOf(placeholders[0])).toBe(2);
    expect(drop).not.toHaveBeenCalled();
    touch(window, 'touchend', 500, 0);
    expect(drop).toHaveBeenCalledExactlyOnceWith(cards[0], ['b', 'c', 'a']);
    expect(document.querySelector('.drag-ghost')).toBeNull();
    expect(host.querySelector('.drag-placeholder')).toBeNull();
  });
  it('keeps ordinary swipes scrollable and does not reorder', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    expect(touch(window, 'touchmove', 190).defaultPrevented).toBe(false);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    expect(document.querySelector('.drag-ghost')).toBeNull();
    touch(window, 'touchend', 190, 0);
    expect(drop).not.toHaveBeenCalled();
  });
  it('cancels on touch cancellation or a second finger, without writing', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchmove', 500);
    touch(window, 'touchcancel', 500, 0);
    expect(document.querySelector('.drag-ghost')).toBeNull();
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchmove', 500, 2);
    touch(window, 'touchend', 500, 0);
    expect(drop).not.toHaveBeenCalled();
  });
  it('ignores action buttons and a hold released without a move', () => {
    touch(host.querySelector('.form-actions button')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    expect(document.querySelector('.drag-ghost')).toBeNull();
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchend', 160, 0);
    expect(drop).not.toHaveBeenCalled();
  });
  it('auto-scrolls near the edge and cancels safely on unmount', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchmove', 580);
    act(() => vi.advanceTimersByTime(64));
    expect(host.querySelector('main')!.scrollTop).toBeGreaterThan(0);
    act(() => root.render(null));
    touch(window, 'touchend', 580, 0);
    expect(drop).not.toHaveBeenCalled();
    expect(document.querySelector('.drag-ghost')).toBeNull();
  });
  it('has no per-card action bar and edits only after a double tap', () => {
    const card = host.querySelector<HTMLElement>('[data-card-id]')!;
    expect(card.querySelectorAll('button:not(.card-field-button)')).toHaveLength(0);
    const tap = () => act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 100, clientY: 160 })));
    tap(); expect(edit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100)); tap();
    expect(edit).toHaveBeenCalledExactlyOnceWith(cards[0]);
  });
  it('shows trash only when dragging, highlights it and deletes only on release inside it', () => {
    expect(host.querySelector('.trash-target')).toBeNull();
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    const trash = host.querySelector<HTMLElement>('.trash-target')!;
    trash.getBoundingClientRect = () => ({ ...rect(8, 56), left: 340, right: 396, width: 56 });
    touch(window, 'touchmove', 32, 1, 368);
    expect(trash.classList.contains('trash-target--active')).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    touch(window, 'touchend', 32, 0, 368);
    expect(remove).toHaveBeenCalledExactlyOnceWith(cards[0]);
    expect(drop).not.toHaveBeenCalled();
    expect(host.querySelector('.trash-target')).toBeNull();
    act(() => host.querySelector('[data-card-id]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(edit).not.toHaveBeenCalled();
  });
  it('does not delete after leaving trash or cancelling over it', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    host.querySelector<HTMLElement>('.trash-target')!.getBoundingClientRect = () => ({ ...rect(8, 56), left: 340, right: 396, width: 56 });
    touch(window, 'touchmove', 32, 1, 368);
    touch(window, 'touchmove', 160, 1, 100);
    expect(host.querySelector('.trash-target--active')).toBeNull();
    touch(window, 'touchend', 160, 0);
    expect(remove).not.toHaveBeenCalled();
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    host.querySelector<HTMLElement>('.trash-target')!.getBoundingClientRect = () => ({ ...rect(8, 56), left: 340, right: 396, width: 56 });
    touch(window, 'touchmove', 32, 1, 368); touch(window, 'touchcancel', 32, 0);
    expect(remove).not.toHaveBeenCalled();
  });
  it('keeps keyboard editing, ordering and deletion without visible controls', () => {
    const card = host.querySelector('[data-card-id]')!;
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(edit).toHaveBeenCalledWith(cards[0], undefined);
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })));
    expect(drop).toHaveBeenCalledWith(cards[0], ['b', 'a', 'c']);
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    expect(remove).toHaveBeenCalledWith(cards[0]);
  });
  it('edits title and text on a single tap at the selected field', () => {
    const title = host.querySelector('[data-edit-field=title]')!;
    act(() => title.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(edit).toHaveBeenLastCalledWith(cards[0], 'title');
    const content = host.querySelector('.card-text')!;
    act(() => content.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(edit).toHaveBeenLastCalledWith(cards[0], 'content');
    expect(update).not.toHaveBeenCalled();
  });
  it('opens category/status choosers without editing, dragging or bubbling keyboard activation', () => {
    const category = host.querySelector<HTMLButtonElement>('button[aria-label="Change category of card 1"]')!;
    act(() => category.click());
    expect(choose).toHaveBeenCalledExactlyOnceWith(cards[0], 'type');
    const status = host.querySelector<HTMLButtonElement>('button[aria-label="Change status of card 1"]')!;
    act(() => status.click());
    expect(choose).toHaveBeenLastCalledWith(cards[0], 'status');
    act(() => status.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    touch(category, 'touchstart', 160); act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    expect(document.querySelector('.drag-ghost')).toBeNull();
    expect(edit).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
  it('never opens the editor from the click generated after dragging card text', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchmove', 500); touch(window, 'touchend', 500, 0);
    act(() => host.querySelector('[data-edit-field=content]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(edit).not.toHaveBeenCalled();
  });
  it('advances status on right swipe only on release, without editing or reordering', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    // A slow horizontal start still claims the swipe before the hold timer.
    expect(touch(window, 'touchmove', 160, 1, 110).defaultPrevented).toBe(true);
    touch(window, 'touchmove', 160, 1, 220);
    expect(host.querySelector('.swipe-status-preview')?.textContent).toContain('confirmed');
    expect(host.querySelector('.trash-target')).toBeNull();
    expect(update).not.toHaveBeenCalled();
    touch(window, 'touchend', 160, 0, 220);
    expect(update).toHaveBeenCalledExactlyOnceWith(cards[0], { status: 'confirmed' });
    expect(drop).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    act(() => host.querySelector('.card-text')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(edit).not.toHaveBeenCalled();
  });
  it('decreases status on left swipe', () => {
    const values = cards.map((card, index) => index === 0 ? { ...card, status: 'started' as const } : card);
    act(() => root.render(<BoardScreen project={project} cards={values} busy={false} onBack={vi.fn()} onEditBoard={vi.fn()} onDeleteBoard={vi.fn()} onAddCard={vi.fn()} onEditCard={edit} onDeleteCard={remove} onReorderCard={drop} onChooseCardField={choose} onUpdateCard={update} onTrashSection={vi.fn()} onEmptyTrash={vi.fn()} />));
    touch(host.querySelector('.card-text')!, 'touchstart', 160, 1, 200);
    touch(window, 'touchmove', 160, 1, 90); touch(window, 'touchend', 160, 0, 90);
    expect(update).toHaveBeenCalledExactlyOnceWith(values[0], { status: 'confirmed' });
  });
  it('ignores short/cancelled swipes and holds remain drag gestures', () => {
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    touch(window, 'touchmove', 160, 1, 120); touch(window, 'touchend', 160, 0, 120);
    expect(update).not.toHaveBeenCalled();
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    touch(window, 'touchmove', 160, 1, 220); touch(window, 'touchcancel', 160, 0, 220);
    expect(update).not.toHaveBeenCalled();
    touch(host.querySelector('.card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchmove', 160, 1, 220); touch(window, 'touchend', 160, 0, 220);
    expect(update).not.toHaveBeenCalled();
  });
  it('never swipes rejected/trash statuses or wraps at a workflow boundary', () => {
    for (const status of ['rejected', 'trash', 'done'] as const) {
      const values = cards.map((card, index) => index === 0 ? { ...card, status } : card);
      act(() => root.render(<BoardScreen project={project} cards={values} busy={false} onBack={vi.fn()} onEditBoard={vi.fn()} onDeleteBoard={vi.fn()} onAddCard={vi.fn()} onEditCard={edit} onDeleteCard={remove} onReorderCard={drop} onChooseCardField={choose} onUpdateCard={update} onTrashSection={vi.fn()} onEmptyTrash={vi.fn()} />));
      touch(host.querySelector('[data-card-id="a"] .card-text')!, 'touchstart', 160);
      touch(window, 'touchmove', 160, 1, 220); touch(window, 'touchend', 160, 0, 220);
    }
    expect(update).not.toHaveBeenCalled();
  });
  it('matches collapsed browser containers and preserves canonical order within each', () => {
    const values = [
      { ...cards[0], status: 'done' as const }, cards[1],
      { ...cards[2], status: 'done' as const },
      { ...cards[0], id: 'reject', status: 'rejected' as const },
      { ...cards[0], id: 'trash', status: 'trash' as const },
    ];
    const trashSection = vi.fn(); const emptyTrash = vi.fn();
    act(() => root.render(<BoardScreen project={project} cards={values} busy={false} onBack={vi.fn()} onEditBoard={vi.fn()} onDeleteBoard={vi.fn()} onAddCard={vi.fn()} onEditCard={edit} onDeleteCard={remove} onReorderCard={drop} onChooseCardField={choose} onUpdateCard={update} onTrashSection={trashSection} onEmptyTrash={emptyTrash} />));
    const sections = [...host.querySelectorAll<HTMLDetailsElement>('details')];
    expect(sections.map(section => section.dataset.sectionStatus)).toEqual(['done', 'rejected', 'trash']);
    expect(sections.every(section => !section.open)).toBe(true);
    expect(sections[0].querySelector('summary span')?.textContent).toBe('Done (2)');
    expect([...sections[0].querySelectorAll<HTMLElement>('[data-card-id]')].map(card => card.dataset.cardId)).toEqual(['a', 'c']);
    expect(host.querySelector('.card-list > .swipe-row [data-card-id]')?.getAttribute('data-card-id')).toBe('b');
    act(() => sections[0].querySelector<HTMLButtonElement>('button')!.click());
    expect(trashSection).toHaveBeenCalledExactlyOnceWith('done'); expect(sections[0].open).toBe(false);
    act(() => sections[2].querySelector<HTMLButtonElement>('button')!.click()); expect(emptyTrash).toHaveBeenCalledOnce();
    act(() => sections[0].querySelector('summary')!.click()); expect(sections[0].open).toBe(true);
    act(() => sections[0].querySelector('[data-card-id="a"]')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true, key: 'ArrowDown' })));
    expect(drop).toHaveBeenCalledExactlyOnceWith(values[0], ['b', 'c', 'a', 'reject', 'trash']);
  });
  it('drags only within the source container using the browser single-card move order', () => {
    const values = [cards[0], { ...cards[1], status: 'done' as const }, cards[2]];
    act(() => root.render(<BoardScreen project={project} cards={values} busy={false} onBack={vi.fn()} onEditBoard={vi.fn()} onDeleteBoard={vi.fn()} onAddCard={vi.fn()} onEditCard={edit} onDeleteCard={remove} onReorderCard={drop} onChooseCardField={choose} onUpdateCard={update} onTrashSection={vi.fn()} onEmptyTrash={vi.fn()} />));
    touch(host.querySelector('[data-card-id="a"] .card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchend', 160, 0);
    expect(drop).not.toHaveBeenCalled();
    touch(host.querySelector('[data-card-id="a"] .card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchmove', 500); touch(window, 'touchend', 500, 0);
    expect(drop).toHaveBeenCalledExactlyOnceWith(values[0], ['b', 'c', 'a']);
    drop.mockClear();
    host.querySelector<HTMLDetailsElement>('details')!.open = true;
    host.querySelector<HTMLElement>('[data-card-id="b"]')!.getBoundingClientRect = () => rect(364, 120);
    touch(host.querySelector('[data-card-id="a"] .card-text')!, 'touchstart', 160);
    act(() => vi.advanceTimersByTime(CARD_HOLD_MS));
    touch(window, 'touchmove', 430); touch(window, 'touchend', 430, 0);
    expect(drop).not.toHaveBeenCalled();

    expect(remove).not.toHaveBeenCalled();
  });
  it('supports browser keyboard outcomes while keeping Android swipe rules', () => {
    const card = host.querySelector<HTMLElement>('[data-card-id="a"]')!;
    act(() => card.focus());
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(host.querySelector('[data-card-id="b"]'));
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(update).toHaveBeenLastCalledWith(cards[0], { status: 'confirmed' });
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true })));
    expect(update).toHaveBeenLastCalledWith(cards[0], { type: 'constraint' });
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true })));
    expect(update).toHaveBeenLastCalledWith(cards[0], { displayMode: 'expanded' });
  });
  it('uses browser card-type accent and tint definitions', () => {
    const card = host.querySelector<HTMLElement>('[data-card-id]')!;
    expect(card.style.getPropertyValue('--card-accent')).toBe('#22827d');
    expect(card.style.getPropertyValue('--card-tint')).toBe('#e4f6f4');
  });
});
