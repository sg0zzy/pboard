import { describe, expect, it } from "vitest";
import { stepCardType, stepStatus } from "../src/sidebar/cardCycle";

describe("stepStatus", () => {
  it("increases status for right and decreases it for left", () => {
    expect(stepStatus("candidate", 1)).toBe("confirmed");
    expect(stepStatus("candidate", -1)).toBe("done");
    expect(stepStatus("confirmed", 1)).toBe("rejected");
    expect(stepStatus("confirmed", -1)).toBe("candidate");
    expect(stepStatus("rejected", 1)).toBe("done");
    expect(stepStatus("rejected", -1)).toBe("confirmed");
    expect(stepStatus("done", 1)).toBe("candidate");
    expect(stepStatus("done", -1)).toBe("rejected");
  });
});

describe("stepCardType", () => {
  it("steps through the template's supported categories in order and wraps", () => {
    expect(stepCardType("project", "goal", 1)).toBe("decision");
    expect(stepCardType("project", "decision", -1)).toBe("goal");
    expect(stepCardType("project", "reference", 1)).toBe("note");
    expect(stepCardType("project", "note", -1)).toBe("reference");
  });

  it("leaves single-category templates unchanged", () => {
    expect(stepCardType("brainstorming", "note", 1)).toBe("note");
    expect(stepCardType("brainstorming", "note", -1)).toBe("note");
  });

  it("maps unsupported legacy types into the supported category list", () => {
    expect(stepCardType("project", "issue", 1)).toBe("goal");
    expect(stepCardType("project", "issue", -1)).toBe("note");
  });
});
