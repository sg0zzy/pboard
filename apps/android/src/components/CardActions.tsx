import { useEffect, useRef } from 'react';
import { CARD_DISPLAY_MODE_DEFINITIONS, normalizeCardDisplayMode } from '../../../../src/cardDisplayModes';
import type { BoardItem } from '../storage/repository';
import type { CardDisplayMode } from '../../../../src/types';
import { MaterialIcon, type MaterialIconName } from './MaterialIcon';
export type CardAction = 'copy' | 'duplicate' | 'insert' | 'merge' | 'trash';
const DISPLAY_MODE_ICONS: Record<CardDisplayMode, MaterialIconName> = { compact: 'compact', standard: 'standard', expanded: 'expanded' };
export function CardActions({ card, cards, choosingTarget, onAction, onMode, onMerge, onCancel }: {
  card: BoardItem; cards: BoardItem[]; choosingTarget: boolean; onAction: (action: CardAction) => void;
  onMode: (mode: CardDisplayMode) => void; onMerge: (target: BoardItem) => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const targets = cards.filter(value => value.id !== card.id && value.projectId === card.projectId);
  return <dialog ref={dialog} className="card-actions-dialog" aria-labelledby="card-actions-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="card-actions-title">{choosingTarget ? 'Merge into card' : 'Card actions'}</h2>
    {choosingTarget ? <div className="card-menu-options">{targets.map(target =>
      <button key={target.id} type="button" aria-label={`Merge into ${target.title || target.content || 'Image card'}`} onClick={() => onMerge(target)}>
        <MaterialIcon name="merge" /><span>{target.title || target.content || 'Image card'}</span><small className={`status-${target.status.replaceAll(' ', '-')}`}>{target.status}</small>
      </button>)}</div> : <>
      <div className="card-menu-options">
        <button type="button" onClick={() => onAction('copy')} disabled={!card.title?.trim() && !card.content.trim()}><MaterialIcon name="copy" /><span>Copy card text</span></button>
        <button type="button" onClick={() => onAction('duplicate')}><MaterialIcon name="duplicate" /><span>Duplicate card</span></button>
        <button type="button" onClick={() => onAction('insert')}><MaterialIcon name="insert" /><span>Add card below</span></button>
        <button type="button" disabled={!!card.imageId || !!card.image || !targets.length} onClick={() => onAction('merge')}><MaterialIcon name="merge" /><span>Merge into another card</span></button>
        <button type="button" className="danger" onClick={() => onAction('trash')}><MaterialIcon name="delete" /><span>{card.status === 'trash' ? 'Delete permanently' : 'Move to trash'}</span></button>
      </div>
      <p className="muted">Display mode</p><div className="display-mode-options" role="group" aria-label="Card display mode">{CARD_DISPLAY_MODE_DEFINITIONS.map(mode =>
        <button key={mode.id} type="button" aria-pressed={normalizeCardDisplayMode(card.displayMode) === mode.id} onClick={() => { if (normalizeCardDisplayMode(card.displayMode) !== mode.id) onMode(mode.id); }}>
          <MaterialIcon name={DISPLAY_MODE_ICONS[mode.id]} size={20} /><span>{mode.label}</span>
        </button>)}</div>
      {(card.imageId || card.image) && <p className="muted">A card with a photo can be duplicated but cannot be merged into another card.</p>}
    </>}
    <div className="form-actions"><button type="button" onClick={onCancel}><MaterialIcon name="close" size={20} />Cancel</button></div>
  </dialog>;
}
