import { copyFile, mkdir } from "node:fs/promises";

await copyFile(
  new URL("../manifest.json", import.meta.url),
  new URL("../dist/manifest.json", import.meta.url)
);

await mkdir(new URL("../dist/icons", import.meta.url), { recursive: true });
await copyFile(
  new URL("../icons/pin.svg", import.meta.url),
  new URL("../dist/icons/pin.svg", import.meta.url)
);
