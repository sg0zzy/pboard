import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browser } from "../src/platform/browser";
import { googleDrive } from "../src/sync/browser";
import { DRIVE_PROJECT_STATE_PREFIX } from "../src/sync/state";
import {
  DRIVE_RECONCILE_MESSAGE,
  DRIVE_SYNC_MESSAGE,
} from "../src/sync/messages";
import { handleDriveSyncMessage, registerDriveBackgroundSync } from "../src/sync/background";

vi.mock("../src/platform/browser", () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(),
      getExtensionState: vi.fn(),
    },
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    alarms: {
      onAlarm: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      create: vi.fn(),
    },
  },
}));

vi.mock("../src/sync/browser", () => ({
  googleDrive: {
    reconcileAll: vi.fn(),
    syncProject: vi.fn(),
    getConnectionState: vi.fn(),
  },
}));

const browserMock = vi.mocked(browser);
const reconcileAll = vi.mocked(googleDrive.reconcileAll);
const syncProject = vi.mocked(googleDrive.syncProject);
const getConnectionState = vi.mocked(googleDrive.getConnectionState);
const alarmsCreate = vi.mocked(browserMock.alarms.create);
const storageAddListener = vi.mocked(browserMock.storage.onChanged.addListener);
const alarmAddListener = vi.mocked(browserMock.alarms.onAlarm.addListener);

const reconcileResult = {
  status: "reconciled" as const,
  imported: 0,
  pulled: 0,
  pushed: 0,
  deleted: 0,
};

function connected(state: "connected" | "disconnected") {
  getConnectionState.mockResolvedValue(state);
}

// Flush enough microtask hops for a fire-and-forget async chain to settle
// without reaching for wall-clock timers.
function awaitMicrotasks(hops: number) {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < hops; i += 1) {
    p = p.then(() => Promise.resolve());
  }
  return p;
}

function storageListener() {
  registerDriveBackgroundSync();
  return storageAddListener.mock.calls.at(0)[0];
}

function alarmListener() {
  registerDriveBackgroundSync();
  return alarmAddListener.mock.calls.at(0)[0];
}

function driveState(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    status: "pending",
    dirty: true,
    ...overrides,
  };
}

beforeEach(() => {
  connected("connected");
  reconcileAll.mockResolvedValue(reconcileResult);
  syncProject.mockResolvedValue("pushed");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleDriveSyncMessage", () => {
  it("reconciles on DRIVE_RECONCILE_ALL", async () => {
    const result = await handleDriveSyncMessage({ type: DRIVE_RECONCILE_MESSAGE });
    expect(result).toEqual({ ok: true, result: reconcileResult });
    expect(reconcileAll).toHaveBeenCalledTimes(1);
  });

  it("surfaces an Error from reconcileAll as the reason", async () => {
    reconcileAll.mockRejectedValue(new Error("reconcile boom"));
    const result = await handleDriveSyncMessage({ type: DRIVE_RECONCILE_MESSAGE });
    expect(result).toEqual({ ok: false, reason: "reconcile boom" });
    expect(reconcileAll).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-Error from reconcileAll with a generic reason", async () => {
    reconcileAll.mockRejectedValue("reconcile boom");
    const result = await handleDriveSyncMessage({ type: DRIVE_RECONCILE_MESSAGE });
    expect(result).toEqual({ ok: false, reason: "Google Drive reconciliation failed" });
  });

  it("returns undefined for an unrecognized message type", async () => {
    const result = await handleDriveSyncMessage({ type: "UNKNOWN" });
    expect(result).toBeUndefined();
    expect(reconcileAll).not.toHaveBeenCalled();
    expect(syncProject).not.toHaveBeenCalled();
  });

  it("rejects a sync message when the connection is not established", async () => {
    connected("disconnected");
    const result = await handleDriveSyncMessage({ type: DRIVE_SYNC_MESSAGE, projectId: "p1" });
    expect(result).toEqual({ ok: false, reason: "Google Drive is not connected" });
    expect(syncProject).not.toHaveBeenCalled();
  });

  it("syncs the project when connected", async () => {
    syncProject.mockResolvedValue("pushed");
    const result = await handleDriveSyncMessage({ type: DRIVE_SYNC_MESSAGE, projectId: "p1" });
    expect(result).toEqual({ ok: true, result: "pushed" });
    expect(syncProject).toHaveBeenCalledTimes(1);
    expect(syncProject).toHaveBeenCalledWith("p1");
  });

  it("surfaces an Error from syncProject as the reason", async () => {
    syncProject.mockRejectedValue(new Error("sync boom"));
    const result = await handleDriveSyncMessage({ type: DRIVE_SYNC_MESSAGE, projectId: "p1" });
    expect(result).toEqual({ ok: false, reason: "sync boom" });
    expect(syncProject).toHaveBeenCalledWith("p1");
  });

  it("surfaces a non-Error from syncProject with a generic reason", async () => {
    syncProject.mockRejectedValue("sync boom");
    const result = await handleDriveSyncMessage({ type: DRIVE_SYNC_MESSAGE, projectId: "p1" });
    expect(result).toEqual({ ok: false, reason: "Google Drive sync failed" });
  });

  it("returns undefined for a sync message without a projectId", async () => {
    const result = await handleDriveSyncMessage({ type: DRIVE_SYNC_MESSAGE });
    expect(result).toBeUndefined();
    expect(syncProject).not.toHaveBeenCalled();
  });

  it("returns undefined for a sync message with an empty projectId", async () => {
    const result = await handleDriveSyncMessage({ type: DRIVE_SYNC_MESSAGE, projectId: "" });
    expect(result).toBeUndefined();
    expect(syncProject).not.toHaveBeenCalled();
  });
});

describe("registerDriveBackgroundSync", () => {
  it("registers a storage and an alarm listener", () => {
    registerDriveBackgroundSync();
    expect(storageAddListener).toHaveBeenCalledTimes(1);
    expect(alarmAddListener).toHaveBeenCalledTimes(1);
  });

  it("schedules an idle-sync alarm for a dirty pending project state", async () => {
    const before = Date.now();
    const listener = storageListener();
    const key = DRIVE_PROJECT_STATE_PREFIX + "p1";
    listener({ [key]: { newValue: driveState("p1") } }, "local");
    await awaitMicrotasks(3);
    expect(alarmsCreate).toHaveBeenCalledTimes(1);
    const [name, opts] = alarmsCreate.mock.calls[0];
    expect(name).toBe("pboard-drive-sync:p1");
    expect(opts.when).toBeGreaterThan(before + 25000 - 1000);
  });

  it("does not schedule when the connection state is not connected", async () => {
    connected("disconnected");
    const listener = storageListener();
    listener({
      [DRIVE_PROJECT_STATE_PREFIX + "p1"]: { newValue: driveState("p1") },
    }, "local");
    await awaitMicrotasks(3);
    expect(alarmsCreate).not.toHaveBeenCalled();
  });

  it("does not schedule for non-matching changes", async () => {
    const listener = storageListener();
    // Non-local area is ignored.
    listener(
      { [DRIVE_PROJECT_STATE_PREFIX + "p1"]: { newValue: driveState("p1") } },
      "sync",
    );
    // Non-prefixed keys are ignored.
    listener({ otherKey: { newValue: "x" } }, "local");
    // A change without newValue is ignored.
    listener({ [DRIVE_PROJECT_STATE_PREFIX + "p1"]: {} }, "local");
    // A non-dirty state is ignored.
    listener(
      {
        [DRIVE_PROJECT_STATE_PREFIX + "p1"]: { newValue: driveState("p1", { dirty: false }) },
      },
      "local",
    );
    // A non-pending status is ignored.
    listener(
      {
        [DRIVE_PROJECT_STATE_PREFIX + "p1"]: {
          newValue: driveState("p1", { status: "synced" }),
        },
      },
      "local",
    );
    await awaitMicrotasks(3);
    expect(alarmsCreate).not.toHaveBeenCalled();
  });

  it("runs syncProject for a valid alarm name", async () => {
    const listener = alarmListener();
    listener({ name: "pboard-drive-sync:p1" });
    expect(syncProject).toHaveBeenCalledTimes(1);
    expect(syncProject).toHaveBeenCalledWith("p1");
  });

  it("ignores alarm names that are not a drive-sync alarm", async () => {
    const listener = alarmListener();
    listener({ name: "other" });
    listener({ name: "pboard-drive-sync:" });
    await awaitMicrotasks(3);
    expect(syncProject).not.toHaveBeenCalled();
  });

  it("swallows a syncProject rejection from the alarm listener", async () => {
    syncProject.mockRejectedValue(new Error("boom"));
    const listener = alarmListener();
    listener({ name: "pboard-drive-sync:p2" });
    await awaitMicrotasks(3);
    expect(syncProject).toHaveBeenCalledTimes(1);
    expect(syncProject).toHaveBeenCalledWith("p2");
  });
});
