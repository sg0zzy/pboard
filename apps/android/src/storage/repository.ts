import { getAndroidSync } from '../sync/service';
import { normalizeUiScale, DEFAULT_UI_SCALE, UI_SCALE_STORAGE_KEY } from '../../../../src/sidebar/uiScale';
import { createRxRepository, type RxRepository } from '../../../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../../../src/storage/blobStore';
import { compareOrdered } from '../../../../src/storage/orderKey';
import type { CardRecord } from '../../../../src/storage/rxdbSchemas';
import type { BoardItem, Project } from '../../../../src/types';
import type { BoardOverview } from '../data/boards';

export type Snapshot = { projects: Project[]; cards: BoardItem[]; showPreviews: boolean; uiScale?: number };
export const EMPTY_SNAPSHOT: Snapshot = { projects: [], cards: [], showPreviews: true };
const PREVIEWS_KEY = 'android.showCardPreviews';
let opening: Promise<RxRepository> | undefined;

/** Reuse the browser-independent repository, without its browser/Drive adapters. */
export function openRepository(): Promise<RxRepository> {
  const sync = getAndroidSync(openRepository);
  return opening ??= createRxRepository({
    events: sync.events, resolveDeletionRole: sync.resolveDeletionRole,
    name: 'pboardandroidv1',
    blobs: createIndexedDbBlobStore('pboard-android-images-v1'),
  }).catch(error => { opening = undefined; throw error; });
}

export async function readSnapshot(repository: RxRepository): Promise<Snapshot> {
  const [projects, documents, setting, scale] = await Promise.all([
    repository.listProjects(), repository.db.cards.find().exec(), repository.db.settings.findOne(PREVIEWS_KEY).exec(), repository.db.settings.findOne(UI_SCALE_STORAGE_KEY).exec(),
  ]);
  const records = documents.map(doc => doc.toJSON()).filter(card => !card.deletedAt).sort(compareOrdered);
  const ranks = new Map<string, number>();
  const cards = records.map((record: CardRecord): BoardItem => {
    const { orderKey: _, deletedAt: __, ...card } = record;
    const order = ranks.get(record.projectId) ?? 0;
    ranks.set(record.projectId, order + 1);
    return { ...card, order };
  });
  return { projects, cards, showPreviews: setting?.value !== 'false', uiScale: normalizeUiScale(scale?.value ? Number(scale.value) : DEFAULT_UI_SCALE) };
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

const categories = { brainstorming: 'Notes', idea: 'Ideas', project: 'Project', software_project: 'Project' } as const;
export function overviewBoards(snapshot: Snapshot): BoardOverview[] {
  return snapshot.projects.map(project => {
    const first = snapshot.cards.filter(card => card.projectId === project.id && card.status !== 'trash').sort((a, b) => a.order - b.order)[0];
    return {
      id: project.id, name: project.name, updatedAt: project.updatedAt,
      category: categories[project.template] ?? 'Notes', template: project.template, firstCardType: first?.type,
      firstCard: first ? first.title?.trim() || first.content || 'Image card' : 'No cards yet',
    };
  });
}
export type { RxRepository, Project, BoardItem };
