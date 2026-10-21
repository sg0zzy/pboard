import { describe, expect, it } from "vitest";

import {
  DRIVE_RECONCILE_MESSAGE,
  DRIVE_SYNC_MESSAGE,
  isDriveReconcileMessage,
  isDriveSyncProjectMessage,
} from "../src/sync/messages";

describe("message constants", () => {
  it("defines the sync and reconcile message types", () => {
    expect(DRIVE_SYNC_MESSAGE).toBe("DRIVE_SYNC_PROJECT");
    expect(DRIVE_RECONCILE_MESSAGE).toBe("DRIVE_RECONCILE_ALL");
  });
});

describe("isDriveSyncProjectMessage", () => {
  it("accepts a valid sync project message (extra fields allowed)", () => {
    expect(isDriveSyncProjectMessage({ type: DRIVE_SYNC_MESSAGE, projectId: "p1" })).toBe(true);
    expect(isDriveSyncProjectMessage({ type: DRIVE_SYNC_MESSAGE, projectId: "p1", extra: "x" })).toBe(
      true,
    );
  });

  it("rejects null, undefined, and non-object values", () => {
    for (const value of [null, undefined, 0, 42, "DRIVE_SYNC_PROJECT", true, []] as const) {
      expect(isDriveSyncProjectMessage(value), `rejects ${String(value)}`).toBe(false);
    }
  });

  it("rejects objects without a valid sync type and non-empty string projectId", () => {
    const cases = [
      {},
      { type: "DRIVE_SYNC_PROJECT" },
      { type: "DRIVE_SYNC_PROJECT", projectId: "" },
      { type: "DRIVE_SYNC_PROJECT", projectId: 5 },
      { type: "DRIVE_SYNC_PROJECT", projectId: null },
      { type: "DRIVE_RECONCILE_ALL", projectId: "p1" },
      { projectId: "p1" },
    ];
    for (const value of cases) {
      expect(isDriveSyncProjectMessage(value), `rejects ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("narrows to DriveSyncProjectMessage", () => {
    const value: unknown = { type: "DRIVE_SYNC_PROJECT", projectId: "p1" };
    expect(isDriveSyncProjectMessage(value)).toBe(true);
    if (isDriveSyncProjectMessage(value)) {
      const id = value.projectId;
      expect(id).toBe("p1");
    }
  });
});

describe("isDriveReconcileMessage", () => {
  it("accepts a valid reconcile message (extra fields allowed)", () => {
    expect(isDriveReconcileMessage({ type: DRIVE_RECONCILE_MESSAGE })).toBe(true);
    expect(isDriveReconcileMessage({ type: DRIVE_RECONCILE_MESSAGE, extra: "x" })).toBe(true);
  });

  it("rejects null, undefined, and non-object values", () => {
    for (const value of [null, undefined, 0, 42, "DRIVE_RECONCILE_ALL", true, []] as const) {
      expect(isDriveReconcileMessage(value), `rejects ${String(value)}`).toBe(false);
    }
  });

  it("rejects objects without the reconcile type", () => {
    const cases = [
      {},
      { type: "DRIVE_SYNC_PROJECT" },
      { type: "WRONG_TYPE" },
      { other: "x" },
    ];
    for (const value of cases) {
      expect(isDriveReconcileMessage(value), `rejects ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("narrows to DriveReconcileMessage", () => {
    const value: unknown = { type: "DRIVE_RECONCILE_ALL" };
    if (isDriveReconcileMessage(value)) {
      expect(value.type).toBe("DRIVE_RECONCILE_ALL");
    }
  });
});

it('rejects malformed force flags on explicit project synchronization', () => {
  expect(isDriveSyncProjectMessage({ type: DRIVE_SYNC_MESSAGE, projectId: 'board', force: 'yes' })).toBe(false);
  expect(isDriveSyncProjectMessage({ type: DRIVE_SYNC_MESSAGE, projectId: 'board', force: true })).toBe(true);
});
