import { useState } from 'react';
import type { createDriveFolderGardener, GardenFolder } from '../../sync/driveFolderGardening';

type Gardener = ReturnType<typeof createDriveFolderGardener>;
const folderMime = 'application/vnd.google-apps.folder';

function latestFileModification(row: GardenFolder): string {
  const files = row.children.filter(file => file.mimeType !== folderMime);
  if (!files.length) return 'No direct files';
  const dated = files.flatMap(file => {
    const time = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
    return Number.isFinite(time) ? [{ file, time }] : [];
  });
  if (!dated.length) return 'Date unavailable';
  const latest = dated.reduce((a, b) => a.time >= b.time ? a : b);
  return `${new Date(latest.time).toLocaleString()} — ${latest.file.name}${dated.length < files.length ? ' (some file dates unavailable)' : ''}`;
}

/** Explicit user review; never moves a folder merely because it is unknown. */
export function DriveFolderGardening({ gardener }: { gardener: Gardener }) {
  const [rows, setRows] = useState<GardenFolder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function review() {
    setBusy(true); setMessage(''); setRows(null);
    try { setRows(await gardener.preview()); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not review Drive folders.'); }
    finally { setBusy(false); }
  }
  async function trash(row: GardenFolder) {
    const risk = row.classification === 'unidentified'
      ? 'This folder is not recognized on this device. It may contain a live board or its only backup, including on another device.'
      : 'This device has a deletion record for this board.';
    if (!window.confirm(`${risk}\n\nMove “${row.name}” and all its contents to Google Drive Trash?`)) return;
    if (window.prompt(`To confirm, type the folder name exactly: ${row.name}`) !== row.name) return;
    setBusy(true); setMessage('');
    try { await gardener.trash(row.folderId); setRows(current => current?.filter(item => item.folderId !== row.folderId) ?? null); setMessage('Folder moved to Google Drive Trash.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not move folder to Trash.'); }
    finally { setBusy(false); }
  }
  return <details><summary>Review Drive folders</summary>
    <p>Compare the folders in your pboard Drive space with boards on this device. Unidentified folders may still be needed by another device; inspect them before moving anything to Trash.</p>
    <button type="button" disabled={busy} onClick={() => void review()}>{busy ? 'Working…' : 'Scan Drive folders'}</button>
    {rows && <><p>{rows.length} folders: {rows.filter(row => row.classification === 'active').length} present here, {rows.filter(row => row.classification === 'deleted').length} with deletion records, {rows.filter(row => row.classification === 'unidentified').length} unidentified.</p>
      {rows.filter(row => row.classification !== 'active').map(row => <details key={row.folderId}>
        <summary>{row.name} — {row.classification === 'deleted' ? 'deletion recorded' : 'unidentified'}{row.owned ? '' : ' (not owned)'} — latest file: {latestFileModification(row)}</summary>
        <p>Folder ID: {row.folderId}</p>
        <p>{row.children.length ? `Contents: ${row.children.map(file => file.name).join(', ')}` : 'No visible direct contents.'}</p>
        <p>Latest direct file modification: {latestFileModification(row)}</p>
        {row.owned && <button type="button" disabled={busy || row.children.some(file => !file.modifiedTime) || (row.classification === 'unidentified' && row.children.some(file => !file.mimeType || file.mimeType === 'application/vnd.google-apps.folder'))} onClick={() => void trash(row)}>Move this folder to Trash…</button>}
      </details>)}
    </>}
    {message && <p role="status">{message}</p>}
  </details>;
}
