import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { draftCommand, pendingHeads, pendingValue, validatePending } from "./pendingWork";
import { liveBoardRole, liveBoardEntitlement, registerAuthorizationJournal, recordLiveBoardAdmission, installLiveBoardMutations } from "../collab/security/liveMutations";
import { canonicalize } from "../collab/security/canonical";
import { documentValue, makeChange, scope, type PendingEdit } from "./changeJournal";
import { admitPendingEdit, portableJournalChanges, certifyLocalHistory, verifyPendingAdmission } from "../collab/security/journalProof";
import { reconcile, validateRecord } from "./causalReconciliation";
import { withUntrustedImport } from "../collab/security/liveMutations";
import { createRxDatabase, defaultConflictHandler, type DeepReadonly, type RxStorage, type RxCollection, type RxDatabase, type WithDeleted } from "rxdb";
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
import { ChangeJournal } from "./changeJournal";
import { createRevision } from 'rxdb/plugins/utils';
import { installJournalStorage, recoverJournal } from "./journalStorage";
import { withJournalMaterialization } from "./journalMaterialization";
import { createCausalReconciliation } from "./causalReconciliation";
import { createConflictResolution } from "./conflictResolution";
import { createPrivateRecovery } from "./privateRecovery";

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
  /** Internal pure-command scratchpad; never exposed to a remote provider. */
  pendingScratch?: boolean;
  blobs?: BlobStore;
  events?: RepositoryEvents;
  storage?: RxStorage<any, any>;
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
  let activeJournal: ChangeJournal | undefined;
  async function causalWinner<T extends CardRecord | ProjectRecord>(collection: "cards" | "projects", input: ConflictInput<T>): Promise<WithDeleted<T>> {
    const boardId = collection === "cards" ? (input.newDocumentState as CardRecord).projectId : input.newDocumentState.id;
    if (activeJournal && liveBoardRole(db[collection], boardId)) {
      const changes = (await activeJournal.entries.where("[collection+documentId]").equals([collection, input.newDocumentState.id]).toArray())
        .filter(e => e.state === "committed" && e.boardId === boardId);
      const matches = (value: unknown) => changes.find(e => canonicalize(e.value) === canonicalize(documentValue(value as Record<string, unknown>)));
      // No inferred ancestry for an unknown legacy payload: its normal guarded
      // observation must be retained first. Proven causal heads outrank clocks.
      if (matches(input.newDocumentState) && matches(input.realMasterState) && changes.some(change => change.proof)) {
        const result = reconcile(changes);
        if ((result.kind === "current" || result.kind === "deleted") && result.variants.length) return result.variants[0].value as unknown as WithDeleted<T>;
      }
    }
    return lastWriteWins(input);
  }
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
        async resolve(input) { return causalWinner("projects", input); }
      }
    },
    cards: {
      schema: cardSchema,
      migrationStrategies: { 1: (doc: Record<string, unknown>) => doc },
      conflictHandler: {
        isEqual: defaultConflictHandler.isEqual,
        async resolve(input) { return causalWinner("cards", input); }
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
  const journal = new ChangeJournal(db.name);
  activeJournal = journal;
  try {
    await journal.open();
    await recoverJournal(journal, { projects, cards });
    registerAuthorizationJournal(cards, journal); registerAuthorizationJournal(projects, journal);
    installJournalStorage(projects, "projects", journal);
    installJournalStorage(cards, "cards", journal);
  } catch (error) {
    journal.close();
    await db.close();
    throw error;
  }
  const permissionWrites = new Map<string, Promise<void>>();
  db.onClose.push(async () => { await Promise.all(permissionWrites.values()); journal.close(); });
  const reconciliation = createCausalReconciliation(journal);
  const blobs = options.blobs ?? createIndexedDbBlobStore();
  const events = options.events ?? {};
  let queue: Promise<unknown> = Promise.resolve();
  function locked<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation);
    queue = run.catch(() => undefined);
    return run;
  }
  async function installBoardSecurity(options: { security: import('../collab/manager').CollaborationSecurityOptions; attestExisting?: boolean; preserveSignedData?: boolean }) {
    const install = await locked(() => installLiveBoardMutations({ ...options,
      projectId: options.security.boardId, cards, projects }));
    return { projectId: install.projectId, uninstall: () => locked(() => install.uninstall()) };
  }
  async function changed(projectId: string) { await events.projectChanged?.(projectId); }
  // Local-only permissions survive logout/restart; they never confer remote admission.
  function setMutatorRole(projectId: string, role: CollaborationRole | null) {
    if (role === null || role === "private") return Promise.resolve();
    const write = (permissionWrites.get(projectId) ?? Promise.resolve()).then(async () => {
      const previous = await journal.permissions.get(projectId);
      await journal.permissions.put({ ...previous, id: projectId, role });
    });
    permissionWrites.set(projectId, write);
    return write;
  }
  async function assertCanMutate(projectId: string, allowPending = false) {
    if (await journal.boardErasure(projectId)) throw new Error('This board was permanently deleted.');
    await permissionWrites.get(projectId);
    const permission = await journal.permissions.get(projectId);
    const observed = liveBoardEntitlement(cards, projectId);
    if (observed === 'revoked' && permission) await journal.permissions.update(projectId, { role: 'revoked' });
    if (observed === 'viewer' && permission?.role !== 'viewer') await journal.permissions.update(projectId, { role: 'viewer' });
    if (observed === 'revoked' || permission?.role === "revoked") throw new Error("Board editing permission was removed; pending work remains available for export");
    if (observed === "viewer" || liveBoardRole(cards, projectId) === "viewer" || (permission?.role ?? options.mutatorRole) === "viewer") throw new Error("You have view-only access to this shared project");
    const signed = permission?.authorityKeyId || (await projects.findOne(projectId).exec())?._sec
      || (await journal.entries.where("boardId").equals(projectId).toArray()).some(e => !!e.value._sec)
      || (await journal.pendingEdits.toArray()).some(e => e.boardId === projectId);
    if (signed && !liveBoardRole(cards, projectId) && !(allowPending && permission?.deviceKeyId && permission.role !== "viewer")) {
      throw new Error("Current board authorization is required; cached content remains readable and exportable");
    }
  }
  async function pendingFor(documentId: string): Promise<PendingEdit[]> {
    const edits = (await journal.pendingEdits.toArray()).filter(e => e.base.documentId === documentId);
    const superseded = new Set(edits.flatMap(e => e.supersedes ?? []));
    return edits.filter(e => !e.admittedChangeId && !superseded.has(e.id));
  }
  async function localCard(record: DeepReadonly<CardRecord>): Promise<CardRecord> {
    const pending = await pendingFor(record.id);
    // Parallel drafts are retained for explicit review, never selected by clocks.
    return pending.length === 1 ? pending[0].value as unknown as CardRecord : record as CardRecord;
  }
  async function admitPendingWork(boardId: string) {
    const admitted = await locked(async () => {
      await assertCanMutate(boardId);
      const edits = (await journal.pendingEdits.toArray()).filter(e => e.boardId === boardId);
      // An immutable private archive may predate a later signed admission.
      // Recover its receipt from verified history, never from backup flags or
      // device identity alone. This also works after loss of the original key.
      const history = edits.some(edit => !edit.admittedChangeId) ? await journal.entries.where('boardId').equals(boardId).toArray() : [];
      for (const edit of edits) if (!edit.admittedChangeId) {
        const candidates = history.filter(entry => (entry.value._sec as any)?.provenance?.operationId === `pending:${edit.id}`);
        for (const entry of candidates) {
          try { await verifyPendingAdmission(db[edit.base.collection], edit, entry); }
          catch { continue; } // Keep unverified/changed drafts for explicit review.
          edit.admittedChangeId = entry.id;
          await journal.pendingEdits.update(edit.id, { admittedChangeId: entry.id });
          break;
        }
      }
      const superseded = new Set(edits.flatMap(e => e.supersedes ?? []));
      const permission = await journal.permissions.get(boardId);
      const heads = edits.filter(e => !e.admittedChangeId && !superseded.has(e.id) && e.deviceKeyId === permission?.deviceKeyId && e.authorityKeyId === permission.authorityKeyId);
      const batch: import('./changeJournal').JournalEntry[] = [];
      const admittedEdits: { edit: PendingEdit; changeId: string }[] = [];
      for (const edit of heads) {
        const collection = db[edit.base.collection];
        const old = history.find(e => (e.value._sec as any)?.provenance?.operationId === `pending:${edit.id}`);
        if (old && ((old.value._sec as any)?.provenance?.authorKeyId !== edit.deviceKeyId || old.documentId !== edit.base.documentId
          || canonicalize(pendingValue(old.value)) !== canonicalize(pendingValue(edit.value)))) throw new Error('Pending operation identity conflicts with retained history');
        if (old) await verifyPendingAdmission(collection, edit, old);
        const entry = old ?? await admitPendingEdit(collection, edit);
        if (!edit.creation && !await journal.entries.get(edit.base.id)) batch.push({ ...edit.base, state: 'committed', origin: 'baseline' });
        validateRecord(entry); await recordLiveBoardAdmission(collection, boardId, entry.value);
        if (!entry.admission) entry.admission = await certifyLocalHistory(collection, entry);
        batch.push(entry); admittedEdits.push({ edit, changeId: entry.id });
      }
      if (batch.length) {
        await assertCanMutate(boardId);
        if (!liveBoardRole(cards, boardId)) throw new Error('Current board authorization expired before pending admission');
        await changed(boardId);
        await journal.accept(batch); // Entire structural command becomes durable together.
        for (const { edit, changeId } of admittedEdits) {
          await journal.pendingEdits.update(edit.id, { admittedChangeId: changeId });
          for (const id of edit.supersedes ?? []) await journal.pendingEdits.update(id, { admittedChangeId: changeId });
        }
      }
      return heads.length > 0 || edits.some(edit => edit.admittedChangeId && !edit.projected);
    });
    if (!admitted) return;
    await privateRecovery.apply(boardId, async () => !!liveBoardRole(cards, boardId));
    await locked(async () => {
      await assertCanMutate(boardId);
      await touchProject(boardId);
      for (const edit of await journal.pendingEdits.toArray()) if (edit.boardId === boardId && edit.admittedChangeId && !edit.projected) {
        await journal.pendingEdits.update(edit.id, { projected: true });
      }
    });
    await changed(boardId);
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
  async function overlay(name: 'cards' | 'projects', records: Record<string, any>[], boardId?: string) {
    const byId = new Map(records.map(row => [String(row.id), row]));
    const edits = pendingHeads((await journal.pendingEdits.toArray()).filter(e => e.base.collection === name && (!boardId || e.boardId === boardId)));
    const counts = new Map<string, number>(); for (const edit of edits) counts.set(edit.base.documentId, (counts.get(edit.base.documentId) ?? 0) + 1);
    for (const edit of edits) if (counts.get(edit.base.documentId) === 1) byId.set(edit.base.documentId, edit.value);
    return [...byId.values()].filter(row => !row._deleted).sort((a, b) => compareOrdered(a as { id: string; orderKey: string }, b as { id: string; orderKey: string }));
  }
  async function allProjectRecords() {
    const deleted = await deletedProjectIds();
    const erased = new Set((await journal.boardErasures()).map(entry => entry.boardId));
    return (await overlay("projects", (await projects.find().exec()).map(doc => doc.toJSON()))).filter(doc => !deleted.includes(doc.id) && !erased.has(doc.id)) as ProjectRecord[];
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
    return !!await journal.boardErasure(projectId) || (await deletedProjectIds()).includes(projectId);
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
  async function projectCardRecords(projectId: string, includeDeleted = false, includePending = true) {
    if (await journal.boardErasure(projectId)) return [];
    const raw = (await cards.find({ selector: { projectId }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] }).exec()).map(doc => doc.toJSON());
    const records = (includePending ? await overlay("cards", raw, projectId) : raw.sort(compareOrdered)) as CardRecord[];
    return includeDeleted ? records : records.filter(isVisible);
  }
  async function listProjects(): Promise<Project[]> { return (await orderedProjects()).map(projectValue); }
  async function getProject(id: string, includePending = true): Promise<Project | null> {
    if (await isDeletedProject(id)) return null;
    const doc = await projects.findOne(id).exec();
    const value = includePending ? (await overlay("projects", doc ? [doc.toJSON()] : [], id))[0] : doc?.toJSON();
    return value ? projectValue(value as ProjectRecord) : null;
  }
  async function getCurrentProject(): Promise<Project | null> {
    const setting = await settings.findOne("currentProjectId").exec();
    if (!setting?.value) return null;
    return await getProject(setting.value) ?? (await listProjects())[0] ?? null;
  }
  async function listCards(projectId: string, includePending = true): Promise<BoardItem[]> {
    if (await isDeletedProject(projectId)) return [];
    return (await projectCardRecords(projectId, false, includePending)).map(cardValue);
  }
  async function listCardsByStatus(projectId: string, status: BoardItemStatus): Promise<BoardItem[]> {
    return (await listCards(projectId)).filter(card => card.status === status);
  }
  async function getCard(id: string): Promise<BoardItem | null> {
    const doc = await cards.findOne(id).exec();
    const pending = await pendingFor(id);
    const boardId = doc?.projectId ?? pending[0]?.boardId;
    if (!boardId) return null;
    const records = await projectCardRecords(boardId);
    const index = records.findIndex(card => card.id === id);
    return index >= 0 ? cardValue(records[index], index) : null;
  }
  async function hydrateCard(card: BoardItem): Promise<BoardItem> {
    if (!card.imageId) return card;
    const image = await blobs.getBlob(card.imageId);
    if (!image) throw new Error(`Image data is missing for card ${card.id}; wait for image sync before exporting`);
    return { ...card, image: { dataUrl: await blobToDataUrl(image.blob), mimeType: image.mimeType, width: image.width, height: image.height } };
  }
  async function exportProject(projectId: string, includePending = true): Promise<{ project: Project; items: BoardItem[] }> {
    const project = await getProject(projectId, includePending);
    if (!project) throw new Error("Project not found");
    const items = await Promise.all((includePending ? await listCards(projectId) : (await projectCardRecords(projectId, false, false)).map(cardValue)).map(hydrateCard));
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
    if ((await journal.pendingEdits.toArray()).some(e => e.value.imageId === imageId || e.base.value.imageId === imageId)) return;
    // Tombstoned cards retain references for rollback and future replication.
    if ((await cards.find().exec()).some((doc) => doc.imageId === imageId)) throw new Error("Image is still referenced by a card");
    if ((await journal.entries.toArray()).some(entry => entry.value.imageId === imageId)) {
      throw new Error("Image is still referenced by local change history");
    }
    await blobs.deleteBlob(imageId);
  }
  async function importProject(project: Project, items: BoardItem[], preserveOrderKey?: string) {
    return locked(() => withUntrustedImport([cards, projects], () => importProjectData(project, items, preserveOrderKey)));
  }
  async function importProjectData(project: Project, items: BoardItem[], preserveOrderKey?: string) {
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
    return locked(() => withUntrustedImport([cards, projects], async () => {
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
    }));
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
    await settings.upsert({ id, value: JSON.stringify({ ...(existing ? parseProjectOrder(existing.value) : {}), ids: orderedIds, updatedAt,
      ...(deletedProjectIds ? { deletedProjectIds } : {}) }) });
  }); }
  async function renameProject(projectId: string, name: string) { return locked(async () => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    const doc = await projects.findOne(projectId).exec();
    if (!doc) throw new Error("Project not found");
    await assertCanMutate(projectId);
    if (doc.name === trimmed) return;
    await doc.incrementalPatch({ name: trimmed });
    await touchProject(projectId);
    await changed(projectId);
  }); }
  async function deleteProject(projectId: string) {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) return;
    await permissionWrites.get(projectId);
    const permission = await journal.permissions.get(projectId);
    const signed = !!doc._sec || !!permission?.authorityKeyId;
    const hide = () => locked(async () => {
      const id = projectOrderAccount ? accountOrderId(projectOrderAccount) : localOrderId;
      const preference = await settings.findOne(id).exec();
      const previous = preference ? parseProjectOrder(preference.value)
        : { ids: (await listProjects()).map((project) => project.id), updatedAt: "1970-01-01T00:00:00.000Z" };
      await settings.upsert({ id, value: JSON.stringify({
        ...previous,
        ids: previous.ids.filter((id) => id !== projectId),
        updatedAt: new Date(Math.max(Date.parse(now()), Date.parse(previous.updatedAt) + 1,
          Date.parse(previous.restoreEvents?.[projectId] ?? '1970-01-01T00:00:00.000Z') + 1)).toISOString(),
        deletedProjectIds: [...new Set([...(previous.deletedProjectIds ?? []), projectId])].sort()
      }) });
      if ((await settings.findOne("currentProjectId").exec())?.value === projectId) {
        await settings.upsert({ id: "currentProjectId", value: (await listProjects())[0]?.id ?? "" });
      }
    });
    // Signed-board authority comes from its verified grant, never a Drive ACL.
    // Keep its handle visible until signed tombstones are durable: selection
    // changes stop the collaboration manager and uninstall the signing guard.
    if (!signed) await hide();
    const role = signed ? liveBoardRole(projects, projectId) ?? permission?.role
      : options.resolveDeletionRole ? await options.resolveDeletionRole(projectId) : permission?.role ?? options.mutatorRole ?? "owner";
    const canDeleteContent = role === "owner" && (!signed || liveBoardRole(projects, projectId) === "owner");
    // Non-owners remove only their account's list handle. Cached rows, images,
    // pending work and conflicts are retained independently of transport state.
    if (canDeleteContent) {
      await events.projectDeleting?.(projectValue(doc.toJSON()));
      await locked(async () => {
        for (const card of await projectCardRecords(projectId, false, false)) {
          await (await cards.findOne(card.id).exec())?.incrementalPatch({ deletedAt: now() });
        }
        await doc.remove();
      });
    }
    if (signed) await hide();
    // Preference sync can itself queue repository writes. Release the mutation
    // lock before notifying listeners so removing a board cannot deadlock sync.
    if (canDeleteContent) await events.projectDeleted?.(projectId);
    else await events.projectHidden?.(projectId);
  }
  async function changeProjectTemplate(projectId: string, template: BoardTemplate): Promise<number> { return locked(async () => {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) throw new Error("Project not found");
    await assertCanMutate(projectId);
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
    await assertCanMutate(input.projectId);
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
    await assertCanMutate(doc.projectId, true);
    const project = await getProject(doc.projectId);
    if (patch.type && project && !isTypeSupported(project.template, patch.type)) throw new Error("Card type is not supported by this board template");
    const permission = await journal.permissions.get(doc.projectId);
    if (permission?.authorityKeyId && (!liveBoardRole(cards, doc.projectId) || (await pendingFor(itemId)).length)) {
      const earlier = await pendingFor(itemId);
      if (earlier.length > 1) throw new Error("Parallel offline drafts need explicit review; all versions are retained");
      const base = earlier[0]?.base ?? await makeChange({ boardId: doc.projectId, collection: "cards", documentId: itemId,
        ancestry: "unknown", parents: [], value: documentValue(doc.toJSON(true)) });
      const candidates = await journal.entries.where("[collection+documentId]").equals(["cards", itemId]).toArray();
      const portable = portableJournalChanges(candidates);
      const matches = candidates.filter(e => portable.has(e.id))
        .filter(e => e.state === "committed" && canonicalize(e.value) === canonicalize(base.value));
      const value: import("./changeJournal").DocumentValue = { ...earlier[0]?.value ?? documentValue(doc.toJSON(true)), ...patch, updatedAt: now() };
      delete value._sec; // This is private pending work, never a remotely valid mutation.
      validateRecord({ ...base, value });
      await journal.pendingEdits.put({ id: newId(), boardId: doc.projectId, base: earlier[0]?.base ?? (matches.length === 1 ? matches[0] : base),
        value, deviceKeyId: permission.deviceKeyId!, authorityKeyId: permission.authorityKeyId, supersedes: earlier.map(e => e.id) });
      return;
    }
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
    await assertCanMutate(doc.projectId);
    await doc.incrementalPatch({ deletedAt: now() });
    await touchProject(doc.projectId);
    await changed(doc.projectId);
  }); }
  async function emptyTrash(projectId: string): Promise<number> { return locked(async () => {
    await assertCanMutate(projectId);
    const trash = (await projectCardRecords(projectId)).filter((item) => item.status === "trash");
    for (const item of trash) await (await cards.findOne(item.id).exec())?.incrementalPatch({ deletedAt: now() });
    if (trash.length) { await touchProject(projectId); await changed(projectId); }
    return trash.length;
  }); }
  async function duplicateItem(itemId: string): Promise<BoardItem> { return locked(async () => {
    const source = await cards.findOne(itemId).exec();
    if (!source || source.deletedAt) throw new Error("Card not found");
    await assertCanMutate(source.projectId);
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
    await assertCanMutate(source.projectId);
    if (source.imageId) throw new Error("Image cards cannot be merged without losing the image");
    const appended = [source.title?.trim(), source.content.trim()].filter(Boolean).join("\n");
    const timestamp = now();
    await target.incrementalPatch({ content: [target.content.trimEnd(), appended].filter(Boolean).join("\n\n"), updatedAt: timestamp });
    await source.incrementalPatch({ deletedAt: timestamp });
    await touchProject(source.projectId, timestamp);
    await changed(source.projectId);
  }); }
  async function reorderItems(projectId: string, orderedIds: string[]) { return locked(async () => {
    await assertCanMutate(projectId);
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
    await assertCanMutate(projectId);
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
    await assertCanMutate(projectId);
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
  /** Reverses only this account's list preference (D04). Cached content and retained conflict/pending evidence stay untouched. */
  async function unhideProject(projectId: string) {
    if (await journal.boardErasure(projectId)) throw new Error('This board was permanently deleted.');
    if (await getProject(projectId)) return; // Board already visible; nothing to restore.
    const doc = await projects.findOne(projectId).exec();
    const wasHidden = await isDeletedProject(projectId);
    if (!doc && !wasHidden) throw new Error("This board's cached copy is unavailable locally; its evidence remains exportable");
    await locked(async () => {
      const id = projectOrderAccount ? accountOrderId(projectOrderAccount) : localOrderId;
      const preference = await settings.findOne(id).exec();
      if (wasHidden && preference) {
        const parse = parseProjectOrder(preference.value);
        const next = { ...parse,
          ids: [...new Set([...parse.ids, projectId])],
          deletedProjectIds: (parse.deletedProjectIds ?? []).filter(id => id !== projectId),
          // Timestamped restore: preference merges keep it visible against older
          // deletion markers on any device, while newer deletions still win.
          restoreEvents: { ...(parse.restoreEvents ?? {}), [projectId]: new Date(Math.max(Date.now(), Date.parse(parse.updatedAt) + 1)).toISOString() },
          updatedAt: new Date(Math.max(Date.now(), Date.parse(parse.updatedAt) + 1)).toISOString() };
        await settings.upsert({ id, value: JSON.stringify(next) });
      }
    });
    // An owner-authorized removal removed the project document itself. Rebuild
    // the board row and cards from the latest non-deleted variant in the
    // retained history — the deletion tombstones stay in the journal as
    // evidence, but the explicit restore brings the pre-deletion state back.
    if (!doc) await locked(async () => {
      const entries = (await journal.entries.where("boardId").equals(projectId).toArray()).filter(e => e.state === "committed");
      const groups = new Map<string, typeof entries>();
      for (const entry of entries) { const id = scope(entry), group = groups.get(id); if (group) group.push(entry); else groups.set(id, [entry]); }
      const ordered = [...groups.values()].sort((a, b) => a[0].collection === b[0].collection ? a[0].documentId.localeCompare(b[0].documentId) : a[0].collection === "projects" ? -1 : 1);
      for (const changes of ordered) {
        const target = changes[0];
        const result = reconcile(changes);
        if (!["current", "deleted", "mergeable", "conflict"].includes(result.kind) || !result.variants.length) continue;
        // Latest variant that was not a deletion — including an ancestor the
        // tombstone replaced, since an explicit restore reverts the deletion.
        // Tombstone-only groups (nothing pre-deletion) stay pure evidence.
        const chosen = result.variants.find(c => c.value._deleted !== true && !c.value.deletedAt)
          ?? [...changes].filter(c => c.value._deleted !== true && !c.value.deletedAt)
            .sort((a, b) => String(b.value.updatedAt).localeCompare(String(a.value.updatedAt)))[0];
        if (!chosen) continue; // Tombstone-only groups stay pure evidence.
        const collection = target.collection === "projects" ? projects : cards;
        const storageRow = (await (collection as typeof projects).storageInstance.findDocumentsById([target.documentId], true))[0] as unknown as { _deleted?: boolean; deletedAt?: string } | undefined;
        const liveDoc = await (collection as typeof projects).findOne(target.documentId).exec();
        if (liveDoc) continue; // A live current document outranks retained variants.
        // A tombstone row blocks the same-document upsert; hard-delete it first.
        if (storageRow) {
          await withUntrustedImport([collection], () => withJournalMaterialization(collection as typeof projects, chosen.value as never,
            () => (collection as typeof projects).bulkRemove([target.documentId])));
        }
        await withUntrustedImport([collection], () => withJournalMaterialization(collection as typeof projects, chosen.value as never,
          () => (collection as typeof projects).upsert(chosen.value as never)));
      }
    });
    await changed(projectId);
  }
  function subscribe<T>(query: { $: { subscribe: (next: () => void) => { unsubscribe(): void } } }, read: () => Promise<T>, listener: (value: T) => void) {
    const { refresh, stop } = subscribeRead(read, listener);
    const sub = query.$.subscribe(refresh);
    const stopJournal = journal.subscribe(refresh);
    refresh();
    return () => { stop(); sub.unsubscribe(); stopJournal(); };
  }
  // A signed write emits several WAL notifications. Bound reads to one in
  // flight plus a trailing refresh, including bursts from another browser.
  function subscribeRead<T>(read: () => Promise<T>, listener: (value: T) => void) {
    let active = true, running = false, dirty = false;
    const refresh = () => {
      dirty = true;
      if (!active || running) return;
      running = true;
      void Promise.resolve().then(async () => {
        while (active && dirty) {
          dirty = false;
          try { const value = await read(); if (active && !dirty) listener(value); }
          catch { console.error('Local recovery view could not refresh; local data is retained.'); }
        }
      }).finally(() => { running = false; if (active && dirty) refresh(); });
    };
    return { refresh, stop: () => { active = false; } };
  }
  const subscribeProjects = (listener: (value: Project[]) => void) => {
    const { refresh, stop } = subscribeRead(listProjects, listener);
    const first = projects.find().$.subscribe(refresh);
    const second = settings.find().$.subscribe(refresh);
    const stopJournal = journal.subscribe(refresh); refresh();
    return () => { stop(); first.unsubscribe(); second.unsubscribe(); stopJournal(); };
  };
  const subscribeCurrentProject = (listener: (value: Project | null) => void) => {
    const { refresh, stop } = subscribeRead(getCurrentProject, listener);
    const first = settings.find().$.subscribe(refresh);
    const second = projects.find().$.subscribe(refresh);
    const stopJournal = journal.subscribe(refresh); refresh();
    return () => { stop(); first.unsubscribe(); second.unsubscribe(); stopJournal(); };
  };
  const subscribeCards = (projectId: string, listener: (value: BoardItem[]) => void) =>
    subscribe(cards.find({ selector: { projectId }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] }), () => listCards(projectId), listener);
  const subscribeCard = (id: string, listener: (value: BoardItem | null) => void) => subscribe(cards.findOne(id), () => getCard(id), listener);
  async function load(): Promise<AppState> { return exportAll(); } // Compatibility for old command callers; not a reactive read path.
  const conflicts = createConflictResolution({ journal, collections: { cards, projects }, assertCanMutate, isDeletedProject,
    listVisibleBoards: async () => (await listProjects()).map(project => project.id),
    changed, touchProject, hasImage: blobs.hasBlob, locked,
    canDraft: async boardId => { try { await assertCanMutate(boardId, true); return !!(await journal.permissions.get(boardId))?.authorityKeyId && !liveBoardRole(cards, boardId); } catch { return false; } } });
  const privateRecovery = createPrivateRecovery({ db, journal, blobs, locked });
  async function listPendingWork() {
    const heads = pendingHeads(await journal.pendingEdits.toArray());
    if (!heads.length) return [];
    // "No handle" check: a board the current account list does not show — removed
    // (hidden), hard-removed, or filtered by the active account scope — leaves its
    // work as retained evidence with a restore handle rather than as blocked work.
    const visible = new Set((await listProjects()).map(project => project.id));
    const boards = new Map<string, Promise<{ role: ReturnType<typeof liveBoardRole>; permission: Awaited<ReturnType<typeof journal.permissions.get>>; boardMissing: boolean; boardName: unknown }>>();
    for (const { boardId } of heads) if (!boards.has(boardId)) boards.set(boardId, (async () => {
      const permission = await journal.permissions.get(boardId);
      const role = liveBoardRole(cards, boardId);
      const boardMissing = !visible.has(boardId);
      const boardDoc = await projects.findOne(boardId).exec();
      const boardName = boardDoc?.name ?? (await journal.entries.where('boardId').equals(boardId).toArray()).find(e => e.collection === 'projects')?.value.name;
      return { permission, role, boardMissing, boardName };
    })());
    return Promise.all(heads.map(async edit => {
      const { permission, role, boardMissing, boardName } = await boards.get(edit.boardId)!;
      return { ...edit, boardMissing, boardName, canReview: !boardMissing && (role === 'owner' || role === 'editor'),
        reason: boardMissing ? 'This board was removed from this account’s list. Its work stays here; restore the board to review it.'
          : permission?.role === 'revoked' ? 'Access was removed. Export or make a private copy.' : permission?.role === 'viewer' ? 'View-only access. Work remains available for export.'
          : edit.deviceKeyId !== permission?.deviceKeyId ? 'Review this recovered draft as a new edit on this device.' : !role ? 'Waiting for current board authorization.' : 'Ready for authorized reconciliation.' };
    }));
  }
  async function reviewPendingWork(id: string, reviewedIds: string[]) {
    await locked(async () => {
      const selected = await journal.pendingEdits.get(id); if (!selected) throw new Error('Pending version is missing');
      await assertCanMutate(selected.boardId);
      const current = pendingHeads(await journal.pendingEdits.toArray()).filter(e => e.boardId === selected.boardId && e.base.collection === selected.base.collection && e.base.documentId === selected.base.documentId);
      if (canonicalize(current.map(e => e.id).sort()) !== canonicalize([...reviewedIds].sort()) || !current.some(e => e.id === id)) throw new Error('Pending versions changed; review them again');
      const permission = (await journal.permissions.get(selected.boardId))!;
      if (selected.base.collection === 'projects' && selected.value._deleted && permission.role !== 'owner') throw new Error('Only an owner may approve board deletion');
      await journal.pendingEdits.put({ ...selected, id: newId(), deviceKeyId: permission.deviceKeyId!, authorityKeyId: permission.authorityKeyId!, supersedes: current.map(e => e.id), admittedChangeId: undefined, projected: undefined });
      await changed(selected.boardId);
    });
    const edit = (await journal.pendingEdits.get(id))!; await admitPendingWork(edit.boardId);
  }
  async function discardRemovedBoardWork(boardId: string, reviewedIds: string[], privateAccount?: string) {
    const reviewed = [...reviewedIds];
    await locked(async () => {
      if ((await listProjects()).some(project => project.id === boardId)) throw new Error('Remove this board from the list before permanently deleting its retained work.');
      const retained = (await journal.pendingEdits.toArray()).filter(edit => edit.boardId === boardId);
      await eraseLocalBoardData(boardId, privateAccount, retained, reviewed);
    });
  }
  /** Account-private erasure, never an unsigned shared-board deletion. */
  async function eraseLocalBoardData(boardId: string, privateAccount?: string, retained: PendingEdit[] = [], reviewed?: string[]) {
    if ((await journal.boardErasure(boardId))?.localPurged) { await events.projectErased?.(boardId); return; }
    const history = await journal.entries.where('boardId').equals(boardId).toArray();
    const pending = [...retained, ...(await journal.pendingEdits.toArray()).filter(edit => edit.boardId === boardId)];
    const live = await cards.find({ selector: { projectId: boardId } }).exec();
    const values = [...history.map(entry => entry.value), ...pending.flatMap(edit => [edit.value, edit.base.value]), ...live.map(doc => doc.toJSON())];
    const bound = (await settings.findOne(`privateDrive:${await hashBlob(new Blob([boardId]))}`).exec())?.value;
    const details = { accountId: bound ?? privateAccount ?? null,
      imageIds: [...new Set(values.map(value => value.imageId).filter((id): id is string => typeof id === 'string'))],
      cardIds: [...new Set([...history.filter(entry => entry.collection === 'cards').map(entry => entry.documentId), ...live.map(doc => doc.id), ...pending.filter(edit => edit.base.collection === 'cards').map(edit => edit.base.documentId)])] };
    if (reviewed) await journal.discardPendingWork(boardId, reviewed, details);
    else await journal.beginBoardErasure(boardId, details.accountId, details.imageIds, details.cardIds);
    const marker = (await journal.boardErasure(boardId))!;
    for (const [collection, ids] of [[cards, marker.cardIds], [projects, [boardId]]] as const) {
      for (const previous of await collection.storageInstance.findDocumentsById([...ids], true)) {
        const timestamp = now();
        const value: any = { id: previous.id, orderKey: 'a0', createdAt: timestamp, updatedAt: timestamp,
          ...(collection === cards ? { projectId: boardId, type: 'note', content: '', status: 'candidate', displayMode: 'standard' }
            : { name: '', template: 'project', revision: 0 }),
          _deleted: true, _attachments: {}, _meta: { lwt: Date.now() }, _rev: createRevision(db.token, previous as any) };
        await withJournalMaterialization(collection, documentValue(value), async () => {
          const result = await (collection.storageInstance as any).bulkWrite([{ previous, document: value }], 'pboard-local-erasure');
          if (result.error.length) throw new Error('Local board erasure remains pending. Retry deletion.');
        });
      }
    }
    await journal.purgeBoardHistory(boardId);
    for (const imageId of marker.imageIds) {
      const referenced = (await journal.entries.toArray()).some(entry => entry.value.imageId === imageId)
        || (await journal.pendingEdits.toArray()).some(edit => edit.value.imageId === imageId || edit.base.value.imageId === imageId)
        || (await cards.find().exec()).some(doc => doc.imageId === imageId);
      if (!referenced) await blobs.deleteBlob(imageId);
    }
    await journal.receipts.update(marker.id, { localPurged: true } as any);
    await events.projectErased?.(boardId);
    if ((await settings.findOne('currentProjectId').exec())?.value === boardId) await settings.upsert({ id: 'currentProjectId', value: (await listProjects())[0]?.id ?? '' });
  }
  async function permanentlyDeleteBoard(boardId: string, privateAccount?: string) {
    await locked(async () => {
      const retained = (await journal.pendingEdits.toArray()).filter(edit => edit.boardId === boardId);
      await eraseLocalBoardData(boardId, privateAccount, retained, pendingHeads(retained).map(edit => edit.id));
    });
  }
  async function applyPrivateBoardErasure(boardId: string, accountId: string) {
    await locked(async () => {
      const bound = (await settings.findOne(`privateDrive:${await hashBlob(new Blob([boardId]))}`).exec())?.value;
      if (bound && bound !== accountId) throw new Error('Board erasure belongs to another private account');
      await eraseLocalBoardData(boardId, accountId);
    });
  }
  const api = { db, blobs, journal, reconciliation, privateRecovery, installBoardSecurity, admitPendingWork, listPendingWork, reviewPendingWork, discardRemovedBoardWork, permanentlyDeleteBoard, applyPrivateBoardErasure,
    subscribePendingWork(listener: (value: Awaited<ReturnType<typeof listPendingWork>>) => void) {
      const { refresh, stop } = subscribeRead(listPendingWork, listener);
      const unsubscribe = journal.subscribe(refresh); refresh();
      return () => { stop(); unsubscribe(); };
    },
    async exportPendingWork(boardId: string) { return { format: "pboard-pending-work-v1" as const, boardId,
      edits: (await journal.pendingEdits.toArray()).filter(e => e.boardId === boardId),
      images: await Promise.all([...new Set((await journal.pendingEdits.toArray()).filter(e => e.boardId === boardId).flatMap(e => [e.value.imageId, e.base.value.imageId]).filter((id): id is string => typeof id === 'string'))].map(async imageId => {
        const image = await blobs.getBlob(imageId); if (!image) throw new Error('A pending image is missing; the draft remains locally recoverable');
        return { ...image, imageId, blob: undefined, dataUrl: await blobToDataUrl(image.blob) };
      })) }; }, ...conflicts, load, exportAll, exportProject, importProject, mergeSharedSnapshot, importState, removeProject, migrationComplete, markMigrationComplete, markMigrationIncomplete, setMutatorRole,
    createProject, selectProject, reorderProjects, setProjectOrderAccount, getProjectOrder, applyProjectOrder, isDeletedProject, renameProject, deleteProject, changeProjectTemplate, unhideProject,
    addItem, updateItem, deleteItem, duplicateItem, emptyTrash, mergeItems, reorderItems, moveItem, rebalanceProject,
    getCurrentProject, getProject, listProjects, listCards, listCardsByStatus, getCard,
    subscribeProjects, subscribeCurrentProject, subscribeCards, subscribeCard,
    putImage, getImage: blobs.getBlob, hasImage: blobs.hasBlob, imageAvailability: blobs.imageAvailability, deleteImage,
    subscribeImages: blobs.subscribe, importImages };
  if (!options.pendingScratch) {
    const resolve = api.resolveConflict;
    api.resolveConflict = async request => {
      const permission = await journal.permissions.get(request.boardId);
      if (!permission?.authorityKeyId || liveBoardRole(cards, request.boardId)) return resolve(request);
      await assertCanMutate(request.boardId, true);
      await locked(async () => {
        const result = await reconciliation.inspect(request);
        if (!["conflict", "mergeable"].includes(result.kind) || canonicalize([...request.heads].sort()) !== canonicalize([...result.heads].sort()) || result.heads.length > 8) throw new Error('Conflict changed; review its current versions');
        if (pendingHeads(await journal.pendingEdits.toArray()).some(e => e.boardId === request.boardId && e.base.documentId === request.documentId)) throw new Error('Review existing pending versions before drafting another resolution');
        const selected = result.variants.find(e => e.id === request.variantId); if (!selected) throw new Error('Select a reviewed version');
        if (request.collection === 'projects' && result.variants.some(e => e.value._deleted) && permission.role !== 'owner') throw new Error('Only an owner may resolve board deletion');
        const value = pendingValue(selected.value);
        if (request.edits) Object.assign(value, request.edits);
        const edit: PendingEdit = { id: newId(), boardId: request.boardId, base: selected, value, deviceKeyId: permission.deviceKeyId!, authorityKeyId: permission.authorityKeyId!, parents: result.heads, supersedes: pendingHeads(await journal.pendingEdits.toArray()).filter(e => e.base.documentId === request.documentId).map(e => e.id) };
        await validatePending(edit, request.boardId);
        await journal.pendingEdits.put(edit); await changed(request.boardId);
      });
    };
    const projectCommands = ['renameProject', 'deleteProject', 'changeProjectTemplate', 'emptyTrash', 'reorderItems', 'moveItem', 'rebalanceProject'] as const;
    const cardCommands = ['updateItem', 'deleteItem', 'duplicateItem', 'mergeItems'] as const;
    for (const command of [...projectCommands, ...cardCommands, 'addItem'] as const) {
      const original = api[command] as (...args: any[]) => Promise<any>;
      (api as any)[command] = async (...args: any[]) => {
        let boardId: string | undefined;
        if (command === 'addItem') boardId = args[0].projectId;
        else if ((projectCommands as readonly string[]).includes(command)) boardId = args[0];
        else boardId = (await getCard(args[0]))?.projectId ?? (await cards.findOne(args[0]).exec())?.projectId;
        if (!boardId) return original(...args);
        const permission = await journal.permissions.get(boardId);
        if (!permission?.authorityKeyId) {
          if (command !== 'deleteProject' && (await journal.pendingEdits.toArray()).some(e => e.boardId === boardId)) await assertCanMutate(boardId);
          return original(...args);
        }
        if (liveBoardRole(cards, boardId) && !pendingHeads((await journal.pendingEdits.toArray()).filter(e => e.boardId === boardId)).length) return original(...args);
        // Viewer removal still hides only that account's copy.
        if (command === 'deleteProject' && permission.role !== 'owner') return original(...args);
        await assertCanMutate(boardId, true);
        const result = await locked(async () => {
          const source = [
            ...(await projects.storageInstance.findDocumentsById([boardId!], true)).map(value => ({ collection: 'projects' as const, value })),
            ...(await cards.find({ selector: { projectId: boardId } }).exec()).map(doc => ({ collection: 'cards' as const, value: doc.toJSON(true) }))
          ];
          const result = await draftCommand({ boardId: boardId!, journal, deviceKeyId: permission.deviceKeyId!, authorityKeyId: permission.authorityKeyId!, source,
            command, args, createScratch: async (): Promise<any> => createRxRepository({ name: `pboardscratch${newId().replaceAll('-', '')}`, storage: getRxStorageMemory(), blobs, pendingScratch: true }) });
          await changed(boardId!); return result;
        });
        if (liveBoardRole(cards, boardId)) await admitPendingWork(boardId);
        return result;
      };
    }
  }
  for (const marker of await journal.boardErasures()) await locked(() => eraseLocalBoardData(marker.boardId));
  return api;
}

export type RxRepository = Awaited<ReturnType<typeof createRxRepository>>;
