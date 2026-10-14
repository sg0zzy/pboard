import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyText, saveBoardArchive } from '../src/platform/boardExport';
const platform = vi.hoisted(() => ({ native: true, save: vi.fn(), clipboard: vi.fn(), browserDownload: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => platform.native }, registerPlugin: () => ({ save: platform.save }) }));
vi.mock('@capacitor/clipboard', () => ({ Clipboard: { write: platform.clipboard } }));
vi.mock('../../../src/sidebar/download', () => ({ downloadBlob: platform.browserDownload }));
beforeEach(() => { vi.resetAllMocks(); platform.native = true; });
describe('Android export platform boundaries', () => {
  it('sends ZIP bytes and filename to the native Save as picker and propagates cancellation', async () => {
    const archive = { filename: 'Board.zip', data: new Uint8Array([80, 75, 3, 4]) };
    platform.save.mockResolvedValueOnce({ saved: true }).mockResolvedValueOnce({ saved: false });
    expect(await saveBoardArchive(archive)).toBe(true);
    expect(platform.save).toHaveBeenLastCalledWith({ filename: 'Board.zip', data: 'UEsDBA==' });
    expect(await saveBoardArchive(archive)).toBe(false);
    expect(platform.browserDownload).not.toHaveBeenCalled();
  });
  it('uses native clipboard only for non-empty text and surfaces failures', async () => {
    platform.clipboard.mockResolvedValueOnce(undefined);
    expect(await copyText('Text')).toBe(true); expect(platform.clipboard).toHaveBeenCalledExactlyOnceWith({ string: 'Text' });
    expect(await copyText('  ')).toBe(false);
    platform.clipboard.mockRejectedValueOnce(new Error('Unavailable')); await expect(copyText('Text')).rejects.toThrow('Unavailable');
  });
  it('keeps frontend downloads working through the browser implementation', async () => {
    platform.native = false; const archive = { filename: 'Board.zip', data: new Uint8Array([1]) };
    expect(await saveBoardArchive(archive)).toBe(true); expect(platform.browserDownload).toHaveBeenCalledExactlyOnceWith(archive.filename, archive.data);
  });
});
