import { describe, expect, it } from "vitest";
import { boardTemplates } from "../src/templates/boardTemplates";

describe("board template configuration", () => {
  it("defines exactly the three initial templates", () => {
    expect(Object.keys(boardTemplates)).toEqual(["brainstorming", "idea", "project"]);
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
  });
});
