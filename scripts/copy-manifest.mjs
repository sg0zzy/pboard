import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const variant = process.argv[2] ?? "firefox";
const outputDir = process.env.PBOARD_OUT_DIR ?? "dist";
const sourceManifest = variant === "chromium" ? "manifest.chromium.json" : "manifest.json";

await copyFile(join(root, "LICENSE.md"), join(root, outputDir, "LICENSE.md"));

await copyFile(
  join(root, sourceManifest),
  join(root, outputDir, "manifest.json")
);

await mkdir(join(root, outputDir, "icons"), { recursive: true });
await copyFile(
  join(root, "icons", "pin.svg"),
  join(root, outputDir, "icons", "pin.svg")
);

const logoIcons = globSync(join(root, "icons", "logo-*.png"));
for (const iconPath of logoIcons) {
  await copyFile(
    iconPath,
    join(root, outputDir, "icons", basename(iconPath))
  );
}

// Local experiment only: tracked manifests and OAuth declarations are untouched.
if (process.env.PBOARD_SIGNALING_DEV_BUILD === '1') {
  const path = join(root, outputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const endpoint = new URL(process.env.VITE_PBOARD_SIGNALING_WS_URL || 'ws://127.0.0.1:8787/ws');
  const scheme = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  manifest.name = 'Pboard (signaling experiment)';
  manifest.host_permissions.push(`${scheme}//${endpoint.hostname}/*`);
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}
