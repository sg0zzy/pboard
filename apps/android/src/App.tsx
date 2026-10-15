import { useCloudSync } from './sync/useCloudSync';
import { CloudSettings } from './components/CloudSettings';
import { CloudBoard } from './components/CloudBoard';
import { focusTargetAfterStatusMove } from '../../../src/sidebar/statusFocus';
import { CardActions, type CardAction } from './components/CardActions';
import { cardTextForClipboard } from '../../../src/sidebar/cardText';
import { serializeBoard, serializeProject } from '../../../src/sidebar/serialize';
import { buildBoardArchive } from '../../../src/sidebar/download';
import { copyText, saveBoardArchive } from './platform/boardExport';
import type { FingerprintTransition } from '../../../src/sidebar/components/ProjectFingerprint';
import { updateCardPhoto } from './storage/cardPhotos';
import { useEffect, useRef, useState } from 'react';
import { App as NativeApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { BoardConfetti } from '../../../src/sidebar/components/BoardConfetti';
import { CardFieldPicker, type CardPickerField } from './components/CardFieldPicker';
import { ConfirmDialog, type Confirmation } from './components/ConfirmDialog';
import { useSystemBars } from './platform/useSystemBars';
import { HomeScreen } from './screens/HomeScreen';
import { BoardScreen } from './screens/BoardScreen';
import { BoardFormScreen, type BoardDraft } from './screens/BoardFormScreen';
import { CardFormScreen, type CardDraft, type CardEditField } from './screens/CardFormScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { openRepository, readSnapshot, watchRepository, overviewBoards, setShowPreviews, setUiScale, EMPTY_SNAPSHOT, type Snapshot, type RxRepository, type BoardItem, type Project } from './storage/repository';

type Screen = { kind: 'home' } | { kind: 'settings' } | { kind: 'board'; id: string } | { kind: 'board-form'; id?: string } | { kind: 'card-form'; projectId: string; id?: string; field?: CardEditField; afterItemId?: string };
export default function App() {
  useSystemBars();
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [repository, setRepository] = useState<RxRepository | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusCardId, setFocusCardId] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<{ id: string; choosingTarget: boolean } | null>(null);
  const [fingerprintTransition, setFingerprintTransition] = useState<FingerprintTransition | null>(null);
  const [cardPicker, setCardPicker] = useState<{ id: string; field: CardPickerField } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [celebration, setCelebration] = useState<{ projectId: string; revision: number } | null>(null);
  const celebrationRevision = useRef(0);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const pending = useRef(false);
  const backRef = useRef<() => void>(() => {});
  const mainRef = useRef<HTMLDivElement>(null);
  const { service: cloud, state: cloudState } = useCloudSync(Boolean(repository), screen.kind === 'board' ? screen.id : screen.kind === 'card-form' ? screen.projectId : screen.kind === 'board-form' ? screen.id ?? null : null);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    setLoadError(false);
    void openRepository().then(repo => {
      if (!active) return;
      setRepository(repo);
      stop = watchRepository(repo, value => {
        if (active) { setSnapshot(value); setReady(true); setLoadError(false); }
      }, error => {
        console.error('Could not read local boards', error);
        if (active) setLoadError(true);
      });
    }, error => {
      console.error('Could not open local boards', error);
      if (active) setLoadError(true);
    });
    return () => { active = false; stop?.(); };
  }, [attempt]);

  useEffect(() => {
    if (!celebration) return;
    const timer = window.setTimeout(() => setCelebration(null), 1000);
    return () => window.clearTimeout(timer);
  }, [celebration]);
  function celebrateDone(projectId: string) {
    setCelebration({ projectId, revision: ++celebrationRevision.current });
  }
  function navigate(next: Screen) { dirty.current = false; setFocusCardId(null); setCardMenu(null); setCardPicker(null); setFingerprintTransition(null); setCelebration(null); setScreen(next); }
  function leaveScreen() {
    if (screen.kind === 'card-form') navigate({ kind: 'board', id: screen.projectId });
    else if (screen.kind === 'board-form' && screen.id) navigate({ kind: 'board', id: screen.id });
    else navigate({ kind: 'home' });
  }
  function goBack(exitFromHome = false) {
    if (pending.current) return;
    if (cardMenu) { setCardMenu(cardMenu.choosingTarget ? { ...cardMenu, choosingTarget: false } : null); return; }
    if (cardPicker) { setCardPicker(null); return; }
    if (confirmation) { setConfirmation(null); return; }
    if (notice) { setNotice(null); return; }
    if (dirty.current) {
      setConfirmation({ title: 'Discard changes?', message: 'Your unsaved changes will be lost.', actionLabel: 'Discard', onConfirm: () => { setConfirmation(null); leaveScreen(); } });
      return;
    }
    if (screen.kind === 'home' && exitFromHome) void NativeApp.exitApp();
    else leaveScreen();
  }
  backRef.current = () => goBack(true);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handle = NativeApp.addListener('backButton', () => backRef.current());
    return () => { void handle.then(listener => listener.remove()); };
  }, []);
  useEffect(() => {
    if (screen.kind !== 'board-form' && screen.kind !== 'card-form') mainRef.current?.focus({ preventScroll: true });
  }, [screen]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function mutate<T>(action: (repo: RxRepository) => Promise<T>, after?: (result: T) => void, failureMessage = 'Could not save this change. Please try again.', allowReadOnly = false) {
    if (!repository || pending.current) return;
    // Local-first: edits are never blocked while Drive/WebRTC role resolution is
    // still in flight; writes apply locally and replicate when the live room or
    // the next backup sync comes up. Only a *resolved* viewer role gates writes.
    if (!allowReadOnly && cloudState?.projectId && (screen.kind === 'board' || screen.kind === 'card-form' || screen.kind === 'board-form') && cloudState.role === 'viewer') { setNotice('This board is currently read-only.'); return; }
    pending.current = true; setBusy(true); setNotice(null);
    try {
      const result = await action(repository);
      const value = await readSnapshot(repository);
      setSnapshot(value);
      after?.(result);
    } catch (error) {
      console.error('Could not save local change', error);
      setNotice(failureMessage);
    } finally { pending.current = false; setBusy(false); }
  }
  function saveBoard(draft: BoardDraft) {
    if (screen.kind !== 'board-form') return;
    const id = screen.id;
    const save = () => {
      setConfirmation(null);
      void mutate(async repo => {
        if (id) {
          await repo.renameProject(id, draft.name);
          await repo.changeProjectTemplate(id, draft.template);
        } else {
          const project = await repo.createProject(draft.name, draft.template);
          return project.id;
        }
        return id;
      }, savedId => navigate({ kind: 'board', id: savedId }));
    };
    const original = snapshot.projects.find(project => project.id === id);
    if (original && original.template !== draft.template) setConfirmation({ title: 'Change board type?', message: 'Unsupported card types will be converted to notes.', actionLabel: 'Change type', onConfirm: save });
    else save();
  }
  function saveCard(draft: CardDraft, addBelow = false) {
    if (screen.kind !== 'card-form') return;
    const { projectId, id, afterItemId } = screen;
    const reachedDone = draft.status === 'done' && snapshot.cards.find(value => value.id === id)?.status !== 'done';
    void mutate(async repo => {
      const { image, ...fields } = draft;
      if (id) { await updateCardPhoto(repo, id, fields, image); return id; }
      return (await repo.addItem({ projectId, ...fields, ...(image ? { image } : {}), ...(afterItemId ? { afterItemId } : {}) })).id;
    }, savedId => {
      navigate(addBelow ? { kind: 'card-form', projectId, afterItemId: savedId } : { kind: 'board', id: projectId });
      if (!addBelow && draft.status !== 'done' && draft.status !== 'rejected' && draft.status !== 'trash') setFocusCardId(savedId);
      if (reachedDone && !addBelow) celebrateDone(projectId);
    });
  }
  function updateCard(value: BoardItem, patch: Partial<Pick<BoardItem, 'type' | 'status' | 'content' | 'displayMode'>>) {
    void mutate(repo => repo.updateItem(value.id, patch), () => { if (patch.status) setFocusCardId(focusTargetAfterStatusMove(snapshot.cards.filter(card => card.projectId === value.projectId), value.id, value.status, patch.status)); if (patch.status && patch.status !== value.status) { setFingerprintTransition({ itemId: value.id, fromStatus: value.status, status: patch.status, revision: ++celebrationRevision.current }); if (patch.status === 'done') celebrateDone(value.projectId); } });
  }
  useEffect(() => {
    if (!fingerprintTransition) return;
    const timer = window.setTimeout(() => setFingerprintTransition(null), 1000);
    return () => window.clearTimeout(timer);
  }, [fingerprintTransition]);
  function cardAction(value: BoardItem, action: CardAction) {
    if (action === 'merge') { if (!value.imageId && !value.image) setCardMenu({ id: value.id, choosingTarget: true }); return; }
    setCardMenu(null);
    if (action === 'insert') navigate({ kind: 'card-form', projectId: value.projectId, afterItemId: value.id });
    else if (action === 'duplicate') void mutate(repo => repo.duplicateItem(value.id), duplicate => { setFocusCardId(duplicate.id); setNotice('Card duplicated.'); });
    else if (action === 'copy') void mutate(() => copyText(cardTextForClipboard(value)), copied => { if (copied) setNotice('Card text copied.'); }, 'Could not copy this card. Please try again.', true);
    else deleteCard(value);
  }
  function mergeCards(source: BoardItem, target: BoardItem) {
    setCardMenu(null);
    if (source.imageId || source.image || source.id === target.id || source.projectId !== target.projectId) return;
    const merge = () => { setConfirmation(null); void mutate(repo => repo.mergeItems(source.id, target.id), () => { setFocusCardId(target.id); setNotice('Cards merged.'); }); };
    if (source.status === 'confirmed') setConfirmation({ title: 'Merge confirmed card?', message: 'Its title and text will be appended to the target card. The source card will be removed.', actionLabel: 'Merge', onConfirm: merge });
    else merge();
  }
  function copyBoard(project: Project, section?: 'done' | 'rejected') {
    const cards = snapshot.cards.filter(value => value.projectId === project.id && (!section || value.status === section));
    const text = section ? serializeProject(project, cards) : serializeBoard(project, cards);
    void mutate(() => copyText(text), copied => { if (copied) setNotice(section ? `${section === 'done' ? 'Done' : 'Rejected'} cards copied.` : 'Board copied.'); }, 'Could not copy the board. Please try again.', true);
  }
  function downloadBoard(project: Project) {
    const cards = snapshot.cards.filter(value => value.projectId === project.id);
    void mutate(async repo => saveBoardArchive(await buildBoardArchive(project, cards, repo.getImage)), saved => { if (saved) setNotice('Board archive saved.'); }, 'Could not download this board. Please try again.', true);
  }
  function deleteBoard(project: Project) {
    setConfirmation({ title: 'Delete board?', message: `Delete “${project.name}”? Private boards are also removed from Google Drive when connected. On a shared board, owners delete live content for collaborators; other users only remove it from their own board list.`, actionLabel: 'Delete', onConfirm: () => {
      setConfirmation(null);
      void mutate(repo => repo.deleteProject(project.id), () => navigate({ kind: 'home' }), 'Could not delete this board. Please try again.', true);
    } });
  }
  function deleteCard(card: BoardItem) {
    void mutate(repo => card.status === 'trash' ? repo.deleteItem(card.id) : repo.updateItem(card.id, { status: 'trash' }));
  }
  function trashSection(projectId: string, status: 'done' | 'rejected') {
    const cards = snapshot.cards.filter(card => card.projectId === projectId && card.status === status);
    void mutate(async repo => { for (const card of cards) await repo.updateItem(card.id, { status: 'trash' }); });
  }
  function emptyTrash(projectId: string) {
    setConfirmation({ title: 'Empty trash?', message: 'All cards in this board’s trash will be deleted permanently.', actionLabel: 'Empty trash', onConfirm: () => {
      setConfirmation(null); void mutate(repo => repo.emptyTrash(projectId));
    } });
  }
  function moveBoard(project: Project, direction: -1 | 1) {
    const ids = snapshot.projects.map(value => value.id);
    const index = ids.indexOf(project.id); const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void mutate(repo => repo.reorderProjects(ids));
  }
  const projectId = screen.kind === 'board' || screen.kind === 'board-form' ? screen.id : screen.kind === 'card-form' ? screen.projectId : undefined;
  const project = snapshot.projects.find(value => value.id === projectId);
  const card = screen.kind === 'card-form' ? snapshot.cards.find(value => value.id === screen.id) : undefined;
  const pickerCard = snapshot.cards.find(value => value.id === cardPicker?.id && value.projectId === project?.id);
  const menuCard = snapshot.cards.find(value => value.id === cardMenu?.id && value.projectId === project?.id);
  const missingCard = screen.kind === 'card-form' && screen.id && !card;
  const missing = (screen.kind === 'board' || screen.kind === 'card-form' || (screen.kind === 'board-form' && screen.id)) && !project;
  // A deleted board (locally, by the owner, or through lost access) must return
  // to the home page instead of leaving a dead screen behind. Card edits bounce
  // back to their (still existing) board. The interstitial page stays as a
  // defensive fallback for the card case and renders before the effect runs.
  useEffect(() => {
    if (!ready || pending.current) return;
    if (missing) { navigate({ kind: 'home' }); return; }
    if (missingCard && screen.kind === 'card-form') navigate({ kind: 'board', id: screen.projectId });
  }, [ready, missing, missingCard, screen, project]);
  return <div className="app-shell" ref={mainRef} tabIndex={-1} aria-busy={busy || !ready} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); goBack(); } }}>
    {loadError && <div className="load-error" role="alert"><p>Could not load your saved boards.</p><button onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
    {!ready ? (!loadError && <p className="empty-state" role="status">Loading boards…</p>) : missing || missingCard ? <main className="screen-content"><p>{missingCard ? 'This card' : 'This board'} is no longer available.</p><button onClick={() => navigate({ kind: 'home' })}>Back to home</button></main> :
      screen.kind === 'home' ? <HomeScreen boards={overviewBoards(snapshot)} showPreviews={snapshot.showPreviews} onOpen={board => navigate({ kind: 'board', id: board.id })} onSettings={() => navigate({ kind: 'settings' })} onNotice={setNotice} onCreate={() => navigate({ kind: 'board-form' })} /> :
      screen.kind === 'settings' ? <SettingsScreen cloud={<CloudSettings service={cloud} state={cloudState} />} uiScale={snapshot.uiScale ?? 1} onScale={scale => { void mutate(repo => setUiScale(repo, scale)); }} projects={snapshot.projects} showPreviews={snapshot.showPreviews} busy={busy} onBack={() => goBack()} onPreviews={show => { void mutate(repo => setShowPreviews(repo, show)); }} onMoveBoard={moveBoard} /> :
      screen.kind === 'board-form' ? <BoardFormScreen key={screen.id ?? 'new-board'} project={project} busy={busy} onBack={() => goBack()} onChange={value => { dirty.current = value; }} onSave={saveBoard} /> :
      screen.kind === 'card-form' && project ? <CardFormScreen getImage={repository?.getImage} key={screen.id ?? `new-card-${screen.afterItemId ?? 'end'}`} project={project} card={card} focusField={screen.field} busy={busy} onBack={() => goBack()} onChange={value => { dirty.current = value; }} onSave={saveCard} /> :
      screen.kind === 'board' && project ? <BoardScreen readOnly={Boolean(cloudState?.projectId === project.id && cloudState?.role === 'viewer')} cloud={<CloudBoard key={project.id} service={cloud} state={cloudState} projectId={project.id} />} focusCardId={focusCardId} onFocusHandled={() => setFocusCardId(null)} uiScale={snapshot.uiScale ?? 1} fingerprintTransition={fingerprintTransition} onCardActions={value => setCardMenu({ id: value.id, choosingTarget: false })} onInsertAfter={value => navigate({ kind: 'card-form', projectId: value.projectId, afterItemId: value.id })} onCopyBoard={() => copyBoard(project)} onCopySection={status => copyBoard(project, status)} onDownloadBoard={() => downloadBoard(project)} getImage={repository?.getImage} project={project} cards={snapshot.cards.filter(value => value.projectId === project.id)} busy={busy} onBack={() => goBack()} onEditBoard={() => navigate({ kind: 'board-form', id: project.id })} onDeleteBoard={() => deleteBoard(project)} onAddCard={() => navigate({ kind: 'card-form', projectId: project.id })} onEditCard={(value, field) => navigate({ kind: 'card-form', projectId: project.id, id: value.id, field })} onDeleteCard={deleteCard} onTrashSection={status => trashSection(project.id, status)} onEmptyTrash={() => emptyTrash(project.id)} onChooseCardField={(value, field) => setCardPicker({ id: value.id, field })} onUpdateCard={updateCard} onReorderCard={(value, ids) => { void mutate(repo => repo.moveItem(value.projectId, value.id, ids), () => setFocusCardId(value.id)); }} /> : null}
    {celebration && screen.kind === 'board' && screen.id === celebration.projectId && <BoardConfetti key={celebration.revision} revision={celebration.revision} />}
    <div className="notice" role="status" aria-live="polite" aria-atomic="true">{notice}</div>
    {cardMenu && menuCard && project && <CardActions card={menuCard} cards={snapshot.cards.filter(value => value.projectId === project.id)} choosingTarget={cardMenu.choosingTarget} onCancel={() => goBack()} onAction={action => cardAction(menuCard, action)} onMerge={target => mergeCards(menuCard, target)} onMode={mode => { setCardMenu(null); updateCard(menuCard, { displayMode: mode }); }} />}
    {cardPicker && pickerCard && project && <CardFieldPicker key={`${cardPicker.id}-${cardPicker.field}`} project={project} card={pickerCard} field={cardPicker.field} onCancel={() => setCardPicker(null)} onChoose={patch => { setCardPicker(null); updateCard(pickerCard, patch); }} />}
    {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} />}
  </div>;
}
