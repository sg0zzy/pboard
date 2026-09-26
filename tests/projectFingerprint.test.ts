import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardItem, BoardItemStatus } from "../src/types";
import {
  compactFingerprintRows,
  expandedFingerprintRowWidth,
  fingerprintHash,
  pencilCellPath,
  ProjectFingerprint,
  splitFingerprintItems
} from "../src/sidebar/components/ProjectFingerprint";

function item(id: string, status: BoardItemStatus, order: number): BoardItem {
  return {
    id,
    projectId: "project-one",
    type: "note",
    content: id,
    status,
    order,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("project fingerprint", () => {
  it("places active and closed states in separate rows and omits trash", () => {
    const rows = splitFingerprintItems([
      item("candidate", "candidate", 0),
      item("done", "done", 1),
      item("confirmed", "confirmed", 2),
      item("rejected", "rejected", 3),
      item("started", "started", 4),
      item("to-validate", "to validate", 5),
      item("trash", "trash", 6)
    ]);

    expect(rows.statusRows.map((row) => row.map((entry) => entry.id))).toEqual([
      ["candidate", "confirmed"],
      ["started", "to-validate"],
      ["done", "rejected"]
    ]);
    expect(rows.active.map((entry) => entry.id)).toEqual(["candidate", "confirmed", "started", "to-validate"]);
    expect(rows.closed.map((entry) => entry.id)).toEqual(["done", "rejected"]);
  });

  it("keeps pencil contours deterministic", () => {
    const seed = fingerprintHash("project-one:cell:4");
    expect(pencilCellPath(2, 3, 7, seed)).toBe(pencilCellPath(2, 3, 7, seed));
    expect(pencilCellPath(2, 3, 7, seed)).not.toBe(pencilCellPath(2, 3, 7, seed + 1));
  });

  it("selects compact mode independently for each status row", () => {
    const rows = splitFingerprintItems([
      ...Array.from({ length: 12 }, (_, index) => item(`candidate-${index}`, "candidate", index)),
      ...Array.from({ length: 3 }, (_, index) => item(`started-${index}`, "started", index + 12)),
      item("done", "done", 15)
    ]).statusRows;
    const availableWidth = expandedFingerprintRowWidth(3);

    expect(compactFingerprintRows(rows, availableWidth)).toEqual([true, false, false]);
  });

  it("returns a compact row to expanded mode when enough width is available", () => {
    const rows = splitFingerprintItems(Array.from(
      { length: 8 },
      (_, index) => item(`candidate-${index}`, "candidate", index)
    )).statusRows;

    expect(compactFingerprintRows(rows, expandedFingerprintRowWidth(8) - 1)[0]).toBe(true);
    expect(compactFingerprintRows(rows, expandedFingerprintRowWidth(8))[0]).toBe(false);
  });

  it("renders a moving Done cell without embedding a local celebration", () => {
    const done = item("moving", "done", 0);
    const markup = renderToStaticMarkup(createElement(ProjectFingerprint, {
      projectId: "project-one",
      items: [done],
      transition: { itemId: done.id, fromStatus: "started", status: "done", revision: 1 }
    }));

    expect(markup).toContain("fingerprint-cell--moving-done");
    expect(markup).not.toContain("confetti");
  });

  it("does not celebrate a Done card without an explicit transition", () => {
    const done = item("already-done", "done", 0);
    const markup = renderToStaticMarkup(createElement(ProjectFingerprint, {
      projectId: "project-one",
      items: [done],
      transition: null
    }));

    expect(markup).not.toContain("confetti");
  });

  it("renders no confetti for a rejected landing", () => {
    const rejected = item("moving", "rejected", 0);
    const markup = renderToStaticMarkup(createElement(ProjectFingerprint, {
      projectId: "project-one",
      items: [rejected],
      transition: { itemId: rejected.id, fromStatus: "confirmed", status: "rejected", revision: 1 }
    }));

    expect(markup).toContain("fingerprint-cell--moving-rejected");
    expect(markup).not.toContain("confetti");
  });

  it("uses em sizing so the whole grid follows the board scale", () => {
    const markup = renderToStaticMarkup(createElement(ProjectFingerprint, {
      projectId: "project-one",
      items: [item("candidate", "candidate", 0), item("started", "started", 1)],
      transition: null
    }));

    expect(markup).toMatch(/style="width:[0-9.]+em"/);
    expect(markup).toContain('viewBox="0 0 25 39"');
  });

  it("renders the to validate status with a safe CSS class", () => {
    const markup = renderToStaticMarkup(createElement(ProjectFingerprint, {
      projectId: "project-one",
      items: [item("validation", "to validate", 0)],
      transition: null
    }));

    expect(markup).toContain("fingerprint-cell--to-validate");
    expect(markup).toContain("<title>to validate</title>");
  });
});
