import { useEffect, useRef, useState } from 'react';
import { googleDrive, operationService, type GardeningPreview } from '../../sync/browser';

/** Durable-log snapshots now publish themselves — the consolidation cycle
 * writes them on a schedule, on tab-hide and on board close, for every board
 * including ones whose history predates its log. What deliberately does NOT
 * happen automatically is deletion: moving eligible segments and superseded
 * snapshots to Google Drive Trash is destructive history retention, and it is
 * preview-plus-confirm by design. This is that gate, and it is the reason a
 * single automatic-snapshot path needs an owner-only control to exist at all.
 * It lives inside the collaboration disclosure because it is a collaboration
 * lifecycle control, and it hides itself for everyone but the Drive owner. */
export function BoardRetentionControls({ projectId }: { projectId: string }) {
  const [owner, setOwner] = useState(false), [busy, setBusy] = useState(''), [feedback, setFeedback] = useState('');
  const cancel = useRef<HTMLButtonElement>(null);
  const [plan, setPlan] = useState<GardeningPreview | null>(null), running = useRef(false), alive = useRef(true);
  useEffect(() => { if (plan) cancel.current?.focus(); }, [plan]);
  useEffect(() => { let active = true, stop = () => {}; void operationService.subscribeRole(projectId, value => { if (active) setOwner(value); }).then(next => { if (active) stop = next; else next(); }).catch(() => { if (active) setOwner(false); }); return () => { active = false; stop(); }; }, [projectId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void (async () => { if (await googleDrive.getConnectionState() !== 'connected') return false; return await operationService.role(projectId) === 'owner'; })()
      .then(value => { if (active) setOwner(value); }).catch(() => { if (active) setOwner(false); });
    return () => { active = false; };
  }, [projectId]);
  async function run(label: string, action: () => Promise<string>) {
    if (running.current) return;
    running.current = true; setBusy(label); setFeedback('');
    try { const result = await action(); if (alive.current) setFeedback(result); }
    catch (error) { if (alive.current) setFeedback(error instanceof Error ? error.message : 'Retention review failed. Nothing was deleted.'); }
    finally { running.current = false; if (alive.current) setBusy(''); }
  }
  if (!owner) return null;
  return <details className="board-retention">
    <summary title="Owner-controlled deletion of history that newer snapshots already cover">History retention</summary>
    <div className="board-retention-panel">
      <p>Snapshots publish themselves. Deleting the history they cover never happens on its own: review a fresh preview, then confirm the exact file set.</p>
      <button type="button" disabled={!!busy} onClick={() => void run('Checking history…', async () => {
        const preview = await operationService.previewGardening(projectId); if (alive.current) setPlan(preview);
        return 'Review the retention policy before deleting eligible history.';
      })}>Review old history</button>
      {plan && <div className="board-retention-preview">
        <p>{plan.eligibleSnapshots} snapshots and {plan.eligibleSegmentIds.length} operation segments eligible. Approximately {Math.ceil(plan.bytes / 1024)} KiB recoverable.</p>
        <p>{plan.policy}</p>
        <button type="button" ref={cancel} disabled={!!busy} onClick={() => setPlan(null)}>Cancel</button>
        <button type="button" disabled={!!busy || !(plan.eligibleSnapshots + plan.eligibleSegmentIds.length)} onClick={() => void run('Deleting eligible history…', async () => {
          const count = await operationService.garden(projectId, plan.eligibleFileIds); if (alive.current) setPlan(null);
          return `${count} eligible files moved to Google Drive Trash.`;
        })}>Confirm history deletion</button>
      </div>}
      <span role="status" aria-live="polite">{busy || feedback}</span>
    </div>
  </details>;
}
