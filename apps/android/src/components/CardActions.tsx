import { useEffect, useRef } from 'react';
import { CARD_DISPLAY_MODE_DEFINITIONS, normalizeCardDisplayMode } from '../../../../src/cardDisplayModes';
import type { BoardItem } from '../storage/repository';
import type { CardDisplayMode } from '../../../../src/types';
export type CardAction = 'copy' | 'duplicate' | 'insert' | 'merge' | 'trash';
export function CardActions({ card, cards, choosingTarget, onAction, onMode, onMerge, onCancel }: {
  card: BoardItem; cards: BoardItem[]; choosingTarget: boolean; onAction: (action: CardAction) => void;
  onMode: (mode: CardDisplayMode) => void; onMerge: (target: BoardItem) => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const targets = cards.filter(value => value.id !== card.id && value.projectId === card.projectId);
  return <dialog ref={dialog} className="card-actions-dialog" aria-labelledby="card-actions-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="card-actions-title">{choosingTarget ? 'Merge into card' : 'Card actions'}</h2>
    {choosingTarget ? <div className="card-menu-options">{targets.map(target => <button key={target.id} type="button" aria-label={`Merge into ${target.title || target.content || 'Image card'}`} onClick={() => onMerge(target)}><span>{target.title || target.content || 'Image card'}</span><small className={`status-${target.status.replaceAll(' ', '-')}`}>{target.status}</small></button>)}</div> : <>
      <div className="card-menu-options">
        <button type="button" onClick={() => onAction('copy')} disabled={!card.title?.trim() && !card.content.trim()}>Copy card text</button>
        <button type="button" onClick={() => onAction('duplicate')}>Duplicate card</button>
        <button type="button" onClick={() => onAction('insert')}>Add card below</button>
        <button type="button" disabled={!!card.imageId || !!card.image || !targets.length} onClick={() => onAction('merge')}>Merge into another card</button>
        <button type="button" className="danger" onClick={() => onAction('trash')}>{card.status === 'trash' ? 'Delete permanently' : 'Move to trash'}</button>
      </div>
      <p className="muted">Display mode</p><div className="display-mode-options" role="group" aria-label="Card display mode">{CARD_DISPLAY_MODE_DEFINITIONS.map(mode => <button key={mode.id} type="button" aria-pressed={normalizeCardDisplayMode(card.displayMode) === mode.id} onClick={() => { if (normalizeCardDisplayMode(card.displayMode) !== mode.id) onMode(mode.id); }}>{mode.label}</button>)}</div>
      {(card.imageId || card.image) && <p className="muted">A card with a photo can be duplicated but cannot be merged into another card.</p>}
    </>}
    <div className="form-actions"><button type="button" onClick={onCancel}>Cancel</button></div>
  </dialog>;
}
