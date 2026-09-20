import { copyFile, mkdir } from "node:fs/promises";

const variant = process.argv[2] ?? "firefox";
const outputDir = process.env.PBOARD_OUT_DIR ?? "dist";
const sourceManifest = variant === "chromium" ? "manifest.chromium.json" : "manifest.json";

await copyFile(
  new URL(`../${sourceManifest}`, import.meta.url),
  new URL(`../${outputDir}/manifest.json`, import.meta.url)
);

await mkdir(new URL(`../${outputDir}/icons`, import.meta.url), { recursive: true });
await copyFile(
  new URL("../icons/pin.svg", import.meta.url),
  new URL(`../${outputDir}/icons/pin.svg`, import.meta.url)
);
