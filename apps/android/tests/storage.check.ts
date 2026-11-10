// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createRxRepository } from '../../../src/storage/rxdbRepository';
import { categoryOf } from '../src/data/categories';
import { overviewBoards, readSnapshot, setCollapseCards, setShowPreviews, watchRepository } from '../src/storage/repository';
const unique = () => `androidtest${crypto.randomUUID().replaceAll('-', '')}`;

describe('Android local data boundary', () => {
  it('persists boards, cards and settings across database restart', async () => {
    const name = unique();
    const repository = await createRxRepository({ name });
    const project = await repository.createProject('Offline board', 'project');
    const card = await repository.addItem({ projectId: project.id, content: 'Saved locally' });
    await setShowPreviews(repository, false);
    await repository.db.close();
    const reopened = await createRxRepository({ name });
    try {
      const snapshot = await readSnapshot(reopened);
      expect(snapshot.projects[0].id).toBe(project.id);
      expect(snapshot.cards[0].id).toBe(card.id);
      expect(snapshot.cards[0].content).toBe('Saved locally');
      expect(snapshot.showPreviews).toBe(false);
    } finally { await reopened.db.close(); }
  });
  it('persists the home and board layout settings without touching edit timestamps', async () => {
    const name = unique();
    let repository = await createRxRepository({ name });
    try {
      const project = await repository.createProject('Layouts');
      const before = (await repository.listProjects())[0].updatedAt;
      // Both are unset by default: previews on, full cards.
      expect(await readSnapshot(repository)).toMatchObject({ showPreviews: true, collapseCards: false });
      await setShowPreviews(repository, false);
      await setCollapseCards(repository, true);
      expect((await repository.listProjects())[0].updatedAt).toBe(before);
      await repository.db.close(); repository = await createRxRepository({ name });
      expect((await readSnapshot(repository)).projects[0].id).toBe(project.id);
      expect(await readSnapshot(repository)).toMatchObject({ showPreviews: false, collapseCards: true });
    } finally { await repository.db.close(); }
  });
  it('derives every board category and its colour from the template, independent of its cards', async () => {
    const repository = await createRxRepository({ name: unique() });
    try {
      const notes = await repository.createProject('Notes board', 'brainstorming');
      const ideas = await repository.createProject('Ideas board', 'idea');
      const project = await repository.createProject('Project board', 'project');
      const software = await repository.createProject('Software board', 'software_project');
      await repository.addItem({ projectId: notes.id, content: 'note' });
      await repository.addItem({ projectId: software.id, type: 'issue', content: 'bug' });
      const overview = new Map(overviewBoards(await readSnapshot(repository)).map(board => [board.id, board]));
      expect([...overview.values()].map(board => board.category)).toEqual(['Notes', 'Ideas', 'Project', 'Project']);
      // Colour follows the category, so the two project templates share one hue
      // while notes and ideas differ from it and from each other.
      expect(overview.get(project.id)!.categoryColor).toBe(overview.get(software.id)!.categoryColor);
      expect(new Set([overview.get(notes.id)!.categoryColor, overview.get(ideas.id)!.categoryColor, overview.get(project.id)!.categoryColor]).size).toBe(3);
      // Editing every card cannot change the tile colour, unlike the old
      // first-card-derived accent.
      const before = overview.get(software.id)!.categoryColor;
      const card = (await repository.listCards(software.id))[0];
      await repository.updateItem(card.id, { type: 'feature' });
      expect(overviewBoards(await readSnapshot(repository)).find(board => board.id === software.id)!.categoryColor).toBe(before);
    } finally { await repository.db.close(); }
  });
  it('leaves edit timestamps unchanged for reads, selection, settings and manual board ordering', async () => {
    const repository = await createRxRepository({ name: unique() });
    try {
      const first = await repository.createProject('First');
      const second = await repository.createProject('Second');
      const before = (await repository.listProjects()).map(project => [project.id, project.updatedAt]);
      await repository.selectProject(first.id);
      await readSnapshot(repository);
      await setShowPreviews(repository, false);
      await repository.reorderProjects([second.id, first.id]);
      expect((await repository.listProjects()).map(project => project.id)).toEqual([second.id, first.id]);
      expect(new Map((await repository.listProjects()).map(project => [project.id, project.updatedAt]))).toEqual(new Map(before as [string, string][]));
    } finally { await repository.db.close(); }
  });
  it('updates edit timestamps only for real edits, including card changes', async () => {
    const repository = await createRxRepository({ name: unique() });
    try {
      const project = await repository.createProject('Board');
      await repository.renameProject(project.id, 'Renamed');
      const renamed = (await repository.getProject(project.id))!;
      expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(project.updatedAt));
      await repository.renameProject(project.id, 'Renamed');
      expect((await repository.getProject(project.id))!.updatedAt).toBe(renamed.updatedAt);
      const card = await repository.addItem({ projectId: project.id, content: 'A' });
      const afterAdd = (await repository.getProject(project.id))!;
      await repository.updateItem(card.id, { content: 'B' });
      const afterEdit = (await repository.getProject(project.id))!;
      expect(Date.parse(afterEdit.updatedAt)).toBeGreaterThan(Date.parse(afterAdd.updatedAt));
      await repository.updateItem(card.id, { content: 'B' });
      expect((await repository.getProject(project.id))!.updatedAt).toBe(afterEdit.updatedAt);
    } finally { await repository.db.close(); }
  });
  it('previews only the first ordered active card and ignores deleted, done, rejected and trash cards', async () => {
    const repository = await createRxRepository({ name: unique() });
    try {
      const project = await repository.createProject('Ideas', 'idea');
      const first = await repository.addItem({ projectId: project.id, content: 'First' });
      const second = await repository.addItem({ projectId: project.id, content: 'Second', title: 'Second title' });
      expect(overviewBoards(await readSnapshot(repository))[0].firstCard).toBe('First');
      await repository.moveItem(project.id, second.id, [second.id, first.id]);
      expect(overviewBoards(await readSnapshot(repository))[0]).toMatchObject({ firstCard: 'Second title', template: 'idea', category: 'Ideas' });
      await repository.updateItem(second.id, { status: 'trash' });
      expect(overviewBoards(await readSnapshot(repository))[0].firstCard).toBe('First');
      // A terminal card is not the board's working list, even when its rank is first.
      for (const status of ['done', 'rejected', 'trash'] as const) {
        await repository.updateItem(first.id, { status });
        const overview = overviewBoards(await readSnapshot(repository))[0];
        expect(overview.firstCard).toBe('No cards yet');
        expect(overview.category).toBe('Ideas');
        expect(overview.template).toBe('idea');
        // The tile's colour is the board's category, not the first card's type,
        // so moving every card out of the working list cannot recolour it.
        expect(overview.categoryColor).toBe(categoryOf('idea').color);
      }
      await repository.updateItem(first.id, { status: 'candidate' });
      expect(overviewBoards(await readSnapshot(repository))[0].firstCard).toBe('First');
      await repository.deleteItem(first.id);
      const overview = overviewBoards(await readSnapshot(repository))[0];
      expect(overview.firstCard).toBe('No cards yet');
      expect(overview.categoryColor).toBe(categoryOf('idea').color);
    } finally { await repository.db.close(); }
  });
  it('refreshes the home preview when the last active card moves to a terminal container', async () => {
    const repository = await createRxRepository({ name: unique() });
    const previews: unknown[] = [];
    const stop = watchRepository(repository, snapshot => previews.push(overviewBoards(snapshot)[0]?.firstCard), error => { throw error; });
    try {
      const project = await repository.createProject('Cleared');
      const card = await repository.addItem({ projectId: project.id, content: 'Only card' });
      await expect.poll(() => previews.at(-1)).toBe('Only card');
      await repository.updateItem(card.id, { status: 'done' });
      await expect.poll(() => previews.at(-1)).toBe('No cards yet');
    } finally { stop(); await repository.db.close(); }
  });
  it('preserves manual ranks across terminal moves, restart, bulk trash and board-scoped emptying', async () => {
    const name = unique();
    let repository = await createRxRepository({ name });
    try {
      const project = await repository.createProject('Containers');
      const other = await repository.createProject('Other');
      const a = await repository.addItem({ projectId: project.id, content: 'First' });
      const b = await repository.addItem({ projectId: project.id, content: 'Second' });
      const c = await repository.addItem({ projectId: project.id, content: 'Third' });
      const untouched = await repository.addItem({ projectId: other.id, content: 'Other trash', status: 'trash' });
      const ranks = new Map((await repository.db.cards.find().exec()).map(doc => [doc.id, doc.orderKey]));
      // Completion time does not determine container order.
      await repository.updateItem(c.id, { status: 'done' });
      await repository.updateItem(a.id, { status: 'done' });
      await repository.updateItem(b.id, { status: 'rejected' });
      await repository.db.close(); repository = await createRxRepository({ name });
      let snapshot = await readSnapshot(repository);
      expect(snapshot.cards.filter(card => card.projectId === project.id && card.status === 'done').map(card => card.id)).toEqual([a.id, c.id]);
      for (const status of ['done', 'rejected']) {
        for (const card of snapshot.cards.filter(card => card.projectId === project.id && card.status === status)) await repository.updateItem(card.id, { status: 'trash' });
      }
      expect(new Map((await repository.db.cards.find().exec()).map(doc => [doc.id, doc.orderKey]))).toEqual(ranks);
      snapshot = await readSnapshot(repository);
      expect(snapshot.cards.filter(card => card.projectId === project.id).map(card => card.id)).toEqual([a.id, b.id, c.id]);
      await repository.updateItem(a.id, { status: 'confirmed' });
      expect(await repository.emptyTrash(project.id)).toBe(2);
      snapshot = await readSnapshot(repository);
      expect(snapshot.cards.map(card => card.id)).toEqual(expect.arrayContaining([a.id, untouched.id]));
      expect(snapshot.cards).toHaveLength(2);
      expect((await repository.db.cards.findOne(b.id).exec())?.deletedAt).toBeTruthy();
      expect(await repository.emptyTrash(project.id)).toBe(0);
    } finally { await repository.db.close(); }
  });
  it('publishes reactive snapshots and stops publishing after unsubscribe', async () => {
    const repository = await createRxRepository({ name: unique() });
    const changes: string[][] = [];
    const errors: unknown[] = [];
    const stop = watchRepository(repository, snapshot => changes.push(snapshot.projects.map(project => project.name)), error => errors.push(error));
    try {
      await repository.createProject('Reactive');
      await expect.poll(() => changes.some(names => names.includes('Reactive'))).toBe(true);
      stop();
      const count = changes.length;
      await repository.createProject('After unsubscribe');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(changes).toHaveLength(count);
      expect(errors).toEqual([]);
    } finally { stop(); await repository.db.close(); }
  });
});
