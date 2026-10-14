import { CARD_DISPLAY_MODE_DEFINITIONS, normalizeCardDisplayMode } from '../../../../src/cardDisplayModes';
import type { CardDisplayMode } from '../../../../src/types';
import { CardImage, type ImageLoader } from '../components/CardImage';
import { Icon } from '../components/Icon';
import { pickPhoto } from '../platform/pickPhoto';
import type { BoardImage } from '../../../../src/types';
import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useCardSaveShortcut } from '../interactions/useCardSaveShortcut';
import { ScreenHeader } from '../components/ScreenHeader';
import { boardTemplates } from '../../../../src/templates/boardTemplates';
import { BOARD_ITEM_STATUSES, type BoardItemStatus, type BoardItemType } from '../../../../src/types';
import type { BoardItem, Project } from '../storage/repository';

export type CardEditField = 'title' | 'content';
export type CardDraft = { title: string; content: string; type: BoardItemType; status: BoardItemStatus; image?: BoardImage | null; displayMode?: CardDisplayMode };
export function CardFormScreen({ project, card, busy, onBack, onChange, onSave, getImage, focusField = card ? 'title' : 'content' }: {
  getImage?: ImageLoader;
  project: Project; card?: BoardItem; focusField?: CardEditField; busy: boolean; onBack: () => void; onChange: (dirty: boolean) => void; onSave: (draft: CardDraft, addBelow?: boolean) => void;
}) {
  const template = boardTemplates[project.template];
  const initial: CardDraft = { title: card?.title ?? '', content: card?.content ?? '', type: card?.type ?? template.defaultCardType, status: card?.status ?? 'candidate', ...(card?.displayMode ? { displayMode: normalizeCardDisplayMode(card.displayMode) } : {}) };
  const [draft, setDraft] = useState(initial);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const [picking, setPicking] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const hasPhoto = draft.image !== null && !!(draft.image || card?.imageId || card?.image);
  const canSave = !busy && !picking && !!(draft.title.trim() || draft.content.trim() || hasPhoto);
  const saveAndAdd = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const shortcut = useCardSaveShortcut(canSave, () => form.current?.requestSubmit());
  function update(next: CardDraft) {
    setDraft(next); onChange(Object.keys(next).some(key => next[key as keyof CardDraft] !== initial[key as keyof CardDraft]));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const addBelow = saveAndAdd.current; saveAndAdd.current = false;
    if (canSave) {
      const saved = { ...draft, title: draft.title.trim(), content: draft.content.trim() };
      if (addBelow) onSave(saved, true); else onSave(saved);
    }
  }
  async function choosePhoto() {
    if (busy || picking) return;
    setPicking(true); setPhotoError(null);
    try {
      const image = await pickPhoto();
      if (mounted.current && image) update({ ...latestDraft.current, image });
    } catch (error) { if (mounted.current) setPhotoError(error instanceof Error ? error.message : 'The photo could not be added. Please try again.'); }
    finally { if (mounted.current) setPicking(false); }
  }
  function removePhoto() {
    const next = { ...draft };
    if (card?.imageId || card?.image) next.image = null; else delete next.image;
    update(next); setPhotoError(null);
  }
  return <section className="card-editor-screen" aria-label="Card editor" {...shortcut}>
    <ScreenHeader title={card ? 'Edit card' : 'New card'} onBack={onBack}>
      <button className="toolbar-save" form="card-editor" type="submit" disabled={!canSave}>{busy ? 'Saving…' : 'Save'}</button>
    </ScreenHeader>
    <main className="screen-content"><form ref={form} id="card-editor" onSubmit={submit} onKeyDown={event => {
      if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey)) return;
      if (event.key === 'Enter' || event.key.toLowerCase() === 's') { event.preventDefault(); if (canSave) { saveAndAdd.current = event.key === 'Enter'; form.current?.requestSubmit(); } }
    }}>
      <label>Card title<input autoFocus={focusField === 'title'} maxLength={200} disabled={busy} value={draft.title} onChange={event => update({ ...draft, title: event.target.value })} /></label>
      <label>Card text<textarea autoFocus={focusField === 'content'} rows={8} disabled={busy} value={draft.content} onChange={event => update({ ...draft, content: event.target.value })} /></label>
      <div className="card-photo-editor">
        <div className="form-actions"><button type="button" className="photo-picker-button" disabled={busy || picking} onClick={() => { void choosePhoto(); }}><Icon name="photo" />{picking ? 'Opening photos…' : hasPhoto ? 'Replace photo' : 'Add photo'}</button>
          {hasPhoto && <button type="button" disabled={busy || picking} onClick={removePhoto}>Remove photo</button>}</div>
        {hasPhoto && <CardImage card={draft.image ? { image: draft.image } : card!} getImage={getImage} alt="Photo attached to this card" />}
        {photoError && <p className="photo-error" role="alert">{photoError}</p>}
      </div>
      <label>Card type<select disabled={busy} value={draft.type} onChange={event => update({ ...draft, type: event.target.value as BoardItemType })}>
        {template.cardTypes.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}
      </select></label>
      <label>Status<select disabled={busy} value={draft.status} onChange={event => update({ ...draft, status: event.target.value as BoardItemStatus })}>
        {BOARD_ITEM_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
      </select></label>
      <label>Display mode<select disabled={busy} value={normalizeCardDisplayMode(draft.displayMode)} onChange={event => update({ ...draft, displayMode: event.target.value as CardDisplayMode })}>{CARD_DISPLAY_MODE_DEFINITIONS.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
      <button type="button" disabled={!canSave} onClick={() => { saveAndAdd.current = true; form.current?.requestSubmit(); }}>Save and add below</button>
    </form></main>
  </section>;
}
