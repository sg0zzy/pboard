import { useRef, type MouseEvent, type TouchEvent } from 'react';

type Tap = { x: number; y: number; time: number; target: EventTarget };
const excluded = (target: EventTarget) => target instanceof Element && !!target.closest('button, select, option, a');

/** Recognize deliberate double taps, excluding swipes, holds and IME composition. */
export function useCardSaveShortcut(enabled: boolean, save: () => void) {
  const start = useRef<Tap | null>(null);
  const previous = useRef<Tap | null>(null);
  const composing = useRef(false);
  const savedAt = useRef(-Infinity);
  function commit() {
    if (!enabled || composing.current || Date.now() - savedAt.current < 500) return false;
    savedAt.current = Date.now(); save(); return true;
  }
  return {
    onCompositionStart: () => { composing.current = true; previous.current = null; },
    onCompositionEnd: () => { composing.current = false; },
    onTouchStart: (event: TouchEvent) => {
      if (event.touches.length !== 1 || excluded(event.target) || composing.current) { start.current = null; previous.current = null; return; }
      const touch = event.touches[0];
      start.current = { x: touch.clientX, y: touch.clientY, time: Date.now(), target: event.target };
    },
    onTouchMove: (event: TouchEvent) => {
      const touch = event.touches[0]; const tap = start.current;
      if (event.touches.length !== 1 || !touch || (tap && Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 8)) { start.current = null; previous.current = null; }
    },
    onTouchCancel: () => { start.current = null; previous.current = null; },
    onTouchEnd: (event: TouchEvent) => {
      const tap = start.current; start.current = null;
      const touch = event.changedTouches[0];
      const time = Date.now();
      if (!tap || !touch || event.touches.length || time - tap.time > 250 || Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 8) { previous.current = null; return; }
      const last = previous.current;
      if (last && last.target === tap.target && time - last.time <= 300 && Math.hypot(touch.clientX - last.x, touch.clientY - last.y) <= 24) {
        previous.current = null;
        if (commit()) event.preventDefault();
      } else previous.current = { x: touch.clientX, y: touch.clientY, time, target: tap.target };
    },
    onDoubleClick: (event: MouseEvent) => { if (!excluded(event.target) && commit()) event.preventDefault(); },
  };
}
