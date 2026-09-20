import { describe, expect, it } from "vitest";
import { serializeBoard } from "../src/sidebar/serialize";
import type { BoardItem, Project } from "../src/types";

const project: Project = { id: "p1", name: "New SaaS", template: "project", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const base: Omit<BoardItem, "id" | "type" | "content" | "order" | "status"> = {
  projectId: "p1", createdAt: "2026-01-01", updatedAt: "2026-01-01"
};

describe("serializeBoard", () => {
  it("creates clean ordered prompt text tagged by category and excludes rejected items", () => {
    const items: BoardItem[] = [
      { ...base, id: "2", type: "decision", status: "confirmed", order: 1, content: "Use a browser sidebar." },
      { ...base, id: "1", type: "goal", status: "candidate", order: 0, title: "Purpose", content: "Keep what matters." },
      { ...base, id: "3", type: "risk", status: "rejected", order: 2, content: "This should be absent." }
    ];
    expect(serializeBoard(project, items)).toBe(
      "PROJECT: New SaaS\n\n[goal] Purpose\nKeep what matters.\n\n[decision] Use a browser sidebar."
    );
  });

  it("tags brainstorming note cards as well", () => {
    const brainstorming: Project = { ...project, template: "brainstorming", name: "Loose thoughts" };
    const items: BoardItem[] = [
      { ...base, id: "1", type: "note", status: "candidate", order: 0, content: "A raw thought" },
      { ...base, id: "2", type: "note", status: "confirmed", order: 1, title: "Maybe", content: "Another thought" }
    ];
    expect(serializeBoard(brainstorming, items)).toBe(
      "PROJECT: Loose thoughts\n\n[note] A raw thought\n\n[note] Maybe\nAnother thought"
    );
  });

  it("uses software-project categories in copied board prompts", () => {
    const softwareProject: Project = { ...project, template: "software_project", name: "Compiler" };
    const items: BoardItem[] = [
      { ...base, id: "1", type: "main_goal", status: "confirmed", order: 0, content: "Compile safely." },
      { ...base, id: "2", type: "issue", status: "candidate", order: 1, content: "Parser crashes." }
    ];
    expect(serializeBoard(softwareProject, items)).toBe(
      "PROJECT: Compiler\n\n[main_goal] Compile safely.\n\n[issue] Parser crashes."
    );
  });
});
