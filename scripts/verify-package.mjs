import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

// Check the actual upload, since web-ext's exclusions do not affect temporary installs.
export async function verifyPackage(archivePath, buildDirectory) {
  const files = unzipSync(await readFile(archivePath));
  const entries = await readdir(buildDirectory, { recursive: true, withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = resolve(entry.parentPath, entry.name);
    const name = relative(buildDirectory, path).replaceAll("\\", "/");
    if (name.startsWith("chromium/") || name.endsWith(".map")) continue;
    if (!files[name]) throw new Error(`Firefox package is missing ${name}`);
    if (!Buffer.from(files[name]).equals(await readFile(path))) {
      throw new Error(`Firefox package differs from build: ${name}`);
    }
    count++;
  }
  if (!files["manifest.json"] || !files["sidebar.html"]) {
    throw new Error("Firefox package must contain manifest.json and sidebar.html at its root");
  }
  if (Object.keys(files).some((name) => name.startsWith("chromium/"))) {
    throw new Error("Firefox package contains the Chromium build");
  }
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const archive = resolve(root, process.argv[2] ?? `web-ext-artifacts/pboard-${version}.zip`);
  const count = await verifyPackage(archive, resolve(root, "dist"));
  console.log(`Firefox package verification passed (${count} files): ${archive}`);
}
