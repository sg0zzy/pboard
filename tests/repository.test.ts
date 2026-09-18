import { beforeEach, describe, expect, it } from "vitest";
import { createRepository, STORAGE_KEY, type KeyValueStorage } from "../src/storage/repository";

class MemoryStorage implements KeyValueStorage {
  data: Record<string, unknown> = {};
  async get(key: string) { return key in this.data ? { [key]: structuredClone(this.data[key]) } : {}; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

describe("Pboard repository", () => {
  let storage: MemoryStorage;
  let repository: ReturnType<typeof createRepository>;

  beforeEach(() => {
    storage = new MemoryStorage();
    repository = createRepository(storage);
  });

  it("creates, selects, persists, and deletes projects", async () => {
    const first = await repository.createProject("Alpha", "idea");
    const second = await repository.createProject("Beta", "project");
    await repository.selectProject(first.id);

    const reloaded = createRepository(storage);
    expect((await reloaded.load()).currentProjectId).toBe(first.id);
    expect((await reloaded.load()).projects.map((project) => project.name)).toEqual(["Alpha", "Beta"]);
    expect((await reloaded.load()).projects.map((project) => project.template)).toEqual(["idea", "project"]);

    await reloaded.deleteProject(first.id);
    const state = await reloaded.load();
    expect(state.projects).toHaveLength(1);
    expect(state.currentProjectId).toBe(second.id);
    expect(storage.data[STORAGE_KEY]).toBeDefined();
  });

  it("renames a project and persists the trimmed name", async () => {
    const project = await repository.createProject("Old name", "idea");
    await repository.renameProject(project.id, "  New name  ");
    expect((await repository.load()).projects[0].name).toBe("New name");
    await expect(repository.renameProject(project.id, "   ")).rejects.toThrow("Project name is required");
  });

  it("creates, edits, deletes, and reorders cards", async () => {
    const project = await repository.createProject("Cards", "project");
    const first = await repository.addItem({ projectId: project.id, content: "First" });
    const second = await repository.addItem({ projectId: project.id, content: "Second", type: "decision" });
    const third = await repository.addItem({ projectId: project.id, content: "Third" });

    await repository.updateItem(first.id, { content: "Edited", status: "confirmed", title: "The first" });
    await repository.reorderItems(project.id, [third.id, first.id, second.id]);
    let state = await repository.load();
    expect(state.boardItems.sort((a, b) => a.order - b.order).map((item) => item.content)).toEqual(["Third", "Edited", "Second"]);
    expect(state.boardItems.find((item) => item.id === first.id)).toMatchObject({ status: "confirmed", title: "The first" });

    await repository.deleteItem(first.id);
    state = await repository.load();
    expect(state.boardItems.map((item) => item.content)).not.toContain("Edited");
    expect(state.boardItems.sort((a, b) => a.order - b.order).map((item) => item.order)).toEqual([0, 1]);
  });

  it("inserts a new card immediately after a chosen card", async () => {
    const project = await repository.createProject("Ordered", "brainstorming");
    const first = await repository.addItem({ projectId: project.id, content: "First" });
    const third = await repository.addItem({ projectId: project.id, content: "Third" });
    const second = await repository.addItem({ projectId: project.id, content: "Second", afterItemId: first.id });

    const ordered = (await repository.load()).boardItems.sort((a, b) => a.order - b.order);
    expect(ordered.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    expect(ordered.map((item) => item.order)).toEqual([0, 1, 2]);
  });

  it("duplicates a card immediately below with independent identity and source metadata", async () => {
    const project = await repository.createProject("Duplicates", "project");
    const original = await repository.addItem({
      projectId: project.id,
      content: "Keep every field",
      title: "Original",
      type: "decision",
      status: "confirmed",
      source: { provider: "web", conversationUrl: "https://example.com", sourceText: "Source" }
    });
    const later = await repository.addItem({ projectId: project.id, content: "Later" });

    const duplicate = await repository.duplicateItem(original.id);
    const ordered = (await repository.load()).boardItems.sort((a, b) => a.order - b.order);
    expect(ordered.map((item) => item.id)).toEqual([original.id, duplicate.id, later.id]);
    expect(duplicate).toMatchObject({
      projectId: original.projectId,
      title: original.title,
      content: original.content,
      type: original.type,
      status: "candidate",
      source: original.source,
      order: 1
    });
    expect(duplicate.id).not.toBe(original.id);
    expect(original.status).toBe("confirmed");
    expect(duplicate.source).not.toBe(original.source);
  });

  it("removes a project's cards when the project is deleted", async () => {
    const project = await repository.createProject("Temporary");
    await repository.addItem({ projectId: project.id, content: "Private point" });
    await repository.deleteProject(project.id);
    expect((await repository.load()).boardItems).toEqual([]);
  });

  it("uses neutral notes for brainstorming even when another type is requested", async () => {
    const project = await repository.createProject("Raw ideas", "brainstorming");
    const card = await repository.addItem({ projectId: project.id, content: "Unclassified", type: "risk" });
    expect(card.type).toBe("note");
  });

  it("changes templates without losing cards and remaps only unsupported types", async () => {
    const project = await repository.createProject("Idea", "idea");
    const core = await repository.addItem({ projectId: project.id, content: "The concept", type: "core_idea" });
    const constraint = await repository.addItem({ projectId: project.id, content: "Local only", type: "constraint" });
    const opportunity = await repository.addItem({ projectId: project.id, content: "Large market", type: "opportunity" });

    expect(await repository.changeProjectTemplate(project.id, "project")).toBe(2);
    const state = await repository.load();
    expect(state.projects[0].template).toBe("project");
    expect(state.boardItems).toHaveLength(3);
    expect(state.boardItems.find((item) => item.id === core.id)).toMatchObject({ content: "The concept", type: "note" });
    expect(state.boardItems.find((item) => item.id === opportunity.id)).toMatchObject({ content: "Large market", type: "note" });
    expect(state.boardItems.find((item) => item.id === constraint.id)).toMatchObject({ content: "Local only", type: "constraint" });
  });

  it("migrates legacy projects to the project template without discarding card data", async () => {
    storage.data[STORAGE_KEY] = {
      version: 1,
      projects: [{ id: "legacy", name: "Legacy", createdAt: "old", updatedAt: "old" }],
      boardItems: [{ id: "card", projectId: "legacy", type: "idea", content: "Keep me", status: "confirmed", order: 0, createdAt: "old", updatedAt: "old" }],
      currentProjectId: "legacy"
    };
    const state = await repository.load();
    expect(state.version).toBe(2);
    expect(state.projects[0].template).toBe("project");
    expect(state.boardItems[0]).toMatchObject({ type: "idea", content: "Keep me", status: "confirmed" });
  });
});
