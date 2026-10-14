import { useState, type FormEvent } from 'react';
import { ScreenHeader } from '../components/ScreenHeader';
import type { Project } from '../storage/repository';
import { boardTemplates } from '../../../../src/templates/boardTemplates';
import { BOARD_TEMPLATES, type BoardTemplate } from '../../../../src/types';

export type BoardDraft = { name: string; template: BoardTemplate };
export function BoardFormScreen({ project, busy, onBack, onChange, onSave }: {
  project?: Project; busy: boolean; onBack: () => void; onChange: (dirty: boolean) => void; onSave: (draft: BoardDraft) => void;
}) {
  const initial = { name: project?.name ?? '', template: project?.template ?? 'brainstorming' };
  const [draft, setDraft] = useState<BoardDraft>(initial);
  function update(next: BoardDraft) {
    setDraft(next); onChange(next.name !== initial.name || next.template !== initial.template);
  }
  function submit(event: FormEvent) { event.preventDefault(); if (draft.name.trim() && !busy) onSave({ ...draft, name: draft.name.trim() }); }
  return <>
    <ScreenHeader title={project ? 'Edit board' : 'New board'} onBack={onBack} />
    <main className="screen-content"><form onSubmit={submit}>
      <label>Board title<input name="name" autoFocus required maxLength={200} value={draft.name} disabled={busy} onChange={event => update({ ...draft, name: event.target.value })} /></label>
      <label>Board type<select value={draft.template} disabled={busy} onChange={event => update({ ...draft, template: event.target.value as BoardTemplate })}>
        {BOARD_TEMPLATES.map(template => <option key={template} value={template}>{boardTemplates[template].displayName}</option>)}
      </select></label>
      {project && draft.template !== initial.template && <p>Changing the board type converts unsupported card types to notes.</p>}
      <button className="primary" type="submit" disabled={busy || !draft.name.trim()}>{busy ? 'Saving…' : 'Save board'}</button>
    </form></main>
  </>;
}
