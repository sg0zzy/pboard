import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeLicenseNotices } from "./license-notices.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.PBOARD_STAGE) {
  const { buildLocal } = await import('./local-build.mjs');
  buildLocal([process.argv[2] === 'chromium' ? 'chromium' : 'firefox']);
  process.exit(0);
}
const variant = process.argv[2] === "chromium" ? "chromium" : "firefox";
const outputDir = variant === "chromium" ? "dist/chromium" : "dist";
const env = { ...process.env, PBOARD_OUT_DIR: outputDir };
if (variant === "chromium") env.VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET = "";

await rm(resolve(root, outputDir), { recursive: true, force: true });
for (const config of ["vite.sidebar.config.ts", "vite.background.config.ts", "vite.content.config.ts"]) {
  execFileSync(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build", "--config", config], {
    cwd: root,
    env,
    stdio: "inherit"
  });
}
const count = await writeLicenseNotices(resolve(root, outputDir));
console.log(`Included licenses and notices for ${count} bundled packages`);
execFileSync(process.execPath, [resolve(root, "scripts/copy-manifest.mjs"), variant], {
  cwd: root,
  env,
  stdio: "inherit"
});
