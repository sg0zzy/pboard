import { describe, expect, it, vi } from "vitest";
import { requestPageCaptureAccess } from "../src/platform/capturePermission";

describe("page capture permission", () => {
  it("requests the exact permission Chrome needs from a side panel", async () => {
    const request = vi.fn(async () => true);

    await expect(requestPageCaptureAccess({ sidePanel: {}, permissions: { request } })).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ origins: ["<all_urls>"] });
  });

  it("reports when the Chromium permission is denied", async () => {
    const request = vi.fn(async () => false);

    await expect(requestPageCaptureAccess({ sidePanel: {}, permissions: { request } })).resolves.toBe(false);
  });

  it("does not request Chromium-only permission in Firefox", async () => {
    const request = vi.fn(async () => true);

    await expect(requestPageCaptureAccess({ permissions: { request } })).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("allows capture when the optional permissions API is unavailable", async () => {
    await expect(requestPageCaptureAccess({ sidePanel: {} })).resolves.toBe(true);
  });
});
