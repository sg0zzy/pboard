import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const outDir = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PBOARD_OUT_DIR ?? "dist";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
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
