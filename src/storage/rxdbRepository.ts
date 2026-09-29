import { createRxDatabase, type RxCollection, type RxDatabase } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { boardTemplates, isTypeSupported } from "../templates/boardTemplates";
import { normalizeCardDisplayMode } from "../cardDisplayModes";
import type { AppState, BoardImage, BoardItem, BoardItemStatus, BoardItemType, BoardTemplate, Project } from "../types";
import { blobToDataUrl, createIndexedDbBlobStore, imageToBlob, type BlobStore } from "./blobStore";
import { compareOrdered, initialOrderKeys, orderKeyBetween, rebalanceOrderKeys } from "./orderKey";
import { cardSchema, projectSchema, settingSchema, type CardRecord, type ProjectRecord, type SettingRecord } from "./rxdbSchemas";
import type { RepositoryEvents } from "./repository";

export type RxCollections = {
  projects: RxCollection<ProjectRecord>;
  cards: RxCollection<CardRecord>;
  settings: RxCollection<SettingRecord>;
};

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const isVisible = (card: CardRecord) => !card.deletedAt;
const projectValue = (record: ProjectRecord): Project => {
  const { orderKey: _, tailOrderKey: __, ...project } = record;
  return project;
};
const cardValue = (record: CardRecord, order: number): BoardItem => {
  const { orderKey: _, deletedAt: __, ...card } = record;
  return { ...card, order, displayMode: normalizeCardDisplayMode(card.displayMode) };
};

export async function createRxRepository(options: {
  name?: string;
  blobs?: BlobStore;
  events?: RepositoryEvents;
  storage?: ReturnType<typeof getRxStorageDexie>;
} = {}) {
  const db: RxDatabase<RxCollections> = await createRxDatabase<RxCollections>({
    name: options.name ?? "pboardlocalv1",
    storage: options.storage ?? getRxStorageDexie(),
    multiInstance: true
  });
  await db.addCollections({ projects: { schema: projectSchema }, cards: { schema: cardSchema }, settings: { schema: settingSchema } });
  const { projects, cards, settings } = db;
  const blobs = options.blobs ?? createIndexedDbBlobStore();
  const events = options.events ?? {};
  let queue: Promise<unknown> = Promise.resolve();
  function locked<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation);
    queue = run.catch(() => undefined);
    return run;
  }
  async function changed(projectId: string) { await events.projectChanged?.(projectId); }
  async function touchProject(projectId: string, timestamp = now(), appendedKey?: string) {
    const project = await projects.findOne(projectId).exec();
    if (!project) return;
    await project.incrementalModify((current) => {
      const previous = Date.parse(current.updatedAt);
      const candidate = Date.parse(timestamp);
      const updatedAt = Number.isFinite(previous) && (!Number.isFinite(candidate) || candidate <= previous)
        ? new Date(previous + 1).toISOString() : timestamp;
      return { ...current, revision: current.revision + 1, updatedAt,
        ...(appendedKey && (!current.tailOrderKey || appendedKey > current.tailOrderKey) ? { tailOrderKey: appendedKey } : {}) };
    });
  }
  async function allProjectRecords() {
    return (await projects.find().exec()).map((doc) => doc.toJSON()).sort(compareOrdered);
  }
  async function projectCardRecords(projectId: string, includeDeleted = false) {
    const records = (await cards.find({ selector: { projectId }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] }).exec()).map((doc) => doc.toJSON()).sort(compareOrdered);
    return includeDeleted ? records : records.filter(isVisible);
  }
  async function listProjects(): Promise<Project[]> { return (await allProjectRecords()).map(projectValue); }
  async function getProject(id: string): Promise<Project | null> {
    const doc = await projects.findOne(id).exec();
    return doc ? projectValue(doc.toJSON()) : null;
  }
  async function getCurrentProject(): Promise<Project | null> {
    const setting = await settings.findOne("currentProjectId").exec();
    return setting?.value ? getProject(setting.value) : null;
  }
  async function listCards(projectId: string): Promise<BoardItem[]> {
    return (await projectCardRecords(projectId)).map(cardValue);
  }
  async function listCardsByStatus(projectId: string, status: BoardItemStatus): Promise<BoardItem[]> {
    const records = (await cards.find({ selector: { projectId, status } }).exec()).map((doc) => doc.toJSON()).filter(isVisible).sort(compareOrdered);
    return records.map(cardValue);
  }
  async function getCard(id: string): Promise<BoardItem | null> {
    const doc = await cards.findOne(id).exec();
    if (!doc || !isVisible(doc.toJSON())) return null;
    const ordered = await projectCardRecords(doc.projectId);
    return cardValue(doc.toJSON(), ordered.findIndex((card) => card.id === id));
  }
  async function hydrateCard(card: BoardItem): Promise<BoardItem> {
    if (!card.imageId) return card;
    const image = await blobs.getBlob(card.imageId);
    if (!image) return card;
    return { ...card, image: { dataUrl: await blobToDataUrl(image.blob), mimeType: image.mimeType, width: image.width, height: image.height } };
  }
  async function exportProject(projectId: string): Promise<{ project: Project; items: BoardItem[] }> {
    const project = await getProject(projectId);
    if (!project) throw new Error("Project not found");
    const items = await Promise.all((await listCards(projectId)).map(hydrateCard));
    return { project, items: items.map(({ imageId: _, imageMimeType: __, imageWidth: ___, imageHeight: ____, ...item }) => item) };
  }
  async function exportAll(): Promise<AppState> {
    const projectList = await listProjects();
    const exported = await Promise.all(projectList.map((project) => exportProject(project.id)));
    return { version: 3, projects: projectList, boardItems: exported.flatMap((entry) => entry.items), currentProjectId: (await getCurrentProject())?.id ?? null };
  }
  async function putImage(image: BoardImage): Promise<string> {
    return blobs.putBlob(await imageToBlob(image.dataUrl), image);
  }
  async function deleteImage(imageId: string): Promise<void> {
    // Tombstoned cards retain references for rollback and future replication.
    if ((await cards.find().exec()).some((doc) => doc.imageId === imageId)) throw new Error("Image is still referenced by a card");
    await blobs.deleteBlob(imageId);
  }
  async function importProject(project: Project, items: BoardItem[], preserveOrderKey?: string) {
    const existing = await projects.findOne(project.id).exec();
    const orderKey = preserveOrderKey ?? existing?.orderKey ?? orderKeyBetween((await allProjectRecords()).at(-1)?.orderKey ?? null, null);
    const sorted = [...items].sort((a, b) => a.order - b.order);
    const keys = initialOrderKeys(sorted.length);
    await projects.upsert({ ...project, orderKey, ...(keys.at(-1) ? { tailOrderKey: keys.at(-1) } : {}) });
    const previous = await projectCardRecords(project.id, true);
    const incomingIds = new Set(items.map((item) => item.id));
    for (const record of previous) if (!incomingIds.has(record.id)) {
      const doc = await cards.findOne(record.id).exec();
      if (doc) await doc.incrementalPatch({ deletedAt: now() });
    }
    // JS stable sort preserves the legacy array order when numeric ranks tie.
    for (const [index, item] of sorted.entries()) {
      const { order: _, image, imageId: existingImageId, imageMimeType, imageWidth, imageHeight, ...rest } = item;
      const imageId = image ? await putImage(image) : existingImageId;
      await cards.upsert({ ...rest, displayMode: normalizeCardDisplayMode(item.displayMode), orderKey: keys[index],
        ...(imageId ? { imageId, imageMimeType: image?.mimeType ?? imageMimeType, imageWidth: image?.width ?? imageWidth, imageHeight: image?.height ?? imageHeight } : {}) });
    }
    if (!(await getCurrentProject())) await settings.upsert({ id: "currentProjectId", value: project.id });
  }
  async function importState(state: AppState) {
    const incomingProjectIds = new Set(state.projects.map((project) => project.id));
    for (const project of await allProjectRecords()) if (!incomingProjectIds.has(project.id)) await removeProject(project.id);
    const projectKeys = initialOrderKeys(state.projects.length);
    for (const [index, project] of state.projects.entries()) {
      await importProject(project, state.boardItems.filter((item) => item.projectId === project.id), projectKeys[index]);
    }
    await settings.upsert({ id: "currentProjectId", value: state.currentProjectId ?? "" });
    const importedProjects = await listProjects();
    if (importedProjects.length !== state.projects.length || importedProjects.some((project) => !state.projects.some((original) => original.id === project.id))) {
      throw new Error("RxDB migration project verification failed");
    }
    for (const project of state.projects) {
      const expected = state.boardItems.filter((card) => card.projectId === project.id);
      const actual = await listCards(project.id);
      if (expected.length !== actual.length || expected.some((card) => !actual.some((imported) => imported.id === card.id))) {
        throw new Error(`RxDB migration card verification failed for ${project.id}`);
      }
      for (const card of expected.filter((candidate) => candidate.image)) {
        const imported = actual.find((candidate) => candidate.id === card.id);
        if (!imported?.imageId || !(await blobs.hasBlob(imported.imageId))) throw new Error(`RxDB migration image verification failed for ${card.id}`);
      }
    }
  }
  async function migrationComplete() { return (await settings.findOne("migrationVersion").exec())?.value === "1"; }
  async function markMigrationComplete() { await settings.upsert({ id: "migrationVersion", value: "1" }); }
  async function markMigrationIncomplete() { await settings.upsert({ id: "migrationVersion", value: "0" }); }
  async function createProject(name: string, template: BoardTemplate = "brainstorming"): Promise<Project> { return locked(async () => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    const timestamp = now();
    const project: Project = { id: newId(), name: trimmed, template, revision: 1, createdAt: timestamp, updatedAt: timestamp };
    await projects.insert({ ...project, orderKey: orderKeyBetween((await allProjectRecords()).at(-1)?.orderKey ?? null, null) });
    await settings.upsert({ id: "currentProjectId", value: project.id });
    await changed(project.id);
    return project;
  }); }
  async function selectProject(projectId: string) {
    if (!(await getProject(projectId))) throw new Error("Project not found");
    await settings.upsert({ id: "currentProjectId", value: projectId });
  }
  async function reorderProjects(orderedIds: string[]) { return locked(async () => {
    const current = await allProjectRecords();
    if (orderedIds.length !== current.length || new Set(orderedIds).size !== current.length || current.some((record) => !orderedIds.includes(record.id))) throw new Error("Project list must contain every project exactly once");
    const keys = initialOrderKeys(current.length);
    for (let index = 0; index < orderedIds.length; index++) {
      const doc = await projects.findOne(orderedIds[index]).exec();
      if (doc && doc.orderKey !== keys[index]) await doc.incrementalPatch({ orderKey: keys[index] });
    }
  }); }
  async function renameProject(projectId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    const doc = await projects.findOne(projectId).exec();
    if (!doc) throw new Error("Project not found");
    if (doc.name === trimmed) return;
    await doc.incrementalPatch({ name: trimmed });
    await touchProject(projectId);
    await changed(projectId);
  }
  async function deleteProject(projectId: string) { return locked(async () => {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) return;
    await events.projectDeleting?.(projectValue(doc.toJSON()));
    for (const card of await projectCardRecords(projectId)) {
      await (await cards.findOne(card.id).exec())?.incrementalPatch({ deletedAt: now() });
    }
    await doc.remove();
    if ((await getCurrentProject())?.id === projectId || (await settings.findOne("currentProjectId").exec())?.value === projectId) {
      await settings.upsert({ id: "currentProjectId", value: (await listProjects())[0]?.id ?? "" });
    }
    await events.projectDeleted?.(projectId);
  }); }
  async function changeProjectTemplate(projectId: string, template: BoardTemplate): Promise<number> { return locked(async () => {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) throw new Error("Project not found");
    if (doc.template === template) return 0;
    let remapped = 0;
    const timestamp = now();
    for (const record of await projectCardRecords(projectId)) if (!isTypeSupported(template, record.type)) {
      await (await cards.findOne(record.id).exec())?.incrementalPatch({ type: "note", updatedAt: timestamp });
      remapped++;
    }
    await doc.incrementalPatch({ template });
    await touchProject(projectId, timestamp);
    await changed(projectId);
    return remapped;
  }); }
  async function addItem(input: { projectId: string; content: string; title?: string; type?: BoardItemType; status?: BoardItemStatus; displayMode?: BoardItem["displayMode"]; source?: BoardItem["source"]; image?: BoardImage; afterItemId?: string }): Promise<BoardItem> { return locked(async () => {
    const projectDoc = await projects.findOne(input.projectId).exec();
    if (!projectDoc) throw new Error("Project not found");
    const project = projectValue(projectDoc.toJSON());
    let beforeKey: string | null = null;
    let afterKey: string | null = null;
    if (input.afterItemId) {
      const anchor = await cards.findOne(input.afterItemId).exec();
      if (anchor?.projectId === input.projectId && !anchor.deletedAt) {
        beforeKey = anchor.orderKey;
        const following = await cards.find({ selector: { projectId: input.projectId, orderKey: { $gt: beforeKey } },
          sort: [{ projectId: "asc" }, { orderKey: "asc" }], limit: 10 }).exec();
        afterKey = following.map((doc) => doc.toJSON()).find(isVisible)?.orderKey ?? null;
        if (!afterKey && following.length === 10) afterKey = (await projectCardRecords(input.projectId)).find((item) => item.orderKey > beforeKey!)?.orderKey ?? null;
      }
    }
    if (!beforeKey && projectDoc.tailOrderKey) {
      // The high-water rank may belong to a tombstone. That is fine: the new
      // card still appends after every visible card without a broad query.
      beforeKey = projectDoc.tailOrderKey;
    }
    if (!beforeKey) {
      const tail = await cards.find({ selector: { projectId: input.projectId },
        sort: [{ projectId: "desc" }, { orderKey: "desc" }], limit: 10 }).exec();
      beforeKey = tail.map((doc) => doc.toJSON()).find(isVisible)?.orderKey ?? null;
      if (!beforeKey && tail.length === 10) beforeKey = (await projectCardRecords(input.projectId)).at(-1)?.orderKey ?? null;
    }
    const key = orderKeyBetween(beforeKey, afterKey);
    const timestamp = now();
    const imageId = input.image ? await putImage(input.image) : undefined;
    const record: CardRecord = { id: newId(), projectId: input.projectId,
      type: input.type && isTypeSupported(project.template, input.type) ? input.type : boardTemplates[project.template].defaultCardType,
      status: input.status ?? "candidate", displayMode: normalizeCardDisplayMode(input.displayMode), content: input.content.trim(),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}), ...(input.source ? { source: input.source } : {}),
      ...(imageId ? { imageId, imageMimeType: input.image?.mimeType, imageWidth: input.image?.width, imageHeight: input.image?.height } : {}),
      orderKey: key, createdAt: timestamp, updatedAt: timestamp };
    await cards.insert(record);
    await touchProject(project.id, timestamp, key);
    await changed(project.id);
    const order = (await projectCardRecords(project.id)).findIndex((item) => item.id === record.id);
    return { ...cardValue(record, order), ...(input.image ? { image: input.image } : {}) };
  }); }
  async function updateItem(itemId: string, patch: Partial<Pick<BoardItem, "content" | "title" | "type" | "status" | "displayMode">>) { return locked(async () => {
    const doc = await cards.findOne(itemId).exec();
    if (!doc || doc.deletedAt) throw new Error("Card not found");
    const project = await getProject(doc.projectId);
    if (patch.type && project && !isTypeSupported(project.template, patch.type)) throw new Error("Card type is not supported by this board template");
    const changedFields = Object.entries(patch).filter(([key, value]) => doc.get(key as keyof CardRecord) !== value);
    if (!changedFields.length) return;
    const timestamp = now();
    await doc.incrementalPatch({ ...Object.fromEntries(changedFields), updatedAt: timestamp });
    await touchProject(doc.projectId, timestamp);
    await changed(doc.projectId);
  }); }
  async function deleteItem(itemId: string) { return locked(async () => {
    const doc = await cards.findOne(itemId).exec();
    if (!doc || doc.deletedAt) return;
    await doc.incrementalPatch({ deletedAt: now() });
    await touchProject(doc.projectId);
    await changed(doc.projectId);
  }); }
  async function emptyTrash(projectId: string): Promise<number> { return locked(async () => {
    const trash = (await projectCardRecords(projectId)).filter((item) => item.status === "trash");
    for (const item of trash) await (await cards.findOne(item.id).exec())?.incrementalPatch({ deletedAt: now() });
    if (trash.length) { await touchProject(projectId); await changed(projectId); }
    return trash.length;
  }); }
  async function duplicateItem(itemId: string): Promise<BoardItem> { return locked(async () => {
    const source = await cards.findOne(itemId).exec();
    if (!source || source.deletedAt) throw new Error("Card not found");
    const ordered = await projectCardRecords(source.projectId);
    const index = ordered.findIndex((item) => item.id === itemId);
    const timestamp = now();
    const record: CardRecord = { ...source.toJSON(), id: newId(), status: "candidate",
      orderKey: orderKeyBetween(source.orderKey, ordered[index + 1]?.orderKey ?? null), createdAt: timestamp, updatedAt: timestamp };
    await cards.insert(record);
    await touchProject(source.projectId, timestamp, record.orderKey);
    await changed(source.projectId);
    return cardValue(record, index + 1);
  }); }
  async function mergeItems(sourceId: string, targetId: string) { return locked(async () => {
    if (sourceId === targetId) throw new Error("A card cannot be merged into itself");
    const source = await cards.findOne(sourceId).exec();
    const target = await cards.findOne(targetId).exec();
    if (!source || !target || source.deletedAt || target.deletedAt) throw new Error("Card not found");
    if (source.projectId !== target.projectId) throw new Error("Cards must belong to the same project");
    if (source.imageId) throw new Error("Image cards cannot be merged without losing the image");
    const appended = [source.title?.trim(), source.content.trim()].filter(Boolean).join("\n");
    const timestamp = now();
    await target.incrementalPatch({ content: [target.content.trimEnd(), appended].filter(Boolean).join("\n\n"), updatedAt: timestamp });
    await source.incrementalPatch({ deletedAt: timestamp });
    await touchProject(source.projectId, timestamp);
    await changed(source.projectId);
  }); }
  async function reorderItems(projectId: string, orderedIds: string[]) { return locked(async () => {
    const current = await projectCardRecords(projectId);
    const requested = new Set(orderedIds);
    if (orderedIds.length !== current.length || requested.size !== current.length || current.some((item) => !requested.has(item.id))) throw new Error("Reorder list must contain every project card exactly once");
    if (orderedIds.every((id, index) => current[index].id === id)) return;
    const oldIds = current.map((item) => item.id);
    const firstMismatch = oldIds.findIndex((id, index) => id !== orderedIds[index]);
    const sameWithout = (candidate: string) => {
      let left = 0;
      let right = 0;
      while (left < oldIds.length || right < orderedIds.length) {
        if (oldIds[left] === candidate) left++;
        if (orderedIds[right] === candidate) right++;
        if (left >= oldIds.length || right >= orderedIds.length) return left >= oldIds.length && right >= orderedIds.length;
        if (oldIds[left++] !== orderedIds[right++]) return false;
      }
      return true;
    };
    const movedId = [oldIds[firstMismatch], orderedIds[firstMismatch]].find((id) => sameWithout(id));
    if (movedId) {
      const position = orderedIds.indexOf(movedId);
      const byId = new Map(current.map((item) => [item.id, item]));
      const before = byId.get(orderedIds[position - 1]);
      const after = byId.get(orderedIds[position + 1]);
      if ((before?.orderKey ?? "") < (after?.orderKey ?? "\uffff")) {
        const key = orderKeyBetween(before?.orderKey ?? null, after?.orderKey ?? null);
        await (await cards.findOne(movedId).exec())?.incrementalPatch({ orderKey: key, updatedAt: now() });
        await touchProject(projectId, now(), key); await changed(projectId); return;
      }
    }
    // Ambiguous or multi-card permutation: explicit rank rebalance, never a normal single move.
    const keys = initialOrderKeys(current.length);
    for (const [index, id] of orderedIds.entries()) await (await cards.findOne(id).exec())?.incrementalPatch({ orderKey: keys[index], updatedAt: now() });
    await touchProject(projectId, now(), keys.at(-1)); await changed(projectId);
  }); }
  async function moveItem(projectId: string, itemId: string, orderedIds: string[]) { return locked(async () => {
    const position = orderedIds.indexOf(itemId);
    if (position < 0 || orderedIds.lastIndexOf(itemId) !== position) throw new Error("Moved card must occur exactly once");
    const item = await cards.findOne(itemId).exec();
    if (!item || item.projectId !== projectId || item.deletedAt) throw new Error("Card not found");
    const before = position ? await cards.findOne(orderedIds[position - 1]).exec() : null;
    const after = position + 1 < orderedIds.length ? await cards.findOne(orderedIds[position + 1]).exec() : null;
    if ((before && (before.projectId !== projectId || before.deletedAt)) ||
        (after && (after.projectId !== projectId || after.deletedAt))) throw new Error("Move neighbors are invalid");
    const key = orderKeyBetween(before?.orderKey ?? null, after?.orderKey ?? null);
    if (key === item.orderKey) return;
    const timestamp = now();
    await item.incrementalPatch({ orderKey: key, updatedAt: timestamp });
    await touchProject(projectId, timestamp, key);
    await changed(projectId);
  }); }
  async function rebalanceProject(projectId: string) { return locked(async () => {
    const ranked = rebalanceOrderKeys(await projectCardRecords(projectId));
    for (const [id, orderKey] of ranked) await (await cards.findOne(id).exec())?.incrementalPatch({ orderKey });
    const project = await projects.findOne(projectId).exec();
    if (project) await project.incrementalPatch({ tailOrderKey: [...ranked.values()].at(-1) });
  }); }
  async function removeProject(projectId: string) {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) return;
    for (const card of await projectCardRecords(projectId)) await (await cards.findOne(card.id).exec())?.incrementalPatch({ deletedAt: now() });
    await doc.remove();
    if ((await settings.findOne("currentProjectId").exec())?.value === projectId) await settings.upsert({ id: "currentProjectId", value: (await listProjects())[0]?.id ?? "" });
  }
  function subscribe<T>(query: { $: { subscribe: (next: () => void) => { unsubscribe(): void } } }, read: () => Promise<T>, listener: (value: T) => void) {
    let active = true;
    const refresh = () => { void read().then((value) => { if (active) listener(value); }); };
    const sub = query.$.subscribe(refresh);
    refresh();
    return () => { active = false; sub.unsubscribe(); };
  }
  const subscribeProjects = (listener: (value: Project[]) => void) => subscribe(projects.find(), listProjects, listener);
  const subscribeCurrentProject = (listener: (value: Project | null) => void) => {
    const emit = () => { void getCurrentProject().then(listener); };
    const first = settings.findOne("currentProjectId").$.subscribe(emit);
    const second = projects.find().$.subscribe(emit);
    emit();
    return () => { first.unsubscribe(); second.unsubscribe(); };
  };
  const subscribeCards = (projectId: string, listener: (value: BoardItem[]) => void) =>
    subscribe(cards.find({ selector: { projectId }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] }), () => listCards(projectId), listener);
  const subscribeCard = (id: string, listener: (value: BoardItem | null) => void) => subscribe(cards.findOne(id), () => getCard(id), listener);
  async function load(): Promise<AppState> { return exportAll(); } // Compatibility for old command callers; not a reactive read path.
  return { db, blobs, load, exportAll, exportProject, importProject, importState, removeProject, migrationComplete, markMigrationComplete, markMigrationIncomplete,
    createProject, selectProject, reorderProjects, renameProject, deleteProject, changeProjectTemplate,
    addItem, updateItem, deleteItem, duplicateItem, emptyTrash, mergeItems, reorderItems, moveItem, rebalanceProject,
    getCurrentProject, getProject, listProjects, listCards, listCardsByStatus, getCard,
    subscribeProjects, subscribeCurrentProject, subscribeCards, subscribeCard,
    putImage, getImage: blobs.getBlob, hasImage: blobs.hasBlob, imageAvailability: blobs.imageAvailability, deleteImage };
}

export type RxRepository = Awaited<ReturnType<typeof createRxRepository>>;
