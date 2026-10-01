import { describe, expect, it } from "vitest";
import {
  MIN_WIDTH_FLOOR_PX,
  computeActionsRow,
  computeMinContentWidth,
  computeMinPageWidth,
  computeTopLine,
  sourceBadgeLabels,
  statusTriggerLabels,
  triggerCategoryLabels,
} from "../src/sidebar/minWidth";

describe("min width formula", () => {
  it("computes the topline from drag handle, category, status and display-mode controls", () => {
    expect(computeTopLine(23, 96, 82, 50)).toBe(23 + 5 + 96 + 5 + 82 + 5 + 50);
  });

  it("computes the worst card-actions row from badge and two icons", () => {
    expect(computeActionsRow(65, 16)).toBe(65 + 5 + 16 + 5 + 16);
  });

  it("takes the wider of the topline and actions row for card content width", () => {
    expect(computeMinContentWidth(258, 102)).toBe(258);
    expect(computeMinContentWidth(102, 258)).toBe(258);
  });

  it("adds horizontal chrome to the content width", () => {
    expect(computeMinPageWidth(258, 52)).toBe(310);
    expect(computeMinPageWidth(200, 0)).toBe(200);
  });

  it("keeps the 260px floor above smaller computed widths", () => {
    expect(MIN_WIDTH_FLOOR_PX).toBe(260);
  });
});

describe("probe label sets", () => {
  it("probes every card type of the active template plus legacy labels", () => {
    expect(triggerCategoryLabels("project", [])).toEqual([
      "Goal",
      "Decision",
      "Task / Next Step",
      "Constraint",
      "Open Question",
      "Risk / Blocker",
      "Reference",
      "Uncategorized",
    ]);

    const legacy = triggerCategoryLabels("project", ["personal", "custom_type"]);
    expect(legacy).toContain("LEGACY: PERSONAL");
    expect(legacy).toContain("LEGACY: CUSTOM TYPE");
    expect(legacy).not.toContain("LEGACY: RISK / BLOCKER");
  });

  it("probes every status", () => {
    expect(statusTriggerLabels()).toEqual([
      "○ Candidate",
      "● Confirmed",
      "▶ Started",
      "◐ To validate",
      "✓ Done",
      "– Trashed",
      "× Rejected",
    ]);
  });

  it("probes base source badges plus providers from current items", () => {
    expect(sourceBadgeLabels([])).toEqual(["From chat", "From web", "From chatgpt"]);
    expect(sourceBadgeLabels(["github", "chatgpt", "web"])).toEqual(["From chat", "From web", "From chatgpt", "From github"]);
    expect(sourceBadgeLabels(["github"])).not.toContain("From github2");
  });
});
