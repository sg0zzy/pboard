import { describe, expect, it } from "vitest";
import { hasCopyableBoardItems, serializeBoard, serializeProject } from "../src/sidebar/serialize";
import type { BoardItem, Project } from "../src/types";

const project: Project = { id: "p1", name: "New SaaS", template: "project", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const base: Omit<BoardItem, "id" | "type" | "content" | "order" | "status"> = {
  projectId: "p1", createdAt: "2026-01-01", updatedAt: "2026-01-01"
};

describe("serializeBoard", () => {
  it("creates clean ordered prompt text tagged by category and status, including rejected items", () => {
    const items: BoardItem[] = [
      { ...base, id: "2", type: "decision", status: "confirmed", order: 1, content: "Use a browser sidebar." },
      { ...base, id: "1", type: "goal", status: "candidate", order: 0, title: "Purpose", content: "Keep what matters." },
      { ...base, id: "3", type: "decision", status: "started", order: 2, content: "In progress." },
      { ...base, id: "4", type: "risk", status: "rejected", order: 3, content: "This was rejected." }
    ];
    expect(serializeBoard(project, items)).toBe(
      "PROJECT: New SaaS\n\n[goal] [candidate] Purpose\nKeep what matters.\n\n[decision] [confirmed] Use a browser sidebar.\n\n[decision] [started] In progress.\n\n[risk] [rejected] This was rejected."
    );
  });

  it("exports cards awaiting validation with their status tag", () => {
    const items: BoardItem[] = [
      { ...base, id: "validate", type: "task", status: "to validate", order: 0, content: "Verify the release." }
    ];

    expect(serializeBoard(project, items)).toContain("[task] [to validate] Verify the release.");
  });

  it("tags brainstorming note cards as well", () => {
    const brainstorming: Project = { ...project, template: "brainstorming", name: "Loose thoughts" };
    const items: BoardItem[] = [
      { ...base, id: "1", type: "note", status: "candidate", order: 0, content: "A raw thought" },
      { ...base, id: "2", type: "note", status: "confirmed", order: 1, title: "Maybe", content: "Another thought" }
    ];
    expect(serializeBoard(brainstorming, items)).toBe(
      "PROJECT: Loose thoughts\n\n[note] [candidate] A raw thought\n\n[note] [confirmed] Maybe\nAnother thought"
    );
  });

  it("uses software-project categories in copied board prompts", () => {
    const softwareProject: Project = { ...project, template: "software_project", name: "Compiler" };
    const items: BoardItem[] = [
      { ...base, id: "1", type: "main_goal", status: "confirmed", order: 0, content: "Compile safely." },
      { ...base, id: "2", type: "issue", status: "candidate", order: 1, content: "Parser crashes." }
    ];
    expect(serializeBoard(softwareProject, items)).toBe(
      "PROJECT: Compiler\n\n[main_goal] [confirmed] Compile safely.\n\n[issue] [candidate] Parser crashes."
    );
  });

  it("puts done and rejected cards after ongoing cards while preserving order within each section", () => {
    const items: BoardItem[] = [
      { ...base, id: "done-2", type: "goal", status: "done", order: 1, content: "Done second." },
      { ...base, id: "rejected-2", type: "goal", status: "rejected", order: 6, content: "Rejected second." },
      { ...base, id: "ongoing-2", type: "goal", status: "started", order: 4, content: "Ongoing second." },
      { ...base, id: "rejected-1", type: "goal", status: "rejected", order: 0, content: "Rejected first." },
      { ...base, id: "ongoing-1", type: "goal", status: "candidate", order: 2, content: "Ongoing first." },
      { ...base, id: "done-1", type: "goal", status: "done", order: 3, content: "Done first." },
      { ...base, id: "trash", type: "goal", status: "trash", order: 5, content: "Trash text" }
    ];
    expect(serializeBoard(project, items)).toBe(
      "PROJECT: New SaaS\n\n[goal] [candidate] Ongoing first.\n\n[goal] [started] Ongoing second.\n\n[goal] [done] Done second.\n\n[goal] [done] Done first.\n\n[goal] [rejected] Rejected first.\n\n[goal] [rejected] Rejected second."
    );
  });

  it("exports a board containing only rejected cards", () => {
    const items: BoardItem[] = [{ ...base, id: "rejected", type: "risk", status: "rejected", order: 0, content: "Ruled out." }];
    expect(hasCopyableBoardItems(items)).toBe(true);
    expect(serializeBoard(project, items)).toBe("PROJECT: New SaaS\n\n[risk] [rejected] Ruled out.");
    expect(hasCopyableBoardItems([{ ...items[0], status: "trash" }])).toBe(false);
  });

  it("serializes arbitrary card subsets for section copies, including rejected and done cards", () => {
    const items: BoardItem[] = [
      { ...base, id: "3", type: "risk", status: "rejected", order: 2, content: "This is rejected." },
      { ...base, id: "1", type: "goal", status: "candidate", order: 0, title: "Purpose", content: "Keep what matters." },
      { ...base, id: "4", type: "decision", status: "rejected", order: 4, content: "Also rejected." },
      { ...base, id: "2", type: "decision", status: "done", order: 1, content: "Finished." }
    ];
    const rejected = items.filter((item) => item.status === "rejected");
    expect(serializeProject(project, rejected)).toBe(
      "PROJECT: New SaaS\n\n[risk] [rejected] This is rejected.\n\n[decision] [rejected] Also rejected."
    );
    const done = items.filter((item) => item.status === "done");
    expect(serializeProject(project, done)).toBe(
      "PROJECT: New SaaS\n\n[decision] [done] Finished."
    );
  });
});
