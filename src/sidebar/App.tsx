import { FormEvent, Fragment, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { processImageFile } from "../images/processing";
import type { CaptureRegionResponse, ToolbarPinContext, ToolbarPinKind, ToolbarPinResponse } from "../messaging/messages";
import { repository, RXDB_MIGRATION_ERROR_KEY } from "../storage/browser";
import { boardTemplates, isTypeSupported } from "../templates/boardTemplates";
import {
  BOARD_TEMPLATES,
  PINNED_CARD_FOCUS_KEY,
  type BoardImage,
  type BoardItem,
  type BoardItemStatus,
  type BoardTemplate
} from "../types";
import { Card } from "./components/Card";
import { BoardConfetti } from "./components/BoardConfetti";
import { CopyIcon } from "./components/CopyIcon";
import { CaptureToolbar } from "./components/CaptureToolbar";
import { TERMINAL_SECTION_DEFINITIONS, TerminalSection } from "./components/TerminalSection";
import { DriveSyncControls } from "./components/DriveSyncControls";
import { ProjectFingerprint, type FingerprintTransition } from "./components/ProjectFingerprint";
import { ProjectPicker } from "./components/ProjectPicker";
import { adjacentItemId, reorderAtTarget, type DropPosition } from "./reorder";
import { hasCopyableBoardItems, serializeBoard, serializeProject } from "./serialize";
import { adjustUiScale, DEFAULT_UI_SCALE, normalizeUiScale, UI_SCALE_STEPS, UI_SCALE_STORAGE_KEY } from "./uiScale";
import { browser } from "../platform/browser";
import { requestPageCaptureAccess, requestPagePinAccess } from "../platform/capturePermission";
import { requestDriveReconciliation, requestProjectSync } from "../sync/client";
import { StatusCommitScheduler } from "./statusCommitScheduler";
import { focusTargetAfterStatusMove, shouldRestoreStatusFocus } from "./statusFocus";

const STATUS_MOVE_DELAY_MS = 800;

export function App() {
  const [projects, setProjects] = useState<import("../types").Project[]>([]);
  const [currentProject, setCurrentProject] = useState<import("../types").Project | null>(null);
  const [items, setItems] = useState<BoardItem[]>([]);
  const [boardReady, setBoardReady] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectTemplate, setNewProjectTemplate] = useState<BoardTemplate>("brainstorming");
  const [addingProject, setAddingProject] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragMergeMode, setDragMergeMode] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [uiScale, setUiScale] = useState(DEFAULT_UI_SCALE);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "project"; id: string } | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{ sourceId: string; targetId: string } | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const selectedCardIdRef = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; startEditing: boolean } | null>(null);
  const [imageDropActive, setImageDropActive] = useState(false);
  const [capturingRegion, setCapturingRegion] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinContext, setPinContext] = useState<ToolbarPinContext>({ page: false, selection: false, link: false, accessible: false });
  const [pendingStatuses, setPendingStatuses] = useState<Record<string, BoardItemStatus>>({});
  const [emptyTrashPending, setEmptyTrashPending] = useState(false);
  const [fingerprintTransition, setFingerprintTransition] = useState<FingerprintTransition | null>(null);
  const pendingStatusesRef = useRef<Record<string, BoardItemStatus>>({});
  const statusCommitScheduler = useRef(new StatusCommitScheduler(STATUS_MOVE_DELAY_MS));
  const itemsRef = useRef<BoardItem[]>([]);
  const fingerprintTimer = useRef<number | null>(null);
  const fingerprintRevision = useRef(0);
  const visibilitySyncTimer = useRef<number | null>(null);
  const currentProjectIdRef = useRef<string | null>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    let stopProjects: (() => void) | undefined;
    let stopCurrent: (() => void) | undefined;
    void repository.subscribeProjects((value) => { if (active) { setProjects(value); setBoardReady(true); } }).then((stop) => {
      if (active) stopProjects = stop; else stop();
    });
    void repository.subscribeCurrentProject((value) => { if (active) setCurrentProject(value); }).then((stop) => {
      if (active) stopCurrent = stop; else stop();
    });
    void requestDriveReconciliation();
    void browser.storage.local.get(UI_SCALE_STORAGE_KEY).then((result: Record<string, unknown>) => {
      setUiScale(normalizeUiScale(result[UI_SCALE_STORAGE_KEY]));
    });
    void browser.storage.local.get(PINNED_CARD_FOCUS_KEY).then((result: Record<string, unknown>) => {
      const cardId = result[PINNED_CARD_FOCUS_KEY] as string | null | undefined;
      if (cardId) void consumePinnedCardFocus(cardId);
    });
    void browser.storage.local.get(RXDB_MIGRATION_ERROR_KEY).then((result: Record<string, unknown>) => {
      if (result[RXDB_MIGRATION_ERROR_KEY]) setNotice(`RxDB migration failed; legacy data is in use: ${result[RXDB_MIGRATION_ERROR_KEY]}`);
    });
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && changes[UI_SCALE_STORAGE_KEY]) {
        setUiScale(normalizeUiScale(changes[UI_SCALE_STORAGE_KEY].newValue));
      }
      if (area === "local" && changes[PINNED_CARD_FOCUS_KEY]) {
        const cardId = changes[PINNED_CARD_FOCUS_KEY].newValue as string | null | undefined;
        if (cardId) void consumePinnedCardFocus(cardId);
      }
      if (area === "local" && changes[RXDB_MIGRATION_ERROR_KEY]?.newValue) {
        setNotice(`RxDB migration failed; legacy data is in use: ${changes[RXDB_MIGRATION_ERROR_KEY].newValue}`);
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => { active = false; stopProjects?.(); stopCurrent?.(); browser.storage.onChanged.removeListener(listener); };
  }, []);

  useEffect(() => {
    if (!currentProject?.id) { setItems([]); return; }
    let active = true;
    let stop: (() => void) | undefined;
    setItems([]);
    void repository.subscribeCards(currentProject.id, (value) => { if (active) setItems(value); }).then((unsubscribe) => {
      if (active) stop = unsubscribe; else unsubscribe();
    });
    return () => { active = false; stop?.(); };
  }, [currentProject?.id]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const context = await browser.runtime.sendMessage({ type: "GET_TOOLBAR_PIN_CONTEXT" }) as ToolbarPinContext;
        if (mounted) setPinContext(context);
      } catch {
        if (mounted) setPinContext({ page: false, selection: false, link: false, accessible: false });
      }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 1500);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  function consumePinnedCardFocus(cardId: string) {
    void browser.storage.local.set({ [PINNED_CARD_FOCUS_KEY]: null });
    setSelectedCardId(cardId);
    setFocusRequest({ id: cardId, startEditing: false });
  }

  function changeUiScale(direction: -1 | 1) {
    const next = adjustUiScale(uiScale, direction);
    if (next === uiScale) return;
    setUiScale(next);
    void browser.storage.local.set({ [UI_SCALE_STORAGE_KEY]: next });
  }

  itemsRef.current = items;
  const fingerprintItems = items;
  const visibleItems = items.filter((item) =>
    item.status !== "rejected" &&
    item.status !== "done" &&
    item.status !== "trash"
  );
  const rejectedItems = items.filter((item) => item.status === "rejected");
  const doneItems = items.filter((item) => item.status === "done");
  const trashItems = items.filter((item) => item.status === "trash");

  useEffect(() => {
    currentProjectIdRef.current = currentProject?.id ?? null;
  }, [currentProject?.id]);

  useEffect(() => {
    const cancel = () => {
      if (visibilitySyncTimer.current !== null) window.clearTimeout(visibilitySyncTimer.current);
      visibilitySyncTimer.current = null;
    };
    const schedule = () => {
      cancel();
      visibilitySyncTimer.current = window.setTimeout(() => {
        visibilitySyncTimer.current = null;
        const projectId = currentProjectIdRef.current;
        if (projectId) void requestProjectSync(projectId);
      }, 3000);
    };
    const onVisibility = () => document.visibilityState === "hidden" ? schedule() : cancel();
    const onPageHide = () => {
      const projectId = currentProjectIdRef.current;
      if (projectId) void requestProjectSync(projectId);
    };
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", cancel);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancel();
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", cancel);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (selectedCardId && !items.some((item) => item.id === selectedCardId)) setSelectedCardId(null);
  }, [items, selectedCardId]);

  useEffect(() => {
    selectedCardIdRef.current = selectedCardId;
  }, [selectedCardId]);

  useEffect(() => () => {
    statusCommitScheduler.current.cancelAll();
    if (fingerprintTimer.current !== null) window.clearTimeout(fingerprintTimer.current);
  }, []);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!newProjectName.trim()) return;
    clearAllPendingStatuses();
    const project = await repository.createProject(newProjectName, newProjectTemplate);
    setNewProjectName("");
    setAddingProject(false);
    void createCard(project.id);
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
  }

  function handleProjectFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelProjectCreation();
  }

  async function removeCurrentProject() {
    if (!currentProject) return;
    clearAllPendingStatuses();
    await repository.deleteProject(currentProject.id);
    setPendingDelete(null);
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
  }

  async function createCard(projectId: string, afterItemId?: string) {
    const created = await repository.addItem({
      projectId,
      content: "",
      ...(afterItemId ? { afterItemId } : {})
    });
    setSelectedCardId(created.id);
    setFocusRequest({ id: created.id, startEditing: true });
  }

  async function updateItem(
    itemId: string,
    patch: Partial<Pick<BoardItem, "content" | "title" | "type" | "status" | "displayMode">>,
    afterSave?: "focus" | "insert"
  ) {
    const { status, ...immediatePatch } = patch;
    if (Object.keys(immediatePatch).length > 0) {
      await repository.updateItem(itemId, immediatePatch);
    }
    if (status !== undefined) requestStatusChange(itemId, status);
    if (afterSave === "insert" && currentProject) void createCard(currentProject.id, itemId);
    if (afterSave === "focus") setFocusRequest({ id: itemId, startEditing: false });
  }

  async function moveCardToTrash(itemId: string) {
    requestStatusChange(itemId, "trash");
  }

  async function removeCardPermanently(itemId: string) {
    clearPendingStatus(itemId);
    setPendingDelete(null);
    if (selectedCardId === itemId) setSelectedCardId(null);
    await repository.deleteItem(itemId);
  }

  async function discardEmptyCard(itemId: string) {
    clearPendingStatus(itemId);
    if (selectedCardId === itemId) setSelectedCardId(null);
    await repository.deleteItem(itemId);
  }

  async function duplicateItem(itemId: string) {
    await repository.duplicateItem(itemId);
  }

  async function requestItemDeletion(itemId: string) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (item?.status === "trash") {
      void removeCardPermanently(itemId);
    } else {
      void moveCardToTrash(itemId);
    }
  }

  function clearPendingStatus(itemId: string) {
    statusCommitScheduler.current.cancel(itemId);
    const nextRef = { ...pendingStatusesRef.current };
    delete nextRef[itemId];
    pendingStatusesRef.current = nextRef;
    setPendingStatuses((current) => {
      if (current[itemId] === undefined) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
  }

  function clearAllPendingStatuses() {
    statusCommitScheduler.current.cancelAll();
    pendingStatusesRef.current = {};
    setPendingStatuses({});
  }

  function requestStatusChange(itemId: string, status: BoardItemStatus) {
    const committedStatus = itemsRef.current.find((item) => item.id === itemId)?.status;
    if (committedStatus === undefined || committedStatus === status) {
      clearPendingStatus(itemId);
      return;
    }
    pendingStatusesRef.current = { ...pendingStatusesRef.current, [itemId]: status };
    setPendingStatuses((current) => ({ ...current, [itemId]: status }));
    statusCommitScheduler.current.schedule(itemId, status, commitStatusChange);
  }

  async function commitStatusChange(itemId: string, status: BoardItemStatus) {
    if (pendingStatusesRef.current[itemId] !== status) return;
    const beforeStatus = itemsRef.current.find((item) => item.id === itemId)?.status;
    if (beforeStatus === undefined || beforeStatus === status) {
      clearPendingStatus(itemId);
      return;
    }
    const itemsBeforeCommit = itemsRef.current;
    await repository.updateItem(itemId, { status });
    const afterStatus = status;
    if (pendingStatusesRef.current[itemId] === status) clearPendingStatus(itemId);
    if (afterStatus !== undefined && beforeStatus !== afterStatus) {
      applyCommittedStatusChange(itemId, beforeStatus, afterStatus, itemsBeforeCommit);
    }
  }

  function applyCommittedStatusChange(
    itemId: string,
    beforeStatus: BoardItemStatus,
    afterStatus: BoardItemStatus,
    itemsBeforeCommit: BoardItem[]
  ) {
    playFingerprintTransition(itemId, beforeStatus, afterStatus);
    if (!shouldRestoreStatusFocus(itemId, selectedCardIdRef.current)) return;
    const focusTargetId = focusTargetAfterStatusMove(itemsBeforeCommit, itemId, beforeStatus, afterStatus);
    setSelectedCardId(focusTargetId);
    setFocusRequest(focusTargetId ? { id: focusTargetId, startEditing: false } : null);
  }

  function playFingerprintTransition(itemId: string, fromStatus: BoardItemStatus, status: BoardItemStatus) {
    fingerprintRevision.current += 1;
    setFingerprintTransition({ itemId, fromStatus, status, revision: fingerprintRevision.current });
    if (fingerprintTimer.current !== null) window.clearTimeout(fingerprintTimer.current);
    fingerprintTimer.current = window.setTimeout(() => {
      fingerprintTimer.current = null;
      setFingerprintTransition(null);
    }, status === "done" ? 1000 : 480);
  }

  async function emptyTrash() {
    if (!currentProject) return;
    const trashIds = items.filter((item) => item.status === "trash").map((item) => item.id);
    await repository.emptyTrash(currentProject.id);
    trashIds.forEach((id) => clearPendingStatus(id));
    if (selectedCardId && trashIds.includes(selectedCardId)) setSelectedCardId(null);
    setEmptyTrashPending(false);
  }

  function requestEmptyTrash() {
    if (trashItems.length === 0) return;
    setEmptyTrashPending(true);
  }

  function beginDrag(itemId: string, mergeMode: boolean) {
    setPendingMerge(null);
    setDraggedId(itemId);
    setDragMergeMode(mergeMode);
    setDropTarget(null);
    setMergeTargetId(null);
  }

  function changeDragMode(mergeMode: boolean) {
    setDragMergeMode(mergeMode);
    if (mergeMode) setDropTarget(null);
    else setMergeTargetId(null);
  }

  function previewDrop(targetId: string, position: DropPosition, mergeMode: boolean) {
    changeDragMode(mergeMode);
    if (!draggedId || draggedId === targetId) {
      setDropTarget(null);
      setMergeTargetId(null);
      return;
    }
    if (mergeMode) {
      setDropTarget(null);
      setMergeTargetId(targetId);
      return;
    }
    setMergeTargetId(null);
    const dragged = items.find((item) => item.id === draggedId);
    const target = items.find((item) => item.id === targetId);
    if (!dragged || !target || cardSection(draggedId) !== cardSection(targetId)) {
      setDropTarget(null);
      return;
    }
    setDropTarget((current) => current?.id === targetId && current.position === position
      ? current
      : { id: targetId, position });
  }

  function endDrag() {
    setDraggedId(null);
    setDragMergeMode(false);
    setDropTarget(null);
    setMergeTargetId(null);
  }

  async function dropOn(targetId: string, position: DropPosition, mergeMode: boolean) {
    if (!currentProject || !draggedId || draggedId === targetId) {
      endDrag();
      return;
    }
    if (mergeMode) {
      const sourceId = draggedId;
      endDrag();
      await requestMerge(sourceId, targetId);
      return;
    }
    const dragged = items.find((item) => item.id === draggedId);
    const target = items.find((item) => item.id === targetId);
    if (!dragged || !target || cardSection(draggedId) !== cardSection(targetId)) {
      endDrag();
      return;
    }
    const ordered = reorderAtTarget(items.map((item) => item.id), draggedId, targetId, position);
    endDrag();
    await repository.moveItem(currentProject.id, draggedId, ordered);
  }

  async function requestMerge(sourceId: string, targetId: string) {
    const source = items.find((item) => item.id === sourceId);
    const target = items.find((item) => item.id === targetId);
    if (!source || !target) return;
    if (source.image || source.imageId) {
      setNotice("Image cards cannot be merged because the image would be lost");
      window.setTimeout(() => setNotice(""), 3000);
      return;
    }
    if (source.status === "confirmed") {
      setPendingMerge({ sourceId, targetId });
      return;
    }
    await mergeItems(sourceId, targetId);
  }

  async function mergeItems(sourceId: string, targetId: string) {
    clearPendingStatus(sourceId);
    await repository.mergeItems(sourceId, targetId);
    setPendingMerge(null);
    setSelectedCardId(targetId);
    setFocusRequest({ id: targetId, startEditing: false });
  }

  function statusSection(status: BoardItemStatus) {
    if (status === "rejected") return rejectedItems;
    if (status === "done") return doneItems;
    if (status === "trash") return trashItems;
    return visibleItems;
  }

  function cardSection(itemId: string) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) return [];
    return statusSection(item.status);
  }

  function navigateCard(itemId: string, direction: -1 | 1) {
    const targetId = adjacentItemId(cardSection(itemId).map((item) => item.id), itemId, direction);
    if (!targetId) return;
    setSelectedCardId(targetId);
    setFocusRequest({ id: targetId, startEditing: false });
  }

  async function moveCardWithKeyboard(itemId: string, direction: -1 | 1) {
    if (!currentProject) return;
    const targetId = adjacentItemId(cardSection(itemId).map((item) => item.id), itemId, direction);
    if (!targetId) return;
    const position: DropPosition = direction === -1 ? "before" : "after";
    const ordered = reorderAtTarget(items.map((item) => item.id), itemId, targetId, position);
    await repository.moveItem(currentProject.id, itemId, ordered);
    setSelectedCardId(itemId);
    setFocusRequest({ id: itemId, startEditing: false });
  }

  async function copyBoard() {
    if (!currentProject) return;
    await navigator.clipboard.writeText(serializeBoard(currentProject, items));
    setNotice("Board copied as a prompt");
    window.setTimeout(() => setNotice(""), 2200);
  }

  async function copySection(sectionItems: BoardItem[], label: string) {
    if (!currentProject) return;
    await navigator.clipboard.writeText(serializeProject(currentProject, sectionItems));
    setNotice(`${label} copied as a prompt`);
    window.setTimeout(() => setNotice(""), 2200);
  }

  async function trashAllSection(sectionItems: BoardItem[]) {
    for (const item of sectionItems) await moveCardToTrash(item.id);
  }

  async function addImageCard(image: BoardImage, content: string, title?: string, pageUrl?: string) {
    if (!currentProject) return;
    const created = await repository.addItem({
      projectId: currentProject.id,
      content,
      ...(title ? { title } : {}),
      image,
      ...(pageUrl ? {
        source: { provider: "web", conversationUrl: pageUrl, sourceText: content }
      } : {})
    });
    setSelectedCardId(created.id);
    setFocusRequest({ id: created.id, startEditing: false });
  }

  async function captureRegion() {
    if (!currentProject || capturingRegion) return;
    setCapturingRegion(true);
    setNotice("Drag a rectangle on the page · Esc to cancel");
    try {
      if (!await requestPageCaptureAccess(browser)) {
        setNotice("Page access is required to capture part of the current page.");
        return;
      }
      const response = await browser.runtime.sendMessage({ type: "CAPTURE_PAGE_REGION" }) as CaptureRegionResponse;
      if (!response.ok) {
        setNotice(response.cancelled ? "" : response.reason);
        return;
      }
      await addImageCard(response.image, "Page capture", response.pageTitle, response.pageUrl);
      setNotice("Capture added");
      window.setTimeout(() => setNotice(""), 2200);
    } catch {
      setNotice("The page could not be captured");
    } finally {
      setCapturingRegion(false);
    }
  }

  async function pinFromToolbar(kind: ToolbarPinKind) {
    if (pinning) return;
    setPinning(true);
    try {
      if (kind !== "page" && !pinContext.accessible && !await requestPagePinAccess(browser)) {
        setNotice("Page access is required to pin selected text or a link.");
        return;
      }
      const result = await browser.runtime.sendMessage({ type: "PIN_FROM_TOOLBAR", kind }) as ToolbarPinResponse;
      setNotice(result.ok ? (kind === "page" ? "Page pinned" : kind === "selection" ? "Selection pinned" : "Link pinned") : result.reason ?? "The page could not be pinned");
      if (result.ok) window.setTimeout(() => setNotice(""), 2200);
      const context = await browser.runtime.sendMessage({ type: "GET_TOOLBAR_PIN_CONTEXT" }) as ToolbarPinContext;
      setPinContext(context);
    } catch {
      setNotice("The page could not be pinned");
    } finally {
      setPinning(false);
    }
  }

  async function dropImage(event: DragEvent<HTMLElement>) {
    const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    setImageDropActive(false);
    setNotice("Processing image…");
    try {
      const image = await processImageFile(file);
      await addImageCard(image, file.name || "Image");
      setNotice("Image added");
      window.setTimeout(() => setNotice(""), 2200);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The image could not be added");
    }
  }

  function renderSortableCard(item: BoardItem) {
    if (!currentProject) return null;
    const showBefore = dropTarget?.id === item.id && dropTarget.position === "before";
    const showAfter = dropTarget?.id === item.id && dropTarget.position === "after";
    return (
      <Fragment key={item.id}>
        {showBefore && <DropPlaceholder targetId={item.id} position="before" />}
        <Card
          item={item}
          getImage={repository.getImage}
          pendingStatus={pendingStatuses[item.id] ?? item.status}
          template={currentProject.template}
          onUpdate={updateItem}
          onStatusChange={requestStatusChange}
          onDelete={requestItemDeletion}
          onDiscardEmpty={discardEmptyCard}
          onDragStart={beginDrag}
          onDragOver={previewDrop}
          onDrop={dropOn}
          onDragEnd={endDrag}
          isDragging={draggedId === item.id}
          isMergeTarget={mergeTargetId === item.id}
          isMergeSource={draggedId === item.id && (dragMergeMode || mergeTargetId !== null)}
          onInsertAfter={(itemId) => void createCard(currentProject.id, itemId)}
          onDuplicate={(itemId) => void duplicateItem(itemId)}
          selected={selectedCardId === item.id}
          onSelect={setSelectedCardId}
          onNavigate={navigateCard}
          onKeyboardMove={(itemId, direction) => void moveCardWithKeyboard(itemId, direction)}
          focusRequested={focusRequest?.id === item.id}
          startEditingOnFocus={focusRequest?.id === item.id && focusRequest.startEditing}
          onFocusHandled={() => setFocusRequest((current) => current?.id === item.id ? null : current)}
        />
        {pendingMerge?.sourceId === item.id && (
          <DeleteConfirmation
            message="Merge this confirmed card?"
            detail="Its text will be appended to the target card and this card will be removed."
            confirmLabel="Merge"
            onCancel={() => setPendingMerge(null)}
            onConfirm={() => void mergeItems(pendingMerge.sourceId, pendingMerge.targetId)}
          />
        )}
        {showAfter && <DropPlaceholder targetId={item.id} position="after" />}
      </Fragment>
    );
  }

  if (!boardReady) return <main className="app" style={{ fontSize: `${uiScale}rem` }}><p className="muted">Loading board…</p></main>;

  return (
    <main className="app" style={{ fontSize: `${uiScale}rem` }}>
      <header>
        <div className="app-title-row">
          <p className="eyebrow">Pboard</p>
          <DriveSyncControls projectId={currentProject?.id ?? null} />
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
          ) : projects.length && currentProject ? (
            <ProjectPicker
              projects={projects}
              currentProjectId={currentProject.id}
              onSelect={async (projectId) => {
                const leavingProjectId = currentProject.id;
                clearAllPendingStatuses();
                setPendingDelete(null);
                setPendingMerge(null);
                setFingerprintTransition(null);
                setRenamingProject(false);
                void requestProjectSync(leavingProjectId);
                await repository.selectProject(projectId);
              }}
              onReorder={async (orderedIds) => {
                await repository.reorderProjects(orderedIds);
              }}
            />
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
        {currentProject && (
          <div className="board-summary-row">
            <ProjectFingerprint
              projectId={currentProject.id}
              items={fingerprintItems}
              transition={fingerprintTransition}
            />
            <select
              className="board-template-select"
              aria-label="Board type"
              title="Board type"
              value={currentProject.template}
              onChange={(event) => void changeTemplate(event.target.value as BoardTemplate)}
            >
              {BOARD_TEMPLATES.map((template) => (
                <option key={template} value={template}>{boardTemplates[template].displayName}</option>
              ))}
            </select>
          </div>
        )}
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
          <section
            className={`board${imageDropActive ? " image-drop-active" : ""}`}
            aria-label="Board cards"
            onDragOver={(event) => {
              if (!hasImageFile(event.dataTransfer)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setImageDropActive(true);
            }}
            onDragLeave={(event) => {
              if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setImageDropActive(false);
            }}
            onDrop={(event) => void dropImage(event)}
          >
            {fingerprintTransition?.status === "done" && fingerprintTransition.fromStatus !== "done" && (
              <BoardConfetti revision={fingerprintTransition.revision} />
            )}
            {imageDropActive && <div className="image-drop-overlay" aria-hidden="true">Drop image to add a card</div>}
            {!visibleItems.length && !rejectedItems.length && !doneItems.length && !trashItems.length && (
              <div className="empty-state small">
                <h2>No pinned points yet.</h2>
                <p>Select something useful on a web page, right-click it, and choose <strong>Pin selection to Pboard</strong>.</p>
              </div>
            )}
            {visibleItems.map(renderSortableCard)}
            <CaptureToolbar
              context={pinContext}
              busy={pinning || capturingRegion}
              onNewCard={() => void createCard(currentProject.id)}
              onPin={(kind) => void pinFromToolbar(kind)}
              onCaptureRegion={() => void captureRegion()}
            />
            {TERMINAL_SECTION_DEFINITIONS.map((definition) => {
              const sectionItems = statusSection(definition.status);
              if (sectionItems.length === 0) return null;
              const isTrash = definition.status === "trash";
              return (
                <TerminalSection
                  key={definition.status}
                  definition={definition}
                  count={sectionItems.length}
                  onCopy={isTrash ? undefined : () => void copySection(sectionItems, `${definition.label} cards`)}
                  onTrash={isTrash ? requestEmptyTrash : () => void trashAllSection(sectionItems)}
                >
                  {sectionItems.map(renderSortableCard)}
                </TerminalSection>
              );
            })}

            {emptyTrashPending && (
              <DeleteConfirmation
                message="Empty trash?"
                detail="All cards in the trash will be deleted permanently."
                onCancel={() => setEmptyTrashPending(false)}
                onConfirm={() => void emptyTrash()}
              />
            )}
            </section>

          <section className="board-controls">
            <button className="copy-button" onClick={copyBoard} disabled={!hasCopyableBoardItems(items)}>
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

function DropPlaceholder({
  targetId,
  position
}: {
  targetId: string;
  position: DropPosition;
}) {
  return (
    <div
      className="drop-placeholder"
      data-drop-target-id={targetId}
      data-drop-position={position}
      aria-hidden="true"
    >
      <span>Drop here</span>
    </div>
  );
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

function hasImageFile(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

function DeleteConfirmation({
  message,
  detail,
  onCancel,
  onConfirm,
  confirmLabel = "Delete"
}: {
  message: string;
  detail: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
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
        <button className="delete-confirm-button" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  );
}
