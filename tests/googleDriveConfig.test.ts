import { describe, expect, it } from "vitest";

import { googleDriveConfig } from "../src/sync/googleDriveConfig";

type Browser = keyof typeof googleDriveConfig;

describe("googleDriveConfig", () => {
  it("maps every browser to a dev and production client id", () => {
    const browsers = Object.keys(googleDriveConfig) as Browser[];
    expect(browsers).toEqual(["chromium", "firefox"]);

    for (const browser of browsers) {
      const entry = googleDriveConfig[browser];
      expect(typeof entry.dev).toBe("string");
      expect(entry.dev.length).toBeGreaterThan(0);
      expect(typeof entry.production).toBe("string");
      expect(entry.production.length).toBeGreaterThan(0);
    }
  });

  it("keeps the chromium and firefox client ids distinct", () => {
    expect(googleDriveConfig.chromium.dev).not.toEqual(googleDriveConfig.firefox.dev);
    expect(googleDriveConfig.chromium.production).not.toEqual(googleDriveConfig.firefox.production);
  });

  it("keeps every client id a non-empty, whitespace-free string", () => {
    for (const browser of ["chromium", "firefox"] as const) {
      expect(googleDriveConfig[browser].dev).toMatch(/^\S+$/);
      expect(googleDriveConfig[browser].production).toMatch(/^\S+$/);
    }
  });
});
