import { useRef, useState } from 'react';
import { repository } from '../../storage/browser';
import { importBoardCopy, MAX_BOARD_IMPORT_BYTES, readBoardArchive } from '../importBoard';

export function ImportBoardControls() {
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');
  async function load(file?: File) {
    if (!file || busy.current) return;
    busy.current = true; setImporting(true); setMessage('');
    try {
      if (file.size > MAX_BOARD_IMPORT_BYTES) throw new Error('Board ZIP exceeds the 25 MB import limit.');
      const board = await readBoardArchive(new Uint8Array(await file.arrayBuffer()));
      await importBoardCopy(board, repository);
      setMessage(board.legacy ? 'Board imported. Older exports combine titles with card text and restore images as separate cards.' : 'Board imported as a new local copy.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The board could not be imported.'); }
    finally { busy.current = false; setImporting(false); if (input.current) input.current.value = ''; }
  }
  return <div className="board-import-controls">
    <input ref={input} type="file" accept=".zip,application/zip" aria-label="Pboard board ZIP" hidden onChange={event => void load(event.target.files?.[0])} />
    <button type="button" disabled={importing} onClick={() => input.current?.click()}>{importing ? 'Importing…' : 'Import pboard'}</button>
    {message && <p className="notice" role="status">{message}</p>}
  </div>;
}
