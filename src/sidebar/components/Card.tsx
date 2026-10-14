import { type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCardTypeDefinition, getTemplateDefinition } from "../../templates/boardTemplates";
import { nextCardDisplayMode, normalizeCardDisplayMode } from "../../cardDisplayModes";
import { statusClassName } from "../../statuses";
import { type BoardItem, type BoardItemStatus, type BoardTemplate } from "../../types";
import type { StoredBlob } from "../../storage/blobStore";
import { stepCardType, stepStatus } from "../cardCycle";
import { cardTextForClipboard } from "../cardText";
import { toSafeWebHref } from "../linkify";
import { MarkdownContent, MarkdownInline, setTaskCheckedAtLine } from "../markdown";
import { crossedPointerDragThreshold, pointerDropPosition } from "../pointerDrag";
import type { DropPosition } from "../reorder";
import { CheckIcon, CopyIcon, DragHandleIcon, TrashIcon } from "./icons";
import { CategoryPicker } from "./CategoryPicker";
import { CardDisplayModeControls } from "./CardDisplayModeControls";
import { StatusPicker } from "./StatusPicker";

type Props = {
  item: BoardItem;
  getImage?: (imageId: string) => Promise<StoredBlob | null>;
  subscribeImage?: (imageId: string, listener: () => void) => Promise<() => void>;
  pendingStatus: BoardItemStatus;
  template: BoardTemplate;
  onUpdate: (itemId: string, patch: Partial<Pick<BoardItem, "content" | "title" | "type" | "status" | "displayMode">>, afterSave?: "focus" | "insert") => Promise<void>;
  onStatusChange: (itemId: string, status: BoardItemStatus) => void;
  onDelete: (itemId: string) => Promise<void>;
  onDiscardEmpty: (itemId: string) => Promise<void>;
  onDragStart: (itemId: string, mergeMode: boolean) => void;
  onDragOver: (itemId: string, position: DropPosition, mergeMode: boolean) => void;
  onDrop: (itemId: string, position: DropPosition, mergeMode: boolean) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isMergeTarget: boolean;
  isMergeSource: boolean;
  onInsertAfter: (itemId: string) => void;
  onDuplicate: (itemId: string) => void;
  selected: boolean;
  onSelect: (itemId: string) => void;
  onNavigate: (itemId: string, direction: -1 | 1) => void;
  onKeyboardMove: (itemId: string, direction: -1 | 1) => void;
    focusRequested: boolean;
    startEditingOnFocus: boolean;
    onFocusHandled: () => void;
  };

type PointerDragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  started: boolean;
  mergeMode: boolean;
  targetId: string | null;
  position: DropPosition;
  overlay: HTMLElement | null;
      removeKeyboardListeners: (() => void) | null;
};

const FOCUS_MARGIN_PX = 24;

function ensureCardVisible(card: HTMLElement | null) {
  if (!card) return;
  const viewport = window.innerHeight;
  const margin = FOCUS_MARGIN_PX;
  const rect = card.getBoundingClientRect();
  if (rect.top >= margin && rect.bottom <= viewport - margin) return;

  let delta: number;
  if (rect.height > viewport - margin * 2) {
    const topDelta = margin - rect.top;
    const bottomDelta = rect.bottom - (viewport - margin);
    delta = Math.abs(topDelta) <= Math.abs(bottomDelta) ? topDelta : bottomDelta;
  } else if (rect.bottom <= margin) {
    delta = rect.bottom - (viewport - margin);
  } else if (rect.top >= viewport - margin) {
    delta = margin - rect.top;
  } else if (rect.top < margin) {
    delta = margin - rect.top;
  } else {
    delta = rect.bottom - (viewport - margin);
  }

  const maxScroll = Math.max(0, document.documentElement.scrollHeight - viewport);
  const target = Math.min(Math.max(0, window.scrollY + delta), maxScroll);
  if (target === window.scrollY) return;
  window.scrollTo({ top: target, behavior: "smooth" });
}

export function Card({ item, getImage, subscribeImage, pendingStatus, template, onUpdate, onStatusChange, onDelete, onDiscardEmpty, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isMergeTarget, isMergeSource, onInsertAfter, onDuplicate, selected, onSelect, onNavigate, onKeyboardMove, focusRequested, startEditingOnFocus, onFocusHandled }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  const [content, setContent] = useState(item.content);
  const [copied, setCopied] = useState(false);
  const [blobImageUrl, setBlobImageUrl] = useState<string | null>(null);
  const [imageMissing, setImageMissing] = useState(false);
    const cardRef = useRef<HTMLElement>(null);
  const pointerDragRef = useRef<PointerDragSession | null>(null);
  const suppressClickRef = useRef(false);
  const pointerCallbacksRef = useRef({ onDragStart, onDragOver, onDrop, onDragEnd });
  pointerCallbacksRef.current = { onDragStart, onDragOver, onDrop, onDragEnd };
  const templateDefinition = getTemplateDefinition(template);
  const typeDefinition = getCardTypeDefinition(template, item.type);
  const sourceHref = item.source?.conversationUrl ? toSafeWebHref(item.source.conversationUrl) : null;
  const displayMode = normalizeCardDisplayMode(item.displayMode);
  const hasTitle = Boolean(item.title?.trim());
  const cardStyle = {
    "--card-accent": typeDefinition.color,
    "--card-tint": typeDefinition.tint
  } as CSSProperties;

  useEffect(() => {
    if (!editing) {
      setTitle(item.title ?? "");
      setContent(item.content);
    }
  }, [editing, item.content, item.title]);

  useEffect(() => {
    if (!item.imageId) { setBlobImageUrl(null); setImageMissing(false); return; }
    if (!getImage) { setImageMissing(true); return; }
    let active = true;
    let objectUrl: string | null = null;
    let unsubscribe: (() => void) | undefined;
    let revision = 0;
    setBlobImageUrl(null);
    setImageMissing(false);
    const reload = () => {
      const request = ++revision;
      void getImage(item.imageId!).then((entry) => {
        if (!active || request !== revision) return;
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        if (!entry) { setBlobImageUrl(null); setImageMissing(true); return; }
        objectUrl = URL.createObjectURL(entry.blob);
        setImageMissing(false);
        setBlobImageUrl(objectUrl);
      }).catch(() => { if (active && request === revision) setImageMissing(true); });
    };
    reload();
    if (subscribeImage) void subscribeImage(item.imageId, reload).then((stop) => {
      if (!active) { stop(); return; }
      unsubscribe = stop;
      reload(); // Cover an arrival while the subscription was being opened.
    }).catch(() => { if (active) setImageMissing(true); });
    return () => { active = false; unsubscribe?.(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.imageId, getImage, subscribeImage]);

  useEffect(() => {
    if (!focusRequested || editing) return;
    window.requestAnimationFrame(() => {
      if (startEditingOnFocus) {
        startEditing();
      } else {
        cardRef.current?.focus({ preventScroll: true });
        ensureCardVisible(cardRef.current);
      }
      if (!startEditingOnFocus) onFocusHandled();
    });
  }, [editing, focusRequested, startEditingOnFocus]);

  useLayoutEffect(() => {
    if (focusRequested && editing) {
      ensureCardVisible(cardRef.current);
      onFocusHandled();
    }
  }, [focusRequested, editing]);

  useEffect(() => () => clearPointerDrag(), []);

  function clearPointerDrag() {
    const session = pointerDragRef.current;
    if (!session) return;
    pointerDragRef.current = null;
    session.removeKeyboardListeners?.();
    session.overlay?.remove();
    document.body.classList.remove("card-pointer-dragging");
    const card = cardRef.current;
    if (card?.hasPointerCapture(session.pointerId)) card.releasePointerCapture(session.pointerId);
  }

  function setPointerMergeMode(mergeMode: boolean) {
    const session = pointerDragRef.current;
    if (!session?.started || session.mergeMode === mergeMode) return;
    session.mergeMode = mergeMode;
    session.overlay?.classList.toggle("merge-preview", mergeMode);
    if (session.targetId) pointerCallbacksRef.current.onDragOver(session.targetId, session.position, mergeMode);
  }

  function startPointerDrag(session: PointerDragSession, clientX: number, clientY: number) {
    const card = cardRef.current;
    if (!card) return;
    session.started = true;
    session.overlay = createPointerDragOverlay(card, clientX, clientY, session.offsetX, session.offsetY, session.mergeMode);
    document.body.classList.add("card-pointer-dragging");
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Shift") setPointerMergeMode(true);
      if (event.key === "Escape") {
        event.preventDefault();
        clearPointerDrag();
        pointerCallbacksRef.current.onDragEnd();
      }
    };
    const keyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Shift") setPointerMergeMode(false);
    };
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp, true);
    session.removeKeyboardListeners = () => {
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp, true);
    };
    window.getSelection()?.removeAllRanges();
    pointerCallbacksRef.current.onDragStart(item.id, session.mergeMode);
  }

  function updatePointerTarget(session: PointerDragSession, clientX: number, clientY: number) {
    session.overlay?.style.setProperty("left", `${clientX - session.offsetX}px`);
    session.overlay?.style.setProperty("top", `${clientY - session.offsetY}px`);
    autoScrollForPointer(clientY);

    const pointedElement = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const placeholder = pointedElement?.closest<HTMLElement>("[data-drop-target-id]");
    const targetCard = pointedElement?.closest<HTMLElement>("[data-card-id]");
    const targetId = placeholder?.dataset.dropTargetId ?? targetCard?.dataset.cardId ?? null;
    if (!targetId || targetId === item.id) {
      session.targetId = null;
      pointerCallbacksRef.current.onDragOver(item.id, "after", session.mergeMode);
      return;
    }

    const position = placeholder?.dataset.dropPosition as DropPosition | undefined
      ?? pointerDropPosition(clientY, targetCard!.getBoundingClientRect().top, targetCard!.getBoundingClientRect().height);
    session.targetId = targetId;
    session.position = position;
    pointerCallbacksRef.current.onDragOver(targetId, position, session.mergeMode);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    const isInteractive = Boolean((event.target as HTMLElement).closest("a, button, input, textarea, select"));
    if (editing || event.button !== 0 || !event.isPrimary || isInteractive) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      started: false,
      mergeMode: event.shiftKey,
      targetId: null,
      position: "after",
      overlay: null,
      removeKeyboardListeners: null
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.started) {
      if (!crossedPointerDragThreshold(session.startX, session.startY, event.clientX, event.clientY)) return;
      startPointerDrag(session, event.clientX, event.clientY);
    }
    event.preventDefault();
    setPointerMergeMode(event.shiftKey);
    updatePointerTarget(session, event.clientX, event.clientY);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.started) {
      clearPointerDrag();
      return;
    }
    setPointerMergeMode(event.shiftKey);
    updatePointerTarget(session, event.clientX, event.clientY);
    const targetId = session.targetId;
    const position = session.position;
    const mergeMode = session.mergeMode;
    suppressClickRef.current = true;
    clearPointerDrag();
    if (targetId) pointerCallbacksRef.current.onDrop(targetId, position, mergeMode);
    else pointerCallbacksRef.current.onDragEnd();
  }

  function cancelPointerDrag(event: ReactPointerEvent<HTMLElement>) {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const started = session.started;
    clearPointerDrag();
    if (started) pointerCallbacksRef.current.onDragEnd();
  }

  function startEditing() {
    setTitle(item.title ?? "");
    setContent(item.content);
    setEditing(true);
  }

  function cancelEditing() {
    const hasLetter = (value: string | undefined) => value ? /\p{L}/u.test(value) : false;
    const isEmptyPersistedCard = !item.image && !item.imageId && !hasLetter(item.title) && !hasLetter(item.content);
    setTitle(item.title ?? "");
    setContent(item.content);
    setEditing(false);
    if (isEmptyPersistedCard) {
      void onDiscardEmpty(item.id);
      return;
    }
    window.requestAnimationFrame(() => {
      cardRef.current?.focus({ preventScroll: true });
      ensureCardVisible(cardRef.current);
    });
  }

  async function save(afterSave?: "focus" | "insert") {
    await onUpdate(item.id, { title: title.trim() || undefined, content: content.trim() }, afterSave);
    setEditing(false);
    if (afterSave === undefined) {
      window.requestAnimationFrame(() => {
        cardRef.current?.focus({ preventScroll: true });
        ensureCardVisible(cardRef.current);
      });
    }
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save(event.ctrlKey || event.metaKey ? "insert" : "focus");
    }
  }

  async function copyText() {
    await navigator.clipboard.writeText(cardTextForClipboard(item));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function toggleTask(lineIndex: number, checked: boolean) {
    const nextContent = setTaskCheckedAtLine(content, lineIndex, checked);
    if (nextContent === content) return;
    setContent(nextContent);
    void onUpdate(item.id, { content: nextContent });
  }

  return (
    <article
      ref={cardRef}
      data-card-id={item.id}
      tabIndex={0}
      className={`card status-${statusClassName(item.status)} display-mode-${displayMode} ${hasTitle ? "has-title" : "no-title"}${editing ? " editing" : ""}${selected ? " selected" : ""}${isDragging ? " dragging" : ""}${isMergeTarget ? " merge-target" : ""}${isMergeSource ? " merge-source" : ""}`}
      style={cardStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelPointerDrag}
      onLostPointerCapture={cancelPointerDrag}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        const isInteractive = Boolean((event.target as HTMLElement).closest("a, button, input, textarea, select"));
        if (event.button === 0 && !isInteractive && !editing) {
          onSelect(item.id);
          cardRef.current?.focus({ preventScroll: true });
        }
        if (event.button === 1 && !isInteractive) {
          event.preventDefault();
        }
      }}
      onFocus={() => onSelect(item.id)}
      onAuxClick={(event) => {
        if (event.button !== 1 || (event.target as HTMLElement).closest("a, button, input, textarea, select")) return;
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) onDuplicate(item.id);
        else onInsertAfter(item.id);
      }}
      onKeyDown={(event) => {
        if (editing && event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])"
          )];
          if (focusable.length > 0) {
            event.preventDefault();
            const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
            const direction = event.shiftKey ? -1 : 1;
            const nextIndex = currentIndex === -1
              ? (event.shiftKey ? focusable.length - 1 : 0)
              : (currentIndex + direction + focusable.length) % focusable.length;
            focusable[nextIndex].focus();
          }
          return;
        }
        if (editing || event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            onInsertAfter(item.id);
          } else {
            startEditing();
          }
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const direction = event.key === "ArrowUp" ? -1 : 1;
          if (event.shiftKey && (event.ctrlKey || event.metaKey)) onKeyboardMove(item.id, direction);
          else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) onNavigate(item.id, direction);
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          if (event.ctrlKey || event.metaKey) {
            const nextType = stepCardType(template, item.type, direction);
            if (nextType !== item.type) void onUpdate(item.id, { type: nextType });
            return;
          }
         onStatusChange(item.id, stepStatus(pendingStatus, direction));
         }
         if (event.key.toLowerCase() === "v" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          void onUpdate(item.id, { displayMode: nextCardDisplayMode(displayMode) });
          return;
         }
         if (event.key === "Delete") {
          event.preventDefault();
          void onDelete(item.id);
          return;
         }
       }}
       onDoubleClick={() => { if (!editing) startEditing(); }}
    >
      <div className="card-topline" onDoubleClick={(event) => event.stopPropagation()}>
        <span className="drag-handle" title="Drag to reorder · Press Shift to merge" aria-label="Drag to reorder; press Shift to merge"><DragHandleIcon /></span>
        {templateDefinition.showTypeSelector && (
          <CategoryPicker
            cardTypes={templateDefinition.cardTypes}
            value={item.type}
            onChange={(type) => void onUpdate(item.id, { type })}
          />
        )}
        {!templateDefinition.showTypeSelector && <span className="card-type-label">NOTE</span>}
        <StatusPicker
          value={pendingStatus}
          onChange={(status) => onStatusChange(item.id, status)}
        />
        <CardDisplayModeControls
          value={displayMode}
          onChange={(mode) => void onUpdate(item.id, { displayMode: mode })}
        />
      </div>

      {editing ? (
        <div
          className="edit-form"
          onDoubleClick={(event) => { event.stopPropagation(); void save(); }}
        >
          <input value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={handleEditKeyDown} placeholder="Optional title" />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} onKeyDown={handleEditKeyDown} rows={5} autoFocus />
          <small className="edit-hint">Enter saves · Ctrl+Enter saves and adds below · Shift+Enter for a new line · Esc to cancel</small>
        </div>
      ) : (
        <>
          {hasTitle && <h3><MarkdownInline text={item.title!} /></h3>}
          {(item.image?.dataUrl || blobImageUrl) && (
            <img
              className="card-image"
              src={blobImageUrl ?? item.image?.dataUrl}
              width={item.imageWidth ?? item.image?.width}
              height={item.imageHeight ?? item.image?.height}
              alt={item.title || item.content || "Board image"}
              draggable={false}
            />
          )}
          {item.imageId && !blobImageUrl && <div className="muted" role="status">{imageMissing ? "Image unavailable" : "Loading image…"}</div>}
          <MarkdownContent text={content} onTaskToggle={toggleTask} />
          <div className="card-actions" onDoubleClick={(event) => event.stopPropagation()}>
            {sourceHref && (
              <a
                className="source-badge"
                href={sourceHref}
                target="_blank"
                rel="noreferrer"
                title={`Open source: ${sourceHref}`}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                From {item.source?.provider ?? "chat"}
              </a>
            )}
            <button
              className="card-icon-button"
              aria-label="Copy card text"
              title={copied ? "Copied" : "Copy card text"}
              onClick={() => void copyText()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            <button
              className="card-icon-button danger"
              aria-label="Delete card"
              title="Delete card"
              onClick={() => void onDelete(item.id)}
            >
              <TrashIcon />
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function createPointerDragOverlay(card: HTMLElement, clientX: number, clientY: number, offsetX: number, offsetY: number, mergeMode: boolean) {
  const overlay = card.cloneNode(true) as HTMLElement;
  overlay.removeAttribute("data-card-id");
  overlay.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  overlay.classList.remove("selected", "dragging", "merge-source", "merge-target");
  overlay.classList.add("pointer-drag-overlay");
  overlay.classList.toggle("merge-preview", mergeMode);
  overlay.style.width = `${card.getBoundingClientRect().width}px`;
  overlay.style.left = `${clientX - offsetX}px`;
  overlay.style.top = `${clientY - offsetY}px`;
  document.body.append(overlay);
  return overlay;
}

function autoScrollForPointer(clientY: number) {
  const edge = 46;
  const speed = 10;
  if (clientY < edge) window.scrollBy(0, -speed);
  else if (clientY > window.innerHeight - edge) window.scrollBy(0, speed);
}
