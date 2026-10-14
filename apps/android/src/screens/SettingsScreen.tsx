import type { ReactNode } from 'react';
import { UI_SCALE_STEPS, adjustUiScale } from '../../../../src/sidebar/uiScale';
import { ScreenHeader } from '../components/ScreenHeader';
import type { Project } from '../storage/repository';
export function SettingsScreen({ showPreviews, projects, busy, onBack, onPreviews, onMoveBoard, uiScale = 1, onScale, cloud }: {
  cloud?: ReactNode;
  uiScale?: number; onScale?: (scale: number) => void;
  showPreviews: boolean; projects: Project[]; busy: boolean; onBack: () => void; onPreviews: (show: boolean) => void; onMoveBoard: (project: Project, direction: -1 | 1) => void;
}) {
  return <>
    <ScreenHeader title="Settings" onBack={onBack} />
    <main className="screen-content">
      <label className="checkbox-label"><input type="checkbox" checked={showPreviews} disabled={busy} onChange={event => onPreviews(event.target.checked)} />Show card previews</label>
      {onScale && <><h2>Board text size</h2><div className="form-actions"><button disabled={busy || uiScale === UI_SCALE_STEPS[0]} aria-label="Decrease board text size" onClick={() => onScale(adjustUiScale(uiScale, -1))}>−</button><output aria-label="Current board text size">{Math.round(uiScale * 100)}%</output><button disabled={busy || uiScale === UI_SCALE_STEPS.at(-1)} aria-label="Increase board text size" onClick={() => onScale(adjustUiScale(uiScale, 1))}>+</button></div></>}
      {cloud}
      <h2>Board order</h2><p>The four most recently edited boards appear first. The remaining boards follow this order.</p>
      <ol className="manual-order">{projects.map((project, index) => <li key={project.id}><span>{project.name}</span>
        <button disabled={busy || index === 0} aria-label={`Move ${project.name} up`} onClick={() => onMoveBoard(project, -1)}>↑</button>
        <button disabled={busy || index === projects.length - 1} aria-label={`Move ${project.name} down`} onClick={() => onMoveBoard(project, 1)}>↓</button>
      </li>)}</ol>
      <p className="settings-footer">pboard 0.2 · Boards are stored on this device.</p>
    </main>
  </>;
}
