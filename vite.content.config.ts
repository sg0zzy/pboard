import { defineConfig } from "vite";

const outDir = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PBOARD_OUT_DIR ?? "dist";

export default defineConfig({
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    lib: {
      entry: "src/content/index.ts",
      name: "ProjectBoardContent",
      formats: ["iife"],
      fileName: () => "content.js"
    }
  }
});
