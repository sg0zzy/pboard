import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';

/**
 * W8 — a write on a background board must not re-render the sidebar.
 *
 * The project-list and current-board subscriptions both read whole
 * collections, and the projection rewrites a board's row (its `revision` and
 * `tailOrderKey`) on every applied operation batch while a receipt is written
 * per downloaded file. Every one of those notifications used to publish a
 * freshly read value and re-render the whole board — for a board the person was
 * not looking at, and, in the receipt case, without anything having changed.
 *
 * Two rules make this decidable, both verified by mutation (see the report):
 *  - **Phases are separated by their own settle window.** The repository
 *    coalesces a burst of notifications into one read after `SETTLE_MS` (8 ms).
 *    A background write followed immediately by the barrier therefore lands in
 *    *one* window and produces one emission either way — a false pass. Each
 *    phase here is closed before the next begins (`phase()` waits out the
 *    window), so "the background phase emitted nothing" is a real question.
 *  - **Every phase asserts exact counts, and the barrier phase asserts its own
 *    exact count.** A count of 1 after the barrier is only meaningful next to a
 *    background phase of 0; asserting both is what distinguishes a suppressed
 *    emission from a coalesced one.
 */
const repos: RxRepository[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.db.close();
});

async function setup() {
  const rx = await createRxRepository({
    name: `w8${crypto.randomUUID().replaceAll('-', '')}`,
    blobs: createIndexedDbBlobStore(`w8${crypto.randomUUID().replaceAll('-', '')}images`)
  });
  repos.push(rx);
  const current = await rx.createProject('Current board', 'project');
  const background = await rx.createProject('Background board', 'project');
  await rx.addItem({ projectId: current.id, content: 'On the current board' });
  await rx.addItem({ projectId: background.id, content: 'On the background board' });
  await rx.selectProject(current.id);
  return { rx, current, background };
}

/** Zero-delay task-queue polling of an observable this test owns — a counter,
 * never a clock reading. */
async function untilQuiet(predicate: () => boolean, turns = 20_000): Promise<boolean> {
  for (let turn = 0; turn < turns; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

/**
 * Closes one write phase before the next begins: waits out the repository's
 * `SETTLE_MS` window (8 ms) and its single read, so the counts read afterwards
 * answer "what did *this* phase emit" instead of "what did this and the next
 * phase emit together". This is a boundary between two phases, each of which
 * is then asserted by exact count — it is not a settle-and-hope.
 */
async function phase() {
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  await new Promise<void>(resolve => setTimeout(resolve, 30));
}

/** The notifiers the sidebar renders from, counted the way the sidebar counts them. */
function countNotified(rx: RxRepository, currentBoardId: string) {
  const counts = { projects: 0, currentProject: 0, cards: 0 };
  const stops = [
    rx.subscribeProjects(() => { counts.projects += 1; }),
    rx.subscribeCurrentProject(() => { counts.currentProject += 1; }),
    rx.subscribeCards(currentBoardId, () => { counts.cards += 1; })
  ];
  return { counts, stop: () => { for (const stop of stops) stop(); } };
}

/**
 * What the operation protocol does to a board's row: the projection rewrites
 * `revision` (the operation-vector sum) and `tailOrderKey` on every applied
 * batch without touching `updatedAt`, plus one receipt per downloaded file.
 * Reproduced directly, because the subject of these tests is the *subscription*,
 * not the sync machinery that produces the writes.
 */
async function applyAppliedBatch(rx: RxRepository, boardId: string, batches = 3) {
  for (let batch = 0; batch < batches; batch++) {
    const doc = await rx.db.projects.findOne(boardId).exec();
    await doc!.incrementalModify(current => ({ ...current, revision: current.revision + 1 }));
    await rx.journal.receipts.put({ id: `${boardId}:download:${batch}`, changeId: `${boardId}:${batch}`,
      destination: `operation-download:${boardId}` });
  }
}

it('a background board\'s applied operations do not notify the project list or the current board', async () => {
  const { rx, current, background } = await setup();
  const { counts, stop } = countNotified(rx, current.id);
  try {
    // Phase 0 — mount. A subscription publishes its first read immediately.
    expect(await untilQuiet(() => counts.projects > 0 && counts.currentProject > 0)).toBe(true);
    await phase();
    const mounted = { ...counts };
    const revisionBefore = (await rx.db.projects.findOne(background.id).exec())!.toJSON().revision as number;

    // Phase 1 — the projection's rewrite of a background board's row, plus one
    // receipt per downloaded file. Both writes really land; neither is visible
    // anywhere the sidebar renders that board.
    await applyAppliedBatch(rx, background.id, 3);
    await phase();
    expect({ projects: counts.projects - mounted.projects, currentProject: counts.currentProject - mounted.currentProject },
      'a background board\'s applied batch and its receipts must emit nothing').toEqual({ projects: 0, currentProject: 0 });

    // Phase 2 — the barrier: the *same* write, on the board that is displayed.
    // It must emit, and by exactly one, which proves phase 1 would have shown a
    // count had anything been published there.
    const afterBackground = { ...counts };
    await rx.renameProject(current.id, 'Barrier rename');
    await phase();
    expect({ projects: counts.projects - afterBackground.projects, currentProject: counts.currentProject - afterBackground.currentProject },
      'the same write on the displayed board must emit exactly once to each view').toEqual({ projects: 1, currentProject: 1 });

    // The background writes really landed: an unobserved write is not evidence.
    expect((await rx.db.projects.findOne(background.id).exec())!.toJSON().revision).toBe(revisionBefore + 3);
  } finally { stop(); }
});

it('a background board\'s card write does not notify the current board\'s card view', async () => {
  const { rx, current, background } = await setup();
  const { counts, stop } = countNotified(rx, current.id);
  try {
    expect(await untilQuiet(() => counts.cards > 0)).toBe(true);
    await phase();
    const mounted = counts.cards;

    // Phase 1 — a card on a board the card view does not mirror.
    await rx.addItem({ projectId: background.id, content: 'Typed on a background board' });
    await phase();
    expect(counts.cards - mounted, 'a background board\'s card must not re-render this board\'s view').toBe(0);

    // Phase 2 — the barrier: the current board's own card, exactly one emission.
    const afterBackground = counts.cards;
    const own = await rx.addItem({ projectId: current.id, content: 'Typed on the current board' });
    await phase();
    expect(counts.cards - afterBackground, 'the current board\'s own card must emit exactly once').toBe(1);
    expect((await rx.listCards(current.id)).some(card => card.id === own.id)).toBe(true);
    expect((await rx.listCards(background.id)).length, 'the background card was really written').toBe(2);
  } finally { stop(); }
});

it('the current board\'s own visible changes still notify both board views', async () => {
  const { rx, current } = await setup();
  const { counts, stop } = countNotified(rx, current.id);
  try {
    expect(await untilQuiet(() => counts.projects > 0 && counts.currentProject > 0)).toBe(true);
    const mounted = { ...counts };

    await rx.renameProject(current.id, 'Renamed while open');
    expect(await untilQuiet(() => counts.projects > mounted.projects && counts.currentProject > mounted.currentProject),
      'a rename of the board on screen must reach the picker and the board header').toBe(true);
    expect((await rx.getProject(current.id))?.name).toBe('Renamed while open');

    // The projection's rewrite of the current board's row is a *different*
    // thing: `revision` is not rendered, so it must not re-render either view.
    // Gated on a subsequent visible change so the assertion cannot pass merely
    // by being read too early.
    const beforeBatch = { ...counts };
    await applyAppliedBatch(rx, current.id, 1);
    await rx.renameProject(current.id, 'Renamed after the batch');
    // Gate on *both* views moving, then assert each moved exactly once. Gating
    // on `projects` alone made the `currentProject` delta a race: the two
    // notifiers are separate subscriptions, so the board header can legitimately
    // be read one scheduler turn after the picker was.
    expect(await untilQuiet(() => counts.projects > beforeBatch.projects && counts.currentProject > beforeBatch.currentProject)).toBe(true);
    expect(counts.projects - beforeBatch.projects, 'the batch itself is invisible; only the second rename may emit').toBe(1);
    expect(counts.currentProject - beforeBatch.currentProject, 'and the board header heard the same one rename').toBe(1);
  } finally { stop(); }
});

it('a genuine list change on a background board still reaches the list', async () => {
  const { rx, background } = await setup();
  const current = (await rx.getCurrentProject())!.id;
  const { counts, stop } = countNotified(rx, current);
  try {
    expect(await untilQuiet(() => counts.projects > 0)).toBe(true);
    const mounted = counts.projects;

    // The person *can* see this: the board's name is what the picker renders.
    await rx.renameProject(background.id, 'Renamed in the background');
    expect(await untilQuiet(() => counts.projects > mounted), 'a visible background change must still render').toBe(true);
    expect((await rx.listProjects()).find(project => project.id === background.id)?.name).toBe('Renamed in the background');
  } finally { stop(); }
});

it('a board created or removed in the background still reaches the list', async () => {
  const { rx } = await setup();
  const { counts, stop } = countNotified(rx, (await rx.getCurrentProject())!.id);
  try {
    expect(await untilQuiet(() => counts.projects > 0)).toBe(true);

    const beforeAdd = counts.projects;
    const added = await rx.createProject('Created elsewhere', 'project');
    expect(await untilQuiet(() => counts.projects > beforeAdd), 'a new board must appear').toBe(true);
    expect((await rx.listProjects()).some(project => project.id === added.id)).toBe(true);

    const beforeRemoval = counts.projects;
    await rx.deleteProject(added.id);
    expect(await untilQuiet(() => counts.projects > beforeRemoval), 'a removed board must disappear').toBe(true);
    expect((await rx.listProjects()).some(project => project.id === added.id)).toBe(false);
  } finally { stop(); }
});
