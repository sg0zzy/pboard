import { defineConfig } from "vite";
// @ts-expect-error Build helpers are native Node ESM.
import { licenseNotices } from "./scripts/license-notices.mjs";

const outDir = process.env.PBOARD_OUT_DIR ?? "dist";
// The recurring-work counters are collected only in a build that asks for them.
const diagnostics = process.env.VITE_PBOARD_DIAGNOSTICS === "1";

export default defineConfig({
  plugins: [licenseNotices("background")],
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
