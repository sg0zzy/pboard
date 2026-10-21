/**
 * Press-and-hold word selection for the card editor.
 *
 * The card editor reserves the double-click for saving, so picking a word
 * needs a different gesture: keeping the left button pressed on the word.
 */

import { WORD_HOLD_MOVE_TOLERANCE_PX, WORD_HOLD_MS, wordRangeAt } from "./wordRange";

export { WORD_HOLD_MOVE_TOLERANCE_PX, WORD_HOLD_MS, wordRangeAt };
export type { WordRange } from "./wordRange";

/** The text fields a word can be selected in. */
export type WordSelectionTarget = HTMLInputElement | HTMLTextAreaElement;

/**
 * Selects the word under the pointer once the left button has been held down
 * long enough.
 *
 * The browser places the caret when the press starts, so the word is read
 * from the caret position once the hold completes. Moving the pointer cancels
 * the hold, which leaves ordinary drag-selection and the double-click that
 * saves the card untouched.
 */
export class HoldWordSelector {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private origin: { x: number; y: number } | null = null;
  private target: WordSelectionTarget | null = null;
  private readonly delayMs: number;
  private readonly moveTolerancePx: number;

  constructor(delayMs: number = WORD_HOLD_MS, moveTolerancePx: number = WORD_HOLD_MOVE_TOLERANCE_PX) {
    this.delayMs = delayMs;
    this.moveTolerancePx = moveTolerancePx;
  }

  begin(target: WordSelectionTarget, clientX: number, clientY: number) {
    this.cancel();
    this.target = target;
    this.origin = { x: clientX, y: clientY };
    this.timer = setTimeout(() => this.selectWord(), this.delayMs);
    window.addEventListener("mousemove", this.handleMove);
    window.addEventListener("mouseup", this.handleRelease);
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.origin = null;
    this.target = null;
    window.removeEventListener("mousemove", this.handleMove);
    window.removeEventListener("mouseup", this.handleRelease);
  }

  private readonly handleMove = (event: MouseEvent) => {
    if (!this.origin) return;
    if (Math.hypot(event.clientX - this.origin.x, event.clientY - this.origin.y) > this.moveTolerancePx) this.cancel();
  };

  private readonly handleRelease = () => {
    this.cancel();
  };

  private selectWord() {
    this.timer = undefined;
    const target = this.target;
    if (!target) return;
    if (target.ownerDocument.activeElement !== target) return;
    const offset = target.selectionStart;
    if (offset === null) return;
    const range = wordRangeAt(target.value, offset);
    if (!range) return;
    target.setSelectionRange(range.start, range.end);
  }
}
