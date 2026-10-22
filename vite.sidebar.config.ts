import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error Build helpers are native Node ESM.
import { licenseNotices } from "./scripts/license-notices.mjs";

const outDir = process.env.PBOARD_OUT_DIR ?? "dist";
// The recurring-work counters are collected only in a build that asks for them.
const diagnostics = process.env.VITE_PBOARD_DIAGNOSTICS === "1";

export default defineConfig({
  plugins: [react(), licenseNotices("sidebar")],
  publicDir: false,
  define: { __PBOARD_DIAGNOSTICS__: JSON.stringify(diagnostics) },
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
