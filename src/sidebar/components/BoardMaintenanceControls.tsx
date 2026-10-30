import { useEffect, useRef, useState } from 'react';
import { googleDrive, operationService } from '../../sync/browser';

type Plan = Awaited<ReturnType<typeof operationService.previewGardening>>;
/** Owner maintenance lives in a compact disclosure, with an explicit deletion
 * preview/confirmation. Compaction never implicitly gardens history. */
export function BoardMaintenanceControls({ projectId }: { projectId: string; revision: number }) {
  const [owner, setOwner] = useState(false), [busy, setBusy] = useState(''), [feedback, setFeedback] = useState('');
  const cancel = useRef<HTMLButtonElement>(null);
  const [plan, setPlan] = useState<Plan | null>(null), running = useRef(false), alive = useRef(true);
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
    catch (error) { if (alive.current) setFeedback(error instanceof Error ? error.message : 'Maintenance failed. Your local work is retained.'); }
    finally { running.current = false; if (alive.current) setBusy(''); }
  }
  if (!owner) return null;
  return <details className="board-maintenance">
    <summary title="Owner snapshot and history maintenance">Maintenance</summary>
    <div className="board-maintenance-panel">
      <button type="button" disabled={!!busy} title="Create an immutable snapshot without deleting history"
        onClick={() => void run('Compacting…', async () => { await operationService.compact(projectId); if (alive.current) setPlan(null); return 'Snapshot complete. Previous snapshots and logs were retained.'; })}>Compact</button>
      <button type="button" disabled={!!busy} onClick={() => void run('Checking history…', async () => {
        const preview = await operationService.previewGardening(projectId); if (alive.current) setPlan(preview);
        return 'Review the retention policy before deleting eligible history.';
      })}>Review old history</button>
      {plan && <div className="board-maintenance-preview">
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
