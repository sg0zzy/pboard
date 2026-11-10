import { defineConfig } from "vite";
// @ts-expect-error Build helpers are native Node ESM.
import { licenseNotices } from "./scripts/license-notices.mjs";
// @ts-expect-error Build helper is native Node ESM.
import { peerRuntimeStub } from "./scripts/peer-runtime-stub.mjs";

const outDir = process.env.PBOARD_OUT_DIR ?? "dist";
// The recurring-work counters are collected only in a build that asks for them.
const diagnostics = process.env.VITE_PBOARD_DIAGNOSTICS === "1";

// Same platform split as the sidebar: this context also runs with
// `setWebRtcDisabled(true)` (src/sync/browser.ts is the composition root it
// shares), so the peer stack is unreachable and aliased to a stub. It matters
// more here — an IIFE cannot code-split, so without the alias every peer module
// is inlined into background.js. See src/collab/peerRuntime.ts.
export default defineConfig({
  plugins: [licenseNotices("background"), peerRuntimeStub()],
  publicDir: false,
  define: { __PBOARD_DIAGNOSTICS__: JSON.stringify(diagnostics) },
  build: {
    outDir,
    emptyOutDir: false,
    lib: {
      entry: "src/background/index.ts",
      name: "ProjectBoardBackground",
      formats: ["iife"],
      fileName: () => "background.js"
    }
  }
});
