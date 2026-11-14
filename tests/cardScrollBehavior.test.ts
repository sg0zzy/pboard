import { expect, it } from 'vitest';

// The behaviour ensureCardVisible passes is the one knob that decides the felt
// latency: measured in Chromium over 2500 px, `smooth` settles in 867 ms and
// `instant` in 67 ms. This pins the choice at each call site rather than the
// browser's timing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dirname, '../src/sidebar/components/Card.tsx'), 'utf8');

it('scrolls instantly when a card is created, saved or dismissed', () => {
  // create / reopen for editing
  expect(source).toContain('ensureCardVisible(cardRef.current, "instant");\n      onFocusHandled();');
  // Enter-save and cancel-dismiss
  const instantCalls = source.match(/ensureCardVisible\(cardRef\.current, "instant"\)/g) ?? [];
  expect(instantCalls.length).toBeGreaterThanOrEqual(3);
});

it('still animates a deliberate navigation', () => {
  // the non-editing focus path keeps the default (smooth) behaviour
  expect(source).toMatch(/function ensureCardVisible\(card: HTMLElement \| null, behavior: ScrollBehavior = "smooth"\)/);
  expect(source).toContain('window.scrollTo({ top: target, behavior });');
});
