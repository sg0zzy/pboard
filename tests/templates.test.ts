import { describe, expect, it } from "vitest";
import { boardTemplates } from "../src/templates/boardTemplates";

describe("board template configuration", () => {
  it("defines the available board templates", () => {
    expect(Object.keys(boardTemplates)).toEqual(["brainstorming", "idea", "project", "software_project"]);
  });

  it("keeps brainstorming neutral and category-free", () => {
    expect(boardTemplates.brainstorming.cardTypes.map((type) => type.id)).toEqual(["note"]);
    expect(boardTemplates.brainstorming.showTypeSelector).toBe(false);
  });

  it("exposes the requested semantic types plus a safe uncategorized fallback", () => {
    expect(boardTemplates.idea.cardTypes.map((type) => type.id)).toEqual([
      "core_idea", "opportunity", "question", "risk", "constraint", "reference", "note"
    ]);
    expect(boardTemplates.project.cardTypes.map((type) => type.id)).toEqual([
      "goal", "decision", "task", "constraint", "question", "risk", "reference", "note"
    ]);
    expect(boardTemplates.software_project.cardTypes.map((type) => type.id)).toEqual([
      "issue", "feature", "decision", "task", "main_goal", "main_description", "note"
    ]);
    expect(boardTemplates.software_project.defaultCardType).toBe("task");
  });
});
