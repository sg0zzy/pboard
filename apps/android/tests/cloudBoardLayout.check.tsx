import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudBoard } from '../src/components/CloudBoard';
import type { AndroidSync } from '../src/sync/service';

type State = ReturnType<AndroidSync['state']>;
const invite = vi.fn(async () => {});
const service = { invite } as unknown as AndroidSync;

const base: State = { connected: true, busy: false, resolving: false, error: '', role: 'private', peers: 0, lastSynced: '', projectId: 'p' };
const state = (patch: Partial<State>): State => ({ ...base, ...patch });

let root: Root; let host: HTMLDivElement;
function render(value: State) {
  return act(async () => root.render(<CloudBoard service={service} state={value} projectId="p" />));
}
const row = () => host.querySelector<HTMLElement>('.cloud-row')!;
const share = () => host.querySelector<HTMLButtonElement>('.cloud-share-button');
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('collaboration strip layout', () => {
  it('keeps the share control on the same row as the peer status', async () => {
    await render(state({ peers: 2, role: 'owner' }));
    expect(row().contains(share())).toBe(true);
    // Both live in the single header row; no separate block between them.
    expect(row().children).toHaveLength(2);
    expect(row().querySelector('.cloud-status')?.textContent).toBe('owner access · 2 live peers');
    expect(share()?.textContent).toBe('Share board');
  });
  it('does not move the control or change the row contents when resolution finishes', async () => {
    await render(state({ resolving: true, peers: 0 }));
    expect(row().querySelector('.cloud-status')?.textContent).toBe('Connecting collaboration…');
    // The button occupies its final place from the first frame, disabled only.
    expect(share()).not.toBeNull();
    expect(share()!.disabled).toBe(true);
    expect(share()!.getAttribute('aria-disabled')).toBe('true');
    expect(row().children).toHaveLength(2);

    await render(state({ resolving: false, peers: 1, role: 'private' }));
    expect(share()!.disabled).toBe(false);
    expect(row().querySelector('.cloud-status')?.textContent).toBe('Private board · 1 live peer');
    // Same two-cell structure before and after: the row cannot reflow.
    expect(row().children).toHaveLength(2);
  });
  it('hides the control for editors and viewers, who cannot invite', async () => {
    await render(state({ role: 'editor', peers: 1 }));
    expect(share()).toBeNull();
    expect(row().children).toHaveLength(1);
    await render(state({ role: 'viewer', peers: 1 }));
    expect(share()).toBeNull();
    await render(state({ role: 'owner', peers: 1 }));
    expect(share()).not.toBeNull();
  });
  it('singularises the peer count and renders nothing while disconnected', async () => {
    await render(state({ peers: 1, role: 'owner' }));
    expect(row().querySelector('.cloud-status')?.textContent).toBe('owner access · 1 live peer');
    await render(state({ connected: false }));
    expect(host.querySelector('.cloud-board')).toBeNull();
  });
  it('opens the invitation form below the header row instead of squeezing the status', async () => {
    await render(state({ role: 'owner', peers: 12 }));
    const statusBefore = row().querySelector('.cloud-status');
    await act(async () => share()!.click());
    const form = host.querySelector('form')!;
    // The form is a sibling of the header row, not a flex child of it: as a
    // child it shrank the status cell to one character per line.
    expect(row().contains(form)).toBe(false);
    expect(row().querySelector('.cloud-status')).toBe(statusBefore);
    expect(form.parentElement).toBe(host.querySelector('.cloud-board'));
    expect(share()!.getAttribute('aria-expanded')).toBe('true');
    await act(async () => share()!.click());
    expect(host.querySelector('form')).toBeNull();
    expect(share()!.getAttribute('aria-expanded')).toBe('false');
  });
  it('invites through the same service call and reports the outcome in place', async () => {
    await render(state({ role: 'private' }));
    await act(async () => share()!.click());
    const [input, select] = host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('form input, form select');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'friend@example.com');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
    select.value = 'viewer';
    await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(invite).toHaveBeenCalledExactlyOnceWith('p', 'friend@example.com', 'viewer');
    expect(host.textContent).toContain('Invitation sent.');
    // The invited address is cleared, but the header row is untouched.
    expect(input.value).toBe('');
    expect(row().children).toHaveLength(2);
  });
  it('surfaces an invitation failure without losing the header row', async () => {
    invite.mockRejectedValueOnce(new Error('Only the owner can invite'));
    await render(state({ role: 'owner' }));
    await act(async () => share()!.click());
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain('Only the owner can invite');
    expect(row().children).toHaveLength(2);
  });
});
