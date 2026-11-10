import { ProjectFingerprint, type FingerprintTransition } from '../../../../src/sidebar/components/ProjectFingerprint';
import { hasCopyableBoardItems } from '../../../../src/sidebar/serialize';
import type { CSSProperties, ReactNode } from 'react';
import type { ImageLoader } from '../components/CardImage';
import { getCardTypeDefinition } from '../../../../src/templates/boardTemplates';
import { BoardCard, type BoardCardApi } from '../components/BoardCard';
import { reorderAtTarget } from '../../../../src/sidebar/reorder';
import { cardContainer, TERMINAL_CONTAINERS, type TerminalStatus } from '../data/cardContainers';
import { memo, useRef, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SWIPE_STATUSES, swipeStatus } from '../interactions/cardSwipeStatus';
import { useCardDrag } from '../interactions/useCardDrag';
import { cardColors } from '../data/cardColors';
import { ScreenHeader } from '../components/ScreenHeader';
import { Icon } from '../components/Icon';
import type { BoardItem, Project } from '../storage/repository';
import type { CardEditField } from './CardFormScreen';
import type { CardPickerField } from '../components/CardFieldPicker';

export function BoardScreen({ project, cards, busy, onBack, onEditBoard, onDeleteBoard, onAddCard, onEditCard, onDeleteCard, onReorderCard, onUpdateCard, onTrashSection, onEmptyTrash, onChooseCardField, getImage, onCardActions, onInsertAfter, onCopyBoard, onDownloadBoard, onCopySection, uiScale = 1, fingerprintTransition = null, focusCardId, onFocusHandled, cloud, readOnly = false, collapseCards = false, onCollapseCards }: {
  cloud?: ReactNode; readOnly?: boolean; collapseCards?: boolean; onCollapseCards?: (collapse: boolean) => void;
  focusCardId?: string | null; onFocusHandled?: () => void;
  onCardActions?: (card: BoardItem) => void; onInsertAfter?: (card: BoardItem) => void; onCopyBoard?: () => void; onDownloadBoard?: () => void; onCopySection?: (status: 'done' | 'rejected') => void; uiScale?: number; fingerprintTransition?: FingerprintTransition | null;
  getImage?: ImageLoader;
  onChooseCardField: (card: BoardItem, field: CardPickerField) => void;
  onTrashSection: (status: Exclude<TerminalStatus, 'trash'>) => void; onEmptyTrash: () => void;
  project: Project; cards: BoardItem[]; busy: boolean; onBack: () => void; onEditBoard: () => void; onDeleteBoard: () => void;
  onAddCard: () => void; onEditCard: (card: BoardItem, field?: CardEditField) => void; onDeleteCard: (card: BoardItem) => void; onReorderCard: (card: BoardItem, ids: string[]) => void; onUpdateCard: (card: BoardItem, patch: Partial<Pick<BoardItem, 'type' | 'status' | 'content' | 'displayMode'>>) => void;
}) {
  // `actionBusy` keeps a save-in-flight from stacking destructive actions.
  // Card input is queued instead (see App.mutate), so only a drag or a resolved
  // viewer role may freeze a row.
  const actionBusy = busy;
  const inputLocked = readOnly;
  // Collapsed rows open individually; the choice is per visit, not persisted.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { if (!collapseCards) setExpanded(new Set()); }, [collapseCards]);
  const list = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const trash = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusCardId) return;
    const frame = requestAnimationFrame(() => {
      const card = [...list.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []].find(value => value.dataset.cardId === focusCardId);
      const section = card?.closest('details'); if (section) section.open = true;
      card?.focus({ preventScroll: true }); card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      onFocusHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusCardId, cards, onFocusHandled]);
  const lastTap = useRef<{ id: string; time: number; x: number; y: number } | null>(null);
  const { drag, swipe, announcement, suppressClick } = useCardDrag(list, scroller, cards.map(card => card.id), inputLocked, (id, ids) => {
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
  // Callbacks handed to every row: one stable object, so a memoized row only
  // re-renders when its own card, index or drag/swipe state changes.
  const api = useRef<BoardCardApi>(null as unknown as BoardCardApi);
  const cardsRef = useRef(cards); cardsRef.current = cards;
  const dragRef = useRef(drag); dragRef.current = drag;
  const swipeRef = useRef(swipe); swipeRef.current = swipe;
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const handlers = useRef({ onEditCard, onDeleteCard, onUpdateCard, onChooseCardField, onReorderCard, onInsertAfter, onCardActions, cards });
  handlers.current = { onEditCard, onDeleteCard, onUpdateCard, onChooseCardField, onReorderCard, onInsertAfter, onCardActions, cards };
  if (!api.current) {
    const byId = (id: string) => cardsRef.current.find(value => value.id === id);
    api.current = {
      dragging: () => !!dragRef.current,
      swipeOffset: id => swipeRef.current?.id === id ? swipeRef.current.offset : undefined,
      expand: id => {
        lastTap.current = null;
        setExpanded(old => old.has(id) ? old : new Set(old).add(id));
        requestAnimationFrame(() => {
          const target = [...list.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []].find(value => value.dataset.cardId === id);
          target?.focus({ preventScroll: true });
        });
      },
      suppressClick: () => suppressClick(),
      edit: (card, field) => handlers.current.onEditCard(card, field),
      editCard: card => handlers.current.onEditCard(card),
      remove: card => handlers.current.onDeleteCard(card),
      update: (card, patch) => handlers.current.onUpdateCard(card, patch),
      chooseField: (card, field) => handlers.current.onChooseCardField(card, field),
      actions: card => handlers.current.onCardActions?.(card),
      insertAfter: card => handlers.current.onInsertAfter?.(card),
      reorderByKey: (card, direction) => {
        const group = handlers.current.cards.filter(value => cardContainer(value.status) === cardContainer(card.status));
        const target = group[group.findIndex(value => value.id === card.id) + direction];
        if (target) handlers.current.onReorderCard(card, reorderAtTarget(handlers.current.cards.map(value => value.id), card.id, target.id, direction < 0 ? 'before' : 'after'));
      },
      focusAdjacent: (card, direction) => {
        const group = handlers.current.cards.filter(value => cardContainer(value.status) === cardContainer(card.status));
        const target = group[group.findIndex(value => value.id === card.id) + direction];
        const element = [...list.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []].find(value => value.dataset.cardId === target?.id);
        element?.focus(); element?.scrollIntoView?.({ block: 'nearest' });
      },
      takeTap: (id, time, x, y) => {
        const previous = lastTap.current;
        if (previous?.id === id && time - previous.time <= 300 && Math.hypot(x - previous.x, y - previous.y) <= 24) { lastTap.current = null; return true; }
        lastTap.current = { id, time, x, y };
        return false;
      },
      dropTap: () => { lastTap.current = null; },
    };
  }
  function renderCard(card: BoardItem) {
    return <BoardCard key={card.id} card={card} index={cards.findIndex(value => value.id === card.id)} project={project}
      collapsed={collapseCards && !expanded.has(card.id)} collapseActive={collapseCards} dragging={drag?.id === card.id} readOnly={readOnly}
      swipeOffset={swipe?.id === card.id ? swipe.offset : undefined} hasActions={!!onCardActions} getImage={getImage} api={api.current} />;
  }
  return <>
    <ScreenHeader title={project.name} onBack={onBack}>
      {onCollapseCards && <button className="icon-button" aria-label="First row only" aria-pressed={collapseCards} title={collapseCards ? 'Show full cards' : 'Show one row per card'} disabled={readOnly || !!drag} onClick={() => onCollapseCards(!collapseCards)}><Icon name={collapseCards ? 'rows' : 'cards'} /></button>}
      {drag && <div ref={trash} role="region" aria-label="Drop card here to trash" className={`trash-target${drag.overTrash ? ' trash-target--active' : ''}`}><Icon name="trash" /><span className="sr-only">Release here to trash</span></div>}
    </ScreenHeader>
    <main ref={scroller} className="screen-content board-content" style={{ '--board-scale': uiScale } as CSSProperties}>
      {cloud}
      {/* A save in flight is queued, not blocking: only a drag or a resolved
          viewer role restricts these controls. */}
      <div className="form-actions"><button disabled={readOnly || !!drag} onClick={onEditBoard}>Edit board</button><button className="danger" disabled={actionBusy || !!drag} onClick={onDeleteBoard}>Delete board</button></div>
      <StableFingerprint projectId={project.id} items={cards} transition={fingerprintTransition} />
      {!cards.length && <p className="empty-state">No cards yet. Tap + to add your first note.</p>}
      {cards.length > 0 && <p className="drag-hint" id="drag-help">Tap to edit · Swipe for status · Hold to drag<span className="sr-only"> Right swipe advances status; left swipe steps back. Keyboard: Enter to edit, Alt plus Up or Down to reorder, Delete to delete.</span></p>}
      <div ref={list} className="card-list" aria-describedby={cards.length ? 'drag-help' : undefined}>
        {ordered.filter(card => cardContainer(card.status) === 'active').map(renderCard)}
        {TERMINAL_CONTAINERS.map(section => {
          const sectionCards = ordered.filter(card => card.status === section.status);
          if (!sectionCards.length) return null;
          const label = section.status === 'trash' ? 'Empty trash' : `Trash ${section.status} cards`;
          return <details key={section.status} className={`terminal-section status-${section.status}`} data-section-status={section.status}>
            <summary><span>{section.label} ({sectionCards.length})</span>{section.status !== 'trash' && onCopySection && <button type="button" className="icon-button" disabled={actionBusy || !!drag} aria-label={`Copy ${section.status} cards`} onClick={event => { event.preventDefault(); event.stopPropagation(); onCopySection(section.status); }}><Icon name="copy" /></button>}<button type="button" className="icon-button" disabled={readOnly || !!drag} aria-label={label} title={label} onClick={event => {
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
    {/* Read-only viewers cannot create cards; a save in flight can, because it is
        queued rather than rejected. */}
    <button className="add-button" aria-label="Create card" disabled={readOnly} onClick={onAddCard}><Icon name="add" /></button>
  </>;
}

/** The fingerprint hashes and lays out one SVG cell per card. It only needs to
 * re-render when a card identity/status or the animation revision changes, so
 * an unrelated board render (busy flags, expansion, another card's text)
 * skips ~25 ms of layout work at 300 cards. */
const StableFingerprint = memo(function StableFingerprint({ projectId, items, transition }: { projectId: string; items: BoardItem[]; transition: FingerprintTransition | null }) {
  return <ProjectFingerprint projectId={projectId} items={items} transition={transition} />;
}, (previous, next) => {
  if (previous.projectId !== next.projectId) return false;
  if (previous.transition?.revision !== next.transition?.revision) return false;
  if (previous.items === next.items) return true;
  if (previous.items.length !== next.items.length) return false;
  for (let index = 0; index < previous.items.length; index++) {
    const left = previous.items[index], right = next.items[index];
    if (left.id !== right.id || left.status !== right.status) return false;
  }
  return true;
});
