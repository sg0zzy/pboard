import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const outDir = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PBOARD_OUT_DIR ?? "dist";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: { input: "sidebar.html" }
  }
});
