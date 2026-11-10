import { getAndroidSync } from '../sync/service';
import { normalizeUiScale, DEFAULT_UI_SCALE, UI_SCALE_STORAGE_KEY } from '../../../../src/sidebar/uiScale';
import { createRxRepository, type RxRepository } from '../../../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../../../src/storage/blobStore';
import { compareOrdered } from '../../../../src/storage/orderKey';
import { cardContainer } from '../data/cardContainers';
import { categoryOf } from '../data/categories';
import type { CardRecord } from '../../../../src/storage/rxdbSchemas';
import type { BoardItem, Project } from '../../../../src/types';
import type { BoardOverview } from '../data/boards';

export type Snapshot = { projects: Project[]; cards: BoardItem[]; showPreviews: boolean; collapseCards?: boolean; uiScale?: number };
export const EMPTY_SNAPSHOT: Snapshot = { projects: [], cards: [], showPreviews: true, collapseCards: false };
const PREVIEWS_KEY = 'android.showCardPreviews';
const COLLAPSE_KEY = 'android.collapseCards';
let opening: Promise<RxRepository> | undefined;

/** Reuse the browser-independent repository, without its browser/Drive adapters. */
export function openRepository(): Promise<RxRepository> {
  const sync = getAndroidSync(openRepository);
  return opening ??= createRxRepository({
    events: sync.events, resolveDeletionRole: sync.resolveDeletionRole,
    // Same rule as the extension root: the Android app is an
    // operation-protocol build with no live board role, so drafts could never
    // be admitted. Drive-first synchronization delivers ordinary writes.
    offlineDrafts: false,
    name: 'pboardandroidv1',
    blobs: createIndexedDbBlobStore('pboard-android-images-v1'),
  }).catch(error => { opening = undefined; throw error; });
}

export async function readSnapshot(repository: RxRepository): Promise<Snapshot> {
  const [projects, documents, setting, scale, collapse] = await Promise.all([
    repository.listProjects(), repository.db.cards.find().exec(), repository.db.settings.findOne(PREVIEWS_KEY).exec(), repository.db.settings.findOne(UI_SCALE_STORAGE_KEY).exec(), repository.db.settings.findOne(COLLAPSE_KEY).exec(),
  ]);
  const records = documents.map(doc => doc.toJSON()).filter(card => !card.deletedAt).sort(compareOrdered);
  const ranks = new Map<string, number>();
  const cards = records.map((record): BoardItem => {
    const { orderKey: _, deletedAt: __, ...card } = record as CardRecord;
    const order = ranks.get(record.projectId) ?? 0;
    ranks.set(record.projectId, order + 1);
    return { ...(card as BoardItem), order };
  });
  return { projects, cards, showPreviews: setting?.value !== 'false', collapseCards: collapse?.value === 'true', uiScale: normalizeUiScale(scale?.value ? Number(scale.value) : DEFAULT_UI_SCALE) };
}

/** Cheap value comparison for the reactive snapshot. One repository write
 * emits several snapshots (cards + settings subscriptions, plus the explicit
 * read after a mutation), and each distinct array identity used to re-render
 * the whole board. Comparing fields costs microseconds against a render.
 * `uiScale` may legitimately be `undefined`; `collapseCards` is a setting. */
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.showPreviews !== b.showPreviews || a.collapseCards !== b.collapseCards || a.uiScale !== b.uiScale) return false;
  if (a.projects !== b.projects) {
    if (a.projects.length !== b.projects.length) return false;
    for (let index = 0; index < a.projects.length; index++) {
      const left = a.projects[index], right = b.projects[index];
      if (left.id !== right.id || left.name !== right.name || left.template !== right.template
        || left.updatedAt !== right.updatedAt || left.revision !== right.revision) return false;
    }
  }
  if (a.cards === b.cards) return true;
  if (a.cards.length !== b.cards.length) return false;
  for (let index = 0; index < a.cards.length; index++) {
    const left = a.cards[index], right = b.cards[index];
    if (left.id !== right.id || left.projectId !== right.projectId || left.status !== right.status
      || left.title !== right.title || left.content !== right.content || left.type !== right.type
      || left.displayMode !== right.displayMode || left.order !== right.order || left.updatedAt !== right.updatedAt
      || left.imageId !== right.imageId || left.imageMimeType !== right.imageMimeType
      || left.imageWidth !== right.imageWidth || left.imageHeight !== right.imageHeight) return false;
  }
  return true;
}

/** A generation guard prevents slower reads overwriting a newer snapshot. */
export function watchRepository(repository: RxRepository, onChange: (snapshot: Snapshot) => void, onError: (error: unknown) => void): () => void {
  let active = true;
  let generation = 0;
  const refresh = () => {
    const current = ++generation;
    void readSnapshot(repository).then(snapshot => {
      if (active && current === generation) onChange(snapshot);
    }, error => { if (active && current === generation) onError(error); });
  };
  const observer = { next: refresh, error: onError };
  const subscriptions = [
    repository.db.projects.find().$.subscribe(observer),
    repository.db.cards.find().$.subscribe(observer),
    repository.db.settings.find().$.subscribe(observer),
  ];
  refresh();
  return () => { active = false; ++generation; subscriptions.forEach(subscription => subscription.unsubscribe()); };
}

export async function setShowPreviews(repository: RxRepository, show: boolean): Promise<void> {
  await repository.db.settings.upsert({ id: PREVIEWS_KEY, value: String(show) });
}

export async function setUiScale(repository: RxRepository, scale: number): Promise<void> {
  await repository.db.settings.upsert({ id: UI_SCALE_STORAGE_KEY, value: String(normalizeUiScale(scale)) });
}

export async function setCollapseCards(repository: RxRepository, collapse: boolean): Promise<void> {
  await repository.db.settings.upsert({ id: COLLAPSE_KEY, value: String(collapse) });
}

export function overviewBoards(snapshot: Snapshot): BoardOverview[] {
  return snapshot.projects.map(project => {
    // The tile summarizes the board's working list. Done, rejected and trash
    // cards live in collapsed containers, so none of them may become the
    // preview after the active list has been emptied or cleared.
    const first = snapshot.cards.filter(card => card.projectId === project.id && cardContainer(card.status) === 'active').sort((a, b) => a.order - b.order)[0];
    return {
      id: project.id, name: project.name, updatedAt: project.updatedAt,
      category: categoryOf(project.template).label, categoryColor: categoryOf(project.template).color,
      template: project.template,
      firstCard: first ? first.title?.trim() || first.content || 'Image card' : 'No cards yet',
    };
  });
}
export type { RxRepository, Project, BoardItem };
