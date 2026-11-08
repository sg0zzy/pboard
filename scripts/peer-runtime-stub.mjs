/**
 * Build-time stand-in for the WebRTC peer stack, for extension bundles only.
 *
 * `src/collab/peerRuntime.ts` is the single module every peer import goes
 * through. The extension can never execute it (`src/sync/browser.ts` calls
 * `setWebRtcDisabled(true)`, and the manager and the runtime return at that gate
 * before either constructs a pool, DataChannel or history session), so the
 * extension builds resolve that specifier to `peerRuntime.stub.ts` instead and
 * ship no peer code at all. Android builds the same sources without this plugin
 * and loads the real modules.
 *
 * `resolveId` rather than a `resolve.alias` entry: the specifier is relative
 * (`./peerRuntime`, `../collab/peerRuntime`), and an alias replacement is
 * interpreted relative to the importer — which points at a file that does not
 * exist — before it can become an absolute path. Returning the absolute path
 * here is the only form that also deduplicates the stub across importers.
 */
import { fileURLToPath } from "node:url";

// Absolute, and the same path for every importer, so the stub is one module
// instance in the graph rather than one per importing directory.
const stub = fileURLToPath(new URL("../src/collab/peerRuntime.stub.ts", import.meta.url));
const peerRuntime = /(?:^|\/)peerRuntime$/;

export function peerRuntimeStub() {
  return {
    name: "pboard-peer-runtime-stub",
    enforce: "pre",
    resolveId(source) {
      if (!peerRuntime.test(source)) return null;
      return stub;
    }
  };
}
