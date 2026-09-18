import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { getCardTypeDefinition, getTemplateDefinition, isTypeSupported } from "../../templates/boardTemplates";
import { BOARD_ITEM_STATUSES, type BoardItem, type BoardTemplate } from "../../types";
import { cardTextForClipboard } from "../cardText";
import { toSafeWebHref } from "../linkify";
import { MarkdownContent, MarkdownInline, setTaskCheckedAtLine } from "../markdown";
import type { DropPosition } from "../reorder";
import { CopyIcon } from "./CopyIcon";

type Props = {
  item: BoardItem;
  template: BoardTemplate;
  onUpdate: (itemId: string, patch: Partial<Pick<BoardItem, "content" | "title" | "type" | "status">>) => Promise<void>;
  onDelete: (itemId: string) => Promise<void>;
  onDragStart: (itemId: string) => void;
  onDragOver: (itemId: string, position: DropPosition) => void;
  onDrop: (itemId: string, position: DropPosition) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  onInsertAfter: (itemId: string) => void;
  onDuplicate: (itemId: string) => void;
  selected: boolean;
  onSelect: (itemId: string) => void;
  onNavigate: (itemId: string, direction: -1 | 1) => void;
  onKeyboardMove: (itemId: string, direction: -1 | 1) => void;
  focusRequested: boolean;
  armInsertOnFocus: boolean;
  onFocusHandled: () => void;
};

const statusLabels: Record<BoardItem["status"], string> = {
  candidate: "○ Candidate",
  confirmed: "● Confirmed",
  rejected: "× Rejected"
};

export function Card({ item, template, onUpdate, onDelete, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, onInsertAfter, onDuplicate, selected, onSelect, onNavigate, onKeyboardMove, focusRequested, armInsertOnFocus, onFocusHandled }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  const [content, setContent] = useState(item.content);
  const [copied, setCopied] = useState(false);
  const [enterCreatesDraft, setEnterCreatesDraft] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const templateDefinition = getTemplateDefinition(template);
  const typeDefinition = getCardTypeDefinition(template, item.type);
  const supportsCurrentType = isTypeSupported(template, item.type);
  const sourceHref = item.source?.conversationUrl ? toSafeWebHref(item.source.conversationUrl) : null;
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
    if (!focusRequested || editing) return;
    window.requestAnimationFrame(() => {
      setEnterCreatesDraft(armInsertOnFocus);
      cardRef.current?.focus({ preventScroll: true });
      cardRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      onFocusHandled();
    });
  }, [armInsertOnFocus, editing, focusRequested, onFocusHandled]);

  function startEditing() {
    setEnterCreatesDraft(false);
    setTitle(item.title ?? "");
    setContent(item.content);
    setEditing(true);
  }

  function cancelEditing() {
    setEnterCreatesDraft(false);
    setTitle(item.title ?? "");
    setContent(item.content);
    setEditing(false);
    window.requestAnimationFrame(() => {
      cardRef.current?.focus({ preventScroll: true });
      cardRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  async function save(armNextInsert = true) {
    if (!content.trim()) return;
    await onUpdate(item.id, { title: title.trim() || undefined, content: content.trim() });
    setEditing(false);
    setEnterCreatesDraft(armNextInsert);
    window.requestAnimationFrame(() => cardRef.current?.focus({ preventScroll: true }));
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save(!(event.ctrlKey || event.metaKey));
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
      tabIndex={0}
      className={`card status-${item.status}${selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      style={cardStyle}
      draggable={!editing}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id);
        onDragStart(item.id);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        onDragOver(item.id, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
      }}
      onDrop={(event) => {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onDrop(item.id, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
      }}
      onDragEnd={onDragEnd}
      onMouseDown={(event) => {
        const isInteractive = Boolean((event.target as HTMLElement).closest("a, button, input, textarea, select"));
        if (event.button === 0 && !isInteractive && !editing) {
          setEnterCreatesDraft(false);
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
        if (editing || event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (enterCreatesDraft) {
            setEnterCreatesDraft(false);
            onInsertAfter(item.id);
          } else {
            startEditing();
          }
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          setEnterCreatesDraft(false);
          const direction = event.key === "ArrowUp" ? -1 : 1;
          if (event.shiftKey && (event.ctrlKey || event.metaKey)) onKeyboardMove(item.id, direction);
          else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) onNavigate(item.id, direction);
        }
      }}
      onDoubleClick={() => { if (!editing) startEditing(); }}
    >
      <div className="card-topline" onDoubleClick={(event) => event.stopPropagation()}>
        <span className="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">≡</span>
        {templateDefinition.showTypeSelector && (
          <select
            className="card-type"
            aria-label="Card type"
            value={item.type}
            onChange={(event) => onUpdate(item.id, { type: event.target.value as BoardItem["type"] })}
          >
            {!supportsCurrentType && <option value={item.type}>LEGACY: {item.type.replaceAll("_", " ").toUpperCase()}</option>}
            {templateDefinition.cardTypes.map((type) => <option key={type.id} value={type.id}>{type.label.toUpperCase()}</option>)}
          </select>
        )}
        {!templateDefinition.showTypeSelector && <span className="card-type-label">NOTE</span>}
        <select
          className="card-status"
          aria-label="Card status"
          value={item.status}
          onChange={(event) => onUpdate(item.id, { status: event.target.value as BoardItem["status"] })}
        >
          {BOARD_ITEM_STATUSES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
        </select>
      </div>

      {editing ? (
        <div
          className="edit-form"
          onDoubleClick={(event) => { event.stopPropagation(); void save(); }}
        >
          <input value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={handleEditKeyDown} placeholder="Optional title" />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} onKeyDown={handleEditKeyDown} rows={5} autoFocus />
          <small className="edit-hint">Enter saves, then Enter adds below · Ctrl+Enter saves only · Shift+Enter for a new line · Esc to cancel</small>
        </div>
      ) : (
        <>
          {item.title && <h3><MarkdownInline text={item.title} /></h3>}
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

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.75 7.25h14.5M9 7.25V4.75h6v2.5m-8.5 0 .75 12h9.5l.75-12M10 10v6.5m4-6.5v6.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5.5 12.5 4 4 9-9" />
    </svg>
  );
}
