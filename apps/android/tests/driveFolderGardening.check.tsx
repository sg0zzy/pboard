import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DriveFolderGardening } from '../../../src/sidebar/components/DriveFolderGardening';
import type { createDriveFolderGardener } from '../../../src/sync/driveFolderGardening';

it('shows unknown contents and requires both confirmations before moving a folder', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const gardener = { preview: vi.fn(async () => [{ folderId: 'folder', rootId: 'root', name: 'old-board', owned: true, classification: 'unidentified' as const,
    children: [{ id: 'file', name: 'old-board.json.gz', mimeType: 'application/gzip', modifiedTime: '2026-01-01' },
      { id: 'older', name: 'older.json', mimeType: 'application/json', modifiedTime: '2025-01-01' }] }]), trash: vi.fn(async () => {}) };
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue('wrong');
  try {
    await act(async () => root.render(<DriveFolderGardening gardener={gardener as ReturnType<typeof createDriveFolderGardener>} />));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('old-board.json.gz');
    expect(host.textContent).toContain('Latest direct file modification:');
    expect(host.querySelectorAll('summary')[1].textContent).toContain(new Date('2026-01-01').toLocaleString());
    const button = [...host.querySelectorAll('button')].find(element => element.textContent?.includes('Move this folder'))!;
    await act(async () => button.click());
    expect(gardener.trash).not.toHaveBeenCalled();
    prompt.mockReturnValue('old-board');
    await act(async () => button.click());
    expect(gardener.trash).toHaveBeenCalledWith('folder');
  } finally { confirm.mockRestore(); prompt.mockRestore(); act(() => root.unmount()); host.remove(); }
});

it('reports the latest direct file date without using a newer subfolder date', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const gardener = { preview: vi.fn(async () => [{ folderId: 'folder', rootId: 'root', name: 'old', owned: true, classification: 'unidentified' as const,
    children: [{ id: 'file', name: 'newest.json', mimeType: 'application/json', modifiedTime: '2026-02-01T12:00:00Z' },
      { id: 'sub', name: 'subfolder', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-06-01T12:00:00Z' }] }]), trash: vi.fn() };
  try {
    await act(async () => root.render(<DriveFolderGardening gardener={gardener as ReturnType<typeof createDriveFolderGardener>} />));
    await act(async () => host.querySelector('button')!.click());
    const summary = host.querySelectorAll('summary')[1].textContent!;
    expect(summary).toContain(new Date('2026-02-01T12:00:00Z').toLocaleString());
    expect(summary).not.toContain(new Date('2026-06-01T12:00:00Z').toLocaleString());
  } finally { act(() => root.unmount()); host.remove(); }
});
