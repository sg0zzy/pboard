import { commandFromChange, OperationSource, type OperationBinding } from '../sync/operations/source';
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { draftCommand, pendingValue, validatePending } from "./pendingWork";
import { liveBoardRole, liveBoardEntitlement, registerAuthorizationJournal, recordLiveBoardAdmission, installLiveBoardMutations } from "../collab/security/liveMutations";
import { canonicalize } from "../collab/security/canonical";
import { documentValue, makeChange, scope, pendingHeads, adoptedPendingIds, confirmableIds, type PendingEdit, type PendingReviewRecord, type OperationRecord, type BoardCleanupState } from "./changeJournal";
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
import { compareOrdered, initialOrderKeys, orderKeyBetween, rebalanceOrderKeys, safeOrderKeyBetween } from "./orderKey";
import { collaborationCounters } from "../collab/counters";
import { mergeBoardOrder, mergeProjectOrder, parseProjectOrder, projectDeletionTime as orderDeletionTime, sameProjectOrder, type ProjectOrderPreference } from "./projectOrder";
import { planLegacyDeletionMigration, type BoardTombstoneFact, type LegacyDeletionPlan } from "./boardTombstone";
import type { BoardTombstoneMerge } from "./changeJournal";
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
import { createReentrantLock, type LockAcquire, type LockedOperation } from "./lock";

export type RxCollections = {
  projects: RxCollection<ProjectRecord>;
  cards: RxCollection<CardRecord>;
  settings: RxCollection<SettingRecord>;
};

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
/**
 * How long a reader waits for a burst of journal notifications to end before
 * it reads. One write produces several notifications in quick succession, and
 * each of them completes an IndexedDB transaction, so the notifications of one
 * write are spread over tens of milliseconds. Reading between them would
 * publish an intermediate value and start another read. The window is short
 * enough to stay imperceptible while typing.
 */
const SETTLE_MS = 8;
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
  /**
   * Whether an unbound signed board holds commands as reviewable pending work.
   * Default true — the signed-mutation-guard world, where a context without
   * the live board authority must not write the journal it cannot sign.
   * The operation-protocol composition root sets this false: that build has
   * no live-role guard to admit drafts, so a held draft is a queue nothing
   * drains. There, every board is taken over by the operation service at the
   * next synchronization — the Drive-first path that predates the relay
   * posture — and local edits wait in the ordinary journal, not in review.
   */
  offlineDrafts?: boolean;
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
   * Recheck the Drive ACL before a SIGNED board's content delete. "Independent"
   * collaboration never consults the Drive ACL for roles, so a board that is
   * still Drive-shared (its usual origin) must not let a collaborator whose
   * Drive permission is non-owner destroy the shared content even if the
   * locally imported grant says owner. A null result (not Drive-shared) or a
   * transport failure keeps the manifest's verdict; an editor/viewer result
   * forces the leave-only path.
   */
  reverifySharedDeletionRole?: (projectId: string) => Promise<"owner" | "editor" | "viewer" | null>;
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
  const operationSource = new OperationSource(journal);
  try {
    await journal.open();
    await recoverJournal(journal, { projects, cards });
    registerAuthorizationJournal(cards, journal); registerAuthorizationJournal(projects, journal);
    await operationSource.open();
    installJournalStorage(projects, "projects", journal, entries => entries.some(entry => operationSource.bindings.has(entry.boardId)) ? operationSource.capture(entries) : undefined);
    installJournalStorage(cards, "cards", journal, entries => entries.some(entry => operationSource.bindings.has(entry.boardId)) ? operationSource.capture(entries) : undefined);
  } catch (error) {
    journal.close();
    await db.close();
    throw error;
  }
  const permissionWrites = new Map<string, Promise<void>>();
  /**
   * The pending-edit table is read by every card and project read, by the
   * pending-work panel and by the mutation gate. Each read was a separate
   * IndexedDB scan, and every journal write notified every reader. The table
   * is therefore read once and shared, and the shared copy is dropped when
   * the journal changes.
   */
  let pendingCache: PendingEdit[] | null = null;
  let pendingLoad: Promise<PendingEdit[]> | null = null;
  const pendingEdits = async (): Promise<PendingEdit[]> => {
    if (pendingCache) return pendingCache;
    // One in-flight read: concurrent readers share it instead of each
    // scanning the table. The copy is dropped when the pending-edit table
    // itself changes.
    pendingLoad ??= journal.pendingEdits.toArray().then(value => {
      pendingCache = value;
      pendingLoad = null;
      return value;
    });
    return pendingLoad;
  };
  const invalidatePendingEdits = () => { pendingCache = null; pendingLoad = null; };
  // The pending-edit overlay mirrors one journal table, so the shared copy is
  // dropped when that table changes — including changes made by another
  // browser, and whether or not a UI subscription is mounted. A change to an
  // unrelated table leaves the copy valid.
  journal.onChange((tables) => { if (tables.includes("pendingEdits")) invalidatePendingEdits(); });
  // Cross-context writers — the extension worker handling the page context
  // menu's pin commands — never hold live board authority, so their commands
  // land as pending drafts that only a context with the board's verified
  // session (the open sidebar) may admit. Without this sweep such a draft
  // reads as "Synchronization pending" until the user manually verifies
  // board access. Admit promptly instead: only boards whose live role in
  // THIS context is an editor are swept, admitPendingWork re-asserts every
  // precondition under its own lock (foreign-device drafts stay retained
  // for review), and one sweep per board is in flight at a time; its own
  // writes re-enter here as a no-op once no heads remain. The subscription
  // (not onChange) is deliberate: journal notifications from the worker's
  // context arrive only on subscribed listeners.
  const sweeping = new Map<string, Promise<void>>();
  if (!options.pendingScratch) journal.subscribe((tables) => {
    if (!tables.includes("pendingEdits")) return;
    invalidatePendingEdits();
    void (async () => {
      for (const boardId of new Set(pendingHeads(await pendingEdits()).map((edit) => edit.boardId))) {
        if (!["owner", "editor"].includes(liveBoardRole(cards, boardId) ?? "") || sweeping.has(boardId)) continue;
        const sweep = admitPendingWork(boardId).catch(() => undefined).finally(() => { sweeping.delete(boardId); });
        sweeping.set(boardId, sweep);
      }
    })();
  });
  db.onClose.push(async () => { await Promise.all(permissionWrites.values()); operationSource.close(); journal.close(); });
  const reconciliation = createCausalReconciliation(journal);
  const blobs = options.blobs ?? createIndexedDbBlobStore();
  const events = options.events ?? {};
  // FIFO single exclusion per RxRepository instance. The operation that owns a section is
  // handed the acquirer, so work it re-acquires runs inside the section it already owns instead
  // of queueing behind itself; a nested call that cannot prove it belongs to the running section
  // — an event handler invoked while the section is held — still queues, so it can only be served
  // by the acquirer handed out here.
  let queue: Promise<unknown> = Promise.resolve();
  const acquire: LockAcquire = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation);
    queue = run.catch(() => undefined);
    return run;
  };
  const reentrant = createReentrantLock(acquire);
  function locked<T>(operation: LockedOperation<T>): Promise<T> {
    return reentrant.run(operation);
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
    const operationBinding = operationSource.bindings.get(projectId);
    if (operationBinding) {
      if (operationBinding.role === 'revoked' || operationBinding.role === 'viewer') throw new Error('Google Drive editing access is unavailable; retained local work is exportable');
      // The board's own log can delete the board while this device still has
      // it open. Authoring another operation for it would push content its
      // owner erased back into the log; the retained journal still exports.
      // The marker, not the row, is the authority: an erase recorded as a
      // tombstone fact (`isDeletedProject`) leaves the document in place while
      // hiding it from every read, so a row-only check let a device that was
      // still live on the board author into it after the owner's erase — the
      // write resolved, matched no project, and vanished.
      if (await isDeletedProject(projectId) || !(await projects.findOne(projectId).exec())) throw new Error('This board was deleted; your retained history is exportable');
      return;
    }
    const permission = await journal.permissions.get(projectId);
    const observed = liveBoardEntitlement(cards, projectId);
    if (observed === 'revoked' && permission) await journal.permissions.update(projectId, { role: 'revoked' });
    if (observed === 'viewer' && permission?.role !== 'viewer') await journal.permissions.update(projectId, { role: 'viewer' });
    if (observed === 'revoked' || permission?.role === "revoked") throw new Error("Board editing permission was removed; pending work remains available for export");
    if (observed === "viewer" || liveBoardRole(cards, projectId) === "viewer" || (permission?.role ?? options.mutatorRole) === "viewer") throw new Error("You have view-only access to this shared project");
    const signed = permission?.authorityKeyId || (await projects.findOne(projectId).exec())?._sec
      || (await journal.hasSignedHistory(projectId))
      || (await pendingEdits()).some(e => e.boardId === projectId);
    // The hold exists so unsigned writes to a signed board go to review
    // instead of to a journal this context cannot sign. With drafts disabled
    // (the operation-protocol build, which never installs a live board role
    // and therefore can never admit what it held) holding would be the very
    // stranding this posture must not produce: the edit stays local and the
    // operation service takes the board over at the next synchronization.
    if (options.offlineDrafts !== false && signed && !liveBoardRole(cards, projectId) && !(allowPending && permission?.deviceKeyId && permission.role !== "viewer")) {
      throw new Error("Current board authorization is required; cached content remains readable and exportable");
    }
  }
  async function pendingFor(documentId: string): Promise<PendingEdit[]> {
    const edits = (await pendingEdits()).filter(e => e.base.documentId === documentId);
    const superseded = new Set(edits.flatMap(e => e.supersedes ?? []));
    return edits.filter(e => !e.admittedChangeId && !superseded.has(e.id));
  }
  async function localCard(record: DeepReadonly<CardRecord>): Promise<CardRecord> {
    if (operationSource.bindings.has(record.projectId)) return record as CardRecord;
    const pending = await pendingFor(record.id);
    // Parallel drafts are retained for explicit review, never selected by clocks.
    return pending.length === 1 ? pending[0].value as unknown as CardRecord : record as CardRecord;
  }
  /** One admission pass per board at a time. Concurrent callers (manual
   * review, the pending-edit sweeper, the manager) wait for the in-flight
   * pass and then re-run: the pass is idempotent once heads are admitted,
   * while two overlapping passes would double-project (an extra
   * touchProject entry per interleaving). */
  const admitting = new Map<string, Promise<void>>();
  function admitPendingWork(boardId: string): Promise<void> {
    const running = admitting.get(boardId);
    if (!running) {
      const work = admitBoardWork(boardId).finally(() => { if (admitting.get(boardId) === work) admitting.delete(boardId); });
      admitting.set(boardId, work);
      return work;
    }
    return running.catch(() => undefined).then(() => admitPendingWork(boardId));
  }
  async function admitBoardWork(boardId: string) {
    const admitted = await locked(async () => {
      await assertCanMutate(boardId);
      const edits = (await pendingEdits()).filter(e => e.boardId === boardId);
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
      for (const edit of await pendingEdits()) if (edit.boardId === boardId && edit.admittedChangeId && !edit.projected) {
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
    const edits = pendingHeads((await pendingEdits()).filter(e => !operationSource.bindings.has(e.boardId) && e.base.collection === name && (!boardId || e.boardId === boardId)));
    const counts = new Map<string, number>(); for (const edit of edits) counts.set(edit.base.documentId, (counts.get(edit.base.documentId) ?? 0) + 1);
    for (const edit of edits) if (counts.get(edit.base.documentId) === 1) byId.set(edit.base.documentId, edit.value);
    return [...byId.values()].filter(row => !row._deleted).sort((a, b) => compareOrdered(a as { id: string; orderKey: string }, b as { id: string; orderKey: string }));
  }
  /** The account list this repository is currently scoped to; the same value
   *  `orderPreference()` reads. Tombstones are per account list for the same
   *  reason the preference is: a collaborator's leave must not hide the
   *  owner's copy on a device that holds both. */
  function tombstoneScope(): string | null { return projectOrderAccount; }
  /**
   * Boards this account list does not show: durable tombstones, permanent
   * erasures, and legacy `deletedProjectIds` markers this device has not
   * adopted as tombstones yet (a device that learned a deletion only from the
   * preference file). Every list read uses this one set, so a board cannot be
   * hidden by one path and visible to another — which is also what stops the
   * preference sync from re-adding an id it would immediately drop again.
   */
  async function hiddenBoardIds(): Promise<Set<string>> {
    const hidden = await journal.deletedBoards(tombstoneScope());
    for (const entry of await journal.boardErasures()) hidden.add(entry.boardId);
    const scope = tombstoneScope();
    const facts = new Map<string, BoardTombstoneFact[]>();
    for (const boardId of await deletedProjectIds()) {
      const row = facts.get(boardId) ?? await journal.boardTombstoneFacts(boardId);
      facts.set(boardId, row);
      // A fact (of either kind) is this device's own decision and outranks the
      // projection; without one, the marker stands.
      if (!row.some(fact => fact.accountId === scope)) hidden.add(boardId);
    }
    return hidden;
  }
  async function allProjectRecords() {
    const hidden = await hiddenBoardIds();
    return (await overlay("projects", (await projects.find().exec()).map(doc => doc.toJSON())))
      .filter(doc => !hidden.has(doc.id)) as ProjectRecord[];
  }
  let projectOrderAccount: string | null = null;
  const localOrderId = "localProjectOrder";
  const accountOrderId = (account: string) => `projectOrder:${account}`;
  /**
   * The last legacy-deletion migration's stated ambiguity. Kept because the
   * whole point of the migration's unknown case is that somebody must be able
   * to read it: a board that no preference lists and no tombstone covers is
   * neither deleted nor confirmed alive, and this is where that is said.
   */
  let legacyDeletionDiagnostic: { at: string; ambiguous: string[]; adopted: string[] } | null = null;
  async function orderPreference(): Promise<ProjectOrderPreference | null> {
    let preference = projectOrderAccount ? await settings.findOne(accountOrderId(projectOrderAccount)).exec() : null;
    if (!preference) {
      const source = await settings.findOne("localProjectOrderAccount").exec();
      if (projectOrderAccount && source && source.value !== projectOrderAccount) return null;
      preference = await settings.findOne(localOrderId).exec();
    }
    return preference ? parseProjectOrder(preference.value) : null;
  }
  /**
   * The account's legacy deletion projection. It is written on every delete so
   * an older build (and a Drive preference file an older build reads) still sees
   * the board as deleted, but it is **never** the source: the durable
   * `board.deleted` tombstone is (`storage/boardTombstone.ts`). A preference
   * merge or a `board.order` record that drops this field therefore cannot
   * resurrect a board.
   */
  async function deletedProjectIds(): Promise<string[]> {
    return (await orderPreference())?.deletedProjectIds ?? [];
  }
  /**
   * When this board left this account's list, in epoch milliseconds; null when
   * it never left or the latest deletion has been restored. Re-share detection
   * needs the moment, not only the flag.
   *
   * A tombstone outranks the preference projection: the projection's value is
   * only used for boards this device has not migrated into a tombstone yet.
   * The timestamp chooses nothing here — the *fact* decides deleted/restored,
   * and the time is only the answer to "since when".
   */
  async function projectDeletionTime(projectId: string): Promise<number | null> {
    const scope = tombstoneScope();
    const tombstone = await journal.boardTombstone(projectId, scope);
    if (tombstone.deleted) return tombstone.fact ? Date.parse(tombstone.fact.at) : null;
    if ((await journal.boardTombstoneFacts(projectId)).some(fact => fact.accountId === scope)) return null;
    const preference = await orderPreference();
    return preference ? orderDeletionTime(preference, projectId) : null;
  }
  /**
   * Permanent erasure, or a durable `board.deleted` tombstone. The account
   * preference's `deletedProjectIds` is consulted only for a board this device
   * has no tombstone fact for at all — the legacy projection, kept so a
   * deletion written by an older build stays hidden until migration adopts it.
   * A `restored` fact therefore also outranks a stale preference marker.
   */
  async function isDeletedProject(projectId: string): Promise<boolean> {
    if (await journal.boardErasure(projectId)) return true;
    const scope = tombstoneScope();
    if ((await journal.boardTombstone(projectId, scope)).deleted) return true;
    if ((await journal.boardTombstoneFacts(projectId)).some(fact => fact.accountId === scope)) return false;
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
    if (projectOrderAccount) {
      const saved = await settings.findOne("localProjectOrderAccount").exec();
      if (saved?.value !== projectOrderAccount) await settings.upsert({ id: "localProjectOrderAccount", value: projectOrderAccount });
    }
    projectOrderAccount = account;
    // Preserve local ordering before shared project documents can arrive, and
    // retain the last visible order when disconnecting or changing accounts.
    // The settings collection is observed by the sidebar's project list and
    // current project, so an unchanged value is not written: the write would
    // re-render the whole board for nothing.
    const local = await settings.findOne(localOrderId).exec();
    if (local?.value !== value) await settings.upsert({ id: localOrderId, value });
  }
  async function getProjectOrder(account: string): Promise<ProjectOrderPreference | null> {
    const preference = await settings.findOne(accountOrderId(account)).exec();
    return preference ? parseProjectOrder(preference.value) : null;
  }
  /**
   * Reflects this device's durable tombstones into a preference document.
   *
   * The preference field is only the legacy projection of the tombstone, and
   * the tombstone never depends on it — but the projection must not *contradict*
   * it either: an order record, a Drive merge or a local reorder that carried
   * the id back into `ids` (or dropped it from `deletedProjectIds`) would make
   * an older build, or the Drive copy an older build reads, present a board
   * this device has deleted. Applying this before every preference write makes
   * that impossible while keeping the field derived, never authoritative.
   */
  async function withTombstoneProjection(preference: ProjectOrderPreference): Promise<ProjectOrderPreference> {
    const tombstoned = await hiddenBoardIds();
    if (!tombstoned.size) return preference;
    const deleted = [...new Set([...(preference.deletedProjectIds ?? []), ...tombstoned])].sort();
    const ids = preference.ids.filter(id => !tombstoned.has(id));
    return { ...preference, ids, deletedProjectIds: deleted };
  }
  async function applyProjectOrder(account: string, preference: ProjectOrderPreference) {
    return locked(async () => {
      // Keep ids for boards not imported yet; they receive their saved rank as
      // soon as discovery/reconciliation adds them to the local repository.
      const id = accountOrderId(account);
      const doc = await settings.findOne(id).exec();
      if (!doc) {
        await settings.upsert({ id, value: JSON.stringify(await withTombstoneProjection(preference)) });
        return;
      }
      const current = doc.value;
      const mergedOrder = await withTombstoneProjection(mergeProjectOrder(parseProjectOrder(current), preference));
      const merged = JSON.stringify(mergedOrder);
      // The account's order is merged on every account-preference sync. The
      // merge returns a new value each time, so writing it unconditionally
      // would change the settings collection on every sync. The settings
      // collection is observed by the sidebar's project list and current
      // project, so that write re-rendered the whole board — and the
      // re-render started the next sync.
      //
      // The merged order is compared by content, not by its text: the same
      // order serializes differently when the merge reorders the keys, and
      // that difference is not a change.
      if (sameProjectOrder(parseProjectOrder(current), mergedOrder)) return;
      await doc.incrementalModify((existing) => ({ ...existing, value: merged }));
    });
  }
  /** The clock of the last order record this device applied from the account
   * room. The preference document's own `updatedAt` is the *local* intent's
   * clock (a Drive merge and a reorder both move it), so remembering the last
   * remote clock separately is what lets a replay after a restart be recognised
   * as already applied instead of flipping the list back. */
  const orderClockId = (account: string) => `projectOrderClock:${account}`;
  function parseOrderClock(value: string | undefined): { updatedAt: number; seq: number; tie: string } | undefined {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') return undefined;
      const clock = parsed as { updatedAt?: unknown; seq?: unknown; tie?: unknown };
      if (typeof clock.updatedAt !== 'number' || typeof clock.seq !== 'number') return undefined;
      return { updatedAt: clock.updatedAt, seq: clock.seq, tie: typeof clock.tie === 'string' ? clock.tie : '' };
    } catch { return undefined; }
  }
  /**
   * Applies a total order received over the account room, keeping this
   * device's own boards.
   *
   * Three rules, and each has a reason:
   *
   * 1. **Never import, never resurrect.** The received ids are woven into the
   *    list this device actually holds (`mergeBoardOrder` in
   *    `storage/projectOrder.ts`), so an id this device does not have is
   *    dropped. Making a board appear is the creation record's job and the
   *    Drive listing's; an order is a property of a list that already exists.
   * 2. **A local board the order does not mention keeps its slot.** It is
   *    anchored to its local predecessor, so a sender that has not seen a newer
   *    board cannot drag it to the front or the back.
   * 3. **Newer wins, by the account plane's own rule.** `updatedAt` first,
   *    `seq` second, the log row id last — the same comparison the account-room
   *    projection already made (`operations/accountLifecycle.ts`). It is
   *    repeated here because a *local* reorder may be newer than the record that
   *    just arrived (two sessions reordered at once): the local preference's
   *    `updatedAt` is that local intent's clock. A record tied with the local
   *    clock wins, and both devices compare the same values, so the loser is
   *    superseded deterministically rather than flipped back and forth.
   *
   * Applying an order writes the local preference document only. It never
   * fires `projectOrderChanged`, so a received order cannot be published
   * again: that is the difference between the record being the realtime path
   * and the Drive poll becoming the realtime path.
   */
  async function applyRealtimeProjectOrder(account: string, order: { ids: string[]; updatedAt: number; seq: number; tie?: string }): Promise<boolean> {
    return locked(async () => {
      const next = { updatedAt: order.updatedAt, seq: order.seq, tie: order.tie ?? '' };
      const previous = parseOrderClock((await settings.findOne(orderClockId(account)).exec())?.value);
      const doc = await settings.findOne(accountOrderId(account)).exec();
      const current = doc ? parseProjectOrder(doc.value) : undefined;
      const localClock = current ? Date.parse(current.updatedAt) : Number.NEGATIVE_INFINITY;
      const local = (await orderedProjects()).map(record => record.id);
      // Older than this device's own intent: the local reorder happened after
      // this record and already supersedes it. Ignoring is what makes the loser
      // of two concurrent reorders *visibly* superseded rather than silently
      // reverted, and it is why a record replayed after a restart cannot flip a
      // newer local order back.
      if (next.updatedAt < localClock) return false;
      // Within one instant there is no clock to compare — two sessions that
      // reordered in the same millisecond produce the same `updatedAt`, and the
      // local intent was never stamped by the log, so it has no `seq` to lose on.
      // The answer must still be the same on both devices, so it is computed from
      // the one thing both devices can see identically: the two orders
      // *restricted to the boards they share*. Each session compares the same two
      // permutations of the same set — its own and the record's — and both keep
      // the greater one, so the loser is superseded on both sides. Restricting is
      // what makes the comparison symmetric: the raw lists routinely differ in
      // length (a board only one device has), and comparing those directly would
      // resolve differently on each side.
      if (next.updatedAt === localClock) {
        const known = new Set(local);
        const shared = new Set(order.ids.filter(id => known.has(id)));
        const mine = local.filter(id => shared.has(id));
        const theirs = order.ids.filter(id => shared.has(id));
        if (JSON.stringify(theirs) <= JSON.stringify(mine)) return false;
      }
      // A record this device already applied is a replay (the log re-delivering
      // after a reconnect), not a newer fact.
      if (previous && next.updatedAt === previous.updatedAt && next.seq === previous.seq && next.tie === previous.tie) return false;
      // A tombstoned board is never re-admitted by an order record, and receiving
      // one never clears the tombstone. The id is dropped from the woven list and
      // from the saved ranks; the record cannot say anything about a board this
      // device has deleted, because an order is a rank, not a creation.
      const tombstoned = await journal.deletedBoards(account);
      const received = order.ids.filter(id => !tombstoned.has(id));
      const merged = mergeBoardOrder(local.filter(id => !tombstoned.has(id)), received);
      // Saved ranks for boards this device has not imported are kept without
      // being resurrected: they are ranks, not rows (`applyProjectOrder`'s own
      // rule), so a later import finds its place and nothing appears now.
      const held = new Set(merged);
      const ids = [...merged, ...(current?.ids ?? []).filter(id => !held.has(id) && !tombstoned.has(id))];
      const idsMoved = !current || current.ids.length !== ids.length || current.ids.some((id, index) => id !== ids[index]);
      await settings.upsert({ id: orderClockId(account), value: JSON.stringify(next) });
      if (!idsMoved) return true;
      // The preference document's clock becomes the record's own clock, not this
      // device's wall clock: both sessions then store the *same* document, so the
      // Drive copy they eventually upload is identical and the poll cannot
      // alternate between two "newest" orders. The local clock is never below it
      // here (the guard above), so this is monotonic in this repository too.
      await settings.upsert({ id: accountOrderId(account), value: JSON.stringify(await withTombstoneProjection({ ...(current ?? {}), ids,
        updatedAt: new Date(order.updatedAt).toISOString() })) });
      return true;
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
    if ((await pendingEdits()).some(e => e.value.imageId === imageId || e.base.value.imageId === imageId)) return;
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
  /**
   * The single import entry point every path funnels through (shared
   * discovery, Drive listing adoption, snapshot/segment recovery, legacy
   * migration, `importState`, collaboration copies).
   *
   * A tombstoned board is refused here even when the copy claims to exist. The
   * refusal is causal, not chronological: a snapshot, a Drive file and a
   * legacy row carry no operation vector, so none of them dominates the
   * tombstone, and an old creation therefore loses to it regardless of its
   * timestamps. Only an explicit `restored` fact (written by
   * `unhideProject`) makes the board admissible again — and `isDeletedProject`
   * answers from that fact, never from the preference projection when a fact
   * exists.
   */
  async function importProjectData(project: Project, items: BoardItem[], preserveOrderKey?: string) {
    // `isDeletedProject` is the tombstone plus the legacy preference fallback
    // for a marker this build has not adopted yet; both mean "decided gone".
    if (await isDeletedProject(project.id) || await journal.boardDeletionBlocks(project.id)) return;
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
    // The preference document this migration writes must carry every deletion
    // fact this device already knows, or the legacy build reading it would
    // re-present a board this build has tombstoned.
    const orderId = projectOrderAccount ? accountOrderId(projectOrderAccount) : localOrderId;
    const existingOrder = await settings.findOne(orderId).exec();
    await settings.upsert({ id: orderId, value: JSON.stringify(await withTombstoneProjection({
      ...(existingOrder ? parseProjectOrder(existingOrder.value) : { updatedAt: "1970-01-01T00:00:00.000Z" }),
      ids: state.projects.map((project) => project.id) })) });
    await settings.upsert({ id: "currentProjectId", value: state.currentProjectId ?? "" });
    const importedProjects = await listProjects();
    // A tombstoned board in the legacy state is *expected* to be absent: the
    // migration must not fail because it refused to re-admit one.
    const tombstoned = await journal.deletedBoards(tombstoneScope());
    const expectedProjects = state.projects.filter(project => !tombstoned.has(project.id));
    if (importedProjects.length !== expectedProjects.length || importedProjects.some((project) => !expectedProjects.some((original) => original.id === project.id))) {
      throw new Error("RxDB migration project verification failed");
    }
    for (const project of expectedProjects) {
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
  /**
   * Adopts the legacy `deletedProjectIds` projection as durable tombstones.
   *
   * Only reliable evidence is adopted: a preference document that *carries* the
   * field and names the board in it. A board that is absent from every
   * preference and has no tombstone is **unknown**, not deleted — the migration
   * reports it and decides nothing, because inventing either decision is how a
   * live board gets destroyed or a deleted one comes back. Nothing here touches
   * Drive: no folder is trashed, no file deleted.
   *
   * Idempotent: a board that already holds any fact (a tombstone written by
   * this build, or a restore) is skipped, so re-running the migration after a
   * restore cannot re-delete the board.
   */
  /** A preference document id carries its account scope: `localProjectOrder` is
   *  the account-less list, `projectOrder:<account>` is that account's. */
  function accountOfPreference(preferenceId: string): string | null {
    return preferenceId.startsWith("projectOrder:") ? preferenceId.slice("projectOrder:".length) : null;
  }
  async function migrateLegacyDeletions(): Promise<LegacyDeletionPlan> {
    const localProjectIds = (await projects.find().exec()).map(doc => String(doc.toJSON().id));
    const preferenceIds = [...new Set([localOrderId,
      ...(await settings.find().exec()).map(doc => doc.toJSON().id).filter(id => id.startsWith("projectOrder:"))])];
    const preferences: { preferenceId: string; preference: ProjectOrderPreference }[] = [];
    for (const preferenceId of preferenceIds) {
      const row = await settings.findOne(preferenceId).exec();
      if (!row) continue;
      try { preferences.push({ preferenceId, preference: parseProjectOrder(row.value) }); }
      catch { /* A malformed preference is not evidence of anything. */ }
    }
    // A preference's marker is only already adopted when a fact exists in *that
    // preference's own account list*; another list's fact is another list's
    // decision.
    const facts = new Map<string, BoardTombstoneFact[]>();
    for (const boardId of localProjectIds) facts.set(boardId, await journal.boardTombstoneFacts(boardId));
    const plan = planLegacyDeletionMigration({ preferences, localProjectIds,
      alreadyRecorded: (boardId, preferenceId) => (facts.get(boardId) ?? []).some(fact => fact.accountId === accountOfPreference(preferenceId)) });
    for (const { boardId, preferenceId, updatedAt } of plan.adopt) {
      const at = Number.isFinite(Date.parse(updatedAt)) ? updatedAt : now();
      await journal.recordBoardDeletion({ boardId, accountId: accountOfPreference(preferenceId), context: await observedContext(boardId), role: "owner",
        at, evidence: `legacy-preference:${preferenceId}`, kind: "deleted", clock: Math.max(0, Date.parse(at)) });
    }
    if (plan.ambiguous.length) {
      // A diagnosis, not a decision: these boards are still listed.
      legacyDeletionDiagnostic = { at: now(), ambiguous: plan.ambiguous.map(entry => entry.boardId), adopted: plan.adopt.map(entry => entry.boardId) };
    } else if (plan.adopt.length) {
      legacyDeletionDiagnostic = { at: now(), ambiguous: [], adopted: plan.adopt.map(entry => entry.boardId) };
    }
    return plan;
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
    void Promise.resolve().then(() => events.projectCreated?.(project.id)).catch(() => undefined);
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
    await settings.upsert({ id, value: JSON.stringify(await withTombstoneProjection({ ...(existing ? parseProjectOrder(existing.value) : {}), ids: orderedIds, updatedAt,
      ...(deletedProjectIds ? { deletedProjectIds } : {}) })) });
    // The settling point of a reorder: `reorderProjects` is called once per
    // drop/commit, never per drag preview (`ProjectPicker` computes a preview
    // and calls this only when it settles), and this assignment is the moment
    // the list stopped moving. The published ids are the list this device
    // holds, so a peer merges a total order over a set it can recognise.
    // Fire-and-forget: the handler publishes to the relay, and a relay ack is
    // never a condition of the local reorder — nor may it re-enter this lock.
    void Promise.resolve(events.projectOrderChanged?.({ account: projectOrderAccount, ids: orderedIds,
      updatedAt: Date.parse(updatedAt) })).catch(() => undefined);
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
  /** Boards whose owner erase is running in this context. The operation
   * projection consults it so a batch that lands mid-erase yields instead of
   * rewriting the row the erase is about to tombstone. */
  const erasingBoards = new Set<string>();
  function isErasingBoard(projectId: string): boolean { return erasingBoards.has(projectId); }
  /**
   * Tombstone the board row, and only succeed when the row says it is deleted.
   *
   * The projection of verified operations (`projectOperations` in
   * src/sync/operations/projection.ts) rewrites the board row on every applied
   * batch — its `revision` is the operation vector and `tailOrderKey` follows
   * the card order, while `updatedAt` keeps the value the log carries. A
   * document read before this point is therefore routinely stale by the time a
   * tombstone is written, and RxDB rejects the write with a `CONFLICT`. If that
   * failure were swallowed the board would stay alive locally and on every
   * other device while the account list already dropped it, which is the state
   * in which the board's log refuses to synchronize at all.
   *
   * So: re-read the row for every attempt (the window then closes to a single
   * storage batch), let the projection yield for the duration, and give up
   * after four attempts — one for the normal case, one to absorb the batch that
   * was already inside its storage write when the latch went up, two for a
   * storage failure that repeats it. Anything still failing at that point is an
   * unknown writer and must reach the user as a failed deletion rather than
   * spin in the repository's mutation lock.
   */
  const ERASE_ATTEMPTS = 4;
  async function eraseProjectDocument(projectId: string): Promise<void> {
    erasingBoards.add(projectId);
    try {
      /** The stored row, including a tombstone the document cache hides. */
      const storedRow = async () => (await projects.storageInstance.findDocumentsById([projectId], true))[0] as unknown as { _deleted?: boolean } | undefined;
      let failure: unknown;
      for (let attempt = 0; attempt < ERASE_ATTEMPTS; attempt++) {
        const row = await storedRow();
        // Already tombstoned — by this call or by a device that got here first
        // — is the outcome the caller asked for, not an error.
        if (!row || row._deleted) return;
        const current = await projects.findOne(projectId).exec();
        try {
          if (current) await current.remove();
        } catch (error) { failure = error; continue; }
        const after = await storedRow();
        if (!after || after._deleted) return;
        failure ??= new Error('Board deletion was rejected by local storage; the board remains listed and its content is untouched');
      }
      throw failure instanceof Error ? failure : new Error('Board deletion did not complete; the board remains listed and its content is untouched');
    } finally { erasingBoards.delete(projectId); }
  }
  /** The context this device has observed for a board, so a tombstone written
   *  now is ordered after everything it has already seen. Empty is honest and
   *  sufficient against copies that carry no context at all. */
  async function observedContext(projectId: string): Promise<import("./boardTombstone").CausalContext> {
    const observed: import("./boardTombstone").CausalContext = operationSource.bindings.has(projectId)
      ? await operationSource.local.observed(projectId).then(state => state.frontier, () => ({}))
      : {};
    const facts = await journal.boardTombstoneFacts(projectId);
    for (const fact of facts) {
      observed[fact.actorId] = Math.max(observed[fact.actorId] ?? 0, fact.seq);
      for (const [actor, seq] of Object.entries(fact.context)) observed[actor] = Math.max(observed[actor] ?? 0, seq);
    }
    return observed;
  }
  /**
   * Persist the durable tombstone. This is the **first** durable write of a
   * deletion and it must happen before `eraseProjectDocument`, before the list
   * hide is reported and before anything is published: a crash after this line
   * leaves the tombstone (and therefore the decision), while a crash before it
   * leaves an untouched board. Nothing in the delete path may reorder the two.
   *
   * The Drive cleanup is a *later* durable write (`beginBoardCleanup`), because
   * whether this device owes it depends on a role decision — a collaborator
   * leaving keeps the owner's folder — that is only known after the fact. The
   * ordering that matters is preserved either way: no cleanup record exists
   * before the tombstone that authorises it.
   *
   * The write is also announced to the rest of the account. That announcement is
   * fire-and-forget and comes *after* the durable write —
   * the fact is what the deletion is, and a relay that is down must not delay or
   * fail the user's action. `projectTombstoned` is the composition root's seam
   * (`storage/browser.ts` → `accountChannel.publishTombstone`); a repository
   * with no such listener simply does not announce, which is what the Drive
   * preference projection still covers.
   */
  async function recordDeletion(projectId: string, role: import("./boardTombstone").DeletionRole, kind: "deleted" | "restored", evidence: string) {
    const fact = await journal.recordBoardDeletion({ boardId: projectId, accountId: tombstoneScope(), context: await observedContext(projectId),
      role, at: now(), evidence, kind });
    void events.projectTombstoned?.(projectId, fact);
    return fact;
  }
  async function deleteProject(projectId: string) {
    const doc = await projects.findOne(projectId).exec();
    if (!doc) return;
    await permissionWrites.get(projectId);
    const permission = await journal.permissions.get(projectId);
    const operationBinding = operationSource.bindings.get(projectId);
    const signed = !operationBinding && (!!doc._sec || !!permission?.authorityKeyId);
    /** Exactly one deletion fact per `deleteProject` call, written at the first
     *  decision point and never again. `role` is what this device knew then. */
    let tombstoned = false;
    const ensureTombstone = async (role: import("./boardTombstone").DeletionRole) => {
      if (tombstoned) return;
      tombstoned = true;
      await recordDeletion(projectId, role, "deleted", `local-delete:${role}`);
    };
    /** The account-list projection of the decision. It never writes a fact: the
     *  tombstone above is the record, this field only lets an older build (and
     *  the Drive preference file an older build reads) agree. */
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
    // For an unsigned board the account marker commits *before* the Drive
    // ownership check is awaited, so the list answers immediately and a
    // verification that never comes still leaves the board out of it; what the
    // erase below protects is the other half — content surviving a committed
    // marker, which is why a failed erase rolls the marker back.
    //
    // The durable tombstone precedes both, and precedes the ownership
    // verification for the unsigned case: it is the first write of the
    // deletion, so a crash between the decision and the rest can never lose the
    // decision. For a signed board the verification is a local grant read (no
    // destructive work happens before it), so the fact is written with the
    // verified role, still before `projectDeleting` publishes anything and
    // before the erase.
    if (!signed) { await ensureTombstone(permission?.role ?? options.mutatorRole ?? "owner"); await hide(); }
    let role = operationBinding ? (options.resolveDeletionRole ? await options.resolveDeletionRole(projectId) : operationBinding.role) : (signed ? liveBoardRole(projects, projectId) ?? permission?.role
      : options.resolveDeletionRole ? await options.resolveDeletionRole(projectId) : permission?.role ?? options.mutatorRole ?? "owner");
    if (signed && role === "owner" && options.reverifySharedDeletionRole) {
      // Independent mode hides the Drive ACL from the local role cache: a
      // board that is Drive-shared must still honour Drive ownership before
      // shared content is destroyed.
      try {
        const drive = await options.reverifySharedDeletionRole(projectId);
        if (drive && drive !== "owner") role = drive;
      } catch {
        // Unverifiable: keep the verified grant's verdict.
      }
    }
    if (signed) await ensureTombstone(role ?? "owner");
    const canDeleteContent = role === "owner" && (!signed || liveBoardRole(projects, projectId) === "owner");
    // Non-owners remove only their account's list handle. Cached rows, images,
    // pending work and conflicts are retained independently of transport state.
    if (!canDeleteContent) {
      await hide();
      await events.projectHidden?.(projectId);
      return;
    }
    await events.projectDeleting?.(projectValue(doc.toJSON()));
    // This device is about to destroy the board's content, so it also owes the
    // board's Drive folder a move to Trash. Written *after* the tombstone
    // above — which is what authorises the move — and before the erase, so a
    // crash at any point leaves the intent durable and the next session
    // resumes it. A collaborator's leave returned above and owes nothing: the
    // owner's folder is not theirs to trash.
    await journal.beginBoardCleanup(projectId, tombstoneScope(), now(), Date.now(), doc.toJSON().name as string | undefined).catch(() => undefined);
    // The account marker is already committed (that is what the ownership check
    // above waits behind, so the list answers immediately). What must never
    // happen is a board that stays hidden while its content survives: hiding a
    // board whose erase failed is the half-deleted state where
    // `isDeletedProject()` reports the board gone, every later synchronization
    // of it is refused with "This board was removed", and no device was told
    // anything. So a failed erase puts the board back in the list and rejects;
    // the caller reports the delete as the failure it is.
    try {
      await locked(async () => {
        await eraseProjectDocument(projectId);
        for (const card of await projectCardRecords(projectId, false, false)) {
          await (await cards.findOne(card.id).exec())?.incrementalPatch({ deletedAt: now() });
        }
      });
    } catch (error) {
      await unhideProject(projectId).catch(() => undefined);
      throw error;
    }
    await hide();
    // Preference sync can itself queue repository writes. Release the mutation
    // lock before notifying listeners so removing a board cannot deadlock sync.
    await events.projectDeleted?.(projectId);
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
    await assertCanMutate(input.projectId);
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
    await assertCanMutate(doc.projectId, true);
    const project = await getProject(doc.projectId);
    if (patch.type && project && !isTypeSupported(project.template, patch.type)) throw new Error("Card type is not supported by this board template");
    const permission = await journal.permissions.get(doc.projectId);
    if (options.offlineDrafts !== false && permission?.authorityKeyId && (!liveBoardRole(cards, doc.projectId) || (await pendingFor(itemId)).length)) {
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
    // A concurrent duplicate midpoint can leave the next card sharing the
    // source's rank; no key fits between equal ranks, so append past that
    // neighbour instead of failing the duplicate over a comparator error.
    const nextKey = ordered[index + 1]?.orderKey ?? null;
    const record: CardRecord = { ...sourceRecord, id: newId(), status: "candidate",
      orderKey: safeOrderKeyBetween(source.orderKey, nextKey) ?? orderKeyBetween(source.orderKey, null), createdAt: timestamp, updatedAt: timestamp };
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
    const beforeKey = before?.orderKey ?? null;
    const afterKey = after?.orderKey ?? null;
    const key = safeOrderKeyBetween(beforeKey, afterKey);
    if (key === null) {
      // Degenerate slot: the neighbours share an order key (two devices minted
      // the same midpoint concurrently) or the caller's list is stale. No key
      // fits strictly between equal ranks, so honour the requested sequence
      // with a fresh lattice — the fallback an ambiguous multi-card
      // permutation already takes — rather than let the fractional-indexing
      // comparator throw mid-drag.
      const keys = initialOrderKeys(orderedIds.length);
      const timestamp = now();
      for (const [index, id] of orderedIds.entries()) await (await cards.findOne(id).exec())?.incrementalPatch({ orderKey: keys[index], updatedAt: timestamp });
      await touchProject(projectId, timestamp, keys.at(-1));
      await changed(projectId);
      return;
    }
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
  /** Reverses only this account's list preference (D04). Cached content and retained conflict/pending evidence stay untouched.
   *
   * The explicit restore is the *only* supported way a tombstoned board comes
   * back locally. It writes a `restored` fact into the same record with the
   * prior facts folded into its context, so the restore causally dominates the
   * deletion it reverses; nothing else (a Drive file, an old snapshot, an old
   * order record, a stale preference marker) may produce that fact.
   *
   * A restore *received* from a peer is a different thing: the fact already
   * exists (`applyBoardTombstoneFact` merged it into this store), so this
   * device must not mint a second `restored` fact for the same decision — it
   * only has to make its own list and row agree with the fact it now holds.
   * That is what `reflectRestore`/`rebuildFromRetained` are for, and why the
   * restore path is split into those two steps. */
  async function unhideProject(projectId: string) {
    if (await journal.boardErasure(projectId)) throw new Error('This board was permanently deleted.');
    if (await getProject(projectId)) return; // Board already visible; nothing to restore.
    const doc = await projects.findOne(projectId).exec();
    const wasHidden = await isDeletedProject(projectId);
    if (!doc && !wasHidden) throw new Error("This board's cached copy is unavailable locally; its evidence remains exportable");
    if (wasHidden) await recordDeletion(projectId, (await journal.boardTombstone(projectId)).fact?.role ?? "owner",
      "restored", "explicit-restore");
    await reflectRestore(projectId, wasHidden);
    // An owner-authorized removal removed the project document itself. Rebuild
    // the board row and cards from the latest non-deleted variant in the
    // retained history — the deletion tombstones stay in the journal as
    // evidence, but the explicit restore brings the pre-deletion state back.
    if (!doc) await rebuildFromRetained(projectId);
    await changed(projectId);
  }
  /**
   * Reflects a `restored` fact into this device's account list: the id goes
   * back into `ids`, out of `deletedProjectIds`, and gets a `restoreEvents`
   * stamp so a preference merge keeps it visible against older markers.
   *
   * Shared by the explicit local restore and a restore received from a peer;
   * the latter must not re-stamp the *fact*, only this document.
   */
  async function reflectRestore(projectId: string, wasHidden: boolean) {
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
  }
  /**
   * Rebuilds one board's row (and its cards) from the latest non-deleted
   * variant in the retained journal. Used by an explicit restore and by a
   * restore received from a peer — both are "the fact says this board is
   * admissible again", so both rebuild through the same one path.
   */
  async function rebuildFromRetained(projectId: string) {
    await locked(async () => {
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
  }
  /**
   * Merges one tombstone fact received from the peer channel into this device's
   * durable store, through the same ordering rule the local delete/restore path
   * writes through, and makes this device's list agree with the result.
   *
   * That is the whole of the consume path, and it is deliberately small:
   *
   *  - **One store, one rule.** `journal.mergeBoardTombstone` is `mergeFacts` +
   *    `latestFact` over the same `boardTombstones` row `recordBoardDeletion`
   *    writes. There is no second merge and no second decision anywhere, so two
   *    devices that received the same facts in different orders hold the same
   *    bytes and answer `isDeletedProject` identically.
   *  - **A duplicate is a no-op**, reported as such: a replayed `opId`, an
   *    older fact, or a concurrent fact that lost the tie leaves the deciding
   *    fact unchanged, so nothing is hidden, nothing is re-shown and the caller
   *    answers `duplicate`.
   *  - **Deletion needs no Drive.** The fact *is* the evidence; a peer that
   *    never saw the deletion hides the board immediately, and every import
   *    gate (`isDeletedProject`, `boardDeletionBlocks`) refuses it from then on
   *    — including a fresh reconcile round's Drive adoption.
   *  - **Restore re-admits** through the explicit restore's own two steps, so a
   *    received restore and a local one leave the same state. It only rebuilds
   *    a row this device still has history for: a peer that never held the
   *    board gets nothing to rebuild and simply stops hiding it.
   */
  async function applyBoardTombstoneFact(boardId: string, fact: BoardTombstoneFact): Promise<BoardTombstoneMerge> {
    const merged = await journal.mergeBoardTombstone({ boardId, fact });
    if (merged.duplicate) return merged;
    if (merged.deleted) {
      // The list, the selection and any open editor read through
      // `isDeletedProject`, so the decided-gone state is already enough. Keep
      // the legacy projection in step so an older build reading the Drive
      // preference file agrees, and drop the selection off the board.
      await locked(async () => {
        const id = projectOrderAccount ? accountOrderId(projectOrderAccount) : localOrderId;
        const preference = await settings.findOne(id).exec();
        if (preference) {
          const parse = parseProjectOrder(preference.value);
          if (!(parse.deletedProjectIds ?? []).includes(boardId) || parse.ids.includes(boardId))
            await settings.upsert({ id, value: JSON.stringify(await withTombstoneProjection({ ...parse,
              ids: parse.ids.filter(candidate => candidate !== boardId),
              deletedProjectIds: [...new Set([...(parse.deletedProjectIds ?? []), boardId])].sort() })) });
        }
      });
      if ((await settings.findOne("currentProjectId").exec())?.value === boardId)
        await settings.upsert({ id: "currentProjectId", value: (await listProjects())[0]?.id ?? "" });
      return merged;
    }
    // A received restore: the fact already decides admissibility, so this device
    // only has to stop hiding the board and put it back in its own list.
    const hadRow = Boolean(await projects.findOne(boardId).exec());
    await reflectRestore(boardId, true);
    if (hadRow && !await getProject(boardId)) await rebuildFromRetained(boardId);
    await changed(boardId);
    return merged;
  }
  function subscribe<T>(query: { $: { subscribe: (next: () => void) => { unsubscribe(): void } } }, read: () => Promise<T>, listener: (value: T) => void) {
    const { refresh, readNow, stop } = subscribeRead("cards", read, listener);
    const sub = query.$.subscribe(refresh);
    // A card's list is the documents plus the pending-edit overlay over them.
    // A journal change in the change log, the receipts or the drafts does not
    // alter either, so it must not re-read the cards and re-render the board.
    const stopJournal = journal.subscribe((tables) => {
      if (tables.includes("pendingEdits")) invalidatePendingEdits();
      if (!tables.length || tables.includes("pendingEdits") || tables.includes("receipts")) refresh();
    });
    readNow();
    return () => { stop(); sub.unsubscribe(); stopJournal(); };
  }
  // A signed write emits several WAL notifications. Bound reads to one in
  // flight plus a trailing refresh, including bursts from another browser.
  //
  // The notifications of one write arrive one after another, so a read that
  // finishes between two of them would publish an intermediate value and
  // start another read. A short settling window turns a burst into a single
  // read: the reader waits for the burst to end before it reads once.
  //
  // `unchanged` is what makes a subscription a *view* subscription: the
  // sources of a whole-collection read (`projects.find()`, `settings.find()`)
  // fire for writes that cannot change what the reader renders — the
  // projection rewrites a board row on every applied operation batch, and a
  // receipt is written per downloaded file — so publishing every re-read is a
  // full sidebar render for a write the person cannot see, on any board. With
  // a comparator the read still happens once per settled burst, and the
  // listener is called only when the value it renders actually moved. The
  // freshly read value is what the listener receives: a suppressed emission
  // never leaves a stale value behind, because the next genuine change
  // publishes the whole current value, not a patch.
  function subscribeRead<T>(label: string, read: () => Promise<T>, listener: (value: T) => void, unchanged?: (previous: T, next: T) => boolean) {
    let active = true, running = false, dirty = false, settling: ReturnType<typeof setTimeout> | undefined;
    let published: { value: T } | undefined;
    const start = () => {
      if (!active || running) return;
      running = true;
      void Promise.resolve().then(async () => {
        while (active && dirty) {
          dirty = false;
          collaborationCounters.countEvent("view.read");
          collaborationCounters.countEvent(`view.read.${label}`);
          const readStarted = collaborationCounters.enabled ? performance.now() : 0;
          try {
            const value = await read();
            if (collaborationCounters.enabled) collaborationCounters.time(`view.read.${label}.ms`, performance.now() - readStarted);
            if (!active || dirty) continue;
            if (published && unchanged?.(published.value, value)) { published = { value }; continue; }
            published = { value };
            // Distinct from the UI's own `countEmission("projects")`: that counts
            // values that reached React, this counts values the subscription
            // published. They differ exactly where a render was suppressed by a
            // later re-read inside the same burst.
            collaborationCounters.countEmission(`view.emit.${label}`);
            listener(value);
          }
          catch { console.error('Local recovery view could not refresh; local data is retained.'); }
        }
      }).finally(() => { running = false; if (active && dirty) refresh(); });
    };
    // A change notification waits for the burst to end. Reading between two
    // notifications of the same write would publish an intermediate value and
    // start another read.
    const refresh = () => {
      dirty = true;
      if (!active) return;
      clearTimeout(settling);
      settling = setTimeout(() => { settling = undefined; start(); }, SETTLE_MS);
    };
    // A live gauge of the repository subscriptions this context holds. Every
    // reader goes through this one helper, so a switch that adds a subscription
    // and never releases it climbs `active['rx.subscriptions']` — which is the
    // "does a board switch return to its starting count" question, answerable
    // without reading every `useEffect` in the UI.
    collaborationCounters.adjustActive("rx.subscriptions", 1);
    let counted = true;
    return {
      refresh,
      // The first read is immediate: a subscription must publish its current
      // value without waiting for a settling window.
      readNow: () => { dirty = true; start(); },
      stop: () => {
        active = false; clearTimeout(settling);
        if (counted) { counted = false; collaborationCounters.adjustActive("rx.subscriptions", -1); }
      }
    };
  }
  /**
   * What the sidebar's project list renders: each visible board's identity and
   * the value the picker shows, in list order. `updatedAt` and `revision` are
   * deliberately absent — `revision` is the projection's operation-vector sum
   * and `updatedAt` is bumped by every local edit on any board, so comparing
   * either makes a background board's work a full list render, which is
   * exactly the cost this comparison exists to remove. Nothing in the sidebar
   * reads them (`ProjectPicker` renders `project.name`; the list is otherwise
   * `projects.length`), and `subscribeProjects` still re-reads on every
   * settled burst, so a suppressed emission never leaves a stale value behind:
   * the next genuine change publishes the whole current list.
   */
  const projectListShape = (projects: Project[]): string => JSON.stringify(projects.map(project => [
    project.id, project.name, project.template
  ]));
  /**
   * What the current-board subscription renders: the selected board (or, when
   * the selection is gone, the first listed board) as the board the sidebar
   * shows — its identity, its name, and the template that decides how its
   * items are drawn. Renaming it or changing its template still notifies;
   * adding a card on it does not, because the card subscriptions own that
   * render. `revision` is excluded for the same reason as in the list: it
   * moves on every applied batch and is not displayed.
   */
  const currentProjectShape = (project: Project | null): string => JSON.stringify(project
    ? [project.id, project.name, project.template]
    : null);
  const subscribeProjects = (listener: (value: Project[]) => void) => {
    const { refresh, readNow, stop } = subscribeRead("projects", listProjects, listener,
      (previous, next) => projectListShape(previous) === projectListShape(next));
    const first = projects.find().$.subscribe(refresh);
    const second = settings.find().$.subscribe(refresh);
    // The project list mirrors the project documents, the settings that record
    // the account's order, the pending-edit overlay and the board-erasure
    // markers. A journal change in another table — the change log, the
    // permissions, the drafts — does not change it, so it must not re-read
    // the list and re-render the board.
    const stopJournal = journal.subscribe((tables) => {
      if (tables.includes("pendingEdits")) invalidatePendingEdits();
      if (!tables.length || tables.includes("pendingEdits") || tables.includes("receipts")) refresh();
    });
    readNow();
    return () => { stop(); first.unsubscribe(); second.unsubscribe(); stopJournal(); };
  };
  const subscribeCurrentProject = (listener: (value: Project | null) => void) => {
    const { refresh, readNow, stop } = subscribeRead("currentProject", getCurrentProject, listener,
      (previous, next) => currentProjectShape(previous) === currentProjectShape(next));
    const first = settings.find().$.subscribe(refresh);
    const second = projects.find().$.subscribe(refresh);
    const stopJournal = journal.subscribe((tables) => {
      if (tables.includes("pendingEdits")) invalidatePendingEdits();
      if (!tables.length || tables.includes("pendingEdits") || tables.includes("receipts")) refresh();
    });
    refresh();
    return () => { stop(); first.unsubscribe(); second.unsubscribe(); stopJournal(); };
  };
  const subscribeCards = (projectId: string, listener: (value: BoardItem[]) => void) =>
    subscribe(cards.find({ selector: { projectId }, sort: [{ projectId: "asc" }, { orderKey: "asc" }] }), () => listCards(projectId), listener);
  const subscribeCard = (id: string, listener: (value: BoardItem | null) => void) => subscribe(cards.findOne(id), () => getCard(id), listener);
  async function load(): Promise<AppState> { return exportAll(); } // Compatibility for old command callers; not a reactive read path.
  const conflicts = createConflictResolution({ journal, collections: { cards, projects }, assertCanMutate, isDeletedProject,
    excludedBoards: () => new Set(operationSource.bindings.keys()),
    ignoreBoard: boardId => operationSource.bindings.has(boardId),
    listVisibleBoards: async () => (await listProjects()).map(project => project.id),
    changed, touchProject, hasImage: blobs.hasBlob, locked,
    canDraft: async boardId => { try { await assertCanMutate(boardId, true); return !!(await journal.permissions.get(boardId))?.authorityKeyId && !liveBoardRole(cards, boardId); } catch { return false; } } });
  const privateRecovery = createPrivateRecovery({ db, journal, blobs, locked });
  async function listPendingWork() {
    let heads = pendingHeads(await pendingEdits());
    if (!heads.length) return [];
    const reviews = await journal.read<PendingReviewRecord[]>('operationCheckpoints', store => store.index('kind').getAll('operation-pending-review'));
    const operations = await journal.read<OperationRecord[]>('operations', store => store.getAll());
    const reviewed = adoptedPendingIds(reviews, operations, new Set(operationSource.bindings.keys()));
    heads = heads.filter(edit => !reviewed.has(edit.id));
    if (!heads.length) return [];
    // "No handle" check: a board the current account list does not show — removed
    // (hidden), hard-removed, or filtered by the active account scope — leaves its
    // work as retained evidence with a restore handle rather than as blocked work.
    const visible = new Set((await listProjects()).map(project => project.id));
    const boards = new Map<string, Promise<{ role: ReturnType<typeof liveBoardRole>; permission: Awaited<ReturnType<typeof journal.permissions.get>>; boardMissing: boolean; boardName: unknown }>>();
    for (const { boardId } of heads) if (!boards.has(boardId)) boards.set(boardId, (async () => {
      const permission = await journal.permissions.get(boardId);
      const binding = operationSource.bindings.get(boardId);
      const role = binding ? binding.role === 'revoked' ? null : binding.role : liveBoardRole(cards, boardId);
      const boardMissing = !visible.has(boardId);
      const boardDoc = await projects.findOne(boardId).exec();
      const boardName = boardDoc?.name ?? (await journal.committedEntries()).find(e => e.collection === 'projects' && e.boardId === boardId)?.value.name;
      return { permission, role, boardMissing, boardName };
    })());
    return Promise.all(heads.map(async edit => {
      const { permission, role, boardMissing, boardName } = await boards.get(edit.boardId)!;
      return { ...edit, boardMissing, boardName, canReview: !boardMissing && (role === 'owner' || role === 'editor'),
        reason: operationSource.bindings.has(edit.boardId) ? 'Review this retained legacy draft as a new operation. Its original bytes remain available for export.' : boardMissing ? 'This board was removed from this account’s list. Its work stays here; restore the board to review it.'
          : permission?.role === 'revoked' ? 'Access was removed. Export or make a private copy.' : permission?.role === 'viewer' ? 'View-only access. Work remains available for export.'
          : edit.deviceKeyId !== permission?.deviceKeyId ? 'Review this recovered draft as a new edit on this device.' : !role ? 'Waiting for current board authorization.' : 'Ready for authorized reconciliation.' };
    }));
  }
  async function reviewPendingWork(id: string, reviewedIds: string[]) {
    let adoptedOperation = false;
    await locked(async () => {
      const selected = await journal.pendingEdits.get(id); if (!selected) throw new Error('Pending version is missing');
      await assertCanMutate(selected.boardId);
      const current = pendingHeads(await pendingEdits()).filter(e => e.boardId === selected.boardId && e.base.collection === selected.base.collection && e.base.documentId === selected.base.documentId);
      if (canonicalize(current.map(e => e.id).sort()) !== canonicalize([...reviewedIds].sort()) || !current.some(e => e.id === id)) throw new Error('Pending versions changed; review them again');
      const binding = operationSource.bindings.get(selected.boardId);
      if (binding) {
        if (selected.base.collection === 'projects' && selected.value._deleted && binding.role !== 'owner') throw new Error('Only the Drive owner may approve board deletion');
        const command = commandFromChange({ ...selected.base, value: selected.value, origin: 'local', state: 'committed' }, selected.creation ? [] : [selected.base.value]);
        if (!command) throw new Error('This draft has no changed board properties; its original is available for export');
        const operation = await operationSource.local.append(selected.boardId, command, await operationSource.local.observed(selected.boardId), `pending:${selected.id}`);
        await journal.operationTransaction<void>(selected.boardId, ['operationCheckpoints'], (tx, result) => {
          tx.objectStore('operationCheckpoints').put({ id: `pending-review:${selected.id}`, kind: 'operation-pending-review', boardId: selected.boardId, reviewedIds: [...reviewedIds], operationId: operation.opId }); result(undefined);
        });
        adoptedOperation = true; await changed(selected.boardId); return;
      }
      const permission = (await journal.permissions.get(selected.boardId))!;
      if (selected.base.collection === 'projects' && selected.value._deleted && permission.role !== 'owner') throw new Error('Only an owner may approve board deletion');
      await journal.pendingEdits.put({ ...selected, id: newId(), deviceKeyId: permission.deviceKeyId!, authorityKeyId: permission.authorityKeyId!, supersedes: current.map(e => e.id), admittedChangeId: undefined, projected: undefined });
      await changed(selected.boardId);
    });
    if (adoptedOperation) return;
    const edit = (await journal.pendingEdits.get(id))!; await admitPendingWork(edit.boardId);
  }
  async function discardRemovedBoardWork(boardId: string, reviewedIds: string[], privateAccount?: string) {
    const reviewed = [...reviewedIds];
    await locked(async () => {
      if ((await listProjects()).some(project => project.id === boardId)) throw new Error('Remove this board from the list before permanently deleting its retained work.');
      const retained = (await pendingEdits()).filter(edit => edit.boardId === boardId);
      await eraseLocalBoardData(boardId, privateAccount, retained, reviewed);
    });
  }
  /** Account-private erasure, never an unsigned shared-board deletion. */
  async function eraseLocalBoardData(boardId: string, privateAccount?: string, retained: PendingEdit[] = [], reviewed?: string[]) {
    if ((await journal.boardErasure(boardId))?.localPurged) { await events.projectErased?.(boardId); return; }
    const history = await journal.entries.where('boardId').equals(boardId).toArray();
    const pending = [...retained, ...(await pendingEdits()).filter(edit => edit.boardId === boardId)];
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
        || (await pendingEdits()).some(edit => edit.value.imageId === imageId || edit.base.value.imageId === imageId)
        || (await cards.find().exec()).some(doc => doc.imageId === imageId);
      if (!referenced) await blobs.deleteBlob(imageId);
    }
    await journal.receipts.update(marker.id, { localPurged: true } as any);
    await events.projectErased?.(boardId);
    if ((await settings.findOne('currentProjectId').exec())?.value === boardId) await settings.upsert({ id: 'currentProjectId', value: (await listProjects())[0]?.id ?? '' });
  }
  async function permanentlyDeleteBoard(boardId: string, privateAccount?: string) {
    await locked(async () => {
      const retained = (await pendingEdits()).filter(edit => edit.boardId === boardId);
      const reviews = await journal.read<PendingReviewRecord[]>('operationCheckpoints', store => store.index('kindBoard').getAll(['operation-pending-review', boardId]));
      const operations = await journal.read<OperationRecord[]>('operations', store => store.getAll());
      await eraseLocalBoardData(boardId, privateAccount, retained, confirmableIds(retained, reviews, operations, new Set(operationSource.bindings.keys())));
    });
  }
  async function applyPrivateBoardErasure(boardId: string, accountId: string) {
    await locked(async () => {
      const bound = (await settings.findOne(`privateDrive:${await hashBlob(new Blob([boardId]))}`).exec())?.value;
      if (bound && bound !== accountId) throw new Error('Board erasure belongs to another private account');
      await eraseLocalBoardData(boardId, accountId);
    });
  }
  // `locked` is published because a callback that runs inside a critical section can only
  // re-acquire the section it already owns through the acquirer that section hands it.
  const api = { db, blobs, journal, operationSource, locked,
    async bindOperationBoard(binding: OperationBinding, coveredIds: string[] = []) { await operationSource.bind(binding, coveredIds); },
    reconciliation, privateRecovery, installBoardSecurity, admitPendingWork, listPendingWork, reviewPendingWork, discardRemovedBoardWork, permanentlyDeleteBoard, applyPrivateBoardErasure,
    subscribePendingWork(listener: (value: Awaited<ReturnType<typeof listPendingWork>>) => void) {
      const { refresh, readNow, stop } = subscribeRead("pendingWork", listPendingWork, listener);
      const unsubscribe = journal.subscribe((tables) => { if (tables.includes("pendingEdits")) invalidatePendingEdits(); refresh(); }); readNow();
      return () => { stop(); unsubscribe(); };
    },
    async exportPendingWork(boardId: string) { return { format: "pboard-pending-work-v1" as const, boardId,
      edits: (await pendingEdits()).filter(e => e.boardId === boardId),
      images: await Promise.all([...new Set((await pendingEdits()).filter(e => e.boardId === boardId).flatMap(e => [e.value.imageId, e.base.value.imageId]).filter((id): id is string => typeof id === 'string'))].map(async imageId => {
        const image = await blobs.getBlob(imageId); if (!image) throw new Error('A pending image is missing; the draft remains locally recoverable');
        return { ...image, imageId, blob: undefined, dataUrl: await blobToDataUrl(image.blob) };
      })) }; }, ...conflicts, load, exportAll, exportProject, importProject, mergeSharedSnapshot, importState, removeProject, migrationComplete, markMigrationComplete, markMigrationIncomplete, setMutatorRole,
    createProject, selectProject, reorderProjects, setProjectOrderAccount, getProjectOrder, applyProjectOrder, applyRealtimeProjectOrder, isDeletedProject, projectDeletionTime, renameProject, deleteProject, isErasingBoard, changeProjectTemplate, unhideProject,
    migrateLegacyDeletions, legacyDeletionDiagnostic: () => legacyDeletionDiagnostic, boardDeletionState: (boardId: string) => journal.boardTombstone(boardId),
    /** Merge one tombstone fact received from the account room. See
     *  `applyBoardTombstoneFact`: the same store and the same ordering rule as
     *  the local delete/restore path, plus the list/row agreement the fact
     *  implies on this device. */
    applyBoardTombstoneFact,
    /**
     * What happened to the board's Drive folder — the deletion's second half.
     * `null` means this device owed nothing (a collaborator's leave, an adopted
     * legacy marker, or a board deleted by a build before the cleanup existed).
     * `pending`/`failed` carry the reason the folder is still there; `trashed`
     * carries the confirmed folder ids. Read by the deletion report next to the
     * board's own sync status, never by the list itself.
     */
    boardDriveCleanup: (boardId: string) => journal.boardCleanup(boardId),
    /** Every board whose Drive folder this device still owes, for the deletion
     *  report: `pending`/`failed` only, and bounded by how many boards were
     *  deleted rather than by how many boards exist. */
    pendingBoardCleanups: () => journal.pendingBoardCleanups(),
    /**
     * The deletion report the UI reads: pending cleanups, filtered to boards
     * that are still deleted (a restore clears the record, and a record left by
     * an older build must not name a live board). One read, so the panel cannot
     * show a board the list has already resurrected.
     */
    boardCleanupReport: async () => {
      const rows = await journal.pendingBoardCleanups();
      if (!rows.length) return [];
      const visible = new Set((await listProjects()).map(project => project.id));
      const stillDeleted: typeof rows = [];
      for (const row of rows) {
        // `isDeletedProject` consults the tombstone and the erasure marker; the
        // visible list check catches a board the projection already brought back
        // before the tombstone read settles.
        if (visible.has(row.boardId)) continue;
        if (await isDeletedProject(row.boardId)) stillDeleted.push(row);
      }
      return stillDeleted;
    },
    /** The deletion report, live. One journal subscription while a reader is
     *  attached (the header while the sidebar is open), released by its
     *  unsubscribe — the same shape as every other recovery view. */
    subscribeBoardCleanups(listener: (value: { boardId: string; cleanup: BoardCleanupState }[]) => void) {
      const read = async () => { try { listener(await api.boardCleanupReport()); } catch { listener([]); } };
      const unsubscribe = journal.subscribe(tables => { if (!tables.length || tables.includes("boardTombstones")) void read(); });
      void read();
      return () => { unsubscribe(); };
    },
    recordBoardDeletion: (boardId: string, input: { kind?: "deleted" | "restored"; role?: "owner" | "editor" | "viewer"; evidence: string; at?: string }) =>
      journal.recordBoardDeletion({ boardId, accountId: tombstoneScope(), context: {}, role: input.role ?? "owner", at: input.at ?? now(),
        evidence: input.evidence, kind: input.kind ?? "deleted" }),
    addItem, updateItem, deleteItem, duplicateItem, emptyTrash, mergeItems, reorderItems, moveItem, rebalanceProject,
    getCurrentProject, getProject, listProjects, listCards, listCardsByStatus, getCard,
    subscribeProjects, subscribeCurrentProject, subscribeCards, subscribeCard,
    putImage, getImage: blobs.getBlob, hasImage: blobs.hasBlob, imageAvailability: blobs.imageAvailability, deleteImage,
    subscribeImages: blobs.subscribe, importImages };
  const legacyConflicts = api.listConflicts;
  api.listConflicts = async () => (await legacyConflicts()).filter(conflict => !operationSource.bindings.has(conflict.boardId));
  if (!options.pendingScratch) {
    const resolve = api.resolveConflict;
    api.resolveConflict = async request => {
      const permission = await journal.permissions.get(request.boardId);
      if (options.offlineDrafts === false) return resolve(request);
      if (!permission?.authorityKeyId || liveBoardRole(cards, request.boardId)) return resolve(request);
      await assertCanMutate(request.boardId, true);
      await locked(async () => {
        const result = await reconciliation.inspect(request);
        if (!["conflict", "mergeable"].includes(result.kind) || canonicalize([...request.heads].sort()) !== canonicalize([...result.heads].sort()) || result.heads.length > 8) throw new Error('Conflict changed; review its current versions');
        if (pendingHeads(await pendingEdits()).some(e => e.boardId === request.boardId && e.base.documentId === request.documentId)) throw new Error('Review existing pending versions before drafting another resolution');
        const selected = result.variants.find(e => e.id === request.variantId); if (!selected) throw new Error('Select a reviewed version');
        if (request.collection === 'projects' && result.variants.some(e => e.value._deleted) && permission.role !== 'owner') throw new Error('Only an owner may resolve board deletion');
        const value = pendingValue(selected.value);
        if (request.edits) Object.assign(value, request.edits);
        const edit: PendingEdit = { id: newId(), boardId: request.boardId, base: selected, value, deviceKeyId: permission.deviceKeyId!, authorityKeyId: permission.authorityKeyId!, parents: result.heads, supersedes: pendingHeads(await pendingEdits()).filter(e => e.base.documentId === request.documentId).map(e => e.id) };
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
        // Draft routing belongs to the signed-guard world. In the operation
        // build (offlineDrafts: false) no live role is ever installed, so a
        // draft here could never be admitted: the edit would sit under
        // "Synchronization pending" while its overlay made it look saved.
        // Commands run for real instead and the operation service takes the
        // board over — Drive-first — at the next synchronization.
        if (options.offlineDrafts === false) return original(...args);
        const permission = await journal.permissions.get(boardId);
        if (operationSource.bindings.has(boardId)) return original(...args);
        if (!permission?.authorityKeyId) {
          if (command !== 'deleteProject' && (await pendingEdits()).some(e => e.boardId === boardId)) await assertCanMutate(boardId);
          return original(...args);
        }
        if (liveBoardRole(cards, boardId) && !pendingHeads((await pendingEdits()).filter(e => e.boardId === boardId)).length) return original(...args);
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
  // Legacy `deletedProjectIds` markers become tombstones before anything reads
  // the board list. Reliable evidence only; the unknown case is reported, not
  // decided, and no Drive object is touched.
  await migrateLegacyDeletions().catch(() => undefined);
  return api;
}

export type RxRepository = Awaited<ReturnType<typeof createRxRepository>>;
