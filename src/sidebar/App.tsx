import { FormEvent, Fragment, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { repository } from "../storage/browser";
import { STORAGE_KEY } from "../storage/repository";
import { boardTemplates, isTypeSupported } from "../templates/boardTemplates";
import { BOARD_TEMPLATES, type AppState, type BoardItem, type BoardTemplate } from "../types";
import { Card } from "./components/Card";
import { CopyIcon } from "./components/CopyIcon";
import { cardDeletionNeedsConfirmation } from "./deletion";
import { reorderAtTarget, type DropPosition } from "./reorder";
import { serializeBoard } from "./serialize";
import { adjustUiScale, DEFAULT_UI_SCALE, normalizeUiScale, UI_SCALE_STEPS, UI_SCALE_STORAGE_KEY } from "./uiScale";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectTemplate, setNewProjectTemplate] = useState<BoardTemplate>("brainstorming");
  const [newCard, setNewCard] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [addingCard, setAddingCard] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [notice, setNotice] = useState("");
  const [uiScale, setUiScale] = useState(DEFAULT_UI_SCALE);
  const [insertingAfterId, setInsertingAfterId] = useState<string | null>(null);
  const [inlineCard, setInlineCard] = useState("");
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "project"; id: string } | { kind: "card"; id: string } | null
  >(null);
  const [focusCardId, setFocusCardId] = useState<string | null>(null);
  const newCardTextareaRef = useRef<HTMLTextAreaElement>(null);
  const newCardFormRef = useRef<HTMLFormElement>(null);
  const inlineCardTextareaRef = useRef<HTMLTextAreaElement>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => setState(await repository.load()), []);

  useEffect(() => {
    void reload();
    void browser.storage.local.get(UI_SCALE_STORAGE_KEY).then((result) => {
      setUiScale(normalizeUiScale(result[UI_SCALE_STORAGE_KEY]));
    });
    const listener = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[STORAGE_KEY]) void reload();
      if (area === "local" && changes[UI_SCALE_STORAGE_KEY]) {
        setUiScale(normalizeUiScale(changes[UI_SCALE_STORAGE_KEY].newValue));
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [reload]);

  useEffect(() => {
    if (addingCard) focusNewCardEditor();
  }, [addingCard]);

  function focusNewCardEditor() {
    window.requestAnimationFrame(() => {
      newCardTextareaRef.current?.focus({ preventScroll: true });
      newCardFormRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function changeUiScale(direction: -1 | 1) {
    const next = adjustUiScale(uiScale, direction);
    if (next === uiScale) return;
    setUiScale(next);
    void browser.storage.local.set({ [UI_SCALE_STORAGE_KEY]: next });
  }

  function beginInsertAfter(itemId: string) {
    setInsertingAfterId(itemId);
    setInlineCard("");
    window.requestAnimationFrame(() => {
      inlineCardTextareaRef.current?.focus({ preventScroll: true });
      inlineCardTextareaRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function cancelInlineCard() {
    setInlineCard("");
    setInsertingAfterId(null);
  }

  async function addInlineCard(event: FormEvent) {
    event.preventDefault();
    if (!currentProject || !insertingAfterId || !inlineCard.trim()) return;
    const target = items.find((item) => item.id === insertingAfterId);
    const created = await repository.addItem({
      projectId: currentProject.id,
      content: inlineCard,
      status: target?.status === "rejected" ? "rejected" : "candidate",
      afterItemId: insertingAfterId
    });
    setFocusCardId(created.id);
    cancelInlineCard();
    await reload();
  }

  function submitInlineCard(textarea: HTMLTextAreaElement) {
    if (inlineCard.trim()) textarea.form?.requestSubmit();
  }

  function handleInlineCardKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelInlineCard();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitInlineCard(event.currentTarget);
    }
  }

  const currentProject = state?.projects.find((project) => project.id === state.currentProjectId) ?? null;
  const items = useMemo(() => state?.boardItems
    .filter((item) => item.projectId === state.currentProjectId)
    .sort((a, b) => a.order - b.order) ?? [], [state]);
  const visibleItems = items.filter((item) => item.status !== "rejected");
  const rejectedItems = items.filter((item) => item.status === "rejected");

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!newProjectName.trim()) return;
    await repository.createProject(newProjectName, newProjectTemplate);
    setNewProjectName("");
    setAddingProject(false);
    setAddingCard(true);
    await reload();
    focusNewCardEditor();
  }

  function cancelProjectCreation() {
    setNewProjectName("");
    setNewProjectTemplate("brainstorming");
    setAddingProject(false);
  }

  function toggleProjectCreation() {
    setRenamingProject(false);
    if (addingProject) cancelProjectCreation();
    else setAddingProject(true);
  }

  function beginProjectRename() {
    if (!currentProject) return;
    setAddingProject(false);
    setProjectNameDraft(currentProject.name);
    setRenamingProject(true);
    window.requestAnimationFrame(() => {
      projectNameInputRef.current?.focus();
      projectNameInputRef.current?.select();
    });
  }

  function cancelProjectRename() {
    setProjectNameDraft("");
    setRenamingProject(false);
  }

  async function renameCurrentProject(event: FormEvent) {
    event.preventDefault();
    if (!currentProject || !projectNameDraft.trim()) return;
    await repository.renameProject(currentProject.id, projectNameDraft);
    cancelProjectRename();
    await reload();
  }

  function handleProjectFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelProjectCreation();
  }

  async function removeCurrentProject() {
    if (!currentProject) return;
    await repository.deleteProject(currentProject.id);
    setPendingDelete(null);
    await reload();
  }

  function requestProjectDeletion() {
    if (currentProject) setPendingDelete({ kind: "project", id: currentProject.id });
  }

  async function changeTemplate(template: BoardTemplate) {
    if (!currentProject || template === currentProject.template) return;
    const unsupportedCount = items.filter((item) => !isTypeSupported(template, item.type)).length;
    if (unsupportedCount > 0) {
      const target = boardTemplates[template].displayName;
      const accepted = confirm(
        `Change to ${target}? ${unsupportedCount} unsupported card type${unsupportedCount === 1 ? "" : "s"} will become Uncategorized. Card content will not change.`
      );
      if (!accepted) return;
    }
    await repository.changeProjectTemplate(currentProject.id, template);
    await reload();
  }

  async function addCard(event: FormEvent) {
    event.preventDefault();
    if (!currentProject || !newCard.trim()) return;
    await repository.addItem({ projectId: currentProject.id, content: newCard });
    setNewCard("");
    await reload();
    focusNewCardEditor();
  }

  function submitNewCard(textarea: HTMLTextAreaElement) {
    if (newCard.trim()) textarea.form?.requestSubmit();
  }

  function cancelNewCard() {
    setNewCard("");
    setAddingCard(false);
  }

  function handleNewCardKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNewCard();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitNewCard(event.currentTarget);
    }
  }

  async function updateItem(itemId: string, patch: Partial<Pick<BoardItem, "content" | "title" | "type" | "status">>) {
    await repository.updateItem(itemId, patch);
    await reload();
  }

  async function deleteItem(itemId: string) {
    await repository.deleteItem(itemId);
    setPendingDelete(null);
    await reload();
  }

  async function duplicateItem(itemId: string) {
    cancelInlineCard();
    await repository.duplicateItem(itemId);
    await reload();
  }

  async function requestItemDeletion(itemId: string) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (item && cardDeletionNeedsConfirmation(item.status)) {
      setPendingDelete({ kind: "card", id: itemId });
      return;
    }
    await deleteItem(itemId);
  }

  function beginDrag(itemId: string) {
    setDraggedId(itemId);
    setDropTarget(null);
  }

  function previewDrop(targetId: string, position: DropPosition) {
    if (!draggedId || draggedId === targetId) {
      setDropTarget(null);
      return;
    }
    const dragged = items.find((item) => item.id === draggedId);
    const target = items.find((item) => item.id === targetId);
    if (!dragged || !target || (dragged.status === "rejected") !== (target.status === "rejected")) return;
    setDropTarget((current) => current?.id === targetId && current.position === position
      ? current
      : { id: targetId, position });
  }

  function endDrag() {
    setDraggedId(null);
    setDropTarget(null);
  }

  async function dropOn(targetId: string, position: DropPosition) {
    if (!currentProject || !draggedId || draggedId === targetId) {
      endDrag();
      return;
    }
    const dragged = items.find((item) => item.id === draggedId);
    const target = items.find((item) => item.id === targetId);
    if (!dragged || !target || (dragged.status === "rejected") !== (target.status === "rejected")) {
      endDrag();
      return;
    }
    const ordered = reorderAtTarget(items.map((item) => item.id), draggedId, targetId, position);
    endDrag();
    await repository.reorderItems(currentProject.id, ordered);
    await reload();
  }

  async function copyBoard() {
    if (!currentProject) return;
    await navigator.clipboard.writeText(serializeBoard(currentProject, items));
    setNotice("Board copied as a prompt");
    window.setTimeout(() => setNotice(""), 2200);
  }

  function renderSortableCard(item: BoardItem) {
    if (!currentProject) return null;
    const showBefore = dropTarget?.id === item.id && dropTarget.position === "before";
    const showAfter = dropTarget?.id === item.id && dropTarget.position === "after";
    return (
      <Fragment key={item.id}>
        {showBefore && <DropPlaceholder />}
        <Card
          item={item}
          template={currentProject.template}
          onUpdate={updateItem}
          onDelete={requestItemDeletion}
          onDragStart={beginDrag}
          onDragOver={previewDrop}
          onDrop={dropOn}
          onDragEnd={endDrag}
          isDragging={draggedId === item.id}
          onInsertAfter={beginInsertAfter}
          onDuplicate={(itemId) => void duplicateItem(itemId)}
          focusRequested={focusCardId === item.id}
          onFocusHandled={() => setFocusCardId((current) => current === item.id ? null : current)}
        />
        {pendingDelete?.kind === "card" && pendingDelete.id === item.id && (
          <DeleteConfirmation
            message="Delete this confirmed card?"
            detail="This cannot be undone."
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => void deleteItem(item.id)}
          />
        )}
        {insertingAfterId === item.id && (
          <form className="inline-insert-card" onSubmit={addInlineCard}>
            <textarea
              ref={inlineCardTextareaRef}
              value={inlineCard}
              onChange={(event) => setInlineCard(event.target.value)}
              onKeyDown={handleInlineCardKeyDown}
              onDoubleClick={(event) => submitInlineCard(event.currentTarget)}
              placeholder="New point…"
              rows={3}
            />
            <small className="edit-hint">Enter or double-click to add · Shift+Enter for a new line · Esc to cancel</small>
          </form>
        )}
        {showAfter && <DropPlaceholder />}
      </Fragment>
    );
  }

  if (!state) return <main className="app" style={{ fontSize: `${uiScale}rem` }}><p className="muted">Loading board…</p></main>;

  return (
    <main className="app" style={{ fontSize: `${uiScale}rem` }}>
      <header>
        <div className="app-title-row">
          <p className="eyebrow">Pboard</p>
          <div className="font-scale-controls" aria-label="Board font size">
            <button
              className="scale-button"
              aria-label="Decrease board font size"
              title="Decrease board font size"
              disabled={uiScale === UI_SCALE_STEPS[0]}
              onClick={() => changeUiScale(-1)}
            >−</button>
            <output className="scale-value" aria-label="Current board size" aria-live="polite">
              {Math.round(uiScale * 100)}%
            </output>
            <button
              className="scale-button"
              aria-label="Increase board font size"
              title="Increase board font size"
              disabled={uiScale === UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1]}
              onClick={() => changeUiScale(1)}
            >+</button>
          </div>
        </div>
        <div className="project-row">
          {renamingProject && currentProject ? (
            <form className="project-rename-form" onSubmit={renameCurrentProject}>
              <input
                ref={projectNameInputRef}
                value={projectNameDraft}
                onChange={(event) => setProjectNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelProjectRename();
                  }
                }}
                aria-label="Project name"
              />
            </form>
          ) : state.projects.length ? (
            <select
              aria-label="Current project"
              value={currentProject?.id ?? ""}
              onChange={async (event) => {
                setPendingDelete(null);
                setRenamingProject(false);
                await repository.selectProject(event.target.value);
                await reload();
              }}
            >
              {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          ) : <h1>Your project state</h1>}
          <button
            className={`project-action-button${addingProject ? " active" : ""}`}
            aria-label="New project"
            title="New project"
            onClick={toggleProjectCreation}
          ><NewProjectIcon /></button>
          {currentProject && (
            <button
              className={`project-action-button${renamingProject ? " active" : ""}`}
              aria-label="Rename project"
              title="Rename project"
              onClick={renamingProject ? cancelProjectRename : beginProjectRename}
            ><EditIcon /></button>
          )}
          {currentProject && <button className="icon-button danger" aria-label="Delete project" title="Delete project" onClick={requestProjectDeletion}>×</button>}
        </div>
        {currentProject && pendingDelete?.kind === "project" && pendingDelete.id === currentProject.id && (
          <DeleteConfirmation
            message={`Delete “${currentProject.name}”?`}
            detail="All cards in this project will also be deleted."
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => void removeCurrentProject()}
          />
        )}
        {addingProject && (
          <form className="compact-form" onSubmit={createProject} onKeyDown={handleProjectFormKeyDown}>
            <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Project name" autoFocus />
            <fieldset className="template-picker">
              <legend>Board type</legend>
              {BOARD_TEMPLATES.map((template) => {
                const definition = boardTemplates[template];
                return (
                  <label key={template} className={newProjectTemplate === template ? "selected" : ""}>
                    <input
                      type="radio"
                      name="board-template"
                      value={template}
                      checked={newProjectTemplate === template}
                      onChange={() => setNewProjectTemplate(template)}
                    />
                    <span><strong>{definition.displayName}</strong><small>{definition.description}</small></span>
                  </label>
                );
              })}
            </fieldset>
            <button disabled={!newProjectName.trim()}>Create</button>
          </form>
        )}
      </header>

      {!currentProject ? (
        <section className="empty-state">
          <h2>No project yet</h2>
          <p>Create a project to start collecting useful points from your AI conversations.</p>
          <button onClick={() => setAddingProject(true)}>Create your first project</button>
        </section>
      ) : (
        <>
          <div className="template-control">
            <label htmlFor="board-template">Board type</label>
            <select
              id="board-template"
              value={currentProject.template}
              onChange={(event) => void changeTemplate(event.target.value as BoardTemplate)}
            >
              {BOARD_TEMPLATES.map((template) => (
                <option key={template} value={template}>{boardTemplates[template].displayName}</option>
              ))}
            </select>
          </div>
          <section className="board" aria-label="Board cards">
            {!visibleItems.length && !rejectedItems.length && (
              <div className="empty-state small">
                <h2>No pinned points yet.</h2>
                <p>Select something useful on a web page, right-click it, and choose <strong>Pin selection to Pboard</strong>.</p>
              </div>
            )}
            {visibleItems.map(renderSortableCard)}
            {rejectedItems.length > 0 && (
              <details className="rejected-section">
                <summary>Rejected ({rejectedItems.length})</summary>
                {rejectedItems.map(renderSortableCard)}
              </details>
            )}
          </section>

          <section className="board-controls">
            <button className="text-button add-card" onClick={() => setAddingCard((value) => !value)}>+ Add point</button>
            {addingCard && (
              <form ref={newCardFormRef} className="add-card-form" onSubmit={addCard}>
                <textarea
                  ref={newCardTextareaRef}
                  value={newCard}
                  onChange={(event) => setNewCard(event.target.value)}
                  onKeyDown={handleNewCardKeyDown}
                  onDoubleClick={(event) => submitNewCard(event.currentTarget)}
                  placeholder="What matters right now?"
                  rows={4}
                  autoFocus
                />
                <small className="edit-hint">Enter or double-click to add the next point · Shift+Enter for a new line · Esc to finish</small>
                <div><button className="text-button" type="button" onClick={cancelNewCard}>Cancel</button><button disabled={!newCard.trim()}>Add</button></div>
              </form>
            )}
            <button className="copy-button" onClick={copyBoard} disabled={!items.some((item) => item.status !== "rejected")}>
              <CopyIcon />
              <span>Copy board</span>
            </button>
            {notice && <p className="notice" role="status">{notice}</p>}
          </section>
        </>
      )}
    </main>
  );
}

function DropPlaceholder() {
  return <div className="drop-placeholder" aria-hidden="true"><span>Drop here</span></div>;
}

function NewProjectIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.75 6.25h6l1.5 2h9v10h-17zM12.5 13.25h5m-2.5-2.5v5" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 16.75-.5 3 3-.5L18.25 8.5l-2.5-2.5L5 16.75Zm8.75-8.75 2.5 2.5" />
    </svg>
  );
}

function DeleteConfirmation({
  message,
  detail,
  onCancel,
  onConfirm
}: {
  message: string;
  detail: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="delete-confirmation"
      role="alertdialog"
      aria-label={message}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div><strong>{message}</strong><small>{detail}</small></div>
      <div className="delete-confirmation-actions">
        <button className="text-button" onClick={onCancel} autoFocus>Cancel</button>
        <button className="delete-confirm-button" onClick={onConfirm}>Delete</button>
      </div>
    </div>
  );
}
