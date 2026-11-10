import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardActions } from '../src/components/CardActions';
import { MaterialIcon } from '../src/components/MaterialIcon';
import type { BoardItem } from '../src/storage/repository';

const card = (id: string, patch: Partial<BoardItem> = {}): BoardItem => ({
  id, projectId: 'p', content: `card ${id}`, type: 'task', status: 'candidate', order: 0, createdAt: '', updatedAt: '', ...patch,
});
const api = { onAction: vi.fn(), onMode: vi.fn(), onMerge: vi.fn(), onCancel: vi.fn() };

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

/** Icon of each menu row, in display order, resolved from the rendered SVG path. */
function rows() {
  return [...host.querySelectorAll<HTMLButtonElement>('dialog button')].map(button => ({
    label: button.querySelector('span')?.textContent ?? button.textContent?.trim() ?? '',
    icon: button.querySelector('svg.material-icon path')?.getAttribute('d') ?? null,
    disabled: button.disabled,
  }));
}
/** The path a named glyph renders, read from a real render rather than guessed. */
async function iconPath(name: Parameters<typeof MaterialIcon>[0]['name']) {
  const probe = document.createElement('div'); document.body.append(probe);
  const probeRoot = createRoot(probe);
  await act(async () => probeRoot.render(<MaterialIcon name={name} />));
  const path = probe.querySelector('svg.material-icon path')!.getAttribute('d');
  await act(async () => probeRoot.unmount()); probe.remove();
  return path;
}

describe('card menu icons', () => {
  it('gives every action row a distinct Material glyph in the same order as its label', async () => {
    await act(async () => root.render(<CardActions card={card('a')} cards={[card('a'), card('b')]} choosingTarget={false} {...api} />));
    const rendered = rows().filter(row => row.label !== '');
    const actions = rendered.slice(0, 5);
    expect(actions.map(row => row.label)).toEqual(['Copy card text', 'Duplicate card', 'Add card below', 'Merge into another card', 'Move to trash']);
    expect(actions.map(row => row.icon)).toEqual([
      await iconPath('copy'), await iconPath('duplicate'), await iconPath('insert'), await iconPath('merge'), await iconPath('delete'),
    ]);
    // No two actions share a glyph; a reused symbol would make them indistinguishable.
    expect(new Set(actions.map(row => row.icon)).size).toBe(5);
    // Display-mode buttons carry distinguishable glyphs too.
    const modes = rendered.slice(5, 8);
    expect(modes.map(row => row.label)).toEqual(['Compact view', 'Standard view', 'Expanded view']);
    expect(new Set(modes.map(row => row.icon)).size).toBe(3);
    expect(modes[1].icon).toBe(await iconPath('standard'));
  });
  it('keeps the destructive row destructive and the icon matching its label', async () => {
    const empty = card('a', { content: '', status: 'candidate' });
    await act(async () => root.render(<CardActions card={empty} cards={[empty]} choosingTarget={false} {...api} />));
    const trash = host.querySelector<HTMLButtonElement>('dialog button.danger')!;
    expect(trash.textContent).toBe('Move to trash');
    expect(trash.querySelector('svg.material-icon')).not.toBeNull();
    // Disabled, not removed, when a card has nothing to copy.
    const copy = [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Copy card text')!;
    expect(copy.disabled).toBe(true);
  });
  it('shows a merge target list whose rows keep the status on the icon-labelled line', async () => {
    const target = card('b', { title: 'Target', status: 'started' });
    await act(async () => root.render(<CardActions card={card('a')} cards={[card('a'), target]} choosingTarget {...api} />));
    const row = host.querySelector<HTMLButtonElement>('dialog button')!;
    expect(row.querySelector('svg.material-icon path')?.getAttribute('d')).toBe(await iconPath('merge'));
    expect(row.querySelector('small')?.textContent).toBe('started');
    expect(host.querySelector('dialog h2')?.textContent).toBe('Merge into card');
    await act(async () => row.click());
    expect(api.onMerge).toHaveBeenCalledExactlyOnceWith(target);
  });
});
