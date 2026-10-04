import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the extension `browser` API so src/sync/client can be imported without a
// Chromium/Firefox extension context. vi.mock is hoisted above the static import
// of src/platform/browser below, so the stub is in place when the module runs.
vi.mock("../src/platform/browser", () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(),
    },
  },
}));

import { browser } from "../src/platform/browser";
import {
  DRIVE_RECONCILE_MESSAGE,
  DRIVE_SYNC_MESSAGE,
} from "../src/sync/messages";
import { requestDriveReconciliation, requestProjectSync } from "../src/sync/client";

const sendMessage = vi.mocked(browser.runtime.sendMessage);

afterEach(() => {
  vi.clearAllMocks();
});

describe("requestProjectSync", () => {
  it("forwards {type, projectId} to runtime.sendMessage", async () => {
    await sendMessage.mockResolvedValueOnce({ ok: true });

    await requestProjectSync("p1");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: DRIVE_SYNC_MESSAGE, projectId: "p1" });
  });

  it("returns the response object on success", async () => {
    await sendMessage.mockResolvedValueOnce({ ok: true });

    const result = await requestProjectSync("p1");

    expect(result).toEqual({ ok: true });
  });

  it("passes through a failure response from the extension", async () => {
    await sendMessage.mockResolvedValueOnce({ ok: false, reason: "rejected by extension" });

    const result = await requestProjectSync("p1");

    expect(result).toEqual({ ok: false, reason: "rejected by extension" });
  });

  it("surfaces an Error message as the reason", async () => {
    await sendMessage.mockRejectedValueOnce(new Error("network down"));

    const result = await requestProjectSync("p1");

    expect(result).toEqual({ ok: false, reason: "network down" });
  });

  it("falls back to a generic reason when the throw is not an Error", async () => {
    await sendMessage.mockRejectedValueOnce("boom");

    const result = await requestProjectSync("p1");

    expect(result).toEqual({ ok: false, reason: "Google Drive sync could not start" });
  });
});

describe("requestDriveReconciliation", () => {
  it("forwards {type} to runtime.sendMessage", async () => {
    await sendMessage.mockResolvedValueOnce({ ok: true });

    await requestDriveReconciliation();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: DRIVE_RECONCILE_MESSAGE });
  });

  it("returns the response object on success", async () => {
    await sendMessage.mockResolvedValueOnce({ ok: true });

    const result = await requestDriveReconciliation();

    expect(result).toEqual({ ok: true });
  });

  it("surfaces an Error message as the reason", async () => {
    await sendMessage.mockRejectedValueOnce(new Error("reconcile failed"));

    const result = await requestDriveReconciliation();

    expect(result).toEqual({ ok: false, reason: "reconcile failed" });
  });

  it("falls back to a generic reason when the throw is not an Error", async () => {
    await sendMessage.mockRejectedValueOnce(42);

    const result = await requestDriveReconciliation();

    expect(result).toEqual({ ok: false, reason: "Google Drive reconciliation could not start" });
  });
});
