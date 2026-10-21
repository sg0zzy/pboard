import { useEffect, useState } from 'react';
import type { RxRepository } from '../../storage/rxdbRepository';
import { downloadBlob } from '../download';

type Pending = Awaited<ReturnType<RxRepository['listPendingWork']>>;
type Api = Partial<Pick<RxRepository, 'listPendingWork' | 'reviewPendingWork' | 'exportPendingWork' | 'unhideProject' | 'discardRemovedBoardWork'>> & {
  subscribePendingWork?: (listener: (value: Pending) => void) => Promise<() => void> | (() => void);
};
export function PendingWorkControls({ api, onRenewBoard }: { api: Api; onRenewBoard?: (boardId: string) => Promise<{ role: string }> }) {
  const [edits, setEdits] = useState<Pending>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [deletion, setDeletion] = useState<{ boardId: string; editId: string; ids: string[] } | null>(null);
  useEffect(() => {
    let active = true, stop = () => {};
    const receive = (value: Pending) => { if (active) setEdits(value); };
    if (api.subscribePendingWork) void Promise.resolve(api.subscribePendingWork(receive)).then(next => { if (active) stop = next; else next(); }).catch(() => { if (active) setError('Pending work could not be read. Local data is retained.'); });
    else if (api.listPendingWork) void api.listPendingWork().then(receive);
    return () => { active = false; stop(); };
  }, [api]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); if (api.listPendingWork) setEdits(await api.listPendingWork()); } catch (e) { setError(e instanceof Error ? e.message : 'Pending work remains saved locally.'); } finally { setBusy(false); } };
  const renewBoard = (boardId: string) => async () => { if (onRenewBoard) await run(async () => { await onRenewBoard(boardId); }); };
  if (!edits.length && !error) return null;
  const actionable = edits.filter(edit => !edit.boardMissing);
  const evidence = edits.filter(edit => edit.boardMissing);
  const restoredBoards = new Set<string>();
  return <section className="conflict-recovery" aria-label="Pending work recovery">
    {actionable.length > 0 && <details>
      <summary>Synchronization pending ({actionable.length})</summary>
      <p>These local versions are held until authorized reconciliation. Private Drive can back them up independently.</p>
      {actionable.map(edit => <article key={edit.id}>
        <strong>{String(edit.value.name ?? edit.value.title ?? 'Card')}</strong>
        <p>{edit.reason}</p>
        {edit.value._deleted || edit.value.deletedAt ? <p>Pending deletion</p> : <pre>{String(edit.value.content ?? edit.value.name ?? '')}</pre>}
        <button disabled={busy || !api.exportPendingWork} onClick={() => void run(async () => {
          const data = await api.exportPendingWork!(edit.boardId); downloadBlob(`pboard-pending-${edit.boardId}.json`, new TextEncoder().encode(JSON.stringify(data)));
        })}>Export pending work and images</button>
        <button disabled={busy || !edit.canReview || !api.reviewPendingWork} onClick={() => void run(() => api.reviewPendingWork!(edit.id, edits.filter(e => e.boardId === edit.boardId && e.base.collection === edit.base.collection && e.base.documentId === edit.base.documentId).map(e => e.id)))}>Keep this version as a new edit on this device</button>
        {onRenewBoard && <button disabled={busy} onClick={renewBoard(edit.boardId)}>Verify board access and reconcile now</button>}
      </article>)}
    </details>}
    {evidence.length > 0 && <details>
      <summary>Retained pending work on removed boards ({evidence.length})</summary>
      <p>These boards are no longer in this account’s list. Restore a board to reconcile its work when authorization returns, or permanently delete the board and its private Drive backup.</p>
      {evidence.map(edit => {
        const restored = restoredBoards.has(edit.boardId);
        return <article key={edit.id}>
          <strong>{typeof edit.boardName === 'string' && edit.boardName ? edit.boardName : String(edit.value.name ?? edit.value.title ?? 'Card')}</strong>
          <p>{edit.reason}</p>
          <button disabled={busy || !api.exportPendingWork} onClick={() => void run(async () => {
            const data = await api.exportPendingWork!(edit.boardId); downloadBlob(`pboard-pending-${edit.boardId}.json`, new TextEncoder().encode(JSON.stringify(data)));
          })}>Export pending work and images</button>
          {api.unhideProject && <button disabled={busy || restored} onClick={() => void run(async () => { await api.unhideProject!(edit.boardId); restoredBoards.add(edit.boardId); })}>{restored ? "Board is restored" : "Restore board to the list"}</button>}
          {api.discardRemovedBoardWork && <div className="retained-work-delete">
            <button className="danger" disabled={busy} onClick={() => setDeletion({ boardId: edit.boardId, editId: edit.id, ids: evidence.filter(value => value.boardId === edit.boardId).map(value => value.id) })}>Permanently delete board</button>
            {deletion?.editId === edit.id && <div role="group" aria-label="Confirm permanent deletion">
              <p>Permanently delete this board, its cards and retained history from this device and its private Google Drive backup? This cannot be undone. Private Drive cleanup retries when connected. Other users’ copies remain intact.</p>
              <button disabled={busy} onClick={() => setDeletion(null)}>Cancel</button>
              <button className="danger" disabled={busy} onClick={() => void run(async () => {
                await api.discardRemovedBoardWork!(deletion.boardId, deletion.ids); setDeletion(null);
              })}>Delete board permanently</button>
            </div>}
          </div>}
        </article>;
      })}
    </details>}
    {error && <p role="status">{error}</p>}
  </section>;
}
