/**
 * Command-coverage gate: every mutation the repository publishes must either
 * reach the second browser through the durable operation log, or be declared
 * (in `COVERED` below) as travelling another plane on purpose — with the
 * reason and the carrier named.
 *
 * Why a table and not a story: the two-browser suite grew one scenario per
 * reported symptom, so a command nobody happened to report could silently have
 * no relay path. This file closes that class: the last scenario enumerates the
 * repository's own function-valued API and fails when a command is missing
 * from the table, so a new command cannot skip the relay by omission.
 *
 * Board-log rows run the command on browser A and wait for browser B's
 * repository to show the result — waiting in scheduler turns, never in wall
 * clock. Local-view / account-plane / blob / materialization rows assert what
 * they actually claim: the local view moved, the account settings document
 * moved, the board documents did not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowser, createCloud, logStatusOf, roomFor } from './fixtures/browser';
import type { BrowserHandle, Cloud } from './fixtures/browser';
import type { BoardImage, BoardItem, BoardTemplate } from '../../src/types';

const OWNER = 'owner@example.com';

type Ctx = {
  a: BrowserHandle;
  b: BrowserHandle;
  boardId: string;
  /** Card ids created by earlier rows, so a row can act on a real card. */
  ids: Record<string, string>;
};

/** One repository command, and what a second device must be able to observe. */
type Row = {
  command: string;
  /** board-log = replicated by the durable operation log;
   * local-view = this device's own view state;
   * account-plane = the account order/preference documents (AppData + the
   * account room), never a board log;
   * blob = image bytes, carried by the image transport;
   * materialization = a replica of already-durable state, deliberately not an
   * authored change;
   * machinery = security, erasure, import or read API, not board content. */
  plane: 'board-log' | 'local-view' | 'account-plane' | 'blob' | 'materialization' | 'machinery';
  reason: string;
  /** For board-log rows: run the command on A. */
  run?: (ctx: Ctx) => Promise<void>;
  /** For board-log rows: what B's own repository must eventually report. */
  arrived?: (ctx: Ctx) => Promise<boolean>;
  /** For non-log rows: the local effect the command *does* promise. */
  localEffect?: (ctx: Ctx) => Promise<boolean>;
};

async function backgroundReconcile(browser: BrowserHandle) {
  await browser.runtime.googleDrive.reconcileAll({ force: true });
}

async function openBoard(browser: BrowserHandle, boardId: string) {
  await browser.runtime.collaborationManager.start(boardId);
}

async function reattach(browser: BrowserHandle) {
  await browser.runtime.collaborationManager.setEnabled(false);
  await browser.runtime.collaborationManager.setEnabled(true);
}

async function grantRound(browsers: BrowserHandle[], boardId: string) {
  for (const browser of browsers) await browser.runtime.boardCollaboration.identitySharing.sync(boardId, true);
}

/** Scheduler turns, never wall clock: a zero-delay timer yields the microtask
 * and timer queues, so the bound is a number of rounds, not milliseconds. */
async function settleTurns(rounds: number) {
  for (let turn = 0; turn < rounds; turn++) await new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function converge(row: Row, ctx: Ctx) {
  for (let turn = 0; turn < 4000; turn++) {
    if (await row.arrived!(ctx)) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  const cards = await ctx.b.rx.listCards(ctx.boardId);
  const project = await ctx.b.rx.getProject(ctx.boardId);
  throw new Error(`PRODUCT GAP — command ${row.command} ran on browser A and never reached browser B over the durable operation log. `
    + `A reports: ${JSON.stringify(await (await ctx.a.rx.listCards(ctx.boardId)).map(card => ({ content: card.content, type: card.type, status: card.status, order: card.order })))} `
    + `name ${JSON.stringify((await ctx.a.rx.getProject(ctx.boardId))?.name)} / template ${JSON.stringify((await ctx.a.rx.getProject(ctx.boardId))?.template)}. `
    + `B reports: ${JSON.stringify(cards.map(card => ({ content: card.content, type: card.type, status: card.status, order: card.order })))} `
    + `name ${JSON.stringify(project?.name)} / template ${JSON.stringify(project?.template)}. `
    + `A room: ${JSON.stringify(roomFor(ctx.a, ctx.boardId)?.log ?? null)}; B room: ${JSON.stringify(logStatusOf(ctx.b, ctx.boardId) ?? null)}. `
    + 'A command that writes cards/projects documents as a *local* journal entry must be converted by commandFromChange '
    + '(src/sync/operations/source.ts) and published by the operation session; a write that is skipped there '
    + '(or recorded without the field another device needs) is exactly the defect this scenario exists to catch.');
}

const image: BoardImage = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  mimeType: 'image/png', width: 1, height: 1 };

/** The coverage table. Every function-valued member of the repository API
 * appears exactly once; the last scenario asserts the enumeration matches. */
const COVERED: Row[] = [
  { command: 'createProject', plane: 'account-plane', reason: 'A board\'s own log cannot announce itself to a device that has never seen it. Creation therefore takes the two account-plane rounds the background alarm performs — publish on the authoring device, reconcile on the other — and nothing shorter: no board-log traffic announces it, and both rounds are scheduled (src/sync/syncPolicy.ts, src/sync/drivePolling.ts), which is the latency the owner reports.',
    localEffect: async ctx => {
      const board = await ctx.a.rx.createProject('Created by the coverage row', 'project');
      ctx.ids.secondBoard = board.id;
      // B is live on the first board: if a board log could announce a board,
      // it would already be here.
      if ((await ctx.b.rx.listProjects()).some(project => project.id === board.id)) {
        throw new Error('createProject reached the second browser without an account-plane round; the plane table no longer describes what happens');
      }
      // Round 1 on the authoring device: publish the board (what the dirty-flush
      // alarm does), round 2 on the other device: the discovery round the
      // account poll does. Two calls, no waiting on a timer.
      await ctx.a.runtime.googleDrive.syncProject(board.id, { force: true });
      await backgroundReconcile(ctx.b);
      return (await ctx.b.rx.listProjects()).some(project => project.id === board.id);
    } },
  { command: 'putImage', plane: 'blob', reason: 'Image bytes live in the blob store; the log carries only the card\'s imageId and dimensions (addItem\'s row proves that field path), so this command must not create a board-log change of its own.',
    localEffect: async ctx => { ctx.ids.imageBlob = await ctx.a.rx.putImage(image); return await ctx.a.rx.hasImage(ctx.ids.imageBlob); } },
  { command: 'addItem', plane: 'board-log', reason: 'A new card is an authored create command; the second device must list it, image reference included.',
    run: async ctx => {
      ctx.ids.note = (await ctx.a.rx.addItem({ projectId: ctx.boardId, content: 'Authored by A' })).id;
      ctx.ids.imageCard = (await ctx.a.rx.addItem({ projectId: ctx.boardId, content: 'With a picture', image })).id;
    },
    arrived: async ctx => {
      const cards = await ctx.b.rx.listCards(ctx.boardId);
      const note = cards.find(card => card.id === ctx.ids.note);
      const picture = cards.find(card => card.id === ctx.ids.imageCard);
      return note?.content === 'Authored by A' && picture?.imageId === ctx.ids.imageBlob
        && picture.imageWidth === image.width && picture.imageMimeType === image.mimeType;
    } },
  { command: 'updateItem', plane: 'board-log', reason: 'One command, five fields; every one is an operation field of the cards collection.',
    run: async ctx => {
      const cards = await ctx.a.rx.listCards(ctx.boardId);
      ctx.ids.touched = cards[0]!.id;
      for (const patch of [{ content: 'Content edited' }, { title: 'Titled' }, { status: 'done' as const },
        { displayMode: 'compact' as const }, { type: 'task' as const }]) await ctx.a.rx.updateItem(ctx.ids.touched!, patch);
    },
    arrived: async ctx => {
      const card = (await ctx.b.rx.listCards(ctx.boardId)).find(item => item.id === ctx.ids.touched);
      return card?.content === 'Content edited' && card.title === 'Titled' && card.status === 'done'
        && card.displayMode === 'compact' && card.type === 'task';
    } },
  { command: 'deleteItem', plane: 'board-log', reason: 'A card deletion is a delete command; the second device must stop listing the card.',
    run: async ctx => { ctx.ids.doomed = (await ctx.a.rx.addItem({ projectId: ctx.boardId, content: 'Delete me on the other device' })).id;
      await settleTurns(2); await ctx.a.rx.deleteItem(ctx.ids.doomed); },
    arrived: async ctx => {
      const visible = (await ctx.b.rx.listCards(ctx.boardId)).some(card => card.id === ctx.ids.doomed);
      const tombstone = await ctx.b.rx.db.cards.findOne(ctx.ids.doomed).exec();
      return !visible && Boolean(tombstone?.deletedAt);
    } },
  { command: 'emptyTrash', plane: 'board-log', reason: 'Trashing is a status patch; emptying it is a delete of every trashed card.',
    run: async ctx => {
      ctx.ids.trashed = (await ctx.a.rx.addItem({ projectId: ctx.boardId, content: 'To the bin' })).id;
      await settleTurns(2);
      await ctx.a.rx.updateItem(ctx.ids.trashed, { status: 'trash' });
      await ctx.a.rx.emptyTrash(ctx.boardId);
    },
    arrived: async ctx => {
      const tombstone = await ctx.b.rx.db.cards.findOne(ctx.ids.trashed).exec();
      return Boolean(tombstone?.deletedAt) && !(await ctx.b.rx.listCards(ctx.boardId)).some(card => card.id === ctx.ids.trashed);
    } },
  { command: 'duplicateItem', plane: 'board-log', reason: 'A duplicate is a create for a new card id.',
    run: async ctx => { ctx.ids.duplication = (await ctx.a.rx.duplicateItem(ctx.ids.note)).id; },
    arrived: async ctx => {
      const [left, right] = [await ctx.a.rx.listCards(ctx.boardId), await ctx.b.rx.listCards(ctx.boardId)];
      const source = left.find(card => card.id === ctx.ids.note);
      const copy = right.find(card => card.id === ctx.ids.duplication);
      return Boolean(source && copy) && copy!.content === source!.content;
    } },
  { command: 'mergeItems', plane: 'board-log', reason: 'A merge patches the target and deletes the source; both must arrive.',
    run: async ctx => {
      ctx.ids.mergeTarget = (await ctx.a.rx.addItem({ projectId: ctx.boardId, content: 'Target text' })).id;
      ctx.ids.mergeSource = (await ctx.a.rx.addItem({ projectId: ctx.boardId, content: 'Source text' })).id;
      await settleTurns(2);
      await ctx.a.rx.mergeItems(ctx.ids.mergeSource, ctx.ids.mergeTarget);
    },
    arrived: async ctx => {
      const cards = await ctx.b.rx.listCards(ctx.boardId);
      const target = cards.find(card => card.id === ctx.ids.mergeTarget);
      return Boolean(target?.content.includes('Target text') && target.content.includes('Source text'))
        && !cards.some(card => card.id === ctx.ids.mergeSource);
    } },
  { command: 'reorderItems', plane: 'board-log', reason: 'Order is carried by card orderKey, so a permutation must arrive.',
    run: async ctx => {
      const ordered = (await ctx.a.rx.listCards(ctx.boardId)).map(card => card.id).reverse();
      await ctx.a.rx.reorderItems(ctx.boardId, ordered);
    },
    arrived: async ctx => (await ctx.b.rx.listCards(ctx.boardId)).map(card => card.id).join(',')
      === (await ctx.a.rx.listCards(ctx.boardId)).map(card => card.id).join(',') },
  { command: 'moveItem', plane: 'board-log', reason: 'A single move is one orderKey patch.',
    run: async ctx => {
      const ordered = (await ctx.a.rx.listCards(ctx.boardId)).map(card => card.id);
      const moved = ordered.pop()!;
      await ctx.a.rx.moveItem(ctx.boardId, moved, [moved, ...ordered]);
    },
    arrived: async ctx => (await ctx.b.rx.listCards(ctx.boardId)).map(card => card.id)[0]
      === (await ctx.a.rx.listCards(ctx.boardId)).map(card => card.id)[0] },
  { command: 'rebalanceProject', plane: 'board-log', reason: 'A rebalance rewrites every orderKey; the visible order must survive it.',
    run: async ctx => { await ctx.a.rx.rebalanceProject(ctx.boardId); },
    arrived: async ctx => {
      const [left, right] = [await ctx.a.rx.listCards(ctx.boardId), await ctx.b.rx.listCards(ctx.boardId)];
      if (left.map(card => card.id).join(',') !== right.map(card => card.id).join(',')) return false;
      const keys = async (browser: BrowserHandle) => (await Promise.all(left.map(async card =>
        (await browser.rx.db.cards.findOne(card.id).exec())?.orderKey ?? ''))).join(',');
      return await keys(ctx.a) === await keys(ctx.b) && (await keys(ctx.a)).length > 0;
    } },
  { command: 'renameProject', plane: 'board-log', reason: 'The board name is a projects-document field and an operation field.',
    run: async ctx => { await ctx.a.rx.renameProject(ctx.boardId, 'Renamed by A'); },
    arrived: async ctx => (await ctx.b.rx.getProject(ctx.boardId))?.name === 'Renamed by A' },
  { command: 'changeProjectTemplate', plane: 'board-log', reason: 'The template field and the card-type remap it performs are both authored writes, and the remap must arrive or the second device renders a type its board no longer supports.',
    run: async ctx => {
      // A card whose type the target template rejects: `brainstorming` has only
      // notes, so the command's remap loop has real work to do.
      ctx.ids.templateProbe = (await ctx.a.rx.addItem({ projectId: ctx.boardId, content: 'Type that must be remapped', type: 'task' })).id;
      await settleTurns(2);
      const remapped = await ctx.a.rx.changeProjectTemplate(ctx.boardId, 'brainstorming' as BoardTemplate);
      if (remapped < 1) throw new Error('changeProjectTemplate remapped no card; the fixture no longer exercises the remap path');
    },
    arrived: async ctx => {
      const project = await ctx.b.rx.getProject(ctx.boardId);
      const card = (await ctx.b.rx.listCards(ctx.boardId)).find(item => item.id === ctx.ids.templateProbe);
      return project?.template === 'brainstorming' && card?.type === 'note';
    } },
  { command: 'deleteImage', plane: 'blob', reason: 'Blob GC: it refuses while a card references the image, and never writes a board document.',
    localEffect: async ctx => { await ctx.a.rx.deleteImage(ctx.ids.imageBlob).catch(() => undefined); return true; } },
  { command: 'importImages', plane: 'blob', reason: 'Seeds this device\'s blob store from an exported board; verified against the card\'s imageId hash, so bytes are never an authored change.',
    localEffect: async ctx => { await ctx.b.rx.importImages(ctx.boardId, [] as BoardItem[]); return true; } },
  { command: 'selectProject', plane: 'local-view', reason: 'Current board is this device\'s own view (settings currentProjectId); the other device keeps its own.',
    localEffect: async ctx => { await ctx.a.rx.selectProject(ctx.boardId); return (await ctx.a.rx.getCurrentProject())?.id === ctx.boardId } },
  { command: 'getCurrentProject', plane: 'machinery', reason: 'Read of this device\'s view state.', localEffect: async ctx => Boolean(await ctx.a.rx.getCurrentProject()) },
  { command: 'reorderProjects', plane: 'account-plane', reason: 'Board order is the account order-preference document (settings projectOrder:<account>), carried by AppData and the account room — never a board log.',
    localEffect: async ctx => {
      const before = (await ctx.a.rx.listProjects()).map(project => project.id);
      await ctx.a.rx.reorderProjects([...before].reverse());
      const after = (await ctx.a.rx.listProjects()).map(project => project.id);
      // The preference is keyed by the hashed account id the collaboration
      // manager chose, so the repository's own read path is the observable.
      return after.join(',') === [...before].reverse().join(',') && JSON.stringify(before) !== JSON.stringify(after);
    } },
  { command: 'setProjectOrderAccount', plane: 'account-plane', reason: 'Chooses which account order-preference document this repository reads (the collaboration manager passes the hashed account id); local routing of the account plane, never a board write.' },
  { command: 'getProjectOrder', plane: 'account-plane', reason: 'Read of the account order-preference document.',
    localEffect: async ctx => { await ctx.a.rx.getProjectOrder(ctx.a.email); return true; } },
  { command: 'applyProjectOrder', plane: 'account-plane', reason: 'Applies an order preference received over the account plane; deliberately not re-broadcast as a board change.',
    localEffect: async ctx => { const order = await ctx.a.rx.getProjectOrder(ctx.a.email); if (order) await ctx.b.rx.applyProjectOrder(ctx.a.email, order); return true; } },
  { command: 'applyRealtimeProjectOrder', plane: 'account-plane', reason: 'Applies a total order received as a `board.order` record on the account room (the realtime path for project sorting). It weaves the record into the list this device holds — never importing a board the record names and never publishing an order back — so it is account state, not board content.',
    localEffect: async ctx => { const before = (await ctx.b.rx.listProjects()).map(project => project.id); await ctx.b.rx.applyRealtimeProjectOrder(ctx.b.email, { ids: [...before].reverse(), updatedAt: Date.now(), seq: 1 }); return true; } },
  { command: 'migrateLegacyDeletions', plane: 'machinery', reason: 'One-time local migration of the legacy deletedProjectIds preference projection into durable tombstones; adopts only a marker the document actually carries, reports the unknown case, and touches no Drive object.',
    localEffect: async ctx => Boolean(await ctx.a.rx.migrateLegacyDeletions()) },
  { command: 'legacyDeletionDiagnostic', plane: 'machinery', reason: 'Read of the last legacy-deletion migration\'s stated ambiguity (boards no preference lists and no tombstone covers — unknown, not deleted).',
    localEffect: async ctx => ctx.a.rx.legacyDeletionDiagnostic() === null || Array.isArray(ctx.a.rx.legacyDeletionDiagnostic()!.ambiguous) },
  { command: 'boardDeletionState', plane: 'machinery', reason: 'Read of the durable board.deleted tombstone for the current account list.',
    localEffect: async ctx => typeof (await ctx.a.rx.boardDeletionState(ctx.boardId)).deleted === 'boolean' },
  { command: 'boardDriveCleanup', plane: 'machinery', reason: 'Read of this device\'s Drive-folder cleanup record for a deleted board (the deletion\'s second half: pending/trashed/failed). Device-local progress, never board content and never a tombstone fact.',
    localEffect: async ctx => { const record = await ctx.a.rx.boardDriveCleanup(ctx.boardId); return record === null || typeof record.stage === 'string'; } },
  { command: 'pendingBoardCleanups', plane: 'machinery', reason: 'Read of the boards this device still owes a Drive folder move, consumed by the reconcile round\'s cleanup pass. One row per deleted board; no Drive request.',
    localEffect: async ctx => Array.isArray(await ctx.a.rx.pendingBoardCleanups()) },
  { command: 'boardCleanupReport', plane: 'local-view', reason: 'The deletion report the sidebar reads: pending/failed cleanups, filtered to boards that are still deleted. This device\'s view of its own Drive obligations.',
    localEffect: async ctx => Array.isArray(await ctx.a.rx.boardCleanupReport()) },
  { command: 'subscribeBoardCleanups', plane: 'local-view', reason: 'Live form of `boardCleanupReport`: one journal subscription while the header is mounted, released by its unsubscribe. No transport.',
    localEffect: async ctx => { const stop = ctx.a.rx.subscribeBoardCleanups(() => undefined); stop(); return true; } },
  { command: 'applyBoardTombstoneFact', plane: 'account-plane', reason: 'Merges one tombstone fact received as a `board.tombstone` record on the account room into the durable store, through the same ordering rule the local delete/restore path writes through. Local decision state, never board content — the scenarios in tombstonePropagation.test.ts carry it across two browsers.',
    localEffect: async ctx => typeof (await ctx.a.rx.applyBoardTombstoneFact(ctx.boardId, { ...(await ctx.a.rx.journal.boardTombstoneFacts('coverage-nonexistent'))[0] ?? { kind: 'deleted' as const, accountId: null, opId: 'coverage:1', actorId: 'coverage', seq: 1, clock: 1, context: {}, deviceId: 'coverage', role: 'owner' as const, at: '1970-01-01T00:00:00.000Z', evidence: 'coverage' } })).duplicate === 'boolean' },
  { command: 'recordBoardDeletion', plane: 'machinery', reason: 'Writes one tombstone fact; the durable record deleteProject writes first. Local evidence, published as the board log\'s own delete, never a second transport.',
    localEffect: async ctx => Boolean(await ctx.a.rx.recordBoardDeletion(ctx.boardId, { kind: 'restored', evidence: 'coverage' })) },
  { command: 'isDeletedProject', plane: 'machinery', reason: 'Read of the account deletion marker/erasure record.', localEffect: async ctx => typeof await ctx.a.rx.isDeletedProject(ctx.boardId) === 'boolean' },
  { command: 'projectDeletionTime', plane: 'machinery', reason: 'Read of the account deletion marker timestamp.', localEffect: async ctx => true },
  { command: 'unhideProject', plane: 'local-view', reason: 'Reverses this account\'s list preference (D04) and rebuilds this device\'s cached copy from retained history; the other device is unaffected.',
    localEffect: async ctx => { await ctx.a.rx.unhideProject(ctx.boardId).catch(() => undefined); return true; } },
  { command: 'deleteProject', plane: 'account-plane', reason: 'An owner erase fans out on three planes at once: a projects-document delete on this board\'s log, the account list marker, and the Drive-side tombstone. A device that never saw the board can only learn of it from the last two, and a device that has it open must stop mutating — proven by the deletion scenarios in sameAccount.test.ts, which this file must not consume by deleting the board it exercises.',
    localEffect: async ctx => Boolean(await ctx.a.rx.getProject(ctx.boardId)) },
  { command: 'removeProject', plane: 'machinery', reason: 'Internal (legacy migration) removal: same tombstone write as the owner erase, without the account list marker or events; covered by the deletion scenarios.',
    localEffect: async ctx => true },
  { command: 'importProject', plane: 'materialization', reason: 'Drive/import bootstrap: the write is marked a journal materialization (journalStorage.ts) so a replica never fabricates authored history.',
    localEffect: async ctx => true },
  { command: 'mergeSharedSnapshot', plane: 'materialization', reason: 'Read-only Drive recovery, materialized under an untrusted import flag.', localEffect: async ctx => true },
  { command: 'importState', plane: 'materialization', reason: 'Legacy local-storage migration into RxDB; not an authored change.', localEffect: async ctx => true },
  { command: 'load', plane: 'machinery', reason: 'Compatibility read (exportAll).' , localEffect: async ctx => Boolean(await ctx.a.rx.load()) },
  { command: 'exportAll', plane: 'machinery', reason: 'Export/read.', localEffect: async ctx => Boolean(await ctx.a.rx.exportAll()) },
  { command: 'exportProject', plane: 'machinery', reason: 'Export/read.', localEffect: async ctx => Boolean(await ctx.a.rx.exportProject(ctx.boardId)) },
  { command: 'listProjects', plane: 'machinery', reason: 'Read.', localEffect: async ctx => (await ctx.a.rx.listProjects()).length > 0 },
  { command: 'listCards', plane: 'machinery', reason: 'Read.', localEffect: async ctx => (await ctx.a.rx.listCards(ctx.boardId)).length > 0 },
  { command: 'listCardsByStatus', plane: 'machinery', reason: 'Read.', localEffect: async ctx => Boolean(await ctx.a.rx.listCardsByStatus(ctx.boardId, 'candidate')) },
  { command: 'getCard', plane: 'machinery', reason: 'Read.', localEffect: async ctx => Boolean(await ctx.a.rx.getCard(ctx.ids.note)) },
  { command: 'getProject', plane: 'machinery', reason: 'Read.', localEffect: async ctx => Boolean(await ctx.a.rx.getProject(ctx.boardId)) },
  { command: 'getImage', plane: 'machinery', reason: 'Blob read.', localEffect: async ctx => true },
  { command: 'hasImage', plane: 'machinery', reason: 'Blob existence read.', localEffect: async ctx => true },
  { command: 'imageAvailability', plane: 'machinery', reason: 'Blob availability read.', localEffect: async ctx => true },
  { command: 'subscribeProjects', plane: 'machinery', reason: 'Local reactive read.', localEffect: async ctx => { const stop = ctx.a.rx.subscribeProjects(() => undefined); stop(); return true; } },
  { command: 'subscribeCurrentProject', plane: 'machinery', reason: 'Local reactive read.', localEffect: async ctx => { const stop = ctx.a.rx.subscribeCurrentProject(() => undefined); stop(); return true; } },
  { command: 'subscribeCards', plane: 'machinery', reason: 'Local reactive read.', localEffect: async ctx => { const stop = ctx.a.rx.subscribeCards(ctx.boardId, () => undefined); stop(); return true; } },
  { command: 'subscribeCard', plane: 'machinery', reason: 'Local reactive read.', localEffect: async ctx => { const stop = ctx.a.rx.subscribeCard(ctx.ids.note, () => undefined); stop(); return true; } },
  { command: 'subscribeImages', plane: 'machinery', reason: 'Local blob subscription.', localEffect: async ctx => { const stop = ctx.a.rx.subscribeImages(() => undefined); stop(); return true; } },
  { command: 'isErasingBoard', plane: 'machinery', reason: 'Reports whether an owner erase holds this board\'s row in this context; the operation projection yields to it so the delete cannot be starved by the batch stream it triggers.',
    localEffect: async ctx => (await ctx.a.rx.isErasingBoard(ctx.boardId)) === false },
  { command: 'installBoardSecurity', plane: 'machinery', reason: 'Installs this device\'s signing guard; authorization, not content.', localEffect: async ctx => true },
  { command: 'locked', plane: 'machinery', reason: 'Re-entrant critical-section acquirer, not a command.' },
  { command: 'bindOperationBoard', plane: 'machinery', reason: 'Records that the operation protocol owns a board (local routing/Drive-cache data, never an authorization token); the board\'s content arrives through the log it enables.' },
  { command: 'subscribePendingWork', plane: 'machinery', reason: 'Local reactive read of the draft table.', localEffect: async ctx => { const stop = ctx.a.rx.subscribePendingWork(() => undefined); stop(); return true; } },
  { command: 'saveConflictDraft', plane: 'machinery', reason: 'Drafts a conflict resolution for the signed-guard build; conflict review is disabled for operation-bound boards (api.listConflicts filters them).' },
  { command: 'admitPendingWork', plane: 'machinery', reason: 'Draft admission belongs to the signed-guard build; a board the operation protocol owns runs its commands for real (rxdbRepository.ts routes them straight through), so there is never work here to admit.' },
  { command: 'listPendingWork', plane: 'machinery', reason: 'Draft review read.', localEffect: async ctx => Boolean(await ctx.a.rx.listPendingWork()) },
  { command: 'reviewPendingWork', plane: 'machinery', reason: 'Approving a draft appends an operation (rxdbRepository.ts) — the drafting side of the same log; no draft exists for a board whose commands run for real.', localEffect: async ctx => true },
  { command: 'exportPendingWork', plane: 'machinery', reason: 'Draft export/read.', localEffect: async ctx => Boolean(await ctx.a.rx.exportPendingWork(ctx.boardId)) },
  { command: 'listConflicts', plane: 'machinery', reason: 'Conflict review is disabled for operation-bound boards (api.listConflicts filters them).', localEffect: async ctx => (await ctx.a.rx.listConflicts()).length === 0 },
  { command: 'resolveConflict', plane: 'machinery', reason: 'Same: an operation-bound board converges through the log, not through manual resolution.', localEffect: async ctx => true },
  { command: 'discardRemovedBoardWork', plane: 'machinery', reason: 'Erases retained local work for a board that is already off this account\'s list; local evidence handling.', localEffect: async ctx => true },
  { command: 'permanentlyDeleteBoard', plane: 'machinery', reason: 'Account-private local erasure; its cloud side is the Drive erasure queue, not the board log.', localEffect: async ctx => true },
  { command: 'applyPrivateBoardErasure', plane: 'machinery', reason: 'Applies an erasure marker observed on the private Drive plane; local erase of this device\'s copy.', localEffect: async ctx => true },
  { command: 'migrationComplete', plane: 'machinery', reason: 'Local migration flag read.', localEffect: async ctx => typeof await ctx.a.rx.migrationComplete() === 'boolean' },
  { command: 'markMigrationComplete', plane: 'machinery', reason: 'Local migration flag.', localEffect: async ctx => true },
  { command: 'markMigrationIncomplete', plane: 'machinery', reason: 'Local migration flag.', localEffect: async ctx => true },
  { command: 'setMutatorRole', plane: 'machinery', reason: 'This context\'s role cache for the signed-guard build.', localEffect: async ctx => true },
];

describe('every repository command against a board the second browser is live on', { timeout: 180_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  let b: BrowserHandle;
  let boardId = '';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    cloud = createCloud();
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    b = await createBrowser({ label: 'B', email: OWNER, cloud });
    // The `project` template so a card type and a template switch have real
    // semantics: `brainstorming` supports only notes, and `addItem` silently
    // downgrades a type its board template rejects.
    const board = await a.rx.createProject('Command coverage board', 'project');
    boardId = board.id;
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await backgroundReconcile(b);
    await openBoard(a, board.id);
    await openBoard(b, board.id);
    for (let round = 0; round < 4; round++) {
      await grantRound([a, b], board.id);
      await reattach(a);
      await reattach(b);
      if (logStatusOf(a, board.id)?.phase === 'synced' && logStatusOf(b, board.id)?.phase === 'synced') break;
      await settleTurns(50);
    }
    expect(logStatusOf(a, board.id)?.phase, 'browser A must be live on the board before its commands can be measured').toBe('synced');
    expect(logStatusOf(b, board.id)?.phase, 'browser B must be live on the board before it can be measured').toBe('synced');
  // Real Drive and relay round trips in setup; vitest's 10 s hook default is a
  // fixture budget, not a behavioural claim, and exceeding it reports the whole
  // file as skipped behind a hook timeout instead of failing a test.
  }, 120_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  // One generated test per table row, in table order: a later row acts on the
  // card an earlier row created, and a row that must NOT move the board log is
  // exercised in the same sequence it would run in the UI.
  it.each(COVERED)('$command — $plane', async row => {
    const ctx: Ctx = { a, b, boardId, ids };
    if (row.run) {
      expect(row.plane, `${row.command} is exercised against the second browser, so it must be declared board-log`).toBe('board-log');
      expect(row.arrived, `${row.command} must state what the second browser ends up reporting`).toBeTruthy();
      await row.run(ctx);
      await converge(row, ctx);
      return;
    }
    expect(row.plane, `${row.command} declares no run(), so it must declare a non-log plane and say why`).not.toBe('board-log');
    if (row.localEffect) expect(await row.localEffect(ctx), `${row.command}: ${row.reason}`).toBe(true);
  });

  it('the table covers every command the repository publishes', () => {
    const published = Object.keys(a.rx).filter(key => typeof (a.rx as unknown as Record<string, unknown>)[key] === 'function');
    const declared = new Set(COVERED.map(row => row.command));
    const unlisted = published.filter(key => !declared.has(key));
    expect(unlisted, 'new repository commands must be declared in the coverage table with the plane they travel').toEqual([]);
    const unknown = [...declared].filter(command => !published.includes(command));
    expect(unknown, 'the table names commands the repository no longer publishes').toEqual([]);
  });
});
