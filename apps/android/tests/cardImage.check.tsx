import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardImage } from '../src/components/CardImage';
import { thumbnailBlob } from '../src/images/thumbnail';
import type { StoredBlob } from '../../../src/storage/blobStore';
vi.mock('../src/images/thumbnail', () => ({ thumbnailBlob: vi.fn() }));
let host: HTMLDivElement; let root: Root; const entry: StoredBlob = { imageId: 'image', blob: new Blob(['image'], { type: 'image/png' }), mimeType: 'image/png', width: 1000, height: 2000, size: 5 };
beforeEach(() => {
  vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:preview'), revokeObjectURL: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('local card photo rendering', () => {
  it('shows a generated board thumbnail and releases its object URL on unmount', async () => {
    const thumbnail = new Blob(['thumbnail']); vi.mocked(thumbnailBlob).mockResolvedValue(thumbnail);
    const getImage = vi.fn().mockResolvedValue(entry);
    await act(async () => root.render(<CardImage card={{ imageId: 'image' }} getImage={getImage} thumbnail />));
    expect(getImage).toHaveBeenCalledExactlyOnceWith('image'); expect(thumbnailBlob).toHaveBeenCalledExactlyOnceWith(entry.blob);
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(thumbnail);
    expect(host.querySelector('img')?.classList.contains('card-photo--thumbnail')).toBe(true);
    act(() => root.render(null)); expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview');
  });
  it('shows unavailable photos gracefully and falls back to the image if thumbnail generation fails', async () => {
    const getImage = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(entry);
    await act(async () => root.render(<CardImage card={{ imageId: 'missing' }} getImage={getImage} thumbnail />));
    expect(host.querySelector('[role=status]')?.textContent).toBe('Photo unavailable');
    vi.mocked(thumbnailBlob).mockRejectedValueOnce(new Error('Canvas unavailable'));
    await act(async () => root.render(<CardImage card={{ imageId: 'image' }} getImage={getImage} thumbnail />));
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(entry.blob); expect(host.querySelector('img')).not.toBeNull();
  });
  it('ignores a stale image request after a new card is displayed', async () => {
    let finish!: (value: StoredBlob) => void;
    const getImage = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(entry);
    await act(async () => root.render(<CardImage card={{ imageId: 'old' }} getImage={getImage} />));
    await act(async () => root.render(<CardImage card={{ imageId: 'new' }} getImage={getImage} />));
    await act(async () => finish(entry));
    expect(URL.createObjectURL).toHaveBeenCalledOnce(); expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
  });
});
