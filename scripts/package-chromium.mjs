import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { zipSync } from "fflate";
import { verifyPackage } from "./verify-package.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const directory = resolve(root, "dist/chromium");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const archive = resolve(root, `web-ext-artifacts/pboard-chromium-${version}.zip`);
const files = {};
for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = resolve(entry.parentPath, entry.name);
  const name = relative(directory, path).replaceAll("\\", "/");
  if (name.endsWith(".map")) continue;
  files[name] = await readFile(path);
}
for (const name of ["LICENSE.md", "THIRD-PARTY-NOTICES.txt"]) {
  if (!files[name]?.length) throw new Error(`Chromium build is missing ${name}; rebuild before packaging`);
}
if (Object.keys(files).some((name) => name.startsWith(".licenses-"))) {
  throw new Error("Unfinished license generation; rebuild before packaging");
}
await mkdir(resolve(root, "web-ext-artifacts"), { recursive: true });
await writeFile(archive, zipSync(files));
const count = await verifyPackage(archive, directory, "Chromium");
console.log(`Chromium package verification passed (${count} files): ${archive}`);
