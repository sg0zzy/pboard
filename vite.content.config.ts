import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/content/index.ts",
      name: "ProjectBoardContent",
      formats: ["iife"],
      fileName: () => "content.js"
    }
  }
});
