import { rm } from "node:fs/promises";

const outputDir = process.env.PBOARD_OUT_DIR ?? "dist";
await rm(new URL(`../${outputDir}`, import.meta.url), { recursive: true, force: true });
