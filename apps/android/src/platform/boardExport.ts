import { Capacitor, registerPlugin } from '@capacitor/core';
import { blobToDataUrl } from '../../../../src/storage/blobStore';
import { downloadBlob, type BoardArchive } from '../../../../src/sidebar/download';

export async function copyText(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  if (Capacitor.isNativePlatform()) {
    const { Clipboard } = await import('@capacitor/clipboard');
    await Clipboard.write({ string: text });
  } else await navigator.clipboard.writeText(text);
  return true;
}

/** WebView blob links cannot save downloads; Android chooses a destination through SAF. */
export async function saveBoardArchive(archive: BoardArchive): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) { downloadBlob(archive.filename, archive.data); return true; }
  const native = registerPlugin<{ save: (options: { filename: string; data: string }) => Promise<{ saved: boolean }> }>('BoardExport');
  const encoded = await blobToDataUrl(new Blob([archive.data], { type: 'application/zip' }));
  return (await native.save({ filename: archive.filename, data: encoded.slice(encoded.indexOf(',') + 1) })).saved;
}
