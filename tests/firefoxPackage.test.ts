import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";
// @ts-expect-error Release scripts are native Node ESM.
import { verifyPackage } from "../scripts/verify-package.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(omitJavascript = false, staleJavascript = false) {
  const root = await mkdtemp(join(tmpdir(), "pboard-package-"));
  directories.push(root);
  const build = join(root, "dist");
  await mkdir(join(build, "assets"), { recursive: true });
  await mkdir(join(build, "chromium"));
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8('{"version":"0.9.3"}'),
    "sidebar.html": strToU8('<script src="/assets/sidebar.js"></script>'),
    "assets/sidebar.js": strToU8('document.body.textContent = "Pboard";')
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(build, name), bytes);
  await writeFile(join(build, "chromium", "manifest.json"), "{}");
  await writeFile(join(build, "assets", "sidebar.js.map"), "{}");
  if (omitJavascript) delete files["assets/sidebar.js"];
  if (staleJavascript) files["assets/sidebar.js"] = strToU8("old bundle");
  const archive = join(root, "package.zip");
  await writeFile(archive, zipSync(files));
  return { build, archive };
}

it("accepts the complete runtime package without Chromium or source maps", async () => {
  const { build, archive } = await fixture();
  await expect(verifyPackage(archive, build)).resolves.toBe(3);
});

it("rejects the missing sidebar JavaScript that caused the AMO blank panel", async () => {
  const { build, archive } = await fixture(true);
  await expect(verifyPackage(archive, build)).rejects.toThrow("missing assets/sidebar.js");
});

it("rejects stale packaged bundles", async () => {
  const { build, archive } = await fixture(false, true);
  await expect(verifyPackage(archive, build)).rejects.toThrow("differs from build: assets/sidebar.js");
});

it("rejects a Chromium ZIP without license notices even if runtime files match", async () => {
  const { build, archive } = await fixture();
  await expect(verifyPackage(archive, build, "Chromium")).rejects.toThrow("missing LICENSE.md");
});
