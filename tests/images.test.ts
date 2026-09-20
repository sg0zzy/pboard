import { describe, expect, it, vi } from "vitest";
import { firstCaptureRegion } from "../src/background/regionCapture";
import { computeCropRect, cropCapturedImage, fitImageWithin } from "../src/images/processing";

describe("image sizing", () => {
  it("preserves small images and scales large images proportionally", () => {
    expect(fitImageWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitImageWithin(2800, 1400)).toEqual({ width: 1400, height: 700 });
    expect(fitImageWithin(1000, 3000)).toEqual({ width: 467, height: 1400 });
  });
});

describe("capture-region cropping", () => {
  it("scales region coordinates to the screenshot size", () => {
    const region = { x: 10, y: 20, width: 300, height: 180, viewportWidth: 1200, viewportHeight: 800 };
    expect(computeCropRect(2400, 1600, region)).toEqual({ x: 20, y: 40, width: 600, height: 360 });
  });

  it("uses the OffscreenCanvas path when running without a document", async () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob(["source"], { type: "image/png" }) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 1200,
      height: 800,
      close: vi.fn()
    })));
    vi.stubGlobal("OffscreenCanvas", class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      async convertToBlob() {
        return new Blob(["encoded"], { type: "image/webp" });
      }
    });

    try {
      const image = await cropCapturedImage("data:image/png;base64,c291cmNl", {
        x: 0,
        y: 0,
        width: 300,
        height: 180,
        viewportWidth: 1200,
        viewportHeight: 800
      });
      expect(image.mimeType).toBe("image/webp");
      expect(image.dataUrl).toMatch(/^data:image\/webp;base64,/);
      expect(image.width).toBe(300);
      expect(image.height).toBe(180);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clamps regions that extend beyond the screenshot", () => {
    const region = { x: 1190, y: 790, width: 200, height: 200, viewportWidth: 1200, viewportHeight: 800 };
    expect(computeCropRect(1200, 800, region)).toEqual({ x: 1190, y: 790, width: 10, height: 10 });
  });

  it("keeps a valid rect when the screenshot is smaller than the viewport", () => {
    const region = { x: 900, y: 500, width: 500, height: 300, viewportWidth: 1200, viewportHeight: 800 };
    expect(computeCropRect(800, 500, region)).toEqual({ x: 600, y: 313, width: 200, height: 187 });
  });
});

describe("capture-region results", () => {
  it("uses the first valid rectangular result", () => {
    const region = { x: 10, y: 20, width: 300, height: 180, viewportWidth: 1200, viewportHeight: 800 };
    expect(firstCaptureRegion([{ result: null }, { result: region }])).toEqual(region);
  });

  it("rejects missing or malformed results", () => {
    expect(firstCaptureRegion([{ result: { x: 10 } }, { result: "invalid" }])).toBeNull();
  });
});
