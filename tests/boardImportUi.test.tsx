// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { ImportBoardControls } from '../src/sidebar/components/ImportBoardControls';

const fake = vi.hoisted(() => ({ importLocalBoard: vi.fn() }));
vi.mock('../src/storage/browser', () => ({ repository: fake }));
const roots: ReturnType<typeof createRoot>[] = [];
const containers: HTMLElement[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); for (const container of containers.splice(0)) container.remove(); vi.resetAllMocks(); });
async function mount() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container); containers.push(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<ImportBoardControls />));
  return container;
}
async function choose(container: HTMLElement, data: Uint8Array) {
  const input = container.querySelector('input')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ size: data.length, arrayBuffer: async () => data.buffer }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
it('imports through the file picker without an existing board, prevents duplicate imports and allows another file afterwards', async () => {
  let complete!: (value: unknown) => void;
  fake.importLocalBoard.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const container = await mount();
  const picker = container.querySelector('input')!;
  const click = vi.spyOn(picker, 'click');
  await act(async () => container.querySelector('button')!.click());
  expect(click).toHaveBeenCalledOnce();
  const data = zipSync({ 'board.txt': strToU8('PROJECT: Import test\n\n[note] [candidate] Hello') });
  await choose(container, data);
  expect(container.querySelector('button')?.disabled).toBe(true);
  await choose(container, data);
  expect(fake.importLocalBoard).toHaveBeenCalledOnce();
  await act(async () => complete({ id: 'copy' }));
  expect(container.querySelector('[role=status]')?.textContent).toContain('Board imported');
  expect(container.querySelector('button')?.disabled).toBe(false);
  fake.importLocalBoard.mockResolvedValueOnce({ id: 'second-copy' });
  await choose(container, data);
  expect(fake.importLocalBoard).toHaveBeenCalledTimes(2);
});
it('shows a rejected archive error without changing storage', async () => {
  const container = await mount();
  await choose(container, zipSync({ 'other.txt': strToU8('No board') }));
  expect(fake.importLocalBoard).not.toHaveBeenCalled();
  expect(container.querySelector('[role=status]')?.textContent).toContain('not a supported Pboard');
});
