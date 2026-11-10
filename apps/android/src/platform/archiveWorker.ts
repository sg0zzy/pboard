import { compressArchive, type ArchivePayload } from './archiveCore';

self.addEventListener('message', (event: MessageEvent<{ id: number; payload: ArchivePayload }>) => {
  const { id, payload } = event.data;
  try { (self as unknown as Worker).postMessage({ id, value: compressArchive(payload) }); }
  catch (error) { (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
