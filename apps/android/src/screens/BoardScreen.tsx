import { normalizeCardDisplayMode, nextCardDisplayMode } from '../../../../src/cardDisplayModes';
import { MarkdownContent, MarkdownInline, setTaskCheckedAtLine } from '../../../../src/sidebar/markdown';
import { stepCardType, stepStatus } from '../../../../src/sidebar/cardCycle';
import { toSafeWebHref } from '../../../../src/sidebar/linkify';
import { ProjectFingerprint, type FingerprintTransition } from '../../../../src/sidebar/components/ProjectFingerprint';
import { hasCopyableBoardItems } from '../../../../src/sidebar/serialize';
import type { CSSProperties, ReactNode } from 'react';
import { CardImage, type ImageLoader } from '../components/CardImage';
import { reorderAtTarget } from '../../../../src/sidebar/reorder';
import { cardContainer, TERMINAL_CONTAINERS, type TerminalStatus } from '../data/cardContainers';
import { useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SWIPE_STATUSES, swipeStatus } from '../interactions/cardSwipeStatus';
import { useCardDrag } from '../interactions/useCardDrag';
import { cardColors } from '../data/cardColors';
import { ScreenHeader } from '../components/ScreenHeader';
import { Icon } from '../components/Icon';
import type { BoardItem, Project } from '../storage/repository';
import type { CardEditField } from './CardFormScreen';
import type { CardPickerField } from '../components/CardFieldPicker';
import { getCardTypeDefinition } from '../../../../src/templates/boardTemplates';

export function BoardScreen({ project, cards, busy, onBack, onEditBoard, onDeleteBoard, onAddCard, onEditCard, onDeleteCard, onReorderCard, onUpdateCard, onTrashSection, onEmptyTrash, onChooseCardField, getImage, onCardActions, onInsertAfter, onCopyBoard, onDownloadBoard, onCopySection, uiScale = 1, fingerprintTransition = null, focusCardId, onFocusHandled, cloud, readOnly = false }: {
  cloud?: ReactNode; readOnly?: boolean;
  focusCardId?: string | null; onFocusHandled?: () => void;
  onCardActions?: (card: BoardItem) => void; onInsertAfter?: (card: BoardItem) => void; onCopyBoard?: () => void; onDownloadBoard?: () => void; onCopySection?: (status: 'done' | 'rejected') => void; uiScale?: number; fingerprintTransition?: FingerprintTransition | null;
  getImage?: ImageLoader;
  onChooseCardField: (card: BoardItem, field: CardPickerField) => void;
  onTrashSection: (status: Exclude<TerminalStatus, 'trash'>) => void; onEmptyTrash: () => void;
  project: Project; cards: BoardItem[]; busy: boolean; onBack: () => void; onEditBoard: () => void; onDeleteBoard: () => void;
  onAddCard: () => void; onEditCard: (card: BoardItem, field?: CardEditField) => void; onDeleteCard: (card: BoardItem) => void; onReorderCard: (card: BoardItem, ids: string[]) => void; onUpdateCard: (card: BoardItem, patch: Partial<Pick<BoardItem, 'type' | 'status' | 'content' | 'displayMode'>>) => void;
}) {
  const actionBusy = busy;
  busy = busy || readOnly;
  const list = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const trash = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusCardId || busy) return;
    const frame = requestAnimationFrame(() => {
      const card = [...list.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []].find(value => value.dataset.cardId === focusCardId);
      const section = card?.closest('details'); if (section) section.open = true;
      card?.focus({ preventScroll: true }); card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      onFocusHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusCardId, busy, cards, onFocusHandled]);
  const lastTap = useRef<{ id: string; time: number; x: number; y: number } | null>(null);
  const { drag, swipe, announcement, suppressClick } = useCardDrag(list, scroller, cards.map(card => card.id), busy, (id, ids) => {
    const card = cards.find(value => value.id === id);
    if (card) onReorderCard(card, ids);
  }, trash, id => {
    const card = cards.find(value => value.id === id);
    if (card) onDeleteCard(card);
  }, {
    container: id => cardContainer(cards.find(card => card.id === id)!.status),
    canSwipe: id => { const card = cards.find(value => value.id === id); return !!card && SWIPE_STATUSES.includes(card.status); },
    onSwipe: (id, direction) => {
      const card = cards.find(value => value.id === id);
      if (!card) return 'Status unchanged.';
      const status = swipeStatus(card.status, direction);
      if (status === card.status) return 'Status unchanged.';
      onUpdateCard(card, { status });
      return `Changing status to ${status}.`;
    },
  });
  const byId = new Map(cards.map(card => [card.id, card]));
  const ordered = drag ? drag.order.map(id => byId.get(id)!).filter(Boolean) : cards;
  const lifted = drag ? byId.get(drag.id) : undefined;
  const cardTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const previous = cardTops.current;
    if (!drag) { if (previous.size) cardTops.current = new Map(); return; }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, number>();
    // offsetTop ignores in-flight FLIP transforms, unlike getBoundingClientRect.
    for (const card of [...list.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []]) {
      const row = (card.closest('.swipe-row') ?? card) as HTMLElement;
      const top = row.offsetTop;
      const before = previous.get(card.dataset.cardId!);
      next.set(card.dataset.cardId!, top);
      if (reduceMotion || before === undefined || Math.abs(before - top) < 1) continue;
      row.style.transition = 'none';
      row.style.transform = `translateY(${before - top}px)`;
      requestAnimationFrame(() => {
        row.style.transition = 'transform 180ms ease-out';
        row.style.transform = '';
      });
    }
    cardTops.current = next;
  }, [drag]);
  function renderCard(card: BoardItem) {
    const index = cards.findIndex(value => value.id === card.id);
    const mode = normalizeCardDisplayMode(card.displayMode);
    const sourceHref = card.source?.conversationUrl ? toSafeWebHref(card.source.conversationUrl) : null;
    return <div className="swipe-row" key={card.id}>
        {swipe?.id === card.id && <span className={`swipe-status-preview${swipe.offset < 0 ? ' swipe-status-preview--left' : ''}`} aria-hidden="true">{swipe.offset < 0 ? '←' : '→'} {swipeStatus(card.status, swipe.offset < 0 ? -1 : 1)}</span>}
        <article role="group" tabIndex={busy ? -1 : 0} aria-disabled={busy} aria-label={`Edit card ${index + 1}: ${card.title || card.content || 'Image card'}`} aria-describedby="drag-help" onClick={event => {
        if (busy || drag || swipe || suppressClick()) return;
        if (event.target instanceof Element) {
          if (event.target.closest('button, select, input, a')) return;
          const field = event.target.closest<HTMLElement>('[data-edit-field]')?.dataset.editField as CardEditField | undefined;
          if (field) { lastTap.current = null; onEditCard(card, field); return; }
        }
        if (event.detail === 0) { lastTap.current = null; onEditCard(card); return; }
        const previous = lastTap.current;
        const time = Date.now();
        if (previous?.id === card.id && time - previous.time <= 300 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 24) { lastTap.current = null; onEditCard(card); }
        else lastTap.current = { id: card.id, time, x: event.clientX, y: event.clientY };
      }} onKeyDown={event => {
        if (busy || drag || swipe || (event.target instanceof Element && event.target.closest('button, select, input, a'))) return;
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onInsertAfter?.(card); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const field = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-edit-field]')?.dataset.editField as CardEditField | undefined : undefined; onEditCard(card, field); }
        else if (event.key === 'Delete') { event.preventDefault(); onDeleteCard(card); }
        else if ((event.altKey || (event.shiftKey && (event.ctrlKey || event.metaKey))) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          const group = cards.filter(value => cardContainer(value.status) === cardContainer(card.status));
          const target = group[group.findIndex(value => value.id === card.id) + (event.key === 'ArrowUp' ? -1 : 1)];
          if (target) onReorderCard(card, reorderAtTarget(cards.map(value => value.id), card.id, target.id, event.key === 'ArrowUp' ? 'before' : 'after'));
        } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          const group = cards.filter(value => cardContainer(value.status) === cardContainer(card.status));
          const target = group[group.findIndex(value => value.id === card.id) + (event.key === 'ArrowUp' ? -1 : 1)];
          const element = [...list.current!.querySelectorAll<HTMLElement>('[data-card-id]')].find(value => value.dataset.cardId === target?.id);
          element?.focus(); element?.scrollIntoView?.({ block: 'nearest' });
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); const direction = event.key === 'ArrowRight' ? 1 : -1;
          onUpdateCard(card, event.ctrlKey || event.metaKey ? { type: stepCardType(project.template, card.type, direction) } : { status: stepStatus(card.status, direction) });
        } else if (event.key.toLowerCase() === 'v' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); onUpdateCard(card, { displayMode: nextCardDisplayMode(card.displayMode) });
        }
      }} data-card-id={card.id} className={`editor-card display-mode-${mode}${card.title?.trim() ? ' has-title' : ' no-title'}${drag?.id === card.id ? ' drag-placeholder' : ''}`} style={{ ...cardColors(project.template, card.type), ...(swipe?.id === card.id ? { transform: `translateX(${swipe.offset}px)` } : {}) }}>
        <div className="card-topline">
          <button type="button" className="card-type-label card-field-control card-field-button" aria-label={`Change category of card ${index + 1}`} aria-haspopup="dialog" disabled={busy || !!drag} onClick={event => { event.stopPropagation(); if (!suppressClick()) onChooseCardField(card, 'type'); }}>{getCardTypeDefinition(project.template, card.type).label}</button>
          <button type="button" className={`card-status card-field-control card-field-button status-${card.status.replaceAll(' ', '-')}`} aria-label={`Change status of card ${index + 1}`} aria-haspopup="dialog" disabled={busy || !!drag} onClick={event => { event.stopPropagation(); if (!suppressClick()) onChooseCardField(card, 'status'); }}>{card.status}</button>
          {onCardActions ? <button type="button" className="card-more-button" disabled={busy || !!drag} aria-label={`Actions for card ${index + 1}`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); if (!suppressClick()) onCardActions(card); }}><Icon name="more" /></button> : <span className="drag-grip" aria-hidden="true">⠿</span>}
        </div>
        {card.title && <h2 data-edit-field="title" role="button" tabIndex={busy ? -1 : 0} aria-label={`Edit title of card ${index + 1}`}><MarkdownInline text={card.title} /></h2>}
        {mode !== 'compact' && (card.imageId || card.image) && <div data-edit-field="content" role="button" tabIndex={busy ? -1 : 0} aria-label={`Edit photo of card ${index + 1}`}><CardImage card={card} getImage={getImage} thumbnail={mode !== 'expanded'} alt={card.title || 'Card photo'} /></div>}
        <div className="card-text" data-edit-field="content" tabIndex={busy ? -1 : 0} aria-label={`Edit text of card ${index + 1}`}>
          {card.content ? <MarkdownContent text={card.content} onTaskToggle={(line, checked) => {
            if (busy || drag || swipe) return;
            const content = setTaskCheckedAtLine(card.content, line, checked);
            if (content !== card.content) onUpdateCard(card, { content });
          }} /> : !(card.imageId || card.image) && <p>Tap to add text</p>}
        </div>
        {sourceHref && <a className="source-link" href={sourceHref} target="_blank" rel="noreferrer">From {card.source?.provider || 'source'}</a>}

      </article></div>;
  }
  return <>
    <ScreenHeader title={project.name} onBack={onBack}>
      {drag && <div ref={trash} role="region" aria-label="Drop card here to trash" className={`trash-target${drag.overTrash ? ' trash-target--active' : ''}`}><Icon name="trash" /><span className="sr-only">Release here to trash</span></div>}
    </ScreenHeader>
    <main ref={scroller} className="screen-content board-content" style={{ '--board-scale': uiScale } as CSSProperties}>
      {cloud}
      <div className="form-actions"><button disabled={busy} onClick={onEditBoard}>Edit board</button><button className="danger" disabled={actionBusy} onClick={onDeleteBoard}>Delete board</button></div>
      <ProjectFingerprint projectId={project.id} items={cards} transition={fingerprintTransition} />
      {!cards.length && <p className="empty-state">No cards yet. Tap + to add your first note.</p>}
      {cards.length > 0 && <p className="drag-hint" id="drag-help">Tap to edit · Swipe for status · Hold to drag<span className="sr-only"> Right swipe advances status; left swipe steps back. Keyboard: Enter to edit, Alt plus Up or Down to reorder, Delete to delete.</span></p>}
      <div ref={list} className="card-list" aria-describedby={cards.length ? 'drag-help' : undefined}>
        {ordered.filter(card => cardContainer(card.status) === 'active').map(renderCard)}
        {TERMINAL_CONTAINERS.map(section => {
          const sectionCards = ordered.filter(card => card.status === section.status);
          if (!sectionCards.length) return null;
          const label = section.status === 'trash' ? 'Empty trash' : `Trash ${section.status} cards`;
          return <details key={section.status} className={`terminal-section status-${section.status}`} data-section-status={section.status}>
            <summary><span>{section.label} ({sectionCards.length})</span>{section.status !== 'trash' && onCopySection && <button type="button" className="icon-button" disabled={actionBusy || !!drag} aria-label={`Copy ${section.status} cards`} onClick={event => { event.preventDefault(); event.stopPropagation(); onCopySection(section.status); }}><Icon name="copy" /></button>}<button type="button" className="icon-button" disabled={busy || !!drag} aria-label={label} title={label} onClick={event => {
              event.preventDefault(); event.stopPropagation();
              if (section.status === 'trash') onEmptyTrash(); else onTrashSection(section.status);
            }}><Icon name="trash" /></button></summary>
            <div className="terminal-cards">{sectionCards.map(renderCard)}</div>
          </details>;
        })}
      </div>
      {(onCopyBoard || onDownloadBoard) && <div className="form-actions board-export-actions">
        {onCopyBoard && <button disabled={actionBusy || !hasCopyableBoardItems(cards)} onClick={onCopyBoard}><Icon name="copy" />Copy board</button>}
        {onDownloadBoard && <button disabled={actionBusy || !hasCopyableBoardItems(cards)} onClick={onDownloadBoard}><Icon name="download" />Download board</button>}
      </div>}
    </main>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    {drag && lifted && createPortal(<article aria-hidden="true" className="editor-card drag-ghost" style={{ ...cardColors(project.template, lifted.type), left: drag.left, top: drag.top, width: drag.width, height: drag.height }}>
      <div className="card-topline"><span className="card-type-label">{getCardTypeDefinition(project.template, lifted.type).label}</span><span className={`card-status status-${lifted.status.replaceAll(" ", "-")}`}>{lifted.status}</span><span className="drag-grip" aria-hidden="true">⠿</span></div>
      {lifted.title && <h2>{lifted.title}</h2>}<p className="card-text">{lifted.content}</p>
    </article>, document.body)}
    <button className="add-button" disabled={busy} aria-label="Create card" onClick={onAddCard}><Icon name="add" /></button>
  </>;
}
