import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error Build helpers are native Node ESM.
import { licenseNotices } from "./scripts/license-notices.mjs";
// @ts-expect-error Build helper is native Node ESM.
import { peerRuntimeStub } from "./scripts/peer-runtime-stub.mjs";

const outDir = process.env.PBOARD_OUT_DIR ?? "dist";
// The recurring-work counters are collected only in a build that asks for them.
const diagnostics = process.env.VITE_PBOARD_DIAGNOSTICS === "1";

// The extension never opens a WebRTC peer pool (src/sync/browser.ts calls
// setWebRtcDisabled(true)), so the whole peer stack — rxdb's replication plugin,
// the connection handler, the signed session exchange, peer history and the
// Drive signaling transport — is unreachable at runtime here. It reaches the
// bundle only through src/collab/peerRuntime.ts, and `peerRuntimeStub()` resolves
// that one specifier to a stub that throws. Android builds the same sources with
// no such plugin, so its live realtime path is unchanged. See
// src/collab/peerRuntime.ts.
export default defineConfig({
  plugins: [react(), licenseNotices("sidebar"), peerRuntimeStub()],
  publicDir: false,
  define: { __PBOARD_DIAGNOSTICS__: JSON.stringify(diagnostics) },
  build: {
    outDir,
    emptyOutDir: false,
    // Measured 2026-11-06: sidebar 610.23 kB (177.71 kB gzip), storage 292.72 kB
    // (92.59 kB gzip), react 218.84 kB, browser 12.40 kB, runtime 0.58 kB, css
    // 39.33 kB. The WebRTC peer stack is no longer bundled at all (see the
    // peerRuntimeStub() plugin above); that removed 40.6 kB from the main chunk,
    // 15 kB from storage, and it deleted the simplepeer chunk outright. The
    // default 500 kB advisory therefore fires on every build and hides a real
    // regression. 600 kB is the owner's budget, not a number this config should
    // raise: the main chunk is still ~10 kB over it, and what remains is
    // application code the sidebar needs before it can paint. The background
    // service worker is a single IIFE by manifest constraint and cannot be split
    // at all; it is 797.81 kB (239.67 kB gzip) now that the peer stack no longer
    // inlines into it. See BUILD.md.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      input: "sidebar.html",
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
            { name: "storage", test: /node_modules[\\/](?:rxdb|dexie|rxjs)[\\/]/ }
          ]
        }
      }
    }
  }
});
