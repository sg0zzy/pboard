export type SidebarApi = {
  sidebarAction?: {
    toggle?: () => void | Promise<void>;
    open?: () => void | Promise<void>;
  };
};

/**
 * Toggles the Pboard sidebar when the Firefox `sidebar_action` API is
 * available. Falls back to opening the sidebar when `toggle` is absent.
 * This is a no-op on Chromium, which opens the side panel through
 * `openPanelOnActionClick` instead.
 */
export function togglePboardSidebar(api: SidebarApi): void {
  const sidebarAction = api.sidebarAction;
  if (!sidebarAction) return;

  if (typeof sidebarAction.toggle === "function") {
    void sidebarAction.toggle();
    return;
  }

  if (typeof sidebarAction.open === "function") {
    void sidebarAction.open();
  }
}
