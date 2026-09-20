/**
 * Small runtime adapter shared by Firefox and Chromium builds.
 * Firefox exposes `browser`; Chromium exposes `chrome` (and newer versions
 * may expose both). Chromium calls the context-menu namespace
 * `contextMenus`, while Firefox calls it `menus`.
 */
type ExtensionApi = Record<string, any>;

const globals = globalThis as typeof globalThis & {
  browser?: ExtensionApi;
  chrome?: ExtensionApi;
};

const api = globals.browser ?? globals.chrome;
if (!api) throw new Error("Pboard extension APIs are unavailable");

if (!api.menus && api.contextMenus) api.menus = api.contextMenus;

export const browser = api as ExtensionApi;
