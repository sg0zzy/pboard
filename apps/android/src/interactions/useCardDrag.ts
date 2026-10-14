import { reorderAtTarget } from '../../../../src/sidebar/reorder';
import { useEffect, useRef, useState, type RefObject } from 'react';

export const CARD_HOLD_MS = 400;
const SCROLL_SLOP = 8;
type Point = { x: number; y: number };
export type CardDrag = { id: string; order: string[]; left: number; top: number; width: number; height: number; overTrash: boolean };
type Gesture = { id: string; start: Point; point: Point; rect: DOMRect; base: string[]; active: boolean; swiping?: boolean; pointerId?: number };

/** Touch listeners remain non-passive so a hold can claim the first move without blocking ordinary swipes. */
export function useCardDrag(list: RefObject<HTMLDivElement | null>, scroller: RefObject<HTMLElement | null>, ids: string[], disabled: boolean, onDrop: (id: string, order: string[]) => void, trash: RefObject<HTMLDivElement | null>, onDelete: (id: string) => void, statusSwipe: { canSwipe: (id: string) => boolean; onSwipe: (id: string, direction: -1 | 1) => string; container?: (id: string) => string }) {
  const [drag, setDrag] = useState<CardDrag | null>(null);
  const [swipe, setSwipe] = useState<{ id: string; offset: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const current = useRef({ ids, disabled, onDrop, onDelete, statusSwipe });
  const suppressClickUntil = useRef(0);
  current.current = { ids, disabled, onDrop, onDelete, statusSwipe };
  const cancelRef = useRef<() => void>(() => {});
  const idsKey = JSON.stringify(ids.map(id => [id, statusSwipe.container?.(id)]));
  useEffect(() => { cancelRef.current(); }, [idsKey, disabled]);

  useEffect(() => {
    const element = list.current;
    const scroll = scroller.current;
    if (!element || !scroll) return;
    let gesture: Gesture | null = null;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let preview: string[] = [];
    let lastTime = 0;
    function cancel() {
      if (hold) clearTimeout(hold);
      cancelAnimationFrame(frame);
      if (gesture?.active || gesture?.swiping) { suppressClickUntil.current = Date.now() + 350; setAnnouncement('Dragging cancelled.'); }
      gesture = null; preview = []; setDrag(null); setSwipe(null);
    }
    cancelRef.current = cancel;
    function overTrash(point: Point): boolean {
      const rect = trash.current?.getBoundingClientRect();
      return !!rect && rect.width > 0 && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }
    function update() {
      if (!gesture?.active) return;
      const selected = gesture;
      const deleting = overTrash(selected.point);
      if (deleting) {
        preview = selected.base;
        setDrag({ id: selected.id, order: preview, left: selected.rect.left + selected.point.x - selected.start.x, top: selected.rect.top + selected.point.y - selected.start.y, width: selected.rect.width, height: selected.rect.height, overTrash: true });
        setAnnouncement('Release over trash to discard this card.');
        return;
      }
      setAnnouncement('Card lifted. Drag to reorder, or onto the top-right trash to discard.');
      const group = selected.base.filter(id => current.current.statusSwipe.container?.(id) === current.current.statusSwipe.container?.(selected.id));
      const remaining = group.filter(id => id !== selected.id);
      const center = selected.rect.top + selected.point.y - selected.start.y + selected.rect.height / 2;
      let insertion = remaining.length;
      const outsideGroup = [...element!.querySelectorAll<HTMLElement>('[data-card-id]')].some(card => {
        if (current.current.statusSwipe.container?.(card.dataset.cardId!) === current.current.statusSwipe.container?.(selected.id)) return false;
        if (card.closest('details:not([open])')) return false;
        const rect = card.getBoundingClientRect();
        return rect.height > 0 && center >= rect.top && center <= rect.bottom;
      });
      for (const [index, id] of remaining.entries()) {
        const target = [...element!.querySelectorAll<HTMLElement>('[data-card-id]')].find(card => card.dataset.cardId === id);
        if (target) {
          const rect = target.getBoundingClientRect();
          if (rect.height > 0 && center < rect.top + rect.height / 2) { insertion = index; break; }
        }
      }
      preview = outsideGroup || insertion === group.indexOf(selected.id) || !remaining.length ? selected.base : reorderAtTarget(selected.base, selected.id, remaining[insertion] ?? remaining.at(-1)!, insertion < remaining.length ? 'before' : 'after');
      setDrag({ id: selected.id, order: preview, left: selected.rect.left + selected.point.x - selected.start.x, top: selected.rect.top + selected.point.y - selected.start.y, width: selected.rect.width, height: selected.rect.height, overTrash: false });
    }
    function autoScroll(time: number) {
      if (!gesture?.active) return;
      const rect = scroll!.getBoundingClientRect();
      const edge = 64;
      const y = gesture.point.y;
      const velocity = overTrash(gesture.point) ? 0 : y < rect.top + edge ? -Math.min(1, (rect.top + edge - y) / edge) : y > rect.bottom - edge ? Math.min(1, (y - rect.bottom + edge) / edge) : 0;
      const elapsed = lastTime ? Math.min(time - lastTime, 32) : 16;
      lastTime = time;
      if (velocity) { scroll!.scrollTop += velocity * elapsed * .6; update(); }
      frame = requestAnimationFrame(autoScroll);
    }
    function activate() {
      if (!gesture || gesture.active || gesture.swiping || current.current.disabled) return;
      if (hold) clearTimeout(hold);
      gesture.active = true;
      setAnnouncement('Card lifted. Drag to reorder, or onto the top-right trash to discard.');
      update(); lastTime = 0; frame = requestAnimationFrame(autoScroll);
    }
    function start(target: EventTarget | null, point: Point, pointerId?: number) {
      cancel();
      if (current.current.disabled || !(target instanceof Element)) return;
      if (target.closest('button, input, textarea, select, a')) return;
      const card = target.closest<HTMLElement>('[data-card-id]');
      const id = card?.dataset.cardId;
      if (!card || !id || !element!.contains(card)) return;
      gesture = { id, start: point, point, rect: card.getBoundingClientRect(), base: [...current.current.ids], active: false, pointerId };
      hold = setTimeout(activate, CARD_HOLD_MS);
    }
    function move(point: Point, event: Event) {
      if (!gesture) return;
      gesture.point = point;
      if (!gesture.active) {
        const dx = point.x - gesture.start.x; const dy = point.y - gesture.start.y;
        if (!gesture.swiping) {
          if (Math.abs(dx) > SCROLL_SLOP && Math.abs(dx) > Math.abs(dy) * 1.5 && gesture.pointerId === undefined && current.current.statusSwipe.canSwipe(gesture.id)) {
            if (hold) clearTimeout(hold);
            gesture.swiping = true;
          } else if (Math.hypot(dx, dy) > SCROLL_SLOP) { suppressClickUntil.current = Date.now() + 350; cancel(); return; }
        }
        if (gesture.swiping) {
          if (event.cancelable) event.preventDefault();
          setSwipe({ id: gesture.id, offset: Math.max(-96, Math.min(96, dx)) });
        }
        return;
      }
      if (event.cancelable) event.preventDefault();
      update();
    }
    function finish() {
      const selected = gesture;
      const order = preview;
      if (hold) clearTimeout(hold);
      cancelAnimationFrame(frame);
      gesture = null; setDrag(null); setSwipe(null);
      if (selected?.swiping) {
        suppressClickUntil.current = Date.now() + 350;
        const dx = selected.point.x - selected.start.x;
        const dy = selected.point.y - selected.start.y;
        const threshold = Math.max(48, Math.min(80, selected.rect.width * .2));
        if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5) setAnnouncement(current.current.statusSwipe.onSwipe(selected.id, dx > 0 ? 1 : -1));
        else setAnnouncement('Status unchanged.');
        return;
      }
      if (selected?.active) {
        suppressClickUntil.current = Date.now() + 350;
        if (overTrash(selected.point)) {
          setAnnouncement('Card dropped in trash.');
          current.current.onDelete(selected.id);
          return;
        }
        const changed = order.some((id, index) => id !== selected.base[index]);
        setAnnouncement(changed ? `Card moved to position ${order.indexOf(selected.id) + 1}.` : 'Card order unchanged.');
        if (changed) current.current.onDrop(selected.id, order);
      }
    }
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0]; start(event.target, { x: touch.clientX, y: touch.clientY });
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0]; move({ x: touch.clientX, y: touch.clientY }, event);
    };
    const touchEnd = (event: TouchEvent) => {
      if (event.touches.length) { cancel(); return; }
      const touch = event.changedTouches?.[0];
      if (gesture?.swiping && event.cancelable) event.preventDefault();
      if (touch && gesture) gesture.point = { x: touch.clientX, y: touch.clientY };
      finish();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      start(event.target, { x: event.clientX, y: event.clientY }, event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !gesture || gesture.pointerId !== event.pointerId) return;
      // Mouse/pen can also drag immediately after crossing the movement threshold.
      if (!gesture.active && Math.hypot(event.clientX - gesture.start.x, event.clientY - gesture.start.y) > SCROLL_SLOP) activate();
      move({ x: event.clientX, y: event.clientY }, event);
    };
    const pointerUp = (event: PointerEvent) => {
      if (gesture?.pointerId === event.pointerId) { gesture.point = { x: event.clientX, y: event.clientY }; finish(); }
    };
    const contextMenu = (event: Event) => { if (gesture || (event.target instanceof Element && event.target.closest('[data-card-id]'))) event.preventDefault(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    element.addEventListener('touchstart', touchStart, { passive: true });
    window.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('touchend', touchEnd);
    window.addEventListener('touchcancel', cancel);
    element.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', cancel);
    element.addEventListener('contextmenu', contextMenu);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      element.removeEventListener('touchstart', touchStart);
      window.removeEventListener('touchmove', touchMove);
      window.removeEventListener('touchend', touchEnd);
      window.removeEventListener('touchcancel', cancel);
      element.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', cancel);
      element.removeEventListener('contextmenu', contextMenu);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
    };
  }, [list, scroller, trash]);
  return { drag, swipe, announcement, suppressClick: () => Date.now() < suppressClickUntil.current };
}
