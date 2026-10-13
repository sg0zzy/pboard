import { defineConfig } from "vite";
// @ts-expect-error Build helpers are native Node ESM.
import { licenseNotices } from "./scripts/license-notices.mjs";

const outDir = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PBOARD_OUT_DIR ?? "dist";

export default defineConfig({
  plugins: [licenseNotices("background")],
  publicDir: false,
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
