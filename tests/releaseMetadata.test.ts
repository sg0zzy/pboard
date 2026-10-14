import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import firefoxManifest from "../manifest.json";
import chromiumManifest from "../manifest.chromium.json";
import { OPEN_PBOARD_SHORTCUT } from "../src/background/shortcuts";

describe("release metadata", () => {
  it("keeps package and browser manifest versions aligned", () => {
    expect(packageMetadata.version).toBe("0.9.5");
    expect(firefoxManifest.version).toBe(packageMetadata.version);
    expect(chromiumManifest.version).toBe(packageMetadata.version);
  });
  it("declares a Firefox toolbar action and sidebar command", () => {
    expect(firefoxManifest.action).toEqual({
      default_title: "Open Pboard",
      default_icon: {
        16: "icons/logo-16.png",
        32: "icons/logo-32.png",
        48: "icons/logo-48.png",
        128: "icons/logo-128.png",
      },
    });
    expect(chromiumManifest.action.default_icon).toEqual(firefoxManifest.action.default_icon);
    expect(chromiumManifest.icons).toEqual(firefoxManifest.icons);
    expect(firefoxManifest.commands["_execute_sidebar_action"].suggested_key.default).toBe(
      OPEN_PBOARD_SHORTCUT
    );
    expect(chromiumManifest.commands).not.toHaveProperty("_execute_sidebar_action");
  });
  it("requests Chromium permissions for both private sync and project sharing", () => {
    expect(chromiumManifest.oauth2.scopes).toEqual([
      "https://www.googleapis.com/auth/drive.appdata",
      "https://www.googleapis.com/auth/drive"
    ]);
  });
});
