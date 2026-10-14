import { readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

const manifest = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"));
const expectedVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

const required = ["manifest.json", "sidebar.html", "background.js", "content.js", "LICENSE.md"];
for (const name of required) {
  if (!readFileSync(resolve(dist, name), { flag: "r" })) {
    throw new Error(`Firefox build is missing ${name}`);
  }
}

const icons = new Set(await readdir(resolve(dist, "icons")));
for (const icon of Object.values(manifest.icons)) {
  if (!icons.has(icon.split("/").pop())) {
    throw new Error(`Firefox build is missing icon ${icon}`);
  }
}

const geo = manifest.browser_specific_settings?.gecko;
if (manifest.version !== expectedVersion || geo?.id !== "project-board@local.invalid") {
  throw new Error(
    `Firefox manifest mismatch: version ${manifest.version} (expected ${expectedVersion}), ` +
    `ID ${geo?.id ?? "(none)"} (expected project-board@local.invalid)`
  );
}

console.log(`Firefox build assets verified: ${required.join(", ")} + ${icons.size} icons`);