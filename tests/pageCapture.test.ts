import { describe, expect, it, vi } from "vitest";
import { capturePageRegion, type PageCaptureApi } from "../src/background/pageCapture";
import type { CaptureRegion } from "../src/images/processing";
import type { BoardImage } from "../src/types";

const region: CaptureRegion = {
  x: 10,
  y: 20,
  width: 300,
  height: 180,
  viewportWidth: 1200,
  viewportHeight: 800,
  href: "https://example.com/page"
};

const image: BoardImage = {
  dataUrl: "data:image/webp;base64,dGVzdA==",
  mimeType: "image/webp",
  width: 300,
  height: 180
};

const selectRegion = vi.fn() as unknown as () => Promise<CaptureRegion | null>;

function createApi(overrides: {
  tabs?: Array<{ id?: number; windowId?: number; url?: string; title?: string }>;
  executeScript?: () => Promise<Array<{ result?: unknown }>>;
  captureVisibleTab?: () => Promise<string>;
} = {}): PageCaptureApi {
  const tabs = overrides.tabs ?? [
    { id: 7, windowId: 3, url: region.href, title: "Example" },
    { id: 7, windowId: 3, url: region.href, title: "Example" }
  ];
  let queryIndex = 0;
  return {
    tabs: {
      query: vi.fn(async () => [tabs[Math.min(queryIndex++, tabs.length - 1)]]),
      captureVisibleTab: vi.fn(overrides.captureVisibleTab ?? (async () => "data:image/png;base64,c2NyZWVu"))
    },
    scripting: {
      executeScript: vi.fn(overrides.executeScript ?? (async () => [{ result: region }]))
    }
  };
}

function dependencies(cropImage = vi.fn(async () => image)) {
  return { selectRegion, cropImage };
}

describe("page-region capture pipeline", () => {
  it("returns the processed capture with page metadata", async () => {
    const api = createApi();
    const deps = dependencies();

    await expect(capturePageRegion(api, deps)).resolves.toEqual({
      ok: true,
      image,
      pageUrl: region.href,
      pageTitle: "Example"
    });
    expect(api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      func: selectRegion
    });
    expect(api.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: "png" });
    expect(deps.cropImage).toHaveBeenCalledWith("data:image/png;base64,c2NyZWVu", region);
  });

  it("rejects capture when there is no active browser tab", async () => {
    const api = createApi({ tabs: [{}] });

    await expect(capturePageRegion(api, dependencies())).resolves.toEqual({
      ok: false,
      reason: "No active web page is available."
    });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("uses a generic unsupported-page message when injection is forbidden", async () => {
    const api = createApi({
      tabs: [{ id: 7, windowId: 3, url: "chrome://settings" }],
      executeScript: async () => { throw new Error("Cannot access contents"); }
    });

    await expect(capturePageRegion(api, dependencies())).resolves.toEqual({
      ok: false,
      reason: "This page type cannot be captured."
    });
  });

  it("uses a retryable message when injection fails on a web page", async () => {
    const api = createApi({ executeScript: async () => { throw new Error("Injection failed"); } });

    await expect(capturePageRegion(api, dependencies())).resolves.toEqual({
      ok: false,
      reason: "The page could not be captured. Try again."
    });
  });

  it("reports an overlay cancellation without taking a screenshot", async () => {
    const api = createApi({ executeScript: async () => [{ result: null }] });

    await expect(capturePageRegion(api, dependencies())).resolves.toEqual({
      ok: false,
      reason: "Capture cancelled.",
      cancelled: true
    });
    expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("stops if the active tab disappears after region selection", async () => {
    const api = createApi({
      tabs: [{ id: 7, windowId: 3, url: region.href }, {}]
    });

    await expect(capturePageRegion(api, dependencies())).resolves.toEqual({
      ok: false,
      reason: "No active web page is available."
    });
  });

  it.each([
    ["tab", { id: 8, windowId: 3, url: region.href }],
    ["URL", { id: 7, windowId: 3, url: "https://example.com/elsewhere" }]
  ])("stops if the active %s changes during selection", async (_label, changedTab) => {
    const api = createApi({
      tabs: [{ id: 7, windowId: 3, url: region.href }, changedTab]
    });

    await expect(capturePageRegion(api, dependencies())).resolves.toEqual({
      ok: false,
      reason: "The page changed while capturing. Try again."
    });
    expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("reports screenshot API failures", async () => {
    const api = createApi({ captureVisibleTab: async () => { throw new Error("Missing permission"); } });

    await expect(capturePageRegion(api, dependencies())).resolves.toEqual({
      ok: false,
      reason: "The page could not be captured. Try again."
    });
  });

  it("reports image-processing failures", async () => {
    const api = createApi();
    const cropImage = vi.fn(async (): Promise<BoardImage> => { throw new Error("Decode failed"); });

    await expect(capturePageRegion(api, dependencies(cropImage))).resolves.toEqual({
      ok: false,
      reason: "The captured image could not be processed."
    });
  });
});
