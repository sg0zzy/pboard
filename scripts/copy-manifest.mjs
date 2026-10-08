import { copyFile, mkdir } from "node:fs/promises";
import { globSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const variant = process.argv[2] ?? "firefox";
const outputDir = process.env.PBOARD_OUT_DIR ?? "dist";
const sourceManifest = variant === "chromium" ? "manifest.chromium.json" : "manifest.json";

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
