import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import firefoxManifest from "../manifest.json";
import chromiumManifest from "../manifest.chromium.json";

describe("release metadata", () => {
  it("keeps package and browser manifest versions aligned", () => {
    expect(packageMetadata.version).toBe("0.9.1");
    expect(firefoxManifest.version).toBe(packageMetadata.version);
    expect(chromiumManifest.version).toBe(packageMetadata.version);
  });
});
