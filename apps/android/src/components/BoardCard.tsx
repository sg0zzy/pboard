import { memo, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { MarkdownContent, MarkdownInline, setTaskCheckedAtLine } from '../../../../src/sidebar/markdown';
import { normalizeCardDisplayMode, nextCardDisplayMode } from '../../../../src/cardDisplayModes';
import { stepCardType, stepStatus } from '../../../../src/sidebar/cardCycle';
import { cardColors } from '../data/cardColors';
import { swipeStatus } from '../interactions/cardSwipeStatus';
import { toSafeWebHref } from '../../../../src/sidebar/linkify';
import { getCardTypeDefinition } from '../../../../src/templates/boardTemplates';
import type { BoardItem, Project } from '../storage/repository';
import type { CardEditField } from '../screens/CardFormScreen';
import type { CardPickerField } from './CardFieldPicker';
import { CardImage, type ImageLoader } from './CardImage';
import { Icon } from './Icon';

/** Stable callbacks. Identity never changes, so it never invalidates the memo. */
export type BoardCardApi = {
  dragging: () => boolean;
  swipeOffset: (id: string) => number | undefined;
  expand: (id: string) => void;
  suppressClick: () => boolean;
  edit: (card: BoardItem, field?: CardEditField) => void;
  editCard: (card: BoardItem) => void;
  remove: (card: BoardItem) => void;
  update: (card: BoardItem, patch: Partial<Pick<BoardItem, 'type' | 'status' | 'content' | 'displayMode'>>) => void;
  chooseField: (card: BoardItem, field: CardPickerField) => void;
  actions: (card: BoardItem) => void;
  insertAfter: (card: BoardItem) => void;
  reorderByKey: (card: BoardItem, direction: -1 | 1) => void;
  focusAdjacent: (card: BoardItem, direction: -1 | 1) => void;
  takeTap: (id: string, eventTime: number, x: number, y: number) => boolean;
  dropTap: () => void;
};

export type BoardCardProps = {
  card: BoardItem; index: number; project: Project; collapsed: boolean; collapseActive: boolean; dragging: boolean; readOnly: boolean;
  swipeOffset?: number; hasActions: boolean; getImage?: ImageLoader; api: BoardCardApi;
};

/** A status, text or display-mode write touches one card. Re-rendering every
 * row re-parsed every card's Markdown and threw away all image state, which
 * measured ~80 ms per write on a 300-card board. The comparator keeps a row
 * when nothing it displays changed — including when the reactive snapshot
 * hands back fresh but equal objects after each write. */
function sameCard(a: BoardItem, b: BoardItem): boolean {
  return a.id === b.id && a.title === b.title && a.content === b.content && a.type === b.type
    && a.status === b.status && a.displayMode === b.displayMode && a.order === b.order
    && a.imageId === b.imageId && a.imageMimeType === b.imageMimeType
    && a.imageWidth === b.imageWidth && a.imageHeight === b.imageHeight
    && a.image === b.image && a.source?.conversationUrl === b.source?.conversationUrl
    && a.source?.provider === b.source?.provider;
}

export const BoardCard = memo(function BoardCard({ card, index, project, collapsed, collapseActive, dragging, readOnly, swipeOffset, hasActions, getImage, api }: BoardCardProps) {
  const mode = normalizeCardDisplayMode(card.displayMode);
  const sourceHref = card.source?.conversationUrl ? toSafeWebHref(card.source.conversationUrl) : null;
  const summary = card.title?.trim() || card.content.trim().split('\n').find(line => line.trim())?.trim() || 'Image card';
  const number = index + 1;
  function click(event: MouseEvent<HTMLElement>) {
    if (readOnly || dragging || api.swipeOffset(card.id) !== undefined || api.suppressClick()) return;
    if (event.target instanceof Element) {
      if (event.target.closest('button, select, input, a')) return;
      if (collapsed) { api.dropTap(); api.expand(card.id); return; }
      const field = event.target.closest<HTMLElement>('[data-edit-field]')?.dataset.editField as CardEditField | undefined;
      if (field) { api.dropTap(); api.edit(card, field); return; }
    }
    if (event.detail === 0) { api.dropTap(); if (collapsed) { api.expand(card.id); return; } api.edit(card); return; }
    // Double-tap opens the editor; a single tap stays inert so a swipe or a
    // long-press drag does not also open it.
    if (api.takeTap(card.id, Date.now(), event.clientX, event.clientY)) api.editCard(card);
  }
  function key(event: KeyboardEvent<HTMLElement>) {
    if (readOnly || dragging || (event.target instanceof Element && event.target.closest('button, select, input, a'))) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); api.insertAfter(card); }
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      // A collapsed row opens in place first; only an open card opens the editor.
      if (collapsed) { api.expand(card.id); return; }
      api.edit(card, event.target instanceof Element ? event.target.closest<HTMLElement>('[data-edit-field]')?.dataset.editField as CardEditField | undefined : undefined);
    }
    else if (event.key === 'Delete') { event.preventDefault(); api.remove(card); }
    else if ((event.altKey || (event.shiftKey && (event.ctrlKey || event.metaKey))) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); api.reorderByKey(card, event.key === 'ArrowUp' ? -1 : 1);
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault(); api.focusAdjacent(card, event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      api.update(card, event.ctrlKey || event.metaKey ? { type: stepCardType(project.template, card.type, direction) } : { status: stepStatus(card.status, direction) });
    } else if (event.key.toLowerCase() === 'v' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); api.update(card, { displayMode: nextCardDisplayMode(card.displayMode) });
    }
  }
  return <div className="swipe-row">
    {swipeOffset !== undefined && <span className={`swipe-status-preview${swipeOffset < 0 ? ' swipe-status-preview--left' : ''}`} aria-hidden="true">{swipeOffset < 0 ? '←' : '→'} {swipeStatus(card.status, swipeOffset < 0 ? -1 : 1)}</span>}
    {/* Rows stay focusable while a write is in flight: `mutate` queues the edit
        instead of refusing it, so a disabled state would be a lie — and a memoized
        row cannot observe `busy` flipping. A resolved viewer role is a real
        restriction, passed as a stable prop. */}
    <article role="group" tabIndex={readOnly ? -1 : 0} aria-disabled={readOnly || undefined} aria-expanded={collapseActive ? !collapsed : undefined} aria-describedby="drag-help" aria-label={`Edit card ${number}: ${card.title || card.content || 'Image card'}`}
      onClick={click} onKeyDown={key} data-card-id={card.id}
      className={`editor-card display-mode-${mode}${card.title?.trim() ? ' has-title' : ' no-title'}${collapsed ? ' is-collapsed' : ''}${dragging ? ' drag-placeholder' : ''}`}
      style={{ ...cardColors(project.template, card.type), ...(swipeOffset !== undefined ? { transform: `translateX(${swipeOffset}px)` } : {}) } as CSSProperties}>
      <div className="card-topline">
        <button type="button" className="card-type-label card-field-control card-field-button" aria-label={`Change category of card ${number}`} aria-haspopup="dialog" disabled={dragging}
          onClick={event => { event.stopPropagation(); if (!api.suppressClick()) api.chooseField(card, 'type'); }}>{getCardTypeDefinition(project.template, card.type).label}</button>
        <button type="button" className={`card-status card-field-control card-field-button status-${card.status.replaceAll(' ', '-')}`} aria-label={`Change status of card ${number}`} aria-haspopup="dialog" disabled={readOnly || dragging}
          onClick={event => { event.stopPropagation(); if (!api.suppressClick()) api.chooseField(card, 'status'); }}>{card.status}</button>
        {collapsed && <span className="card-summary" role="button" tabIndex={readOnly ? -1 : 0} aria-expanded={false} aria-label={`Expand card ${number}`}
          onClick={event => { event.stopPropagation(); if (!api.suppressClick()) api.expand(card.id); }}>{summary}</span>}
        {hasActions
          ? <button type="button" className="card-more-button" disabled={readOnly || dragging} aria-label={`Actions for card ${number}`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); if (!api.suppressClick()) api.actions(card); }}><Icon name="more" /></button>
          : <span className="drag-grip" aria-hidden="true">⠿</span>}
      </div>
      {!collapsed && <>
        {card.title && <h2 data-edit-field="title" role="button" tabIndex={readOnly ? -1 : 0} aria-label={`Edit title of card ${number}`}><MarkdownInline text={card.title} /></h2>}
        {mode !== 'compact' && (card.imageId || card.image) && <div data-edit-field="content" role="button" tabIndex={readOnly ? -1 : 0} aria-label={`Edit photo of card ${number}`}><CardImage card={card} getImage={getImage} thumbnail={mode !== 'expanded'} alt={card.title || 'Card photo'} /></div>}
        <div className="card-text" data-edit-field="content" tabIndex={readOnly ? -1 : 0} aria-label={`Edit text of card ${number}`}>
          {card.content ? <MarkdownContent text={card.content} onTaskToggle={(line, checked) => {
            if (readOnly || dragging) return;
            const content = setTaskCheckedAtLine(card.content, line, checked);
            if (content !== card.content) api.update(card, { content });
          }} /> : !(card.imageId || card.image) && <p>Tap to add text</p>}
        </div>
        {sourceHref && <a className="source-link" href={sourceHref} target="_blank" rel="noreferrer">From {card.source?.provider || 'source'}</a>}
      </>}
    </article>
  </div>;
}, (previous, next) =>
  previous.index === next.index && previous.project === next.project && previous.collapsed === next.collapsed && previous.collapseActive === next.collapseActive && previous.readOnly === next.readOnly
  && previous.dragging === next.dragging && previous.swipeOffset === next.swipeOffset
  && previous.hasActions === next.hasActions && previous.getImage === next.getImage
  && previous.api === next.api && sameCard(previous.card, next.card));
