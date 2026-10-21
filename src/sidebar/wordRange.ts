/**
 * Word selection for the card editor.
 *
 * The card editor reserves the double-click for saving, so picking a word
 * needs a different gesture: keeping the left button pressed on the word.
 */

/** How long the left button stays down before the word under it is selected. */
export const WORD_HOLD_MS = 450;

/** Pointer movement that still counts as holding the button in place. */
export const WORD_HOLD_MOVE_TOLERANCE_PX = 6;

export type WordRange = { start: number; end: number };

let wordSegmenter: Intl.Segmenter | null = null;

function segments(): Intl.Segmenter {
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  return wordSegmenter;
}

/**
 * Expand a caret offset to the word around it.
 *
 * A caret inside a word selects that word. A caret sitting exactly on the end
 * of a word selects the same word, because that is where the browser puts the
 * caret when the right half of the final letter is pressed.
 */
export function wordRangeAt(text: string, offset: number): WordRange | null {
  if (!text) return null;
  const caret = Math.max(0, Math.min(offset, text.length));
  let trailing: WordRange | null = null;

  for (const segment of segments().segment(text)) {
    if (!segment.isWordLike) continue;
    const start = segment.index;
    const end = start + segment.segment.length;
    if (caret >= start && caret < end) return { start, end };
    if (caret === end) trailing = { start, end };
  }

  return trailing;
}
