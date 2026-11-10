/**
 * Extension-context wiring for the Live Debug Bridge.
 *
 * The bridge channel is enabled by exactly one of:
 *  - an explicit per-profile setting in `browser.storage.local` under
 *    `pboardDebugBridge` (`{ enabled, url?, token?, clientId? }`), which is
 *    how a developer turns it on in a loaded release-ish build without
 *    rebuilding: `await browser.storage.local.set({ pboardDebugBridge: {
 *    enabled: true } })` and reload the extension;
 *  - a development build (`import.meta.env.DEV`) or a
 *    `VITE_PBOARD_DIAGNOSTICS=1` build, where it defaults ON pointing at the
 *    loopback bridge, and can be silenced with `{ enabled: false }`.
 *
 * Production builds without the setting enable nothing: `configureDebug`
 * resolves without creating a transport, and `emit` stays a boolean test.
 */

import { browser } from "../platform/browser";
import { configureDebugBus, debugDropReport } from "./bus.ts";
import { HttpBridgeTransport, isSafeBridgeEndpoint, DEFAULT_BRIDGE_URL } from "./bridgeTransport.ts";
import { resolveClientId, resolveSessionId } from "./ids.ts";

declare const __PBOARD_DIAGNOSTICS__: boolean;

export const debugBridgeSettingsKey = "pboardDebugBridge";

export type DebugContext = "background" | "sidebar";

export interface DebugBridgeSettings {
  enabled?: boolean;
  url?: string;
  token?: string;
  clientId?: string;
}

const buildFlag: boolean = typeof __PBOARD_DIAGNOSTICS__ === "undefined" ? false : __PBOARD_DIAGNOSTICS__;

export interface DebugRuntimeHandle {
  transport: HttpBridgeTransport;
  clientId: string;
  sessionId: string;
}

let handle: DebugRuntimeHandle | undefined;

export async function readDebugBridgeSettings(): Promise<DebugBridgeSettings> {
  try {
    const stored = await browser.storage.local.get(debugBridgeSettingsKey);
    const raw = stored?.[debugBridgeSettingsKey];
    if (raw && typeof raw === "object") return raw as DebugBridgeSettings;
  } catch {
    /* storage may be unavailable this early; defaults apply */
  }
  return {};
}

/**
 * Enables the diagnostic channel for this context when policy says so.
 * Idempotent; returns the active handle or undefined when disabled.
 * Also exposes the `pboardDebug` console command in this context.
 */
export async function configureDebugForContext(context: DebugContext): Promise<DebugRuntimeHandle | undefined> {
  if (handle) return handle;
  const settings = await readDebugBridgeSettings();
  const enabled = settings.enabled ?? (import.meta.env.DEV || buildFlag);
  if (!enabled) return undefined;

  const url = settings.url?.trim() || DEFAULT_BRIDGE_URL;
  if (!isSafeBridgeEndpoint(url)) {
    console.warn(`pboard debug: refusing non-loopback bridge URL ${url}`);
    return undefined;
  }
  const clientId = await resolveClientId(settings.clientId, {
    get: async (key) => (await browser.storage.local.get(key))?.[key],
    set: async (key, value) => { await browser.storage.local.set({ [key]: value }); },
  });
  const sessionId = resolveSessionId();

  const transport = new HttpBridgeTransport({
    url,
    ...(settings.token ? { token: settings.token } : {}),
    clientId,
    sessionId,
    context,
    onError: (message) => console.debug(`pboard debug bridge: ${message}`),
  });

  configureDebugBus({
    enabled: true,
    identity: () => ({ clientId, sessionId, context }),
    transport: () => transport,
  });
  handle = { transport, clientId, sessionId };
  exposeDebugCommand(handle);
  return handle;
}

/** Console entry point matching the existing `pboardCollaboration()` style:
 * `pboardDebug.status()`, `pboardDebug.enable()`, `pboardDebug.disable()`,
 * `pboardDebug.drops()`. */
function exposeDebugCommand(own: DebugRuntimeHandle): void {
  const scope = globalThis as Record<string, unknown>;
  if (scope.pboardDebug) return;
  scope.pboardDebug = {
    status: () => ({
      enabled: true,
      clientId: own.clientId,
      sessionId: own.sessionId,
      context: (globalThis as { window?: unknown }).window ? "sidebar" : "background",
      transport: own.transport ? "http-bridge" : "none",
    }),
    drops: () => debugDropReport(),
    /** Persist the on-switch and report the next-boot value; the current
     * context keeps its current state until reload. */
    enable: (options: { url?: string; token?: string } = {}) => {
      void browser.storage.local.set({
        [debugBridgeSettingsKey]: { enabled: true, ...(options.url ? { url: options.url } : {}), ...(options.token ? { token: options.token } : {}) },
      });
      return "diagnostics will be enabled after the next extension reload";
    },
    disable: () => {
      void browser.storage.local.set({ [debugBridgeSettingsKey]: { enabled: false } });
      return "diagnostics will be disabled after the next extension reload";
    },
  };
}
