import { createRxDatabase, defaultConflictHandler, type RxCollection, type RxDatabase, type WithDeleted } from "rxdb";
import { addRxPlugin } from "rxdb";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { boardTemplates, isTypeSupported } from "../templates/boardTemplates";
import { normalizeCardDisplayMode } from "../cardDisplayModes";
import type { AppState, BoardImage, BoardItem, BoardItemStatus, BoardItemType, BoardTemplate, Project } from "../types";
import type { CollaborationRole } from "../collab/manager";
import { blobToDataUrl, createIndexedDbBlobStore, hashBlob, imageToBlob, type BlobStore } from "./blobStore";
import { compareOrdered, initialOrderKeys, orderKeyBetween, rebalanceOrderKeys } from "./orderKey";
import { mergeProjectOrder, parseProjectOrder, type ProjectOrderPreference } from "./projectOrder";
import { cardSchema, projectSchema, settingSchema, type CardRecord, type ProjectRecord, type SettingRecord } from "./rxdbSchemas";
import type { MutationGuardInstall } from "../collab/security/mutation";
import type { RepositoryEvents } from "./repository";

export type RxCollections = {
  projects: RxCollection<ProjectRecord>;
  cards: RxCollection<CardRecord>;
  settings: RxCollection<SettingRecord>;
};

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const isVisible = (card: { deletedAt?: string }) => !card.deletedAt;

// Migration strategies fire when a stored collection's schema version is lower
// than the declared schema (e.g. the protocol-2 `_sec` field bumped cards and
// projects from version 0 to 1). Registering before any createRxDatabase call.
addRxPlugin(RxDBMigrationSchemaPlugin);
const projectValue = (record: { orderKey: string; tailOrderKey?: string; [key: string]: unknown }): Project => {
  const { orderKey: _, tailOrderKey: __, ...project } = record;
  void _; void __;
  return project as unknown as Project;
};
const cardValue = (record: { [key: string]: unknown; orderKey: string; deletedAt?: string }, order: number): BoardItem => {
  const { orderKey: _, deletedAt: __, ...card } = record;
  void _; void __;
  return { ...(card as BoardItem), order, displayMode: normalizeCardDisplayMode(card.displayMode as BoardItem["displayMode"]) };
};

/** Conflict-handler view of a document: schema fields plus the tombstone flag. */
type ConflictInput<T extends { updatedAt: string; deletedAt?: string }> = {
  realMasterState: WithDeleted<T>;
  newDocumentState: WithDeleted<T>;
};

/**
 * Shared-board conflict policy for the replicated collections: last-write-wins by the
 * document's own write time.
 *
 * RxDB's default handler keeps the master state whenever `isEqual(realMasterState,
 * assumedMasterState)` fails — the fork's assumption is either absent (the master created
 * the document first) or stale (both peers created the same project independently, one by
 * bootstrap import and one by create). The fork write is then dropped and never re-applied.
 * WebRTC picks the master by storage-token hash, not by who edited, so that policy loses an
 * editor's change to the document arbitrarily. Resolving by write time keeps the edit; the
 * losing side converges on the next upstream pass, because a conflict response writes the
 * resolved state plus a meta row for the document.
 *
 * `updatedAt` is monotonic per instance (the write path bumps it past the previous value),
 * so it is a usable ordering across peers. A soft delete does not bump it, so the effective
 * write time is `max(updatedAt, deletedAt)`. `Date.parse("")` is `NaN` and would poison
 * `Math.max`, hence the explicit guards. Ties keep the master state.
 */
function lastWriteWins<T extends { updatedAt: string; deletedAt?: string }>(
  input: ConflictInput<T>
): WithDeleted<T> {
  const writeTime = (doc: WithDeleted<T>) => Math.max(Date.parse(doc.updatedAt) || 0, doc.deletedAt ? (Date.parse(doc.deletedAt) || 0) : 0);
  return writeTime(input.newDocumentState) > writeTime(input.realMasterState) ? input.newDocumentState : input.realMasterState;
}

export async function createRxRepository(options: {
  name?: string;
  blobs?: BlobStore;
  events?: RepositoryEvents;
  storage?: ReturnType<typeof getRxStorageDexie>;
  /**
   * Collaboration write-gate. When the caller is a Viewer of the active shared
   * project, board/project mutations are rejected at the storage layer so no
   * local write can exist to be replicated. WebRTC picks master/slave by token
   * hash, not role, and the master streams its change log unconditionally, so a
   * viewer that is the master would otherwise leak its local writes to peers.
   * The push modifier alone does not cover that path; this gate does.
   */
  mutatorRole?: CollaborationRole;
  /** Recheck Drive ownership before writing shared content deletion records. */
  resolveDeletionRole?: (projectId: string) => Promise<CollaborationRole>;
  /**
   * Protocol-2 mutation security. The collaboration manager installs a verifier
   * for a shared project when it starts secured pools; every persistence path
   * for that project's documents then requires valid signed provenance.
   */
  installMutationGuard?: (projectId: string) => Promise<MutationGuardInstall | null>;
  removeMutationGuard?: (projectId: string) => Promise<void>;
} = {}) {
  const db: RxDatabase<RxCollections> = await createRxDatabase<RxCollections>({
    name: options.name ?? "pboardlocalv1",
    storage: options.storage ?? getRxStorageDexie(),
    multiInstance: true
  });
  await db.addCollections({
    projects: {
      schema: projectSchema,
      // v0 → v1 adds the optional `_sec` mutation-provenance field; existing
      // documents pass through unchanged (the field is simply absent).
      migrationStrategies: { 1: (doc: Record<string, unknown>) => doc },
      conflictHandler: {
        isEqual: defaultConflictHandler.isEqual,
        async resolve(input) { return lastWriteWins(input); }
      }
    },
    cards: {
      schema: cardSchema,
      migrationStrategies: { 1: (doc: Record<string, unknown>) => doc },
      conflictHandler: {
        isEqual: defaultConflictHandler.isEqual,
        async resolve(input) { return lastWriteWins(input); }
      }
    },
    settings: {
      schema: settingSchema,
      conflictHandler: {
        isEqual: defaultConflictHandler.isEqual,
        async resolve(input) {
          const master = input.realMasterState;
          const incoming = input.newDocumentState;
          if (master.id.startsWith("projectOrder:") && !master._deleted && !incoming._deleted) {
            return { ...master, value: JSON.stringify(mergeProjectOrder(parseProjectOrder(master.value), parseProjectOrder(incoming.value))) };
          }
          return master;
        }
      }
    }
  });
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
  /**
   * Per-project collaboration write-gate. Set by the collaboration manager when
   * it starts a shared project: "viewer" means the caller has read-only Drive
   * access. The gate rejects per-project content mutations for viewers so no
   * local write can exist to be replicated. WebRTC picks master/slave by token
   * hash, not role, and the master streams its change log unconditionally — so
   * a viewer that is the master would otherwise leak its local writes to peers.
   * The replication push modifier only covers the slave→master path; this gate
   * is the authoritative enforcement the spec requires.
   */
  const mutatorRoles = new Map<string, CollaborationRole>();
  function setMutatorRole(projectId: string, role: CollaborationRole | null) {
    if (role === null) mutatorRoles.delete(projectId);
    else mutatorRoles.set(projectId, role);
  }
  function assertCanMutate(projectId: string) {
    if ((mutatorRoles.get(projectId) ?? options.mutatorRole) === "viewer") {
      throw new Error("You have view-only access to this shared project");
    }
  }
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
    const deleted = await deletedProjectIds();
    return (await projects.find().exec()).map((doc) => doc.toJSON()).filter((doc) => !deleted.includes(doc.id)).sort(compareOrdered);
  }
  let projectOrderAccount: string | null = null;
  const localOrderId = "localProjectOrder";
  const accountOrderId = (account: string) => `projectOrder:${account}`;
  async function deletedProjectIds(): Promise<string[]> {
    let preference = projectOrderAccount ? await settings.findOne(accountOrderId(projectOrderAccount)).exec() : null;
    if (!preference) {
      const source = await settings.findOne("localProjectOrderAccount").exec();
      if (projectOrderAccount && source && source.value !== projectOrderAccount) return [];
      preference = await settings.findOne(localOrderId).exec();
    }
    return preference ? parseProjectOrder(preference.value).deletedProjectIds ?? [] : [];
  }
  async function isDeletedProject(projectId: string): Promise<boolean> {
    return (await deletedProjectIds()).includes(projectId);
  }
  async function orderedProjects() {
    const records = await allProjectRecords();
    const preference = (projectOrderAccount ? await settings.findOne(accountOrderId(projectOrderAccount)).exec() : null)
      ?? await settings.findOne(localOrderId).exec();
    if (!preference) return records;
    const ids = parseProjectOrder(preference.value).ids;
    const ranks = new Map(ids.map((id, index) => [id, index]));
    return records.sort((a, b) => (ranks.get(a.id) ?? ids.length) - (ranks.get(b.id) ?? ids.length));
  }
  async function setProjectOrderAccount(account: string | null) {
    const preference = (projectOrderAccount ? await settings.findOne(accountOrderId(projectOrderAccount)).exec() : null)
      ?? await settings.findOne(localOrderId).exec();
    const value = preference?.value ?? JSON.stringify((await orderedProjects()).map((record) => record.id));
    if (projectOrderAccount) await settings.upsert({ id: "localProjectOrderAccount", value: projectOrderAccount });
    projectOrderAccount = account;
    // Preserve local ordering before shared project documents can arrive, and
    // retain the last visible order when disconnecting or changing accounts.
    await settings.upsert({ id: localOrderId, value });
  }
  async function getProjectOrder(account: string): Promise<ProjectOrderPreference | null> {
    const preference = await settings.findOne(accountOrderId(account)).exec();
    return preference ? parseProjectOrder(preference.value) : null;
  }
  async function applyProjectOrder(account: string, preference: ProjectOrderPreference) {
    return locked(async () => {
      // Keep ids for boards not imported yet; they receive their saved rank as
      // soon as discovery/reconciliation adds them to the local repository.
      const id = accountOrderId(account);
      const doc = await settings.findOne(id).exec();
      if (!doc) {
        await settings.upsert({ id, value: JSON.stringify(preference) });
        return;
      }
      await doc.incrementalModify((current) => ({ ...current,
        value: JSON.stringify(mergeProjectOrder(parseProjectOrder(current.value), preference)) }));
    });
  }
  async function projectCardRecords(projectId: string, includeDeleted = false) {
    const records = (await cards.find({ selector: { projectId }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] }).exec()).map((doc) => doc.toJSON()).sort(compareOrdered);
    return includeDeleted ? records : records.filter(isVisible);
  }
  async function listProjects(): Promise<Project[]> { return (await orderedProjects()).map(projectValue); }
  async function getProject(id: string): Promise<Project | null> {
    if (await isDeletedProject(id)) return null;
    const doc = await projects.findOne(id).exec();
    return doc ? projectValue(doc.toJSON()) : null;
  }
  async function getCurrentProject(): Promise<Project | null> {
    const setting = await settings.findOne("currentProjectId").exec();
    if (!setting?.value) return null;
    return await getProject(setting.value) ?? (await listProjects())[0] ?? null;
  }
  async function listCards(projectId: string): Promise<BoardItem[]> {
    if (await isDeletedProject(projectId)) return [];
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
    if (!image) throw new Error(`Image data is missing for card ${card.id}; wait for image sync before exporting`);
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
  async function importImages(projectId: string, items: BoardItem[]): Promise<void> {
    for (const item of items) {
      if (item.projectId !== projectId || !item.image?.dataUrl.startsWith("data:image/")) continue;
      const doc = await cards.findOne(item.id).exec();
      if (!doc || doc.projectId !== projectId || !doc.imageId || await blobs.hasBlob(doc.imageId)) continue;
      const blob = await imageToBlob(item.image.dataUrl);
      if (await hashBlob(blob) === doc.imageId) await blobs.putBlob(blob, item.image);
    }
  }
  async function deleteImage(imageId: string): Promise<void> {
    // Tombstoned cards retain references for rollback and future replication.
    if ((await cards.find().exec()).some((doc) => doc.imageId === imageId)) throw new Error("Image is still referenced by a card");
    await blobs.deleteBlob(imageId);
  }
  async function importProject(project: Project, items: BoardItem[], preserveOrderKey?: string) {
    if (await isDeletedProject(project.id)) return;
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
  /** Read-only Drive recovery: merge documents without replacing the board. */
  async function mergeSharedSnapshot(project: Project, items: BoardItem[], canApply: () => Promise<boolean>) {
    if (items.some(item => item.projectId !== project.id)) throw new Error("Shared snapshot belongs to a different project");
    return locked(async () => {
      const active = async () => await canApply() && !await isDeletedProject(project.id) && Boolean(await getProject(project.id));
      if (!await active()) return;
      const existing = await projectCardRecords(project.id, true);
      let tail = existing.at(-1)?.orderKey ?? null;
      for (const item of [...items].sort((a, b) => a.order - b.order)) {
        if (!await active()) return;
        const { order: _, image, imageId: savedImageId, imageMimeType, imageWidth, imageHeight, ...fields } = item;
        const imageId = image ? await putImage(image) : savedImageId;
        if (!await active()) return;
        let doc = await cards.findOne(item.id).exec();
        // A v1 snapshot contains no deletion history. Absence cannot prove a
        // remote deletion, and an old backup must never resurrect a tombstone.
        if (doc && (doc.projectId !== project.id || doc.deletedAt)) continue;
        const record: CardRecord = { ...fields,
          displayMode: normalizeCardDisplayMode(item.displayMode),
          orderKey: doc?.orderKey ?? orderKeyBetween(tail, null),
          imageId, imageMimeType: image?.mimeType ?? imageMimeType,
          imageWidth: image?.width ?? imageWidth, imageHeight: image?.height ?? imageHeight };
        if (!doc) {
          try {
            await cards.insert(record);
            tail = record.orderKey;
            continue;
          } catch (error) {
            // WebRTC can insert the same card while image bytes are restored.
            doc = await cards.findOne(item.id).exec();
            if (!doc) throw error;
          }
        }
        if (Date.parse(doc.updatedAt) >= Date.parse(record.updatedAt)) continue;
        await doc.incrementalModify(current => {
          if (current.projectId !== project.id || current.deletedAt || Date.parse(current.updatedAt) >= Date.parse(record.updatedAt)) return current;
          // Retain live fractional ordering: the Drive v1 export only has ranks.
          const merged = { ...current, ...record, orderKey: current.orderKey };
          if (record.title === undefined) delete merged.title;
          if (record.source === undefined) delete merged.source;
          return merged;
        });
      }
      if (!await active()) return;
      const doc = await projects.findOne(project.id).exec();
      if (!doc || Date.parse(doc.updatedAt) >= Date.parse(project.updatedAt)) return;
      await doc.incrementalModify(current => {
        if (Date.parse(current.updatedAt) >= Date.parse(project.updatedAt)) return current;
        return { ...current, ...project, orderKey: current.orderKey, tailOrderKey: tail && (!current.tailOrderKey || tail > current.tailOrderKey) ? tail : current.tailOrderKey };
      });
    });
  }

  async function importState(state: AppState) {
    const incomingProjectIds = new Set(state.projects.map((project) => project.id));
    for (const project of await allProjectRecords()) if (!incomingProjectIds.has(project.id)) await removeProject(project.id);
    const projectKeys = initialOrderKeys(state.projects.length);
    for (const [index, project] of state.projects.entries()) {
      await importProject(project, state.boardItems.filter((item) => item.projectId === project.id), projectKeys[index]);
    }
    await settings.upsert({ id: projectOrderAccount ? accountOrderId(projectOrderAccount) : localOrderId,
      value: JSON.stringify(state.projects.map((project) => project.id)) });
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
    const id = projectOrderAccount ? accountOrderId(projectOrderAccount) : localOrderId;
    const existing = await settings.findOne(id).exec();
    const previous = existing ? Date.parse(parseProjectOrder(existing.value).updatedAt) : 0;
    const updatedAt = new Date(Math.max(Date.parse(now()), previous + 1)).toISOString();
    const deletedProjectIds = existing ? parseProjectOrder(existing.value).deletedProjectIds : undefined;
    await settings.upsert({ id, value: JSON.stringify({ ids: orderedIds, updatedAt,
      ...(deletedProjectIds ? { deletedProjectIds } : {}) }) });
  }); }
  async function renameProject(projectId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    const doc = await projects.findOne(projectId).exec();
    if (!doc) throw new Error("Project not found");
    assertCanMutate(projectId);
    if (doc.name === trimmed) return;
    await doc.incrementalPatch({ name: trimmed });
    await touchProject(projectId);
    await changed(projectId);
  }
  async function deleteProject(projectId: string) {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) return;
    // Commit the account-visible removal first so the board disappears without
    // waiting for Drive ownership verification or the per-card tombstone pass.
    await locked(async () => {
      const id = projectOrderAccount ? accountOrderId(projectOrderAccount) : localOrderId;
      const preference = await settings.findOne(id).exec();
      const previous = preference ? parseProjectOrder(preference.value)
        : { ids: (await listProjects()).map((project) => project.id), updatedAt: "1970-01-01T00:00:00.000Z" };
      await settings.upsert({ id, value: JSON.stringify({
        ids: previous.ids.filter((id) => id !== projectId),
        updatedAt: new Date(Math.max(Date.parse(now()), Date.parse(previous.updatedAt) + 1)).toISOString(),
        deletedProjectIds: [...new Set([...(previous.deletedProjectIds ?? []), projectId])].sort()
      }) });
      if ((await getCurrentProject())?.id === projectId || (await settings.findOne("currentProjectId").exec())?.value === projectId) {
        await settings.upsert({ id: "currentProjectId", value: (await listProjects())[0]?.id ?? "" });
      }
    });
    const role = options.resolveDeletionRole ? await options.resolveDeletionRole(projectId)
      : mutatorRoles.get(projectId) ?? options.mutatorRole ?? "owner";
    // Shared collections replicate to every collaborator. Non-owners may only
    // hide the board through their own account preference, never delete content.
    if (role === "owner") {
      await events.projectDeleting?.(projectValue(doc.toJSON()));
      await locked(async () => {
        for (const card of await projectCardRecords(projectId)) {
          await (await cards.findOne(card.id).exec())?.incrementalPatch({ deletedAt: now() });
        }
        await doc.remove();
      });
    }
    // Preference sync can itself queue repository writes. Release the mutation
    // lock before notifying listeners so removing a board cannot deadlock sync.
    if (role === "owner") await events.projectDeleted?.(projectId);
    else if (role) await events.projectHidden?.(projectId);
  }
  async function changeProjectTemplate(projectId: string, template: BoardTemplate): Promise<number> { return locked(async () => {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) throw new Error("Project not found");
    assertCanMutate(projectId);
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
    assertCanMutate(input.projectId);
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
    assertCanMutate(doc.projectId);
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
    assertCanMutate(doc.projectId);
    await doc.incrementalPatch({ deletedAt: now() });
    await touchProject(doc.projectId);
    await changed(doc.projectId);
  }); }
  async function emptyTrash(projectId: string): Promise<number> { return locked(async () => {
    assertCanMutate(projectId);
    const trash = (await projectCardRecords(projectId)).filter((item) => item.status === "trash");
    for (const item of trash) await (await cards.findOne(item.id).exec())?.incrementalPatch({ deletedAt: now() });
    if (trash.length) { await touchProject(projectId); await changed(projectId); }
    return trash.length;
  }); }
  async function duplicateItem(itemId: string): Promise<BoardItem> { return locked(async () => {
    const source = await cards.findOne(itemId).exec();
    if (!source || source.deletedAt) throw new Error("Card not found");
    assertCanMutate(source.projectId);
    const ordered = await projectCardRecords(source.projectId);
    const index = ordered.findIndex((item) => item.id === itemId);
    const timestamp = now();
    // The duplicate is a new local mutation; stale provenance from the source
    // (wrong documentId, wrong payload hash) must not be inherited.
    const { _sec: staleProvenance, ...sourceRecord } = source.toJSON();
    const record: CardRecord = { ...sourceRecord, id: newId(), status: "candidate",
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
    assertCanMutate(source.projectId);
    if (source.imageId) throw new Error("Image cards cannot be merged without losing the image");
    const appended = [source.title?.trim(), source.content.trim()].filter(Boolean).join("\n");
    const timestamp = now();
    await target.incrementalPatch({ content: [target.content.trimEnd(), appended].filter(Boolean).join("\n\n"), updatedAt: timestamp });
    await source.incrementalPatch({ deletedAt: timestamp });
    await touchProject(source.projectId, timestamp);
    await changed(source.projectId);
  }); }
  async function reorderItems(projectId: string, orderedIds: string[]) { return locked(async () => {
    assertCanMutate(projectId);
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
    assertCanMutate(projectId);
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
    assertCanMutate(projectId);
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
  const subscribeProjects = (listener: (value: Project[]) => void) => {
    const stopProjects = subscribe(projects.find(), listProjects, listener);
    const stopSettings = subscribe(settings.find(), listProjects, listener);
    return () => { stopProjects(); stopSettings(); };
  };
  const subscribeCurrentProject = (listener: (value: Project | null) => void) => {
    const emit = () => { void getCurrentProject().then(listener); };
    const first = settings.find().$.subscribe(emit);
    const second = projects.find().$.subscribe(emit);
    emit();
    return () => { first.unsubscribe(); second.unsubscribe(); };
  };
  const subscribeCards = (projectId: string, listener: (value: BoardItem[]) => void) =>
    subscribe(cards.find({ selector: { projectId }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] }), () => listCards(projectId), listener);
  const subscribeCard = (id: string, listener: (value: BoardItem | null) => void) => subscribe(cards.findOne(id), () => getCard(id), listener);
  async function load(): Promise<AppState> { return exportAll(); } // Compatibility for old command callers; not a reactive read path.
  return { db, blobs, load, exportAll, exportProject, importProject, mergeSharedSnapshot, importState, removeProject, migrationComplete, markMigrationComplete, markMigrationIncomplete, setMutatorRole,
    createProject, selectProject, reorderProjects, setProjectOrderAccount, getProjectOrder, applyProjectOrder, isDeletedProject, renameProject, deleteProject, changeProjectTemplate,
    addItem, updateItem, deleteItem, duplicateItem, emptyTrash, mergeItems, reorderItems, moveItem, rebalanceProject,
    getCurrentProject, getProject, listProjects, listCards, listCardsByStatus, getCard,
    subscribeProjects, subscribeCurrentProject, subscribeCards, subscribeCard,
    putImage, getImage: blobs.getBlob, hasImage: blobs.hasBlob, imageAvailability: blobs.imageAvailability, deleteImage,
    subscribeImages: blobs.subscribe, importImages };
}

export type RxRepository = Awaited<ReturnType<typeof createRxRepository>>;
