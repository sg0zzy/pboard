import { describe, expect, it, vi } from "vitest";
import { togglePboardSidebar, type SidebarApi } from "../src/background/sidebar";

describe("togglePboardSidebar", () => {
  it("toggles when the sidebarAction API exposes toggle", () => {
    const toggle = vi.fn(() => void 0);
    const open = vi.fn(() => void 0);
    const api: SidebarApi = { sidebarAction: { toggle, open } };
    expect(() => togglePboardSidebar(api)).not.toThrow();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens when only the sidebarAction API exposes open", () => {
    const open = vi.fn(() => void 0);
    const api: SidebarApi = { sidebarAction: { open } };
    expect(() => togglePboardSidebar(api)).not.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when there is no sidebarAction (Chromium)", () => {
    const api: SidebarApi = {};
    const open = vi.fn(() => void 0);
    expect(() => togglePboardSidebar(api)).not.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});
