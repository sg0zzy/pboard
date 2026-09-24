import { describe, expect, it } from "vitest";
import { STATUS_DEFINITIONS, WORKFLOW_STATUS_ROWS } from "../src/statuses";

describe("status definitions", () => {
  it("uses one canonical three-row workflow order everywhere", () => {
    expect(WORKFLOW_STATUS_ROWS.map((row) => row.map((status) => status.id))).toEqual([
      ["candidate", "confirmed"],
      ["started", "to validate"],
      ["done", "rejected"]
    ]);
    expect(STATUS_DEFINITIONS.map((status) => status.id)).toEqual([
      "candidate",
      "confirmed",
      "started",
      "to validate",
      "done",
      "trash",
      "rejected"
    ]);
    expect(STATUS_DEFINITIONS.find((status) => status.id === "to validate")?.label).toBe("To validate");
    expect(STATUS_DEFINITIONS.find((status) => status.id === "trash")?.label).toBe("Trashed");
  });
});
